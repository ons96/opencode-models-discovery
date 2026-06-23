import { promises as fs } from 'node:fs'
import path from 'node:path'
import { xdgData } from 'xdg-basedir'
import { ToastNotifier } from '../ui/toast-notifier'
import { categorizeModel, formatModelName, extractModelOwner } from '../utils'
import { normalizeBaseURL, discoverModelsFromProvider, discoverModelInfoFromProvider, autoDetectOpenAICompatibleProvider } from '../utils/openai-compatible-api'
import { createModelInfoEnricher, isSupportedModelInfoFormat, type ModelInfoEnricher } from '../utils/model-info'
import { getProviderFilter, getDiscoveryConfig, getModelRegexFilter, getProviderModelRegexFilter, shouldDiscoverModel, shouldDiscoverProviderWithOverride } from '../types/plugin-config'
import { readCache, writeCache, type CacheData } from '../utils/cache'
import type { PluginLogger } from './logger'
import type { PluginInput } from '@opencode-ai/plugin'
import type { OpenAIModel } from '../types'
import type { PluginConfig } from '../types/plugin-config'

interface DiscoveredProvider {
  name: string
  baseURL: string
  models: Record<string, any>
}

interface ResolvedProvider {
  id?: string
  key?: string
}

interface ResolvedProvidersLoader {
  promise?: Promise<Map<string, ResolvedProvider>>
}

interface OpenCodeAuth {
  type?: string
  key?: string
}

type HostClient = 'opencode' | 'mimocode'

const RESOLVED_PROVIDERS_TIMEOUT_MS = 250
const PARALLEL_CONCURRENCY = 10

async function getResolvedProvidersByID(
  client: PluginInput['client'],
  logger: PluginLogger,
  timeoutMs: number = RESOLVED_PROVIDERS_TIMEOUT_MS
): Promise<Map<string, ResolvedProvider>> {
  try {
    const loadProviders = client.config?.providers
    if (typeof loadProviders !== 'function') {
      return new Map()
    }

    const result = await Promise.race([
      loadProviders.call(client.config),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), timeoutMs)
      })
    ])

    if (!result) {
      logger.debug('Timed out loading resolved providers')
      return new Map()
    }

    const providers = result?.data?.providers
    if (!Array.isArray(providers)) {
      return new Map()
    }

    return new Map(
      providers
        .filter((provider: ResolvedProvider) => typeof provider?.id === 'string')
        .map((provider: ResolvedProvider) => [provider.id!, provider])
    )
  } catch (error) {
    logger.debug('Could not load resolved providers', {
      error: error instanceof Error ? error.message : String(error),
    })
    return new Map()
  }
}

function detectHostClient(): HostClient {
  if (process.env.OPENCODE === '1') {
    return 'opencode'
  }

  if (process.env.MIMOCODE === '1') {
    return 'mimocode'
  }

  return 'opencode'
}

function getHostAuthFile(): string | undefined {
  if (!xdgData) {
    return undefined
  }

  const hostClient = detectHostClient()
  return path.join(xdgData, hostClient, 'auth.json')
}

async function getOpenCodeAuth(providerName: string, logger: PluginLogger): Promise<OpenCodeAuth | undefined> {
  const normalizedProviderName = providerName.replace(/\/+$/, '')

  try {
    if (process.env.OPENCODE_AUTH_CONTENT) {
      const auths = JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, OpenCodeAuth>
      return auths[providerName] ?? auths[normalizedProviderName] ?? auths[`${normalizedProviderName}/`]
    }
  } catch (error) {
    logger.debug('Could not parse OPENCODE_AUTH_CONTENT', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const file = getHostAuthFile()
  if (file) {
    try {
      const auths = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, OpenCodeAuth>
      return auths[providerName] ?? auths[normalizedProviderName] ?? auths[`${normalizedProviderName}/`]
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        logger.debug('Could not read host auth store', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  return undefined
}

function getConfiguredApiKey(providerConfig: any): string | undefined {
  const explicitApiKey = providerConfig.options?.apiKey
  if (typeof explicitApiKey === 'string' && explicitApiKey.trim().length > 0) {
    return explicitApiKey
  }

  return undefined
}

async function getProviderApiKey(
  providerName: string,
  providerConfig: any,
  client: PluginInput['client'],
  loader: ResolvedProvidersLoader,
  logger: PluginLogger
): Promise<string | undefined> {
  const explicitApiKey = getConfiguredApiKey(providerConfig)
  if (explicitApiKey) {
    return explicitApiKey
  }

  loader.promise ??= getResolvedProvidersByID(client, logger)
  const resolvedProvider = (await loader.promise).get(providerName)

  if (typeof resolvedProvider?.key === 'string' && resolvedProvider.key.trim().length > 0) {
    return resolvedProvider.key
  }

  const auth = await getOpenCodeAuth(providerName, logger)
  if (auth?.type === 'api' && typeof auth.key === 'string' && auth.key.trim().length > 0) {
    return auth.key
  }

  return undefined
}

// Run async tasks with concurrency limit
async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0

  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i])
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.allSettled(workers)
  return results
}

interface ProviderJob {
  name: string
  p: any
  modelsEndpoint: string
  modelInfoEndpoint: string | undefined
  modelInfoFormat: string | undefined
  filterNonChat: boolean
  smartModelNameEnabled: boolean
}

export async function enhanceConfig(
  config: any,
  client: PluginInput['client'],
  toastNotifier: ToastNotifier,
  pluginConfig: PluginConfig,
  logger: PluginLogger
): Promise<void> {
  try {
    const providers = config.provider || {}
    const providerFilter = getProviderFilter(pluginConfig)
    const modelRegexFilter = getModelRegexFilter(pluginConfig, logger.child({ category: 'filtering' }))
    const discoveryConfig = getDiscoveryConfig(pluginConfig)
    const globalDiscoveryEnabled = discoveryConfig.enabled
    const resolvedProvidersLoader: ResolvedProvidersLoader = {}

    // Load cache for fallback seeding
    const cache = await readCache(logger)

    // Phase 1: Collect eligible providers into jobs
    const jobs: ProviderJob[] = []
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      const p = providerConfig as any
      const providerDiscoveryConfig = p.options?.modelsDiscovery ?? {}
      const modelsEndpoint = providerDiscoveryConfig.endpoint ?? '/v1/models'
      const modelInfoEndpoint = providerDiscoveryConfig.modelInfoEndpoint
      const modelInfoFormat = providerDiscoveryConfig.modelInfoFormat
      const filterNonChat = providerDiscoveryConfig.filterNonChat !== false
      // ponytail: probe any provider with a baseURL, not just npm-detected ones.
      // Users may have providers without @ai-sdk/openai-compatible that still serve /v1/models.
      // API failures are handled gracefully (cache fallback + 3s timeout per request).

      if (!shouldDiscoverProviderWithOverride(providerName, providerFilter, globalDiscoveryEnabled, providerDiscoveryConfig)) {
        logger.debug(`Provider ${providerName} model discovery disabled by configuration`)
        continue
      }

      if (!p.options?.baseURL) {
        continue
      }

      const smartModelNameEnabled = providerDiscoveryConfig.smartModelName ?? pluginConfig.smartModelName ?? false

      jobs.push({
        name: providerName,
        p,
        modelsEndpoint,
        modelInfoEndpoint,
        modelInfoFormat,
        filterNonChat,
        smartModelNameEnabled,
      })
    }

    if (jobs.length === 0) {
      return
    }

    logger.info(`Starting model discovery for ${jobs.length} providers (parallel, concurrency=${PARALLEL_CONCURRENCY})`)

    // Phase 2: Parallel discovery
    const openAICompatibleProviders: DiscoveredProvider[] = []
    const cacheUpdates: CacheData = { version: 1, providers: {} }

    const results = await parallelMap(jobs, PARALLEL_CONCURRENCY, async (job) => {
      const { name: providerName, p, modelsEndpoint, modelInfoEndpoint, modelInfoFormat, filterNonChat, smartModelNameEnabled } = job
      const baseURL = normalizeBaseURL(p.options.baseURL)
      const apiKey = await getProviderApiKey(providerName, p, client, resolvedProvidersLoader, logger)
      const existingModels = p.models || {}

      // Probe API
      const discovery = await discoverModelsFromProvider(baseURL, apiKey, modelsEndpoint)
      if (!discovery.ok || discovery.models.length === 0) {
        // API failed — seed from cache if available
        const cached = cache.providers[providerName]
        if (cached?.models) {
          const cachedKeys = Object.keys(cached.models).filter(k => !existingModels[k])
          if (cachedKeys.length > 0) {
            logger.debug(`API failed for ${providerName}, seeding ${cachedKeys.length} cached models`)
            for (const k of cachedKeys) existingModels[k] = cached.models[k]
          }
        }
        return { name: providerName, baseURL, models: null, existingModels }
      }

      // API succeeded — build discovered models
      let modelInfoEnricher: ModelInfoEnricher | undefined
      if (modelInfoFormat && !isSupportedModelInfoFormat(modelInfoFormat)) {
        logger.warn('Unsupported provider model info format', { provider: providerName, format: modelInfoFormat })
      } else if (typeof modelInfoEndpoint === 'string' && modelInfoEndpoint.length > 0 && modelInfoFormat) {
        const modelInfoDiscovery = await discoverModelInfoFromProvider(baseURL, apiKey, modelInfoEndpoint)
        if (modelInfoDiscovery.ok) {
          modelInfoEnricher = createModelInfoEnricher(modelInfoFormat, modelInfoDiscovery.data, { filterNonChat })
        }
      }

      const discoveredModels: Record<string, any> = {}
      const hasProviderModelRegexFilter = !!(p.options?.modelsDiscovery?.models?.includeRegex?.length || p.options?.modelsDiscovery?.models?.excludeRegex?.length)
      const providerModelRegexFilter = hasProviderModelRegexFilter
        ? getProviderModelRegexFilter(p.options.modelsDiscovery, logger.child({ category: 'filtering' }))
        : modelRegexFilter

      for (const model of discovery.models) {
        if (existingModels[model.id]) continue
        const activeModelRegexFilter = hasProviderModelRegexFilter ? providerModelRegexFilter : modelRegexFilter
        if (!shouldDiscoverModel(model.id, activeModelRegexFilter)) continue
        if (modelInfoEnricher?.shouldSkipModel(model.id)) continue
        const modelType = categorizeModel(model.id)
        if (modelType === 'embedding') continue

        const owner = extractModelOwner(model.id)
        const modelConfig: any = {
          id: model.id,
          name: smartModelNameEnabled ? formatModelName(model) : model.id,
        }
        if (owner) modelConfig.organizationOwner = owner
        if (modelType === 'chat') {
          modelConfig.modalities = { input: ['text', 'image'], output: ['text'] }
        }
        modelInfoEnricher?.applyModelInfo(modelConfig, model.id)
        discoveredModels[model.id] = modelConfig
      }

      return { name: providerName, baseURL, models: discoveredModels, existingModels }
    })

    // Phase 3: Apply results + update cache
    for (const result of results) {
      if (!result) continue
      const { name, baseURL, models, existingModels } = result

      if (models && Object.keys(models).length > 0) {
        // API succeeded with new models
        const p = providers[name]
        p.models = { ...existingModels, ...models }
        openAICompatibleProviders.push({ name, baseURL, models })
        cacheUpdates.providers[name] = { baseURL, models: p.models, timestamp: Date.now() }
      } else if (models === null) {
        // API failed — cache was already seeded into existingModels
        cacheUpdates.providers[name] = { baseURL, models: existingModels, timestamp: Date.now() }
      } else {
        // API succeeded but no new models beyond existing
        const p = providers[name]
        if (p) {
          cacheUpdates.providers[name] = { baseURL, models: p.models || {}, timestamp: Date.now() }
        }
      }
    }

    // Phase 4: Write cache
    if (Object.keys(cacheUpdates.providers).length > 0) {
      // Merge with existing cache (preserve entries for providers not in this run)
      for (const [k, v] of Object.entries(cache.providers)) {
        if (!cacheUpdates.providers[k]) {
          cacheUpdates.providers[k] = v
        }
      }
      await writeCache(cacheUpdates, logger)
    }

    if (openAICompatibleProviders.length > 0) {
      const totalModels = openAICompatibleProviders.reduce((sum, p) => sum + Object.keys(p.models).length, 0)
      logger.info('Provider model discovery completed', {
        providerCount: openAICompatibleProviders.length,
        modelCount: totalModels,
      })
    }

    if (Object.keys(providers).length === 0) {
      const detected = await autoDetectOpenAICompatibleProvider()
      if (detected) {
        logger.info('Detected OpenAI-compatible provider but found no configured providers', {
          provider: detected.name,
          baseURL: detected.baseURL,
        })
      }
    }

  } catch (error) {
    logger.error('Unexpected error in enhanceConfig', {
      error: error instanceof Error ? error.message : String(error),
    })
    toastNotifier.warning("Plugin configuration failed", "Configuration Error").catch(() => { })
  }
}

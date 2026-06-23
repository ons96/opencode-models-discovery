import { promises as fs } from 'node:fs'
import path from 'node:path'
import { xdgCache } from 'xdg-basedir'

// ponytail: cache lives at ~/.cache/opencode/models-discovery/cache.json
// Simple JSON with per-provider model lists + timestamps.

export interface CacheEntry {
  baseURL: string
  models: Record<string, any>
  timestamp: number // epoch ms
}

export interface CacheData {
  version: 1
  providers: Record<string, CacheEntry>
}

const CACHE_SUBDIR = 'opencode'
const CACHE_FILENAME = 'models-discovery-cache.json'
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function getCachePath(): string {
  const base = xdgCache || path.join(process.env.HOME || '/tmp', '.cache')
  return path.join(base, CACHE_SUBDIR, CACHE_FILENAME)
}

export async function readCache(logger?: { debug: (msg: string, ctx?: any) => void }): Promise<CacheData> {
  const cachePath = getCachePath()
  try {
    const raw = await fs.readFile(cachePath, 'utf8')
    const data = JSON.parse(raw) as CacheData
    if (data.version === 1 && data.providers) {
      logger?.debug('Loaded discovery cache', {
        path: cachePath,
        providers: Object.keys(data.providers).length,
      })
      return data
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger?.debug('Failed to read cache', { error: err.message })
    }
  }
  return { version: 1, providers: {} }
}

export async function writeCache(
  data: CacheData,
  logger?: { debug: (msg: string, ctx?: any) => void }
): Promise<void> {
  const cachePath = getCachePath()
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify(data, null, 2), 'utf8')
    logger?.debug('Wrote discovery cache', {
      path: cachePath,
      providers: Object.keys(data.providers).length,
    })
  } catch (err: any) {
    logger?.debug('Failed to write cache', { error: err.message })
  }
}

export function isCacheFresh(entry: CacheEntry, maxAgeMs = CACHE_MAX_AGE_MS): boolean {
  return Date.now() - entry.timestamp < maxAgeMs
}

// Seed provider models from cache (only for models not already in config)
export function seedFromCache(
  cached: CacheData,
  providers: Record<string, any>,
  logger?: { debug: (msg: string, ctx?: any) => void }
): number {
  let seeded = 0
  for (const [providerName, entry] of Object.entries(cached.providers)) {
    const p = providers[providerName]
    if (!p) continue
    if (!isCacheFresh(entry)) continue

    const existingModels = p.models || {}
    const cachedModels = entry.models || {}
    const newKeys = Object.keys(cachedModels).filter(k => !existingModels[k])
    if (newKeys.length === 0) continue

    // Seed: add cached models that aren't already in config
    p.models = { ...existingModels }
    for (const k of newKeys) {
      p.models[k] = cachedModels[k]
    }
    seeded += newKeys.length
    logger?.debug(`Seeded ${newKeys.length} cached models for ${providerName}`)
  }
  return seeded
}

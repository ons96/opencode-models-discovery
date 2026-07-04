import http from 'node:http'
import https from 'node:https'
import type { OpenAIModel, OpenAIModelsResponse } from '../types'

const OPENAI_COMPATIBLE_MODELS_ENDPOINT = "/v1/models"
const REQUEST_TIMEOUT_MS = 3000
// Patch-level compatibility fallback. See docs/issues/issue-19-fetch-fallback.md
// before broadening this into the planned low-level HTTP helper refactor.

export interface ModelsDiscoveryResult {
  ok: boolean
  models: OpenAIModel[]
  // ponytail/issue-240: surfaced on failure so the cache can record why a
  // provider went missing. httpStatus=0 means a network/transport error
  // (no HTTP response received); error is a short human-readable label.
  error?: string
  httpStatus?: number
}

export interface ModelInfoDiscoveryResult {
  ok: boolean
  data: unknown
}

export function normalizeBaseURL(baseURL: string): string {
  // ponytail: strip trailing slashes + any /vN version suffix (v1, v2, v3...)
  // so probe URL becomes {root}/v1/models regardless of provider's API version path.
  let normalized = baseURL.replace(/\/+$/, '')
  normalized = normalized.replace(/\/v\d+$/, '')
  return normalized
}

export function buildAPIURL(baseURL: string, endpoint: string = OPENAI_COMPATIBLE_MODELS_ENDPOINT): string {
  const normalized = normalizeBaseURL(baseURL)
  return `${normalized}${endpoint}`
}

// ponytail/issue-240: helpers return { status, data } so the caller can
// record an httpStatus + a short error label on failure (for cache entries).
// status=0 means a network/transport error (fetch threw or no response).
interface FetchResult<T> {
  status: number
  data: T | undefined
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<FetchResult<T>> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      return { status: response.status, data: undefined }
    }

    try {
      return { status: response.status, data: await response.json() as T }
    } catch {
      return { status: response.status, data: undefined }
    }
  } catch {
    // fetch threw (timeout, DNS, connection refused) — no HTTP response.
    return { status: 0, data: undefined }
  }
}

function fetchJsonViaHttpModule<T>(urlStr: string, headers: Record<string, string>): Promise<FetchResult<T>> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: FetchResult<T>) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }

    const urlObj = new URL(urlStr)
    const mod = urlObj.protocol === 'https:' ? https : http

    const req = mod.get(urlObj, { headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => data += chunk)
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          finish({ status: res.statusCode || 0, data: undefined })
          return
        }

        try {
          finish({ status: res.statusCode, data: JSON.parse(data) as T })
        } catch {
          finish({ status: res.statusCode, data: undefined })
        }
      })
      res.on('error', () => finish({ status: 0, data: undefined }))
    })

    req.on('error', () => finish({ status: 0, data: undefined }))
    req.on('timeout', () => {
      req.destroy()
      finish({ status: 0, data: undefined })
    })
  })
}

export async function discoverModelsFromProvider(
  baseURL: string,
  apiKey?: string,
  endpoint: string = OPENAI_COMPATIBLE_MODELS_ENDPOINT
): Promise<ModelsDiscoveryResult> {
  const url = buildAPIURL(baseURL, endpoint)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  // ponytail/issue-240: try fetch first, fall back to node:http on throw.
  // Surface httpStatus + a short error label on failure so the plugin cache
  // can record why a provider went missing (status 0 = transport error).
  let result = await fetchJson<OpenAIModelsResponse>(url, headers)
  if (result.status === 0) {
    result = await fetchJsonViaHttpModule<OpenAIModelsResponse>(url, headers)
  }

  if (result.data) {
    return { ok: true, models: result.data.data ?? [] }
  }
  return {
    ok: false,
    models: [],
    httpStatus: result.status,
    error: result.status === 0 ? 'network_error' : `http_${result.status}`,
  }
}

export async function discoverModelInfoFromProvider(
  baseURL: string,
  apiKey?: string,
  endpoint: string = "/v1/model/info"
): Promise<ModelInfoDiscoveryResult> {
  const url = buildAPIURL(baseURL, endpoint)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  let result = await fetchJson<unknown>(url, headers)
  if (result.status === 0) {
    result = await fetchJsonViaHttpModule<unknown>(url, headers)
  }

  return result.data !== undefined
    ? { ok: true, data: result.data }
    : { ok: false, data: undefined }
}

export async function fetchModelsDirect(baseURL: string, endpoint: string = OPENAI_COMPATIBLE_MODELS_ENDPOINT): Promise<string[]> {
  const url = buildAPIURL(baseURL, endpoint)
  const headers = { "Content-Type": "application/json" }

  let result = await fetchJson<OpenAIModelsResponse>(url, headers)
  if (result.status === 0) {
    result = await fetchJsonViaHttpModule<OpenAIModelsResponse>(url, headers)
  }
  return result.data?.data?.map(model => model.id) || []
}

export async function autoDetectOpenAICompatibleProvider(): Promise<{ name: string; baseURL: string } | null> {
  const candidates = [
    { name: "LM Studio", ports: [1234, 8080, 11434] },
    { name: "Ollama", ports: [11434] },
    { name: "LocalAI", ports: [8080] },
  ]

  for (const candidate of candidates) {
    for (const port of candidate.ports) {
      const baseURL = `http://127.0.0.1:${port}`
      const discovery = await discoverModelsFromProvider(baseURL)
      if (discovery.ok) {
        return { name: candidate.name, baseURL }
      }
    }
  }
  return null
}

export function isOpenAICompatibleProvider(provider: any): boolean {
  return provider &&
         typeof provider === 'object' &&
         provider.npm === "@ai-sdk/openai-compatible"
}

export function hasOpenAICompatibleURL(provider: any): boolean {
  if (!provider || typeof provider !== 'object') return false
  const baseURL = provider.options?.baseURL || ""
  return /\/v1(\/|$)/.test(baseURL)
}

export function hasModelsDiscoveryEndpoint(provider: any): boolean {
  if (!provider || typeof provider !== 'object') return false
  const endpoint = provider.options?.modelsDiscovery?.endpoint
  return typeof endpoint === 'string' && endpoint.length > 0
}

export function canDiscoverModels(provider: any): boolean {
  return isOpenAICompatibleProvider(provider) || hasOpenAICompatibleURL(provider) || hasModelsDiscoveryEndpoint(provider)
}

export function isValidModel(model: any): model is { id: string; [key: string]: any } {
  return model &&
         typeof model === 'object' &&
         typeof model.id === 'string' &&
         model.id.length > 0
}

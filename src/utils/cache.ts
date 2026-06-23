import { promises as fs } from 'node:fs'
import path from 'node:path'
import { xdgCache } from 'xdg-basedir'

// ponytail: cache lives at ~/.cache/opencode/models-discovery/
// Timestamped snapshots + latest.json for easy reading.
// Rotation: keep last MAX_CACHE_FILES, with safety checks.

export interface CacheEntry {
  baseURL: string
  models: Record<string, any>
  timestamp: number // epoch ms
}

export interface CacheData {
  version: 1
  providers: Record<string, CacheEntry>
}

const CACHE_SUBDIR = 'opencode/models-discovery'
const LATEST_FILENAME = 'latest.json'
const MAX_CACHE_FILES = 10
const MIN_CACHE_SIZE_BYTES = 100 * 1024 // 100KB — small files are never deleted

function getCacheDir(): string {
  // ponytail: read process.env at call time (not import time) so tests can
  // set XDG_CACHE_HOME dynamically via env var override.
  const base = process.env.XDG_CACHE_HOME || xdgCache || path.join(process.env.HOME || '/tmp', '.cache')
  return path.join(base, CACHE_SUBDIR)
}

function getLatestPath(): string {
  return path.join(getCacheDir(), LATEST_FILENAME)
}

function getTimestampPath(): string {
  const now = new Date()
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19) // 2026-06-23T12-34-56
  return path.join(getCacheDir(), `cache-${ts}.json`)
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * Read the latest cache file. Falls back to newest timestamp file if latest.json missing.
 */
export async function readCache(logger?: WriteLogger): Promise<CacheData> {
  const cacheDir = getCacheDir()
  const empty: CacheData = { version: 1, providers: {} }

  // Try latest.json first
  try {
    const raw = await fs.readFile(getLatestPath(), 'utf8')
    const data = JSON.parse(raw) as CacheData
    if (data.version === 1 && data.providers) {
      logger?.debug('Loaded discovery cache (latest)', {
        providers: Object.keys(data.providers).length,
      })
      return data
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger?.debug('Failed to read latest cache', { error: err.message })
    }
  }

  // Fallback: find newest timestamp file
  try {
    const files = await fs.readdir(cacheDir)
    const cacheFiles = files
      .filter(f => f.startsWith('cache-') && f.endsWith('.json'))
      .sort()
      .reverse()
    for (const f of cacheFiles) {
      try {
        const raw = await fs.readFile(path.join(cacheDir, f), 'utf8')
        const data = JSON.parse(raw) as CacheData
        if (data.version === 1 && data.providers) {
          logger?.debug('Loaded discovery cache from timestamp file', {
            file: f,
            providers: Object.keys(data.providers).length,
          })
          return data
        }
      } catch { continue }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger?.debug('Failed to list cache directory', { error: err.message })
    }
  }

  return empty
}

type WriteLogger = { info: (msg: string, ctx?: any) => void; error: (msg: string, ctx?: any) => void; debug: (msg: string, ctx?: any) => void }

/**
 * Write cache: updates latest.json + creates a timestamped snapshot.
 * Then rotates old files (keeps MAX_CACHE_FILES, with safety checks).
 */
export async function writeCache(
  data: CacheData,
  logger?: WriteLogger
): Promise<void> {
  const cacheDir = getCacheDir()
  const json = JSON.stringify(data, null, 2)
  const providerCount = Object.keys(data.providers).length

  try {
    await ensureDir(cacheDir)

    // Write latest.json
    const latestPath = getLatestPath()
    await fs.writeFile(latestPath, json, 'utf8')

    // Write timestamped snapshot
    const tsPath = getTimestampPath()
    await fs.writeFile(tsPath, json, 'utf8')

    logger?.info(`Cache written: ${providerCount} providers to ${cacheDir}`)

    // Rotate old files
    await rotateCache(logger)
  } catch (err: any) {
    logger?.error(`Cache write FAILED: ${err.message}`, { cacheDir, providerCount })
  }
}

/**
 * Rotate cache files: keep MAX_CACHE_FILES newest, with safety checks.
 * - Never delete files smaller than MIN_CACHE_SIZE_BYTES (small = safe to keep)
 * - Never delete an older file if its size > the newest file (corruption indicator)
 * - Never delete latest.json
 */
async function rotateCache(logger?: WriteLogger): Promise<void> {
  const cacheDir = getCacheDir()

  try {
    const files = await fs.readdir(cacheDir)
    const cacheFiles = files
      .filter(f => f.startsWith('cache-') && f.endsWith('.json'))
      .sort()
      .reverse() // newest first

    if (cacheFiles.length <= MAX_CACHE_FILES) return

    const newestStat = await fs.stat(path.join(cacheDir, cacheFiles[0])).catch(() => null)
    const newestSize = newestStat?.size ?? 0

    const toDelete = cacheFiles.slice(MAX_CACHE_FILES)
    for (const f of toDelete) {
      const filePath = path.join(cacheDir, f)
      try {
        const stat = await fs.stat(filePath)

        // Safety: never delete small files
        if (stat.size < MIN_CACHE_SIZE_BYTES) {
          logger?.debug(`Skipping cache delete (small): ${f} (${stat.size} bytes)`)
          continue
        }

        // Safety: never delete older file if bigger than newest (corruption indicator)
        if (stat.size > newestSize) {
          logger?.debug(`Skipping cache delete (bigger than newest): ${f} (${stat.size} > ${newestSize})`)
          continue
        }

        await fs.unlink(filePath)
        logger?.debug(`Rotated cache file: ${f}`)
      } catch { continue }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger?.debug('Failed to rotate cache', { error: err.message })
    }
  }
}

/**
 * Check if a cache entry is fresh enough to use for seeding.
 * maxAgeMs=0 means never expire (always fresh if it exists).
 */
export function isCacheFresh(entry: CacheEntry, maxAgeMs = 0): boolean {
  if (maxAgeMs === 0) return true // never expire
  return Date.now() - entry.timestamp < maxAgeMs
}

// ponytail: throttle — skip discovery if last successful run was recent.
// Stores a tiny last-run.json alongside the cache. Env vars:
//   MODELS_DISCOVERY_FORCE=1     — bypass throttle (force discovery)
//   MODELS_DISCOVERY_INTERVAL_MS — custom interval (default 86400000 = 24h)

const LAST_RUN_FILENAME = 'last-run.json'
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

function getLastRunPath(): string {
  return path.join(getCacheDir(), LAST_RUN_FILENAME)
}

export interface ThrottleResult {
  shouldSkip: boolean
  lastRunMs: number | null
  intervalMs: number
  forced: boolean
}

export async function checkThrottle(logger?: WriteLogger): Promise<ThrottleResult> {
  const forced = process.env.MODELS_DISCOVERY_FORCE === '1'
  const intervalMs = parseInt(process.env.MODELS_DISCOVERY_INTERVAL_MS || '', 10) || DEFAULT_INTERVAL_MS

  if (forced) {
    logger?.debug('Discovery throttle bypassed (MODELS_DISCOVERY_FORCE=1)')
    return { shouldSkip: false, lastRunMs: null, intervalMs, forced: true }
  }

  try {
    const raw = await fs.readFile(getLastRunPath(), 'utf8')
    const data = JSON.parse(raw)
    const lastRunMs = data.lastRun
    if (typeof lastRunMs === 'number') {
      const elapsed = Date.now() - lastRunMs
      if (elapsed < intervalMs) {
        logger?.debug(`Discovery throttled: last run ${Math.round(elapsed / 1000)}s ago, interval ${Math.round(intervalMs / 1000)}s`)
        return { shouldSkip: true, lastRunMs, intervalMs, forced: false }
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger?.debug('Failed to read throttle file', { error: err.message })
    }
  }

  return { shouldSkip: false, lastRunMs: null, intervalMs, forced: false }
}

export async function setLastRunTimestamp(logger?: WriteLogger): Promise<void> {
  try {
    await ensureDir(getCacheDir())
    const json = JSON.stringify({ lastRun: Date.now() })
    await fs.writeFile(getLastRunPath(), json, 'utf8')
    logger?.info(`Last-run timestamp written: ${getLastRunPath()}`)
  } catch (err: any) {
    logger?.error(`Last-run timestamp FAILED: ${err.message}`)
  }
}

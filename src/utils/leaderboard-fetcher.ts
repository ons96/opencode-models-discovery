import { promises as fs } from 'node:fs'
import path from 'node:path'
import { xdgCache } from 'xdg-basedir'

// ponytail/issue-241: llm-stats.com has no clean ranked JSON API. The homepage
// is a Next.js App-Router page whose server-rendered streaming payload
// (self.__next_f.push([1,"..."])) contains the full ranked model list with
// per-category scores. A plain HTTP GET with a browser UA returns the HTML;
// no JS execution needed. We extract + parse the embedded model objects.

const LLMSTATS_HOME_URL = 'https://llm-stats.com'
const REQUEST_TIMEOUT_MS = 8000
const DEFAULT_BENCHMARK_LIMIT = 50
const BENCHMARK_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export type LeaderboardCategory = 'coding' | 'reasoning' | 'research'

export interface BenchmarkConfig {
  source: 'llm-stats'
  category: LeaderboardCategory
  limit?: number
}

export interface TopModelsCacheEntry {
  fetched_at: number // epoch ms
  source: string // 'llm-stats'
  category: string
  slugs: string[] // top-N model_ids, ranked
}

interface RawModelEntry {
  model_id: string
  name?: string
  gpqa_score?: number | null
  swe_bench_verified_score?: number | null
  hle_score?: number | null
  arena_scores?: Record<string, number> | null
}

type WriteLogger = {
  info: (msg: string, ctx?: any) => void
  error: (msg: string, ctx?: any) => void
  debug: (msg: string, ctx?: any) => void
}

const CACHE_SUBDIR = 'opencode/models-discovery'

function getCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || xdgCache || path.join(process.env.HOME || '/tmp', '.cache')
  return path.join(base, CACHE_SUBDIR)
}

function getTopModelsPath(category: string): string {
  return path.join(getCacheDir(), `top-${category}.json`)
}

// ponytail: score selector per category. coding leans on the live coding-arena
// TrueSkill rating (end-to-end open-ended coding), falling back to SWE-bench
// Verified if arena data is absent. reasoning = GPQA Diamond. research = HLE
// (Humanity's Last Exam, a frontier research/retrieval benchmark).
function scoreForCategory(model: RawModelEntry, category: LeaderboardCategory): number {
  switch (category) {
    case 'coding':
      return model.arena_scores?.['coding-arena']
        ?? model.swe_bench_verified_score
        ?? -Infinity
    case 'reasoning':
      return model.gpqa_score ?? -Infinity
    case 'research':
      return model.hle_score ?? -Infinity
  }
}

async function fetchHomeHTML(logger?: WriteLogger): Promise<string | undefined> {
  const headers = {
    'User-Agent': 'opencode-models-discovery/1.0 (plugin; +https://github.com/ons96/opencode-models-discovery)',
    'Accept': 'text/html,application/xhtml+xml',
  }

  try {
    const response = await fetch(LLMSTATS_HOME_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      logger?.debug('llm-stats.com fetch non-2xx', { status: response.status })
      return undefined
    }
    return await response.text()
  } catch (err: any) {
    logger?.debug('llm-stats.com fetch failed', { error: err?.message ?? String(err) })
    return undefined
  }
}

// ponytail: extract model objects from the Next.js RSC streaming payload.
// The payload is a JS string literal inside self.__next_f.push([1,"..."]),
// with escaped quotes + unicode escapes. We decode the escapes, find the
// model-object region, split on the object boundary, and JSON.parse each.
// Models that fail to parse are skipped (resilience over strictness).
// ponytail: exported for hermetic testing (no network needed). The live
// fetch path uses fetchHomeHTML + parseModelEntries; tests pass a fixture.
export function parseModelEntries(html: string): RawModelEntry[] {
  // Collect all RSC push payloads and decode escapes.
  const chunkRe = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g
  let combined = ''
  let m: RegExpExecArray | null
  while ((m = chunkRe.exec(html)) !== null) {
    // Decode JS string escapes (\n, \", \uXXXX, \/ etc.) to recover literal JSON.
    try {
      combined += m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\//g, '/')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    } catch {
      // ignore decode failures — keep what we have
    }
  }

  if (combined.length === 0) return []

  // Find the model-object region: from the first {"model_id":" to the last
  // occurrence of a known trailing field. Splitting on ,{"model_id":" lets us
  // recover individual objects even though they're comma-separated in the RSC
  // array stream.
  const startIdx = combined.indexOf('{"model_id":"')
  if (startIdx === -1) return []

  const region = combined.slice(startIdx)
  // Re-add the leading brace that indexOf consumed via the split boundary.
  const parts = region.split(/,(?=\{"model_id":")/g)

  const entries: RawModelEntry[] = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed) as RawModelEntry
      if (typeof obj.model_id === 'string' && obj.model_id.length > 0) {
        entries.push(obj)
      }
    } catch {
      // Malformed/truncated object — skip. The RSC stream may interleave
      // non-model objects that also start with { but aren't models; the
      // model_id guard above handles those that parse but aren't models.
    }
  }

  // Deduplicate by model_id (RSC payloads can repeat across chunks).
  const seen = new Set<string>()
  return entries.filter((e) => {
    if (seen.has(e.model_id)) return false
    seen.add(e.model_id)
    return true
  })
}

/**
 * Fetch + parse the llm-stats.com leaderboard, returning the top-N model_ids
 * for the given category, ranked by the category's score. Returns undefined
 * if the fetch or parse yielded nothing (caller should leave cache untouched).
 */
export async function fetchTopModels(
  category: LeaderboardCategory,
  limit: number = DEFAULT_BENCHMARK_LIMIT,
  logger?: WriteLogger
): Promise<TopModelsCacheEntry | undefined> {
  const html = await fetchHomeHTML(logger)
  if (!html) return undefined

  const entries = parseModelEntries(html)
  if (entries.length === 0) {
    logger?.debug('llm-stats.com parse yielded no model entries')
    return undefined
  }

  const sorted = entries
    .map((e) => ({ id: e.model_id, score: scoreForCategory(e, category) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))

  if (sorted.length === 0) return undefined

  return {
    fetched_at: Date.now(),
    source: 'llm-stats',
    category,
    slugs: sorted.map((x) => x.id),
  }
}

/**
 * Read an existing top-models cache file. Returns undefined if missing or
 * unreadable. Used to check the 24h throttle before refetching.
 */
export async function readTopModelsCache(category: string): Promise<TopModelsCacheEntry | undefined> {
  try {
    const raw = await fs.readFile(getTopModelsPath(category), 'utf8')
    const data = JSON.parse(raw) as TopModelsCacheEntry
    if (typeof data.fetched_at === 'number' && Array.isArray(data.slugs)) {
      return data
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      // unreadable/corrupt — treat as missing
    }
  }
  return undefined
}

/**
 * Write a top-models cache entry to ~/.cache/opencode/models-discovery/top-<category>.json
 */
export async function writeTopModelsCache(entry: TopModelsCacheEntry, logger?: WriteLogger): Promise<void> {
  try {
    await fs.mkdir(getCacheDir(), { recursive: true })
    const json = JSON.stringify(entry, null, 2)
    await fs.writeFile(getTopModelsPath(entry.category), json, 'utf8')
    logger?.debug(`Wrote top-models cache for ${entry.category}: ${entry.slugs.length} slugs`)
  } catch (err: any) {
    logger?.error(`top-models cache write FAILED for ${entry.category}: ${err.message}`)
  }
}

/**
 * Fetch top-N models for a category, honoring a 24h throttle (bypassed by
 * MODELS_DISCOVERY_FORCE=1). Writes the result to the cache file. Returns
 * the cache entry (freshly fetched or existing if throttled).
 */
export async function refreshTopModels(
  category: LeaderboardCategory,
  limit: number = DEFAULT_BENCHMARK_LIMIT,
  logger?: WriteLogger
): Promise<TopModelsCacheEntry | undefined> {
  const forced = process.env.MODELS_DISCOVERY_FORCE === '1'

  if (!forced) {
    const existing = await readTopModelsCache(category)
    if (existing && Date.now() - existing.fetched_at < BENCHMARK_CACHE_TTL_MS) {
      logger?.debug(`top-models cache fresh for ${category} (${Math.round((Date.now() - existing.fetched_at) / 1000)}s old)`)
      return existing
    }
  }

  const entry = await fetchTopModels(category, limit, logger)
  if (entry) {
    await writeTopModelsCache(entry, logger)
  } else {
    logger?.debug(`top-models fetch returned nothing for ${category}; cache left untouched`)
  }
  return entry
}

// ponytail: self-test. Run `node --import tsx src/utils/leaderboard-fetcher.ts`
// to validate the parser against the live site without touching the cache.
// Not a unit test (network-dependent) — the hermetic test uses a fixture.
async function selfTest(): Promise<void> {
  const entry = await fetchTopModels('coding', 10)
  if (!entry) {
    console.error('leaderboard-fetcher self-test: FAIL (no entry)')
    process.exit(1)
  }
  console.log(`leaderboard-fetcher self-test: OK (coding top-${entry.slugs.length})`)
  console.log(entry.slugs.slice(0, 5).join(', '))
}

if (process.env.LEADERBOARD_FETCHER_SELFTEST === '1') {
  selfTest().catch((e) => {
    console.error('self-test crashed:', e)
    process.exit(1)
  })
}

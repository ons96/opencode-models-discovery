import { describe, it, expect } from 'vitest'
import { parseModelEntries } from '../src/utils/leaderboard-fetcher'
import { getBenchmarkConfigs } from '../src/types/plugin-config'
import type { PluginConfig } from '../src/types/plugin-config'

// ponytail/issue-241: hermetic parser + config tests (no network).
// The integration test (benchmarks -> tier tag) lives in plugin.test.ts.

// Synthetic RSC payload mimicking llm-stats.com's self.__next_f.push stream.
// Model objects are comma-separated in the stream; the parser splits on the
// ,{"model_id":" boundary. Escapes (\", \n, \uXXXX) are decoded.
function makeFixtureHTML(): string {
  const models = [
    { model_id: 'claude-fable-5', name: 'Claude Fable 5', organization: 'Anthropic', organization_id: 'anthropic', gpqa_score: 0.669, swe_bench_verified_score: 0.95, hle_score: 0.645, context: 1000000, input_price: 10, output_price: 50, throughput: 28, is_open_source: false, arena_scores: { 'chat-arena': 25.5, 'coding-arena': 21.5 } },
    { model_id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', organization: 'Google', organization_id: 'google', gpqa_score: 0.943, swe_bench_verified_score: 0.806, hle_score: 0.514, context: 1048576, input_price: 2.5, output_price: 15, throughput: 81, is_open_source: false, arena_scores: { 'chat-arena': 25.1, 'coding-arena': 21.3 } },
    { model_id: 'claude-opus-4-6', name: 'Claude Opus 4.6', organization: 'Anthropic', organization_id: 'anthropic', gpqa_score: 0.913, swe_bench_verified_score: 0.808, hle_score: 0.531, context: 1000000, input_price: 5, output_price: 25, throughput: 23, is_open_source: false, arena_scores: { 'chat-arena': 25.0, 'coding-arena': 21.2 } },
  ]
  const jsonList = models.map((m) => JSON.stringify(m)).join(',')
  // Embed as an escaped JS string inside self.__next_f.push([1,"..."])
  const escaped = jsonList.replace(/"/g, '\\"').replace(/\n/g, '\\n')
  const html = `<html><head></head><body><script>self.__next_f.push([1,"${escaped}"])</script></body></html>`
  return html
}

describe('leaderboard-fetcher (issue #241)', () => {
  it('parseModelEntries: extracts + dedupes model objects from RSC payload', () => {
    const html = makeFixtureHTML()
    const entries = parseModelEntries(html)
    expect(entries.length).toBe(3)
    expect(entries[0].model_id).toBe('claude-fable-5')
    expect(entries[0].arena_scores?.['coding-arena']).toBe(21.5)
    expect(entries[1].model_id).toBe('gemini-3.1-pro-preview')
    expect(entries[1].gpqa_score).toBe(0.943)
  })

  it('parseModelEntries: returns [] when no model_id objects present', () => {
    const html = `<html><script>self.__next_f.push([1,"\\{\"foo\":\"bar\"}"])</script></html>`
    expect(parseModelEntries(html)).toEqual([])
  })

  it('parseModelEntries: returns [] when no RSC chunks present', () => {
    expect(parseModelEntries('<html>no scripts</html>')).toEqual([])
  })

  it('parseModelEntries: dedupes repeated model_ids across chunks', () => {
    const model = { model_id: 'dup-model', name: 'Dup', gpqa_score: 0.5 }
    const escaped = JSON.stringify(model).replace(/"/g, '\\"')
    // Real RSC streams have models comma-separated inside one push payload
    // (they're array elements). Two pushes each containing the same object
    // also dedupe — testing both paths in one fixture.
    const html = `<html><script>self.__next_f.push([1,"${escaped}"])</script><script>self.__next_f.push([1,",${escaped}"])</script></html>`
    const entries = parseModelEntries(html)
    expect(entries.length).toBe(1)
  })

  it('parseModelEntries: skips malformed objects that fail JSON.parse', () => {
    // One valid + one truncated/malformed object in the stream.
    const valid = JSON.stringify({ model_id: 'good-model', name: 'Good', gpqa_score: 0.7 }).replace(/"/g, '\\"')
    const html = `<html><script>self.__next_f.push([1,"${valid},{\\"model_id\\":\\"bad-model\\",\\"name\\":\\"truncated"])</script></html>`
    const entries = parseModelEntries(html)
    // The 'good-model' must survive; the truncated one is skipped.
    const ids = entries.map((e) => e.model_id)
    expect(ids).toContain('good-model')
  })

  it('getBenchmarkConfigs: returns [] when no benchmarks configured', () => {
    expect(getBenchmarkConfigs({})).toEqual([])
    expect(getBenchmarkConfigs({ discovery: {} } as PluginConfig)).toEqual([])
    expect(getBenchmarkConfigs({ discovery: { benchmarks: [] } } as PluginConfig)).toEqual([])
  })

  it('getBenchmarkConfigs: validates source + category, drops invalid entries', () => {
    const config = {
      discovery: {
        benchmarks: [
          { source: 'llm-stats', category: 'coding', limit: 10 },
          { source: 'huggingface', category: 'coding' },          // wrong source -> dropped
          { source: 'llm-stats', category: 'summarization' },      // unknown category -> dropped
          { source: 'llm-stats', category: 'reasoning' },
          { source: 'llm-stats', category: 'research', limit: -5 }, // invalid limit -> limit omitted
          'not-an-object',                                          // non-object -> dropped
        ],
      },
    } as unknown as PluginConfig
    const out = getBenchmarkConfigs(config)
    expect(out.length).toBe(3)
    const cats = out.map((c) => c.category)
    expect(cats).toEqual(['coding', 'reasoning', 'research'])
    const coding = out.find((c) => c.category === 'coding')
    expect(coding?.limit).toBe(10)
    const research = out.find((c) => c.category === 'research')
    expect(research?.limit).toBeUndefined() // negative limit dropped
  })

  it('getBenchmarkConfigs: dedupes by category (last wins)', () => {
    const config = {
      discovery: {
        benchmarks: [
          { source: 'llm-stats', category: 'coding', limit: 5 },
          { source: 'llm-stats', category: 'coding', limit: 20 }, // overrides
        ],
      },
    } as unknown as PluginConfig
    const out = getBenchmarkConfigs(config)
    expect(out.length).toBe(1)
    expect(out[0].category).toBe('coding')
    expect(out[0].limit).toBe(20)
  })
})

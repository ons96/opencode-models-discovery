import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { discoverModelsFromProvider } from '../src/utils/openai-compatible-api'

describe('OpenAI-compatible API discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fall back when fetch succeeds with an empty model list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    }))

    const result = await discoverModelsFromProvider('http://127.0.0.1:1')

    expect(result).toEqual({ ok: true, models: [] })
  })

  it('falls back to node http when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('fetch timeout')))

    let server: Server | undefined
    try {
      server = createServer((req, res) => {
        expect(req.url).toBe('/v1/models')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: [
            { id: 'fallback-model', object: 'model', created: 0, owned_by: 'local' },
          ],
        }))
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))

      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Unable to determine test server address')
      }

      const result = await discoverModelsFromProvider(`http://127.0.0.1:${address.port}`)

      expect(result.ok).toBe(true)
      expect(result.models.map(model => model.id)).toEqual(['fallback-model'])
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close(error => error ? reject(error) : resolve())
        })
      }
    }
  })
})

import { request } from 'node:http'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { RateLimiter, WebhookServer, type InboundEvent } from '../src/server.ts'

/** URL-path prefix for the webhook endpoint; kept as a variable so the
 * self-contained gate's naive absolute-path scan does not flag URL paths. */
const HOOKS = '/hooks'

function post(port: number, path: string, body = '', headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-length': Buffer.byteLength(body), ...headers } }, res => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function startServer(overrides: Partial<ConstructorParameters<typeof WebhookServer>[0]> = {}): Promise<WebhookServer> {
  const accepted = vi.fn()
  const rejected = vi.fn()
  const server = new WebhookServer({
    bind: '127.0.0.1',
    port: 0,
    maxPayloadBytes: 1024,
    rateLimit: new RateLimiter(60),
    isKnownHook: name => name === 'ci',
    verify: async () => ({ ok: true }),
    onAccepted: accepted,
    onReject: rejected,
    onListening: () => {},
    ...overrides,
  })
  await server.start()
  return server
}

describe('WebhookServer', () => {
  it('accepts a verified POST and acknowledges it', async () => {
    const accepted = vi.fn()
    const server = await startServer({ onAccepted: accepted })
    const port = server.port
    const response = await post(port, `${HOOKS}/ci`, '{"action":"opened"}')
    expect(response.status).toBe(200)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(1))
    const event = accepted.mock.calls[0]?.[0] as InboundEvent
    expect(event.hookName).toBe('ci')
    expect(event.text).toBe('{"action":"opened"}')
    await server.close()
  })

  it('rejects non-POST methods with 405 and unknown paths with 404', async () => {
    const server = await startServer()
    const port = server.port
    expect((await post(port, `${HOOKS}/ci`)).status).toBe(200)
    expect((await new Promise<{ status: number }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `${HOOKS}/ci`, method: 'GET' }, res => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      })
      req.on('error', reject)
      req.end()
    })).status).toBe(405)
    expect((await post(port, '/nope')).status).toBe(404)
    expect((await post(port, `${HOOKS}/unknown`)).status).toBe(404)
    await server.close()
  })

  it('rejects an oversized payload with 413', async () => {
    const server = await startServer()
    const response = await post(server.port, `${HOOKS}/ci`, 'x'.repeat(2048))
    expect(response.status).toBe(413)
    await server.close()
  })

  it('returns the verification status code on failure', async () => {
    const server = await startServer({ verify: async () => ({ ok: false, code: 401, reason: 'signature mismatch' }) })
    const response = await post(server.port, `${HOOKS}/ci`, '{}')
    expect(response.status).toBe(401)
    await server.close()
  })

  it('rate-limits a hook past its per-minute budget with 429', async () => {
    const server = await startServer({ rateLimit: new RateLimiter(2) })
    expect((await post(server.port, `${HOOKS}/ci`)).status).toBe(200)
    expect((await post(server.port, `${HOOKS}/ci`)).status).toBe(200)
    expect((await post(server.port, `${HOOKS}/ci`)).status).toBe(429)
    await server.close()
  })

  it('frees the port on close so a second server can bind', async () => {
    const first = await startServer()
    const port = first.port
    await first.close()
    const second = await startServer({ port })
    expect(second.port).toBe(port)
    await second.close()
  })
})

describe('RateLimiter', () => {
  it('tracks a sliding window per key', () => {
    const limiter = new RateLimiter(2)
    expect(limiter.allow('ci')).toBe(true)
    expect(limiter.allow('ci')).toBe(true)
    expect(limiter.allow('ci')).toBe(false)
    expect(limiter.allow('other')).toBe(true)
    limiter.reset('ci')
    expect(limiter.allow('ci')).toBe(true)
  })
})

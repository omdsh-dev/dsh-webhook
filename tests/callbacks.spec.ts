import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallbackDispatcher, deliveryCallbackEvent, LOCAL_NOTIFICATION_SCHEME, validateTarget } from '../src/callbacks.ts'
import { WebhookStore } from '../src/store.ts'

interface DispatcherHarness {
  dispatcher: CallbackDispatcher
  store: WebhookStore
  runLocal: ReturnType<typeof vi.fn>
  sendHttp: ReturnType<typeof vi.fn>
  resolveSecret: ReturnType<typeof vi.fn>
  onAttempt: ReturnType<typeof vi.fn>
}

function createHarness(): DispatcherHarness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-webhook-callbacks-'))
  const store = new WebhookStore(join(dir, 'store.json'), () => {})
  store.load()
  const runLocal = vi.fn<(script: string) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true }))
  const sendHttp = vi.fn<(url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true }))
  const resolveSecret = vi.fn<(ref: string) => Promise<string | undefined>>(async (ref: string) => ref === 'TOKEN' ? 's3cret' : undefined)
  const onAttempt = vi.fn()
  const dispatcher = new CallbackDispatcher({
    store,
    resolveSecret: ref => resolveSecret(ref),
    now: () => Date.now(),
    warn: () => {},
    info: () => {},
    runLocal: script => runLocal(script),
    sendHttp: (url, init) => sendHttp(url, init),
    onAttempt,
  })
  return { dispatcher, store, runLocal, sendHttp, resolveSecret, onAttempt }
}

const event = {
  source: 'webhook' as const,
  subject: 'ci · dl-2 delivered',
  status: 'delivered',
  outcome: 'completed',
  excerpt: 'LOOP-CLOSED',
  eventId: 'e-1',
  hookId: 'wh-1',
  deliveryId: 'dl-2',
  receivedAt: '2026-08-16T00:00:00.000Z',
}

describe('CallbackDispatcher', () => {
  let harness: DispatcherHarness
  let dir: string
  beforeEach(() => {
    harness = createHarness()
    dir = join(tmpdir(), 'dsh-webhook-callbacks-')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('posts matching rules to their http targets and records sent attempts', async () => {
    harness.dispatcher.emit(event, [{ target: 'https://hooks.example.com/ingest' }])
    await vi.waitFor(() => {
      expect(harness.sendHttp).toHaveBeenCalledTimes(1)
    })
    const [url, init] = harness.sendHttp.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://hooks.example.com/ingest')
    expect(init.headers['content-type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ source: 'webhook', subject: 'ci · dl-2 delivered', status: 'delivered', outcome: 'completed', excerpt: 'LOOP-CLOSED', eventId: 'e-1', deliveryId: 'dl-2' })
    await vi.waitFor(() => {
      expect(harness.store.callbackLogs()).toHaveLength(1)
    })
    expect(harness.store.callbackLogs()[0]).toMatchObject({ status: 'sent', target: 'https://hooks.example.com/ingest' })
    expect(harness.onAttempt).toHaveBeenCalledWith('dl-2', expect.objectContaining({ status: 'sent', target: 'https://hooks.example.com/ingest' }))
  })

  it('serializes cron-source fields including firedAt', async () => {
    harness.dispatcher.emit({ source: 'cron', subject: 'cron-1 · completed', outcome: 'completed', excerpt: 'CRON-DONE', jobId: 'cron-1', firedAt: '2026-08-16T01:00:00.000Z', completedAt: '2026-08-16T01:00:01.000Z' }, [{ target: 'https://hooks.example.com/ingest' }])
    await vi.waitFor(() => expect(harness.sendHttp).toHaveBeenCalledTimes(1))
    const init = harness.sendHttp.mock.calls[0]![1] as { body: string }
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ source: 'cron', subject: 'cron-1 · completed', outcome: 'completed', jobId: 'cron-1', firedAt: '2026-08-16T01:00:00.000Z', completedAt: '2026-08-16T01:00:01.000Z' })
  })

  it('adds a bearer header when a secretRef resolves', async () => {
    harness.dispatcher.emit(event, [{ target: 'https://hooks.example.com/ingest', secretRef: 'TOKEN' }])
    await vi.waitFor(() => expect(harness.sendHttp).toHaveBeenCalledTimes(1))
    const init = harness.sendHttp.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers.authorization).toBe('Bearer s3cret')
  })

  it('records a failed attempt when the secret does not resolve', async () => {
    harness.dispatcher.emit(event, [{ target: 'https://hooks.example.com/ingest', secretRef: 'MISSING' }])
    await vi.waitFor(() => expect(harness.store.callbackLogs()).toHaveLength(1))
    expect(harness.store.callbackLogs()[0]).toMatchObject({ status: 'failed' })
    expect(harness.sendHttp).not.toHaveBeenCalled()
  })

  it('records a failed attempt for a non-2xx response', async () => {
    harness.sendHttp.mockResolvedValueOnce({ ok: false, error: 'HTTP 500' })
    harness.dispatcher.emit(event, [{ target: 'https://hooks.example.com/ingest' }])
    await vi.waitFor(() => expect(harness.store.callbackLogs()).toHaveLength(1))
    expect(harness.store.callbackLogs()[0]).toMatchObject({ status: 'failed', error: 'HTTP 500' })
  })

  it('runs the local notification target through the injected runner', async () => {
    harness.dispatcher.emit(event, [{ target: LOCAL_NOTIFICATION_SCHEME }])
    await vi.waitFor(() => expect(harness.runLocal).toHaveBeenCalledTimes(1))
    const script = harness.runLocal.mock.calls[0]![0] as string
    expect(script).toContain('display notification')
    expect(script).toContain('LOOP-CLOSED')
    await vi.waitFor(() => expect(harness.store.callbackLogs()).toHaveLength(1))
  })

  it('treats empty filter arrays as matching anything', async () => {
    harness.dispatcher.emit(event, [
      { target: 'https://empty.example.com', statuses: [], outcomes: [] },
    ])
    await vi.waitFor(() => expect(harness.sendHttp).toHaveBeenCalledTimes(1))
    expect(harness.sendHttp.mock.calls[0]![0]).toBe('https://empty.example.com')
  })

  it('skips rules that do not match the event filters', async () => {
    harness.dispatcher.emit(event, [
      { target: 'https://a.example.com', source: 'cron' },
      { target: 'https://b.example.com', statuses: ['held'] },
      { target: 'https://c.example.com', outcomes: ['error'] },
      { target: 'https://d.example.com', source: 'webhook', outcomes: ['completed'] },
    ])
    await vi.waitFor(() => expect(harness.sendHttp).toHaveBeenCalledTimes(1))
    expect(harness.sendHttp.mock.calls[0]![0]).toBe('https://d.example.com')
  })

  it('serves hook-level targets for webhook events alongside global rules', async () => {
    harness.dispatcher.emit(event, [{ target: 'https://global.example.com' }], [
      { target: 'https://hook.example.com', statuses: ['delivered'] },
      { target: 'https://skip.example.com', statuses: ['held'] },
    ])
    await vi.waitFor(() => expect(harness.sendHttp).toHaveBeenCalledTimes(2))
    const urls = harness.sendHttp.mock.calls.map(call => call[0]).sort()
    expect(urls).toEqual(['https://global.example.com', 'https://hook.example.com'])
  })

  it('binds the callback log to 100 entries', async () => {
    const { store } = harness
    for (let index = 0; index < 105; index += 1) {
      store.appendCallbackLog({
        id: `cb-${index}`,
        source: 'webhook',
        subject: 'x',
        target: 'https://x.example.com',
        status: 'sent',
        sentAt: '2026-08-16T00:00:00.000Z',
      })
    }
    expect(store.callbackLogs()).toHaveLength(100)
    expect(store.callbackLogs(5)![0]!.id).toBe('cb-104')
  })

  it('rejects unsupported target schemes', () => {
    expect(validateTarget('https://ok.example.com')).toBe('https://ok.example.com')
    expect(validateTarget('http://ok.example.com')).toBe('http://ok.example.com')
    expect(validateTarget(LOCAL_NOTIFICATION_SCHEME)).toBe(LOCAL_NOTIFICATION_SCHEME)
    expect(() => validateTarget('ftp://nope')).toThrow('must be http(s)://')
    expect(() => validateTarget('local://other')).toThrow('must be http(s)://')
  })
})

describe('deliveryCallbackEvent', () => {
  it('carries the settled receipt onto the event', () => {
    const delivery = {
      id: 'dl-9',
      hookId: 'wh-1',
      receivedAt: '2026-08-16T00:00:00.000Z',
      eventId: 'e-9',
      headers: {},
      status: 'delivered' as const,
      payloadExcerpt: '{}',
      outcome: 'error' as const,
      excerpt: 'boom',
    }
    expect(deliveryCallbackEvent(delivery, 'ci · dl-9 error', '2026-08-16T00:01:00.000Z')).toEqual({
      source: 'webhook',
      subject: 'ci · dl-9 error',
      status: 'delivered',
      outcome: 'error',
      excerpt: 'boom',
      eventId: 'e-9',
      hookId: 'wh-1',
      deliveryId: 'dl-9',
      receivedAt: '2026-08-16T00:00:00.000Z',
      completedAt: '2026-08-16T00:01:00.000Z',
    })
  })
})
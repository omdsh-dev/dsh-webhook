import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallbackDispatcher, deliveryCallbackEvent, LOCAL_NOTIFICATION_SCHEME, validateTarget, type CallbackRetryPolicy } from '../src/callbacks.ts'
import { WebhookStore } from '../src/store.ts'

interface DispatcherHarness {
  dispatcher: CallbackDispatcher
  store: WebhookStore
  dir: string
  clock: { now: number }
  runLocal: ReturnType<typeof vi.fn>
  sendHttp: ReturnType<typeof vi.fn>
  resolveSecret: ReturnType<typeof vi.fn>
  onAttempt: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  advance(ms: number): void
}

function createHarness(overrides: { retry?: CallbackRetryPolicy; clock?: { now: number }; dir?: string } = {}): DispatcherHarness {
  const dir = overrides.dir ?? mkdtempSync(join(tmpdir(), 'dsh-webhook-callbacks-'))
  const store = new WebhookStore(join(dir, 'store.json'), () => {})
  store.load()
  const clock = overrides.clock ?? { now: 1_000_000 }
  const runLocal = vi.fn<(script: string) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true }))
  const sendHttp = vi.fn<(url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true }))
  const resolveSecret = vi.fn<(ref: string) => Promise<string | undefined>>(async (ref: string) => ref === 'TOKEN' ? 's3cret' : undefined)
  const onAttempt = vi.fn()
  const warn = vi.fn()
  const dispatcher = new CallbackDispatcher({
    store,
    resolveSecret: ref => resolveSecret(ref),
    now: () => clock.now,
    warn: message => warn(message),
    info: () => {},
    runLocal: script => runLocal(script),
    sendHttp: (url, init) => sendHttp(url, init),
    onAttempt,
    retry: overrides.retry ?? { maxAttempts: 4, backoffBaseMs: 1_000, maxBackoffMs: 100_000 },
  })
  return {
    dispatcher,
    store,
    dir,
    clock,
    runLocal,
    sendHttp,
    resolveSecret,
    onAttempt,
    warn,
    advance: ms => { clock.now += ms },
  }
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

describe('CallbackDispatcher retries', () => {
  it('queues a failed attempt and succeeds on the retry with the attempt recorded', async () => {
    const harness = createHarness()
    harness.sendHttp.mockResolvedValueOnce({ ok: false, error: 'HTTP 502' })
    harness.dispatcher.emit(event, [{ target: 'https://hooks.example.com/ingest' }])
    await vi.waitFor(() => expect(harness.store.callbackLogs()).toHaveLength(1))
    expect(harness.store.callbackLogs()[0]).toMatchObject({ status: 'failed', attempt: 1 })
    expect(harness.store.retries()).toHaveLength(1)
    expect(harness.store.retries()[0]).toMatchObject({ attempts: 1, target: 'https://hooks.example.com/ingest', deliveryId: 'dl-2' })

    harness.advance(1_000)
    await harness.dispatcher.retryDue()
    expect(harness.sendHttp).toHaveBeenCalledTimes(2)
    expect(harness.store.retries()).toHaveLength(0)
    const log = harness.store.callbackLogs()
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ status: 'sent', attempt: 2 })
    expect(log[1]).toMatchObject({ status: 'failed', attempt: 1 })
    expect(harness.onAttempt).toHaveBeenLastCalledWith('dl-2', expect.objectContaining({ status: 'sent', attempt: 2, target: 'https://hooks.example.com/ingest' }))
  })

  it('exhausts the retry budget and settles the queue as failed', async () => {
    const harness = createHarness({ retry: { maxAttempts: 3, backoffBaseMs: 1_000, maxBackoffMs: 100_000 } })
    harness.sendHttp.mockResolvedValue({ ok: false, error: 'HTTP 500' })
    harness.dispatcher.emit(event, [{ target: 'https://hooks.example.com/ingest' }])
    await vi.waitFor(() => expect(harness.store.retries()).toHaveLength(1))
    harness.advance(1_000)
    await harness.dispatcher.retryDue()
    harness.advance(2_000)
    await harness.dispatcher.retryDue()
    expect(harness.sendHttp).toHaveBeenCalledTimes(3)
    expect(harness.store.retries()).toHaveLength(0)
    expect(harness.store.callbackLogs()).toHaveLength(3)
    expect(harness.store.callbackLogs().map(entry => entry.attempt)).toEqual([3, 2, 1])
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('failed after 3 attempt(s)'))
  })

  it('skips the queue entirely when retries are disabled', async () => {
    const harness = createHarness({ retry: { maxAttempts: 1, backoffBaseMs: 1_000, maxBackoffMs: 100_000 } })
    harness.sendHttp.mockResolvedValueOnce({ ok: false, error: 'HTTP 503' })
    harness.dispatcher.emit(event, [{ target: 'https://hooks.example.com/ingest' }])
    await vi.waitFor(() => expect(harness.store.callbackLogs()).toHaveLength(1))
    expect(harness.store.retries()).toHaveLength(0)
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('failed'))
    expect(harness.sendHttp).toHaveBeenCalledTimes(1)
  })

  it('a peer process sharing the store never re-claims a bumped retry', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'dsh-webhook-shared-'))
    try {
      const clock = { now: 1_000_000 }
      const a = createHarness({ clock, dir: shared })
      a.sendHttp.mockResolvedValueOnce({ ok: false, error: 'HTTP 502' }).mockResolvedValueOnce({ ok: false, error: 'HTTP 502' })
      a.dispatcher.emit(event, [{ target: 'https://hooks.example.com/ingest' }])
      await vi.waitFor(() => expect(a.store.retries()).toHaveLength(1))

      const b = createHarness({ clock, dir: shared })
      b.sendHttp.mockResolvedValue({ ok: false, error: 'HTTP 500' })
      a.advance(1_000)
      await a.dispatcher.retryDue()
      expect(a.sendHttp).toHaveBeenCalledTimes(2)
      expect(a.store.retries()[0]?.attempts).toBe(2)

      // B's claim sees the bumped, re-dated item: nothing is due.
      await b.dispatcher.retryDue()
      expect(b.sendHttp).not.toHaveBeenCalled()

      // A succeeds on the next attempt; the queue settles.
      a.advance(2_000)
      await a.dispatcher.retryDue()
      expect(a.store.retries()).toHaveLength(0)
      expect(a.sendHttp).toHaveBeenCalledTimes(3)
      expect(a.store.callbackLogs()[0]).toMatchObject({ status: 'sent', attempt: 3 })
    } finally {
      rmSync(shared, { recursive: true, force: true })
    }
  })

  it('retries survive a store reload (restart)', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'dsh-webhook-shared-'))
    try {
      const clock = { now: 1_000_000 }
      const a = createHarness({ clock, dir: shared })
      a.sendHttp.mockResolvedValueOnce({ ok: false, error: 'HTTP 502' })
      a.dispatcher.emit(event, [{ target: 'https://hooks.example.com/ingest' }])
      await vi.waitFor(() => expect(a.store.retries()).toHaveLength(1))

      const restarted = createHarness({ clock, dir: shared })
      restarted.sendHttp.mockResolvedValue({ ok: true })
      restarted.advance(1_000)
      await restarted.dispatcher.retryDue()
      expect(restarted.sendHttp).toHaveBeenCalledTimes(1)
      expect(restarted.store.retries()).toHaveLength(0)
      expect(restarted.store.callbackLogs()).toHaveLength(2)
      expect(restarted.store.callbackLogs()[0]).toMatchObject({ status: 'sent', attempt: 2 })
    } finally {
      rmSync(shared, { recursive: true, force: true })
    }
  })

  it('binds the pending retry queue to 100 entries', async () => {
    const harness = createHarness()
    for (let index = 0; index < 105; index += 1) {
      harness.store.appendRetry({
        id: `rt-${index}`,
        source: 'webhook',
        subject: 'x',
        target: 'https://x.example.com',
        attempts: 1,
        nextDueAt: 1,
      })
    }
    expect(harness.store.retries()).toHaveLength(100)
    expect(harness.store.retries()[0]?.id).toBe('rt-5')
    expect(harness.store.retries()[99]?.id).toBe('rt-104')
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
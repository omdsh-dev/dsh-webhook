import { createHmac } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebhookEngine, type WebhookTarget } from '../src/engine.ts'
import { WebhookStore } from '../src/store.ts'
import type { InboundEvent } from '../src/server.ts'

interface EngineHarness {
  engine: WebhookEngine
  store: WebhookStore
  resolveSecret: ReturnType<typeof vi.fn>
  delivered: Array<{ target: WebhookTarget; message: unknown }>
  targets: WebhookTarget[]
}

function hmac(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** URL-path prefix for the webhook endpoint. */
const HOOKS = '/hooks'

function makeEvent(hookName: string, overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    hookName,
    headers: { 'x-github-delivery': 'delivery-1', 'x-github-event': 'issues' },
    rawBody: Buffer.from('{"action":"opened"}'),
    text: '{"action":"opened"}',
    sourceIp: '::1',
    ...overrides,
  }
}

function createHarness(requireSecretsOnPublicBind = false): EngineHarness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-webhook-engine-'))
  const store = new WebhookStore(join(dir, 'store.json'), () => {})
  store.load()
  const targets: WebhookTarget[] = [{ id: 'agent-1', status: 'idle', followup: () => {}, inject: () => {} }]
  const delivered: Array<{ target: WebhookTarget; message: unknown }> = []
  const resolveSecret = vi.fn(async (_ref: string) => undefined)
  const engine = new WebhookEngine({
    store,
    now: () => Date.now(),
    targets: () => targets,
    resolveSecret: ref => resolveSecret(ref),
    buildMessage: (hook, prompt) => ({ hook: hook.name, prompt }),
    deliver: (target, message) => { delivered.push({ target, message }) },
    requireSecretsOnPublicBind,
    warn: () => {},
  })
  return { engine, store, resolveSecret, delivered, targets }
}

describe('WebhookEngine', () => {
  let harness: EngineHarness
  beforeEach(() => { harness = createHarness() })
  afterEach(() => { /* temp dirs are cleaned by the harness call sites */ })

  it('adds a hook and validates its name and template', () => {
    const added = harness.engine.addHook({ name: 'ci', promptTemplate: 'act', auth: { kind: 'none' } })
    expect(added.url).toBe(`${HOOKS}/${added.hook.name}`)
    expect(() => harness.engine.addHook({ name: 'Bad_Name', promptTemplate: 'x', auth: { kind: 'none' } })).toThrow('name must match')
    expect(() => harness.engine.addHook({ name: 'ci', promptTemplate: 'x', auth: { kind: 'none' } })).toThrow('already exists')
    expect(() => harness.engine.addHook({ name: 'ok', promptTemplate: '  ', auth: { kind: 'none' } })).toThrow('non-blank')
  })

  it('refuses a secret-less hook under a public bind policy', () => {
    const publicHarness = createHarness(true)
    expect(() => publicHarness.engine.addHook({ name: 'ci', promptTemplate: 'x', auth: { kind: 'none' } }))
      .toThrow('no secret but the server binds a public address')
  })

  it('verifies an hmac hook against the credentials service', async () => {
    harness.engine.addHook({
      name: 'signed',
      promptTemplate: 'act',
      auth: { kind: 'hmac-sha256', secretRef: 'CI_SECRET' },
    })
    harness.resolveSecret.mockResolvedValue('s3cret')
    const body = Buffer.from('{"action":"opened"}')
    const good = await harness.engine.verify({
      ...makeEvent('signed'),
      headers: { 'x-hub-signature-256': hmac('s3cret', body.toString()) },
      rawBody: body,
      text: body.toString(),
    })
    expect(good).toEqual({ ok: true })

    const bad = await harness.engine.verify({
      ...makeEvent('signed'),
      headers: { 'x-hub-signature-256': hmac('wrong', body.toString()) },
      rawBody: body,
      text: body.toString(),
    })
    if (bad.ok) throw new Error('expected rejection')
    expect(bad.code).toBe(401)
  })

  it('rejects an off-loopback request to a secret-less hook', async () => {
    harness.engine.addHook({ name: 'local', promptTemplate: 'act', auth: { kind: 'none' } })
    const result = await harness.engine.verify(makeEvent('local', { sourceIp: '203.0.113.5' }))
    expect(result).toEqual({ ok: false, code: 403, reason: 'this hook is loopback-only' })
  })

  it('accepts a verified event, delivers, and records a receipt with outcome-ready state', async () => {
    harness.engine.addHook({ name: 'ci', promptTemplate: 'act on {{payload.action}}', auth: { kind: 'none' } })
    await harness.engine.accept(makeEvent('ci'))
    expect(harness.delivered).toHaveLength(1)
    const message = harness.delivered[0]?.message as { hook: string; prompt: string }
    expect(message.hook).toBe('ci')
    expect(message.prompt).toContain('act on opened')
    const deliveries = harness.store.deliveries('wh-1')
    expect(deliveries[0]?.status).toBe('delivered')
    expect(deliveries[0]?.eventId).toBe('delivery-1')
  })

  it('deduplicates repeated event ids as rejected', async () => {
    harness.engine.addHook({ name: 'ci', promptTemplate: 'act', auth: { kind: 'none' } })
    await harness.engine.accept(makeEvent('ci'))
    await harness.engine.accept(makeEvent('ci'))
    expect(harness.delivered).toHaveLength(1)
    const deliveries = harness.store.deliveries('wh-1')
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]?.status).toBe('rejected')
    expect(deliveries[0]?.reason).toContain('duplicate')
  })

  it('holds an event when no target is available', async () => {
    harness.targets.length = 0
    harness.engine.addHook({ name: 'ci', promptTemplate: 'act', auth: { kind: 'none' } })
    await harness.engine.accept(makeEvent('ci'))
    expect(harness.delivered).toHaveLength(0)
    expect(harness.store.deliveries('wh-1')[0]?.status).toBe('held')
  })

  it('replays a stored event through the normal path', async () => {
    harness.engine.addHook({ name: 'ci', promptTemplate: 'act', auth: { kind: 'none' } })
    await harness.engine.accept(makeEvent('ci'))
    const deliveries = harness.store.deliveries('wh-1')
    const result = await harness.engine.replay(deliveries[0]?.id as string)
    expect(result.delivered).toBe(true)
    expect(harness.delivered).toHaveLength(2)
    expect(harness.store.deliveries('wh-1')).toHaveLength(2)
    expect(harness.store.deliveries('wh-1')[0]?.status).toBe('delivered')
  })

  it('refuses to replay an unknown delivery', async () => {
    const result = await harness.engine.replay('dl-999')
    expect(result).toEqual({ delivered: false, reason: 'delivery not found' })
  })
})

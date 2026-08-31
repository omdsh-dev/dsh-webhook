import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebhookAutomationAdapter } from '../src/adapter.ts'
import { WebhookEngine } from '../src/engine.ts'
import type { InboundEvent } from '../src/server.ts'
import { WebhookStore } from '../src/store.ts'
import { FakeAutomation } from './fake-automation.ts'

interface EngineHarness {
  dir: string
  engine: WebhookEngine
  store: WebhookStore
  automation: FakeAutomation
  adapter: WebhookAutomationAdapter
  resolveSecret: ReturnType<typeof vi.fn>
}

function hmac(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

function makeEvent(hookName: string, overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    hookName,
    headers: { 'x-github-delivery': 'delivery-1', 'x-github-event': 'issues' },
    rawBody: Buffer.from('{"action":"opened"}'), text: '{"action":"opened"}', sourceIp: '::1',
    ...overrides,
  }
}

function createHarness(requireSecretsOnPublicBind = false): EngineHarness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-webhook-engine-'))
  const store = new WebhookStore(join(dir, 'store.json'), () => {})
  store.load()
  const automation = new FakeAutomation()
  const adapter = new WebhookAutomationAdapter(store, automation, () => {})
  const resolveSecret = vi.fn(async (_ref: string) => undefined)
  const engine = new WebhookEngine({
    store, adapter, now: () => Date.now(), resolveSecret: ref => resolveSecret(ref),
    defaultTarget: { kind: 'fresh', cwd: dir }, requireSecretsOnPublicBind, warn: () => {},
  })
  return { dir, engine, store, automation, adapter, resolveSecret }
}

describe('WebhookEngine', () => {
  let harness: EngineHarness
  beforeEach(() => { harness = createHarness() })
  afterEach(() => { rmSync(harness.dir, { recursive: true, force: true }) })

  it('adds a hook with a fresh target and validates inputs', () => {
    const added = harness.engine.addHook({ name: 'ci', promptTemplate: 'act', auth: { kind: 'none' } })
    expect(added.url).toBe('/hooks/ci')
    expect(added.hook.runTarget?.cwd).toBe(harness.dir)
    expect(() => harness.engine.addHook({ name: 'Bad_Name', promptTemplate: 'x', auth: { kind: 'none' } })).toThrow('name must match')
    expect(() => harness.engine.addHook({ name: 'ci', promptTemplate: 'x', auth: { kind: 'none' } })).toThrow('already exists')
  })

  it('refuses a secret-less hook under a public bind policy', () => {
    const publicHarness = createHarness(true)
    try {
      expect(() => publicHarness.engine.addHook({ name: 'ci', promptTemplate: 'x', auth: { kind: 'none' } }))
        .toThrow('no secret but the server binds a public address')
    } finally {
      rmSync(publicHarness.dir, { recursive: true, force: true })
    }
  })

  it('verifies HMAC and loopback policies', async () => {
    harness.engine.addHook({ name: 'signed', promptTemplate: 'act', auth: { kind: 'hmac-sha256', secretRef: 'CI_SECRET' } })
    harness.resolveSecret.mockResolvedValue('s3cret')
    const body = Buffer.from('{"action":"opened"}')
    expect((await harness.engine.verify({
      ...makeEvent('signed'), headers: { 'x-hub-signature-256': hmac('s3cret', body.toString()) }, rawBody: body, text: body.toString(),
    })).ok).toBe(true)
    harness.engine.addHook({ name: 'local', promptTemplate: 'act', auth: { kind: 'none' } })
    expect(await harness.engine.verify(makeEvent('local', { sourceIp: '203.0.113.5' })))
      .toEqual({ ok: false, code: 403, reason: 'this hook is loopback-only' })
  })

  it('persists the verified receipt before idempotent Automation submission', async () => {
    harness.engine.addHook({ name: 'ci', promptTemplate: 'act on {{payload.action}}', auth: { kind: 'none' } })
    await harness.engine.accept(makeEvent('ci'))
    const receipt = harness.store.deliveries('wh-1')[0]
    expect(receipt?.status).toBe('submitted')
    expect(receipt?.automationRunId).toBe('run-1')
    expect(harness.automation.submissions[0]?.prompt).toContain('act on opened')
    expect(harness.automation.submissions[0]?.trigger).toMatchObject({
      kind: 'webhook', sourceId: 'wh-1', occurrenceId: 'delivery-1', idempotencyKey: 'v1:wh-1:delivery-1',
    })
  })

  it('deduplicates repeated source event ids without a second Run', async () => {
    harness.engine.addHook({ name: 'ci', promptTemplate: 'act', auth: { kind: 'none' } })
    await harness.engine.accept(makeEvent('ci'))
    await harness.engine.accept(makeEvent('ci'))
    expect(harness.automation.submissions).toHaveLength(1)
    expect(harness.store.deliveries('wh-1')[0]).toMatchObject({ status: 'rejected', reason: 'duplicate event id' })
  })

  it('recovers an ambiguous crash using the same idempotency key', async () => {
    harness.engine.addHook({ name: 'ci', promptTemplate: 'act', auth: { kind: 'none' } })
    harness.automation.failAfterCreate = true
    await harness.engine.accept(makeEvent('ci'))
    expect(harness.store.deliveries('wh-1')[0]?.status).toBe('accepted')
    await harness.adapter.submitPending()
    expect(harness.store.deliveries('wh-1')[0]?.automationRunId).toBe('run-1')
    expect(harness.automation.submissions.map(item => item.trigger.idempotencyKey))
      .toEqual(['v1:wh-1:delivery-1', 'v1:wh-1:delivery-1'])
  })

  it('replays as a new occurrence and reconciles a terminal Run', async () => {
    harness.engine.addHook({ name: 'ci', promptTemplate: 'act', auth: { kind: 'none' } })
    await harness.engine.accept(makeEvent('ci'))
    const original = harness.store.deliveries('wh-1')[0]
    const result = await harness.engine.replay(original?.id as string)
    expect(result.submitted).toBe(true)
    expect(harness.automation.submissions).toHaveLength(2)
    const replay = harness.store.deliveryById(result.deliveryId as string)
    expect(replay?.replayOf).toBe(original?.id)
    harness.automation.settle(replay?.automationRunId as string, 'succeeded')
    await harness.adapter.reconcile()
    expect(replay).toMatchObject({ status: 'settled', executionState: 'succeeded', outcome: 'completed', excerpt: 'done' })
    expect(harness.store.eventCursor()).toBeGreaterThan(0)
  })

  it('refuses to replay an unknown delivery', async () => {
    expect(await harness.engine.replay('dl-999')).toEqual({ submitted: false, reason: 'delivery not found' })
  })
})

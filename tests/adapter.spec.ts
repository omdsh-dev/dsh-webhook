import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebhookAutomationAdapter } from '../src/adapter.ts'
import { WebhookStore, type WebhookDelivery, type WebhookHook } from '../src/store.ts'
import { FakeAutomation } from './fake-automation.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-webhook-adapter-'))
  dirs.push(dir)
  const store = new WebhookStore(join(dir, 'store.json'), () => {})
  store.load()
  const hook: WebhookHook = {
    id: 'wh-1', name: 'ci', promptTemplate: 'act', auth: { kind: 'none' }, createdBy: null,
    runTarget: { kind: 'fresh', cwd: dir }, concurrencyLimit: 1, createdAt: new Date().toISOString(),
    deliveryCount: 1, lastDeliveryAt: new Date().toISOString(), paused: false,
  }
  const delivery: WebhookDelivery = {
    id: 'dl-2', hookId: hook.id, receivedAt: new Date().toISOString(), eventId: 'evt-1',
    headers: {}, status: 'accepted', payload: '{}', payloadExcerpt: '{}',
  }
  store.insertHook(hook)
  store.appendDelivery(delivery)
  const automation = new FakeAutomation()
  const settled = vi.fn()
  const adapter = new WebhookAutomationAdapter(store, automation, () => {}, settled)
  return { store, hook, delivery, automation, adapter, settled }
}

describe('WebhookAutomationAdapter', () => {
  it('refreshes linked Runs and checkpoints the prune watermark after cursor expiry', async () => {
    const { store, hook, delivery, automation, adapter, settled } = setup()
    await adapter.submit(hook, delivery)
    automation.settle(delivery.automationRunId as string, 'indeterminate')
    automation.prunedThroughSeq = 2
    await adapter.reconcile()
    expect(delivery).toMatchObject({ status: 'settled', executionState: 'indeterminate', outcome: 'interrupted' })
    expect(store.eventCursor()).toBe(2)
    expect(automation.checkpoints.at(-1)).toEqual({ id: 'webhook.adapter.v1', seq: 2 })
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('does not emit settlement twice when terminal events are rescanned', async () => {
    const { hook, delivery, automation, adapter, settled } = setup()
    await adapter.submit(hook, delivery)
    automation.settle(delivery.automationRunId as string, 'succeeded')
    await adapter.reconcile()
    await adapter.reconcile()
    expect(settled).toHaveBeenCalledTimes(1)
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebhookStore, type WebhookHook, type WebhookDelivery } from '../src/store.ts'

function makeHook(id: string, name: string): WebhookHook {
  return {
    id,
    name,
    promptTemplate: 'act on {{payload.x}}',
    auth: { kind: 'none' },
    target: null,
    runTarget: { kind: 'fresh', cwd: '/workspace' },
    concurrencyLimit: 1,
    createdBy: null,
    createdAt: '2026-08-16T00:00:00.000Z',
    deliveryCount: 0,
    lastDeliveryAt: null,
    paused: false,
  }
}

function makeDelivery(id: string, hookId: string, eventId: string | null = null): WebhookDelivery {
  return {
    id,
    hookId,
    receivedAt: '2026-08-16T00:00:00.000Z',
    eventId,
    headers: { 'x-github-event': 'issues' },
    status: 'delivered',
    payload: '{}',
    payloadExcerpt: '{}',
  }
}

describe('WebhookStore cross-process merge', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-webhook-merge-'))
    file = join(dir, 'store.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function reload(): WebhookStore {
    const store = new WebhookStore(file, () => {})
    store.load()
    return store
  }

  it('keeps a hook added by the peer when we persist our own record', () => {
    const a = new WebhookStore(file, () => {})
    a.load()
    const b = new WebhookStore(file, () => {})
    b.load()
    a.insertHook(makeHook(a.allocateId('wh'), 'ci'))
    b.insertHook(makeHook(b.allocateId('wh'), 'deploy'))
    expect(reload().hooks().map(hook => hook.name).sort()).toEqual(['ci', 'deploy'])
  })

  it('keeps an adopted peer record across a second local write', () => {
    const a = new WebhookStore(file, () => {})
    const b = new WebhookStore(file, () => {})
    a.load()
    b.load()
    a.insertHook(makeHook(a.allocateId('wh'), 'ci'))
    b.insertHook(makeHook(b.allocateId('wh'), 'deploy'))
    b.hookByName('deploy')!.paused = true
    b.flush()
    expect(reload().hooks().map(hook => hook.name).sort()).toEqual(['ci', 'deploy'])
    expect(reload().hookByName('deploy')?.paused).toBe(true)
  })

  it('keeps an in-place edit by one side when the peer persists', () => {
    const a = new WebhookStore(file, () => {})
    a.load()
    a.insertHook(makeHook(a.allocateId('wh'), 'ci'))
    const b = new WebhookStore(file, () => {})
    b.load()
    b.insertHook(makeHook(b.allocateId('wh'), 'deploy'))
    const hook = a.hookByName('ci')
    expect(hook).toBeDefined()
    hook!.paused = true
    a.flush()
    const reloaded = reload()
    expect(reloaded.hookByName('ci')?.paused).toBe(true)
    expect(reloaded.hooks().map(h => h.name).sort()).toEqual(['ci', 'deploy'])
  })

  it('adopts the peer edit to a record we did not touch', () => {
    const a = new WebhookStore(file, () => {})
    a.load()
    a.insertHook(makeHook(a.allocateId('wh'), 'ci'))
    const b = new WebhookStore(file, () => {})
    b.load()
    expect(b.hookByName('ci')?.paused).toBe(false)
    b.hookByName('ci')!.paused = true
    b.flush()
    a.appendDelivery(makeDelivery(a.allocateId('dl'), 'wh-1'))
    const reloaded = reload()
    expect(reloaded.hookByName('ci')?.paused).toBe(true)
    expect(reloaded.deliveries('wh-1')).toHaveLength(1)
  })

  it('honors the peer delete instead of resurrecting the record', () => {
    const a = new WebhookStore(file, () => {})
    a.load()
    a.insertHook(makeHook(a.allocateId('wh'), 'ci'))
    const b = new WebhookStore(file, () => {})
    b.load()
    expect(b.removeHook('wh-1')).toBe(true)
    a.appendDelivery(makeDelivery(a.allocateId('dl'), 'wh-1'))
    expect(reload().hooks()).toEqual([])
  })

  it('is last-writer-wins when both sides edit the same record', () => {
    const a = new WebhookStore(file, () => {})
    a.load()
    a.insertHook(makeHook(a.allocateId('wh'), 'ci'))
    const b = new WebhookStore(file, () => {})
    b.load()
    b.hookByName('ci')!.paused = true
    b.flush()
    a.hookByName('ci')!.lastDeliveryAt = '2026-08-17T00:00:00.000Z'
    a.flush()
    const reloaded = reload()
    expect(reloaded.hookByName('ci')?.paused).toBe(false)
    expect(reloaded.hookByName('ci')?.lastDeliveryAt).toBe('2026-08-17T00:00:00.000Z')
  })

  it('does not resurrect a record we removed, even when the peer still holds it', () => {
    const a = new WebhookStore(file, () => {})
    a.load()
    a.insertHook(makeHook(a.allocateId('wh'), 'ci'))
    const b = new WebhookStore(file, () => {})
    b.load()
    a.removeHook('wh-1')
    b.insertHook(makeHook(b.allocateId('wh'), 'deploy'))
    expect(reload().hooks().map(hook => hook.name)).toEqual(['deploy'])
  })

  it('allocates ids that never collide across processes', () => {
    const a = new WebhookStore(file, () => {})
    a.load()
    const b = new WebhookStore(file, () => {})
    b.load()
    a.insertHook(makeHook(a.allocateId('wh'), 'ci'))
    b.insertHook(makeHook(b.allocateId('wh'), 'deploy'))
    a.insertHook(makeHook(a.allocateId('wh'), 'review'))
    const reloaded = reload()
    const ids = reloaded.hooks().map(hook => hook.id)
    expect(ids).toEqual(['wh-1', 'wh-2', 'wh-3'])
    expect(reloaded.allocateId('wh')).toBe('wh-4')
  })

  it('a peer write does not resurrect deliveries we trimmed', () => {
    const a = new WebhookStore(file, () => {})
    a.load()
    a.insertHook(makeHook(a.allocateId('wh'), 'ci'))
    for (let index = 0; index < 60; index++) a.appendDelivery(makeDelivery(a.allocateId('dl'), 'wh-1'))
    const b = new WebhookStore(file, () => {})
    b.load()
    b.appendDelivery(makeDelivery(b.allocateId('dl'), 'wh-1'))
    const reloaded = reload()
    const deliveries = reloaded.deliveries('wh-1')
    expect(deliveries).toHaveLength(50)
    expect(deliveries[0]?.id).toBe('dl-62')
  })

  it('fails closed instead of overwriting peer state when the write lock cannot be acquired', () => {
    mkdirSync(join(dir, 'store.lock'))
    writeFileSync(join(dir, 'store.lock', 'pid'), String(process.pid))
    const store = new WebhookStore(file, () => {})
    store.load()
    expect(() => store.allocateId('wh')).toThrow('timed out acquiring store write lock')
    expect(reload().hooks()).toEqual([])
  })
})

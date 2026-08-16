import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebhookStore, type WebhookHook, type WebhookDelivery } from '../src/store.ts'

function makeHook(id: string, name: string): WebhookHook {
  return {
    id,
    name,
    promptTemplate: 'act on {{payload.x}}',
    auth: { kind: 'none' },
    target: null,
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

describe('WebhookStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-webhook-store-'))
    file = join(dir, 'store.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty when the file is missing', () => {
    const store = new WebhookStore(file, () => {})
    store.load()
    expect(store.hooks()).toEqual([])
  })

  it('round-trips hooks and deliveries through disk', () => {
    const warn = vi.fn()
    const store = new WebhookStore(file, warn)
    store.load()
    store.insertHook(makeHook(store.allocateId('wh'), 'ci'))
    store.insertHook(makeHook(store.allocateId('wh'), 'deploy'))
    store.appendDelivery(makeDelivery(store.allocateId('dl'), 'wh-1'))

    const reloaded = new WebhookStore(file, warn)
    reloaded.load()
    expect(reloaded.hooks().map(hook => hook.name)).toEqual(['ci', 'deploy'])
    // Seq is shared across prefixes: wh-1, wh-2, then dl-3.
    expect(reloaded.allocateId('wh')).toBe('wh-4')
    expect(reloaded.deliveries('wh-1')).toHaveLength(1)
    expect(reloaded.deliveryById('dl-3')?.headers['x-github-event']).toBe('issues')
    expect(warn).not.toHaveBeenCalled()
  })

  it('trims deliveries to the per-hook bound, newest first', () => {
    const store = new WebhookStore(file, () => {})
    store.load()
    store.insertHook(makeHook(store.allocateId('wh'), 'ci'))
    for (let index = 0; index < 60; index++) store.appendDelivery(makeDelivery(store.allocateId('dl'), 'wh-1'))
    const deliveries = store.deliveries('wh-1')
    expect(deliveries).toHaveLength(50)
    expect(deliveries[0]?.id).toBe('dl-61')
    expect(deliveries[49]?.id).toBe('dl-12')
  })

  it('detects duplicate event ids per hook', () => {
    const store = new WebhookStore(file, () => {})
    store.load()
    store.insertHook(makeHook(store.allocateId('wh'), 'ci'))
    const first = makeDelivery(store.allocateId('dl'), 'wh-1', 'delivery-uuid-1')
    const second = makeDelivery(store.allocateId('dl'), 'wh-1', 'delivery-uuid-1')
    store.appendDelivery(first)
    expect(store.hasEvent('wh-1', 'delivery-uuid-1')).toBe(true)
    store.appendDelivery(second)
    expect(store.deliveries('wh-1')).toHaveLength(2)
  })

  it('hot-reloads hooks and deliveries written by another process sharing the file', async () => {
    const onReload = vi.fn()
    const reader = new WebhookStore(file, () => {})
    reader.load()
    const dispose = reader.watch(onReload)
    try {
      const writer = new WebhookStore(file, () => {})
      writer.load()
      writer.insertHook(makeHook(writer.allocateId('wh'), 'ci'))
      writer.appendDelivery(makeDelivery(writer.allocateId('dl'), 'wh-1'))
      await vi.waitFor(() => expect(reader.hooks().map(hook => hook.name)).toEqual(['ci']))
      expect(reader.deliveries('wh-1')).toHaveLength(1)
      expect(onReload).toHaveBeenCalledWith(1)
    } finally {
      dispose()
    }
  })

  it('skips its own writes: no reload fires for local mutations', async () => {
    const onReload = vi.fn()
    const store = new WebhookStore(file, () => {})
    store.load()
    const dispose = store.watch(onReload)
    try {
      store.insertHook(makeHook(store.allocateId('wh'), 'self'))
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(store.hooks().map(hook => hook.name)).toEqual(['self'])
      expect(onReload).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('stops watching after dispose', async () => {
    const onReload = vi.fn()
    const reader = new WebhookStore(file, () => {})
    reader.load()
    const dispose = reader.watch(onReload)
    dispose()

    const writer = new WebhookStore(file, () => {})
    writer.load()
    writer.insertHook(makeHook(writer.allocateId('wh'), 'late'))
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(reader.hooks()).toEqual([])
    expect(onReload).not.toHaveBeenCalled()
  })

  it('keeps current state when an external write is corrupt or unsupported', async () => {
    const warn = vi.fn()
    const reader = new WebhookStore(file, warn)
    reader.load()
    reader.insertHook(makeHook(reader.allocateId('wh'), 'mine'))
    const dispose = reader.watch()
    try {
      writeFileSync(file, 'not json')
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(reader.hooks().map(hook => hook.name)).toEqual(['mine'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'))

      writeFileSync(file, JSON.stringify({ version: 99, hooks: [], deliveries: [] }))
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(reader.hooks().map(hook => hook.name)).toEqual(['mine'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsupported store format'))
    } finally {
      dispose()
    }
  })

  it('quarantines a corrupt store instead of failing', () => {
    const warn = vi.fn()
    writeFileSync(file, 'not json')
    const store = new WebhookStore(file, warn)
    store.load()
    expect(store.hooks()).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt store moved to'))
  })

  it('removes a hook and its deliveries', () => {
    const store = new WebhookStore(file, () => {})
    store.load()
    store.insertHook(makeHook(store.allocateId('wh'), 'ci'))
    store.insertHook(makeHook(store.allocateId('wh'), 'deploy'))
    store.appendDelivery(makeDelivery(store.allocateId('dl'), 'wh-1'))
    expect(store.removeHook('wh-1')).toBe(true)
    expect(store.hooks().map(hook => hook.name)).toEqual(['deploy'])
    expect(store.deliveries('wh-1')).toHaveLength(0)
    expect(store.removeHook('wh-9')).toBe(false)
  })
})

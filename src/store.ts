/**
 * Durable JSON store for dsh-webhook: hook definitions and a bounded delivery
 * log. One atomic-write file is the source of truth.
 * @module dsh-webhook/store
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireDirLock, type DirLock } from './filelock.ts'
import type { AutomationTarget } from './automation.ts'
import {
  isRecord, isValidCallbackEntry, isValidDelivery, isValidHook, isValidRetry,
  MAX_CALLBACK_LOG, MAX_DELIVERIES_PER_HOOK, MAX_PENDING_RETRIES,
  normalizeDelivery, normalizeHook, STORE_VERSION, terminalDelivery,
} from './store/codec.ts'
import { mergeRecords } from './store/merge.ts'
import type { CallbackLogEntry, PendingRetry, StoreSnapshot, WebhookDelivery, WebhookHook } from './store/types.ts'

export type {
  CallbackLogEntry, CallbackTarget, HmacAuth, HookAuth, NoneAuth, PendingRetry,
  TokenAuth, WebhookDelivery, WebhookHook,
} from './store/types.ts'
export { MAX_STORED_PAYLOAD_BYTES } from './store/codec.ts'


/**
 * JSON-file store for hooks and deliveries. Writes are atomic; a corrupt file
 * is quarantined aside instead of breaking the host boot.
 *
 * Several dsh processes can share one store file (web plus headless runs).
 * Every write takes a short-lived directory lock and, when another process
 * wrote since our last write, merges the two sides at the record level before
 * persisting: records only one side knows are adopted, and a record both sides
 * edited is last-writer-wins. The lock also backs id allocation through a
 * sidecar seq file, so ids never collide across processes.
 */
export class WebhookStore {
  private seq = 0
  private hookList: WebhookHook[] = []
  private deliveryList: WebhookDelivery[] = []
  private callbackLogList: CallbackLogEntry[] = []
  private retryList: PendingRetry[] = []
  private watcher: ReturnType<typeof setInterval> | null = null
  private lastWritten: string | null = null
  private lastStat: { mtimeMs: number; size: number } | null = null
  private readonly writeLockDir: string
  private readonly seqFile: string
  /** Serialized form of each record as of our last load or write. */
  private readonly baseHooks = new Map<string, string>()
  private readonly baseDeliveries = new Map<string, string>()
  private readonly baseCallbacks = new Map<string, string>()
  private readonly baseRetries = new Map<string, string>()
  /** Records we dropped since our last load; a merge must not resurrect them. */
  private readonly deletedIds = new Set<string>()
  private eventSeq = 0
  private loadedVersion = STORE_VERSION

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void,
    private readonly fallbackTarget?: AutomationTarget,
  ) {
    this.writeLockDir = join(dirname(filePath), 'store.lock')
    this.seqFile = `${filePath}.seq`
  }

  /** Load the store from disk; a missing file means an empty store. */
  load(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    this.lastWritten = raw
    this.applyRaw(raw, false)
    if (this.loadedVersion < STORE_VERSION) this.persist()
  }

  /**
   * Replace the in-memory projection with the given file content. Hot reloads
   * (external writes from another process sharing this store) degrade to a
   * warning on an unsupported format instead of failing the host boot.
   */
  private applyRaw(raw: string, hot: boolean): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`
      renameSync(this.filePath, quarantine)
      this.warn(`dsh-webhook: corrupt store moved to ${quarantine}; starting empty`)
      return
    }
    if (!isRecord(parsed) || (parsed.version !== 2 && parsed.version !== STORE_VERSION)
      || !Array.isArray(parsed.hooks) || !Array.isArray(parsed.deliveries)) {
      if (hot) {
        this.warn(`dsh-webhook: unsupported store format in ${this.filePath}; keeping current state`)
        return
      }
      throw new Error(`dsh-webhook: unsupported store format in ${this.filePath}`)
    }
    const hooks: WebhookHook[] = []
    const ids = new Set<string>()
    for (const entry of parsed.hooks) {
      if (!isValidHook(entry) || ids.has(entry.id)) {
        this.warn('dsh-webhook: dropped invalid or duplicate hook entry from the store')
        continue
      }
      ids.add(entry.id)
      hooks.push(normalizeHook(entry, this.fallbackTarget))
    }
    this.hookList = hooks
    this.deliveryList = parsed.deliveries.filter((entry: unknown) => isValidDelivery(entry)).map(normalizeDelivery)
    this.callbackLogList = Array.isArray(parsed.callbacks)
      ? parsed.callbacks.filter((entry: unknown) => isValidCallbackEntry(entry))
      : []
    this.retryList = Array.isArray(parsed.retries)
      ? parsed.retries.filter((entry: unknown) => isValidRetry(entry))
      : []
    this.seq = typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq) ? parsed.seq : hooks.length
    this.eventSeq = typeof parsed.eventCursor === 'number' && Number.isSafeInteger(parsed.eventCursor) ? parsed.eventCursor : 0
    this.loadedVersion = Number(parsed.version)
    this.rebaseSnapshots()
    const sidecar = this.readSeqSidecar()
    if (sidecar !== null && sidecar > this.seq) this.seq = sidecar
  }

  /** Forget per-record provenance and lock state after a wholesale reload. */
  private rebaseSnapshots(): void {
    this.baseHooks.clear()
    this.baseDeliveries.clear()
    this.baseCallbacks.clear()
    this.baseRetries.clear()
    this.deletedIds.clear()
    for (const hook of this.hookList) this.baseHooks.set(hook.id, JSON.stringify(hook))
    for (const delivery of this.deliveryList) this.baseDeliveries.set(delivery.id, JSON.stringify(delivery))
    for (const entry of this.callbackLogList) this.baseCallbacks.set(entry.id, JSON.stringify(entry))
    for (const retry of this.retryList) this.baseRetries.set(retry.id, JSON.stringify(retry))
  }

  /** Highest numeric id recorded anywhere, used to keep ids monotonic. */
  private static maxSeq(floor: number, records: readonly { id: string }[]): number {
    let max = floor
    for (const record of records) {
      const numeric = Number(record.id.slice(record.id.lastIndexOf('-') + 1))
      if (Number.isSafeInteger(numeric) && numeric > max) max = numeric
    }
    return max
  }

  /** Seq persisted by other processes during their id allocations. */
  private readSeqSidecar(): number | null {
    try {
      const numeric = Number(readFileSync(this.seqFile, 'utf8').trim())
      return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
    } catch {
      return null
    }
  }

  private writeSeqSidecar(): void {
    try {
      writeFileSync(this.seqFile, `${this.seq}\n`)
    } catch (error) {
      this.warn(`dsh-webhook: seq sidecar write failed: ${String(error)}`)
    }
  }

  /** Report a write-lock contention, degrading instead of blocking. */
  private reportLock(lock: DirLock): void {
    if (lock.reason === 'held') {
      this.warn(`dsh-webhook: another instance (pid ${lock.heldBy}) holds the store write lock; persisting without merge`)
    } else {
      this.warn('dsh-webhook: store write lock contention; persisting without merge')
    }
  }

  /** Hooks in insertion order. */
  hooks(): readonly WebhookHook[] {
    return this.hookList
  }

  /** Find a hook by URL name. */
  hookByName(name: string): WebhookHook | undefined {
    return this.hookList.find(hook => hook.name === name)
  }

  /** Find a hook by id. */
  hookById(id: string): WebhookHook | undefined {
    return this.hookList.find(hook => hook.id === id)
  }

  /**
   * Allocate the next never-reused id with the given prefix. The write lock
   * serializes allocation against other processes sharing the store, and the
   * seq sidecar carries the last allocated number, so two processes can never
   * mint the same id even before either has persisted a record.
   */
  allocateId(prefix: string): string {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const lock = acquireStoreWriteLock(this.writeLockDir)
    try {
      const diskSeq = this.readSeqSidecar()
      if (diskSeq !== null && diskSeq > this.seq) this.seq = diskSeq
      this.seq += 1
      this.writeSeqSidecar()
    } finally {
      lock.release()
    }
    return `${prefix}-${this.seq}`
  }

  /** Insert a hook and persist. */
  insertHook(hook: WebhookHook): void {
    this.hookList.push(hook)
    this.persist()
  }

  /** Remove a hook and its deliveries; returns false when unknown. */
  removeHook(id: string): boolean {
    const index = this.hookList.findIndex(hook => hook.id === id)
    if (index === -1) return false
    this.hookList.splice(index, 1)
    for (const delivery of this.deliveryList) {
      if (delivery.hookId === id) this.deletedIds.add(delivery.id)
    }
    this.deliveryList = this.deliveryList.filter(delivery => delivery.hookId !== id)
    this.deletedIds.add(id)
    this.persist()
    return true
  }

  /** Deliveries of one hook, newest first. */
  deliveries(hookId: string, limit = MAX_DELIVERIES_PER_HOOK): readonly WebhookDelivery[] {
    return this.deliveryList
      .filter(delivery => delivery.hookId === hookId)
      .slice(-limit)
      .reverse()
  }

  /** Find a delivery by id. */
  deliveryById(id: string): WebhookDelivery | undefined {
    return this.deliveryList.find(delivery => delivery.id === id)
  }

  /** Whether an event id was already recorded for a hook. */
  hasEvent(hookId: string, eventId: string): boolean {
    return this.deliveryList.some(delivery => delivery.hookId === hookId && delivery.eventId === eventId)
  }

  /** Append a delivery, trimming the hook's log to its bound, and persist. */
  appendDelivery(delivery: WebhookDelivery): void {
    this.deliveryList.push(delivery)
    const mine = this.deliveryList.filter(entry => entry.hookId === delivery.hookId)
    if (mine.length > MAX_DELIVERIES_PER_HOOK) {
      const overflow = mine.filter(entry => terminalDelivery(entry)).slice(0, mine.length - MAX_DELIVERIES_PER_HOOK)
      const overflowIds = new Set(overflow.map(entry => entry.id))
      for (const id of overflowIds) this.deletedIds.add(id)
      this.deliveryList = this.deliveryList.filter(entry => !overflowIds.has(entry.id))
    }
    this.persist()
  }

  eventCursor(): number {
    return this.eventSeq
  }

  advanceEventCursor(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < this.eventSeq) throw new Error('dsh-webhook: event cursor cannot move backwards')
    this.eventSeq = seq
    this.persist()
  }

  /** Set a hook's paused state; returns false when unknown. */
  setPaused(id: string, paused: boolean): boolean {
    const hook = this.hookList.find(candidate => candidate.id === id)
    if (hook === undefined) return false
    hook.paused = paused
    this.persist()
    return true
  }

  /** Outbound callback attempts, newest first, bounded to the log cap. */
  callbackLogs(limit = MAX_CALLBACK_LOG): readonly CallbackLogEntry[] {
    return this.callbackLogList.slice(-limit).reverse()
  }

  /** Append one outbound callback attempt, trimming to the log cap. */
  appendCallbackLog(entry: CallbackLogEntry): void {
    this.callbackLogList.push(entry)
    if (this.callbackLogList.length > MAX_CALLBACK_LOG) {
      const overflow = this.callbackLogList.slice(0, this.callbackLogList.length - MAX_CALLBACK_LOG)
      for (const dropped of overflow) this.deletedIds.add(dropped.id)
      this.callbackLogList = this.callbackLogList.slice(-MAX_CALLBACK_LOG)
    }
    this.persist()
  }

  /** Pending callback retries in enqueue order. */
  retries(): readonly PendingRetry[] {
    return this.retryList
  }

  /** Queue a failed callback for a later attempt, trimming to the cap. */
  appendRetry(item: PendingRetry): void {
    this.retryList.push(item)
    if (this.retryList.length > MAX_PENDING_RETRIES) {
      const overflow = this.retryList.slice(0, this.retryList.length - MAX_PENDING_RETRIES)
      for (const dropped of overflow) this.deletedIds.add(dropped.id)
      this.retryList = this.retryList.slice(-MAX_PENDING_RETRIES)
    }
    this.persist()
  }

  /** Forget a finished retry (delivered, or exhausted). */
  settleRetry(id: string): void {
    const index = this.retryList.findIndex(item => item.id === id)
    if (index === -1) return
    this.retryList.splice(index, 1)
    this.deletedIds.add(id)
    this.persist()
  }

  /**
   * Claim the due retries under the store write lock and schedule each for its
   * next attempt. The lock serializes claims across processes sharing the
   * home, and every claimed item is re-dated before the lock is released, so
   * no two processes dispatch the same retry. Returns the claimed items with
   * `attempts` already bumped; an empty result (also on lock contention, with
   * a warning) means the next tick should try again.
   */
  claimDueRetries(now: number, backoffBaseMs: number, maxBackoffMs: number): PendingRetry[] {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const lock = acquireDirLock(this.writeLockDir)
    if (!lock.acquired) {
      this.reportLock(lock)
      return []
    }
    try {
      const merged = this.mergeFromDisk()
      if (merged !== null) {
        // Adopt the peer's queue into memory: the merged view is what we are
        // about to write, and dispatch outcomes below mutate this same list.
        this.retryList = merged.retries
        this.baseRetries.clear()
        for (const retry of merged.retries) this.baseRetries.set(retry.id, JSON.stringify(retry))
      }
      const due: PendingRetry[] = []
      for (const item of this.retryList) {
        if (item.nextDueAt > now) continue
        item.attempts += 1
        item.nextDueAt = now + Math.min(backoffBaseMs * 2 ** (item.attempts - 1), maxBackoffMs)
        due.push(item)
      }
      if (due.length > 0) this.writeSnapshot(merged)
      return due
    } finally {
      lock.release()
    }
  }

  /**
   * Persist after an in-place record mutation. Takes the store write lock,
   * merges any records another process wrote since our last write, then
   * atomically replaces the file.
   */
  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const lock = acquireStoreWriteLock(this.writeLockDir)
    try {
      this.writeSnapshot(this.mergeFromDisk())
    } finally {
      lock.release()
    }
  }

  /**
   * Atomically write a snapshot to the store file and the seq sidecar.
   * @param merged - the merged record lists when an external write was
   *   folded in, or null to write our in-memory state as-is.
   */
  private writeSnapshot(merged: StoreSnapshot | null): void {
    const hooks = merged?.hooks ?? this.hookList
    const deliveries = merged?.deliveries ?? this.deliveryList
    const callbacks = merged?.callbacks ?? this.callbackLogList
    const retries = merged?.retries ?? this.retryList
    if (merged !== null) {
      this.hookList = hooks
      this.deliveryList = deliveries
      this.callbackLogList = callbacks
      this.retryList = retries
      this.seq = WebhookStore.maxSeq(this.seq, [...hooks, ...deliveries, ...callbacks, ...retries])
    }
    const payload = JSON.stringify({
      version: STORE_VERSION,
      seq: this.seq,
      eventCursor: this.eventSeq,
      hooks,
      deliveries,
      callbacks,
      retries,
    }, null, 2)
    const content = `${payload}\n`
    this.lastWritten = content
    const temporary = `${this.filePath}.tmp-${process.pid}`
    writeFileSync(temporary, content)
    renameSync(temporary, this.filePath)
    this.writeSeqSidecar()
    this.deletedIds.clear()
    this.updateProvenance()
  }

  /**
   * Track the version our memory holds for each record, so a later merge can
   * tell our edits from the peer's. A record we adopted from the peer keeps
   * its old provenance (our memory still matches it), which keeps the merge
   * idempotent; a record we created or edited records our own version.
   */
  private updateProvenance(): void {
    for (const record of this.hookList) {
      if (JSON.stringify(record) !== this.baseHooks.get(record.id)) this.baseHooks.set(record.id, JSON.stringify(record))
    }
    for (const delivery of this.deliveryList) {
      if (JSON.stringify(delivery) !== this.baseDeliveries.get(delivery.id)) this.baseDeliveries.set(delivery.id, JSON.stringify(delivery))
    }
    for (const entry of this.callbackLogList) {
      if (JSON.stringify(entry) !== this.baseCallbacks.get(entry.id)) this.baseCallbacks.set(entry.id, JSON.stringify(entry))
    }
    for (const retry of this.retryList) {
      if (JSON.stringify(retry) !== this.baseRetries.get(retry.id)) this.baseRetries.set(retry.id, JSON.stringify(retry))
    }
  }

  /**
   * Read the current disk state and merge it with ours at the record level.
   * Returns null when the file is absent, unchanged since our last write, or
   * unreadable — in all of which cases our in-memory state is written as-is.
   */
  private mergeFromDisk(): StoreSnapshot | null {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`dsh-webhook: store merge read failed: ${String(error)}`)
      }
      return null
    }
    if (raw === this.lastWritten) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.warn('dsh-webhook: external store content is corrupt; writing local state over it')
      return null
    }
    if (!isRecord(parsed) || (parsed.version !== 2 && parsed.version !== STORE_VERSION)
      || !Array.isArray(parsed.hooks) || !Array.isArray(parsed.deliveries)) {
      this.warn('dsh-webhook: unsupported external store format; writing local state over it')
      return null
    }
    const diskHooks = new Map<string, WebhookHook>()
    for (const entry of parsed.hooks) {
      if (isValidHook(entry)) diskHooks.set(entry.id, normalizeHook(entry, this.fallbackTarget))
    }
    const diskDeliveries = new Map<string, WebhookDelivery>()
    for (const entry of parsed.deliveries) {
      if (isValidDelivery(entry)) diskDeliveries.set(entry.id, normalizeDelivery(entry))
    }
    const diskCallbacks = new Map<string, CallbackLogEntry>()
    if (Array.isArray(parsed.callbacks)) {
      for (const entry of parsed.callbacks) {
        if (isValidCallbackEntry(entry)) diskCallbacks.set(entry.id, entry)
      }
    }
    const diskRetries = new Map<string, PendingRetry>()
    if (Array.isArray(parsed.retries)) {
      for (const entry of parsed.retries) {
        if (isValidRetry(entry)) diskRetries.set(entry.id, entry)
      }
    }
    const diskSeq = typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq) ? parsed.seq : 0
    const diskEventSeq = typeof parsed.eventCursor === 'number' && Number.isSafeInteger(parsed.eventCursor) ? parsed.eventCursor : 0
    const hooks = mergeRecords(this.hookList, this.baseHooks, diskHooks, this.deletedIds)
    const deliveries = mergeRecords(this.deliveryList, this.baseDeliveries, diskDeliveries, this.deletedIds)
    const callbacks = mergeRecords(this.callbackLogList, this.baseCallbacks, diskCallbacks, this.deletedIds)
    const retries = mergeRecords(this.retryList, this.baseRetries, diskRetries, this.deletedIds)
    this.seq = WebhookStore.maxSeq(Math.max(this.seq, diskSeq), [...hooks, ...deliveries, ...callbacks, ...retries])
    this.eventSeq = Math.max(this.eventSeq, diskEventSeq)
    return { hooks, deliveries, callbacks, retries }
  }

  /** Persist after an in-place record mutation. */
  flush(): void {
    this.persist()
  }

  /**
   * Watch the store file for external changes (another dsh process sharing
   * this Harness home) and hot-reload the in-memory projection. Polling is
   * used instead of `fs.watch`: libuv's fs-event on Windows aborts the
   * process when the watched directory is deleted, which the tests' teardown
   * (and a removed data dir in production) would trigger. Self-writes are
   * recognized by content equality and skipped. Returns a disposer.
   * @param onReload - called once per applied external reload.
   * @param intervalMs - poll interval; tests use a short one.
   */
  watch(onReload?: (hooks: number) => void, intervalMs = 500): () => void {
    if (this.watcher !== null) return () => {}
    const timer = setInterval(() => this.poll(onReload), intervalMs)
    // Do not keep a one-shot headless process alive just for the watcher.
    timer.unref()
    this.watcher = timer
    return () => this.stopWatch()
  }

  /** One poll tick: reload when the file changed since our last sighting. */
  private poll(onReload?: (hooks: number) => void): void {
    if (this.watcher === null) return
    let stat: Stats
    try {
      stat = statSync(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lastStat = null
        return
      }
      this.warn(`dsh-webhook: store watch stat failed: ${String(error)}`)
      return
    }
    const sighting = { mtimeMs: stat.mtimeMs, size: stat.size }
    if (this.lastStat !== null && this.lastStat.mtimeMs === sighting.mtimeMs && this.lastStat.size === sighting.size) return
    this.lastStat = sighting
    if (!this.reloadIfChanged()) return
    if (onReload !== undefined) onReload(this.hookList.length)
  }

  /** Whether the file changed since our last write; reloads when it did. */
  private reloadIfChanged(): boolean {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`dsh-webhook: store watch read failed: ${String(error)}`)
      }
      return false
    }
    if (raw === this.lastWritten) return false
    this.lastWritten = raw
    this.applyRaw(raw, true)
    return true
  }

  private stopWatch(): void {
    if (this.watcher !== null) {
      clearInterval(this.watcher)
      this.watcher = null
    }
  }
}

const storeLockWait = new Int32Array(new SharedArrayBuffer(4))

function acquireStoreWriteLock(lockDir: string): DirLock {
  for (let attempt = 0; attempt < 100; attempt++) {
    const lock = acquireDirLock(lockDir)
    if (lock.acquired) return lock
    Atomics.wait(storeLockWait, 0, 0, 5)
  }
  throw new Error(`dsh-webhook: timed out acquiring store write lock ${lockDir}`)
}

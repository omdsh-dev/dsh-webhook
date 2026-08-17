/**
 * Durable JSON store for dsh-webhook: hook definitions and a bounded delivery
 * log. One atomic-write file is the source of truth.
 * @module dsh-webhook/store
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireDirLock, type DirLock } from './filelock.ts'

/** HMAC-SHA256 signature check (GitHub-style `sha256=<hex>` header). */
export interface HmacAuth {
  readonly kind: 'hmac-sha256'
  /** Credential reference resolved through the host credentials service. */
  readonly secretRef: string
  /** Signature header name; defaults to `x-hub-signature-256`. */
  readonly header?: string
}

/** Static token check against the Authorization bearer or a named header. */
export interface TokenAuth {
  readonly kind: 'bearer'
  readonly secretRef: string
  /** Token header name; defaults to `authorization` (Bearer scheme). */
  readonly header?: string
}

/** No secret: requests are accepted from loopback addresses only. */
export interface NoneAuth {
  readonly kind: 'none'
}

export type HookAuth = HmacAuth | TokenAuth | NoneAuth

/** Outbound notification rule attached to a hook or declared globally. */
export interface CallbackTarget {
  /** `http(s)://...` POST target or `local://macos-notification`. */
  readonly target: string
  /** Credential reference for the `Authorization: Bearer` header. */
  readonly secretRef?: string
  /** Delivery-status filter; absent matches any status. */
  readonly statuses?: readonly string[]
  /** Outcome filter; absent matches any outcome. */
  readonly outcomes?: readonly string[]
}

/** One registered webhook endpoint. */
export interface WebhookHook {
  /** Stable store-local id, never reused within one store file. */
  readonly id: string
  /** URL slug; the endpoint is `POST /hooks/<name>`. */
  readonly name: string
  /** Prompt template; `{{payload.path}}` and `{{header.name}}` interpolate. */
  readonly promptTemplate: string
  readonly auth: HookAuth
  /** Preferred delivery target session id, or null. */
  readonly target: string | null
  readonly createdBy: string | null
  readonly createdAt: string
  deliveryCount: number
  lastDeliveryAt: string | null
  /** Requests are refused while paused. */
  paused: boolean
  /** Hook-level outbound callbacks fired on settle; absent means none. */
  callbacks?: readonly CallbackTarget[]
}

/** One recorded delivery attempt. */
export interface WebhookDelivery {
  readonly id: string
  readonly hookId: string
  readonly receivedAt: string
  /** Deduplication key when the source supplied one, else null. */
  readonly eventId: string | null
  /** Request headers retained for template interpolation and replay. */
  readonly headers: Record<string, string>
  status: 'accepted' | 'rejected' | 'delivered' | 'held'
  /** Rejection or hold reason for non-delivered records. */
  reason?: string
  /** Raw request body, capped for replay; absent when the body exceeded the cap. */
  payload?: string
  /** Bounded payload preview for listings. */
  readonly payloadExcerpt: string
  outcome?: 'completed' | 'error' | 'cancelled' | 'timeout'
  excerpt?: string
  /** Result of the last outbound callback attempt for this delivery. */
  lastCallback?: {
    readonly target: string
    readonly status: 'sent' | 'failed'
    readonly sentAt: string
    readonly error?: string
  }
}

/** One recorded outbound callback attempt. */
export interface CallbackLogEntry {
  readonly id: string
  readonly source: 'webhook' | 'cron'
  readonly subject: string
  readonly target: string
  readonly status: 'sent' | 'failed'
  readonly error?: string
  readonly sentAt: string
}

const STORE_VERSION = 1

/** Deliveries retained per hook. */
const MAX_DELIVERIES_PER_HOOK = 50

/** Outbound callback attempts retained globally. */
const MAX_CALLBACK_LOG = 100

/** Raw bodies retained for replay. */
const MAX_STORED_PAYLOAD_BYTES = 8_192

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidHook(value: unknown): value is WebhookHook {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return false
  if (typeof value.promptTemplate !== 'string' || typeof value.createdAt !== 'string') return false
  if (value.target !== null && typeof value.target !== 'string') return false
  if (value.createdBy !== null && typeof value.createdBy !== 'string') return false
  if (typeof value.deliveryCount !== 'number') return false
  if (value.lastDeliveryAt !== null && typeof value.lastDeliveryAt !== 'string') return false
  if (value.paused !== undefined && typeof value.paused !== 'boolean') return false
  const auth = value.auth
  if (!isRecord(auth)) return false
  if (auth.kind === 'none') return true
  if (auth.kind === 'hmac-sha256' || auth.kind === 'bearer') return typeof auth.secretRef === 'string'
  return false
}

function isValidDelivery(value: unknown): value is WebhookDelivery {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.hookId !== 'string') return false
  if (typeof value.receivedAt !== 'string' || typeof value.payloadExcerpt !== 'string') return false
  if (value.eventId !== null && typeof value.eventId !== 'string') return false
  if (!isRecord(value.headers)) return false
  return value.status === 'accepted' || value.status === 'rejected'
    || value.status === 'delivered' || value.status === 'held'
}

function isValidCallbackEntry(value: unknown): value is CallbackLogEntry {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.subject !== 'string') return false
  if (typeof value.target !== 'string' || typeof value.sentAt !== 'string') return false
  if (value.source !== 'webhook' && value.source !== 'cron') return false
  if (value.status !== 'sent' && value.status !== 'failed') return false
  return value.error === undefined || typeof value.error === 'string'
}

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
  private watcher: ReturnType<typeof setInterval> | null = null
  private lastWritten: string | null = null
  private lastStat: { mtimeMs: number; size: number } | null = null
  private readonly writeLockDir: string
  private readonly seqFile: string
  /** Serialized form of each record as of our last load or write. */
  private readonly baseHooks = new Map<string, string>()
  private readonly baseDeliveries = new Map<string, string>()
  private readonly baseCallbacks = new Map<string, string>()
  /** Records we dropped since our last load; a merge must not resurrect them. */
  private readonly deletedIds = new Set<string>()

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void,
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
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION
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
      hooks.push({ ...entry, paused: entry.paused ?? false })
    }
    this.hookList = hooks
    this.deliveryList = parsed.deliveries.filter((entry: unknown) => isValidDelivery(entry))
    this.callbackLogList = Array.isArray(parsed.callbacks)
      ? parsed.callbacks.filter((entry: unknown) => isValidCallbackEntry(entry))
      : []
    this.seq = typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq) ? parsed.seq : hooks.length
    this.rebaseSnapshots()
    const sidecar = this.readSeqSidecar()
    if (sidecar !== null && sidecar > this.seq) this.seq = sidecar
  }

  /** Forget per-record provenance and lock state after a wholesale reload. */
  private rebaseSnapshots(): void {
    this.baseHooks.clear()
    this.baseDeliveries.clear()
    this.baseCallbacks.clear()
    this.deletedIds.clear()
    for (const hook of this.hookList) this.baseHooks.set(hook.id, JSON.stringify(hook))
    for (const delivery of this.deliveryList) this.baseDeliveries.set(delivery.id, JSON.stringify(delivery))
    for (const entry of this.callbackLogList) this.baseCallbacks.set(entry.id, JSON.stringify(entry))
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
    const lock = acquireDirLock(this.writeLockDir)
    try {
      if (!lock.acquired) {
        this.reportLock(lock)
        this.seq += 1
      } else {
        const diskSeq = this.readSeqSidecar()
        if (diskSeq !== null && diskSeq > this.seq) this.seq = diskSeq
        this.seq += 1
        this.writeSeqSidecar()
      }
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
      const overflow = mine.slice(0, mine.length - MAX_DELIVERIES_PER_HOOK)
      const overflowIds = new Set(overflow.map(entry => entry.id))
      for (const id of overflowIds) this.deletedIds.add(id)
      this.deliveryList = this.deliveryList.filter(entry => !overflowIds.has(entry.id))
    }
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

  /**
   * Persist after an in-place record mutation. Takes the store write lock,
   * merges any records another process wrote since our last write, then
   * atomically replaces the file.
   */
  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const lock = acquireDirLock(this.writeLockDir)
    try {
      if (lock.acquired) {
        this.writeSnapshot(this.mergeFromDisk())
      } else {
        this.reportLock(lock)
        this.writeSnapshot(null)
      }
    } finally {
      lock.release()
    }
  }

  /**
   * Atomically write a snapshot to the store file and the seq sidecar.
   * @param merged - the merged record lists when an external write was
   *   folded in, or null to write our in-memory state as-is.
   */
  private writeSnapshot(merged: { hooks: WebhookHook[]; deliveries: WebhookDelivery[]; callbacks: CallbackLogEntry[] } | null): void {
    const hooks = merged?.hooks ?? this.hookList
    const deliveries = merged?.deliveries ?? this.deliveryList
    const callbacks = merged?.callbacks ?? this.callbackLogList
    if (merged !== null) {
      this.seq = WebhookStore.maxSeq(this.seq, [...hooks, ...deliveries, ...callbacks])
    }
    const payload = JSON.stringify({
      version: STORE_VERSION,
      seq: this.seq,
      hooks,
      deliveries,
      callbacks,
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
  }

  /**
   * Read the current disk state and merge it with ours at the record level.
   * Returns null when the file is absent, unchanged since our last write, or
   * unreadable — in all of which cases our in-memory state is written as-is.
   */
  private mergeFromDisk(): { hooks: WebhookHook[]; deliveries: WebhookDelivery[]; callbacks: CallbackLogEntry[] } | null {
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
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION
      || !Array.isArray(parsed.hooks) || !Array.isArray(parsed.deliveries)) {
      this.warn('dsh-webhook: unsupported external store format; writing local state over it')
      return null
    }
    const diskHooks = new Map<string, WebhookHook>()
    for (const entry of parsed.hooks) {
      if (isValidHook(entry)) diskHooks.set(entry.id, { ...entry, paused: entry.paused ?? false })
    }
    const diskDeliveries = new Map<string, WebhookDelivery>()
    for (const entry of parsed.deliveries) {
      if (isValidDelivery(entry)) diskDeliveries.set(entry.id, entry)
    }
    const diskCallbacks = new Map<string, CallbackLogEntry>()
    if (Array.isArray(parsed.callbacks)) {
      for (const entry of parsed.callbacks) {
        if (isValidCallbackEntry(entry)) diskCallbacks.set(entry.id, entry)
      }
    }
    const diskSeq = typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq) ? parsed.seq : 0
    const hooks = mergeRecords(this.hookList, this.baseHooks, diskHooks, this.deletedIds)
    const deliveries = mergeRecords(this.deliveryList, this.baseDeliveries, diskDeliveries, this.deletedIds)
    const callbacks = mergeRecords(this.callbackLogList, this.baseCallbacks, diskCallbacks, this.deletedIds)
    this.seq = WebhookStore.maxSeq(Math.max(this.seq, diskSeq), [...hooks, ...deliveries, ...callbacks])
    return { hooks, deliveries, callbacks }
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

/**
 * Merge one record list with the current disk state. Per-record semantics:
 *
 * - a record only the other side has is adopted, in the disk order;
 * - a record we created or edited wins over the other side's version
 *   (last-writer-wins on the record);
 * - a record we have not touched since our last load or write takes the
 *   other side's version, or is dropped when the other side deleted it;
 * - records only we hold are appended after the disk records;
 * - a record we dropped (in `deleted`) is never resurrected.
 */
function mergeRecords<T extends { id: string }>(
  ours: readonly T[],
  base: ReadonlyMap<string, string>,
  latest: ReadonlyMap<string, T>,
  deleted: ReadonlySet<string>,
): T[] {
  const merged: T[] = []
  const seen = new Set<string>()
  const byId = new Map<string, T>()
  for (const record of ours) byId.set(record.id, record)
  for (const [id, current] of latest) {
    if (deleted.has(id)) continue
    seen.add(id)
    const our = byId.get(id)
    if (our === undefined) {
      merged.push(current)
    } else if (JSON.stringify(our) === base.get(id)) {
      merged.push(current)
    } else {
      merged.push(our)
    }
  }
  for (const record of ours) {
    if (seen.has(record.id) || deleted.has(record.id)) continue
    if (JSON.stringify(record) === base.get(record.id)) continue
    merged.push(record)
  }
  return merged
}

export { MAX_STORED_PAYLOAD_BYTES }

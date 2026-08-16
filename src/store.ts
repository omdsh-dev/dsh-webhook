/**
 * Durable JSON store for dsh-webhook: hook definitions and a bounded delivery
 * log. One atomic-write file is the source of truth.
 * @module dsh-webhook/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
 */
export class WebhookStore {
  private seq = 0
  private hookList: WebhookHook[] = []
  private deliveryList: WebhookDelivery[] = []
  private callbackLogList: CallbackLogEntry[] = []

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void,
  ) {}

  /** Load the store from disk; a missing file means an empty store. */
  load(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
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

  /** Allocate the next never-reused id with the given prefix. */
  allocateId(prefix: string): string {
    this.seq += 1
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
    this.deliveryList = this.deliveryList.filter(delivery => delivery.hookId !== id)
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
      const overflow = new Set(mine.slice(0, mine.length - MAX_DELIVERIES_PER_HOOK).map(entry => entry.id))
      this.deliveryList = this.deliveryList.filter(entry => !overflow.has(entry.id))
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
      this.callbackLogList = this.callbackLogList.slice(-MAX_CALLBACK_LOG)
    }
    this.persist()
  }

  /** Persist after an in-place record mutation. */
  flush(): void {
    this.persist()
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload = JSON.stringify({
      version: STORE_VERSION,
      seq: this.seq,
      hooks: this.hookList,
      deliveries: this.deliveryList,
      callbacks: this.callbackLogList,
    }, null, 2)
    const temporary = `${this.filePath}.tmp-${process.pid}`
    writeFileSync(temporary, `${payload}\n`)
    renameSync(temporary, this.filePath)
  }
}

export { MAX_STORED_PAYLOAD_BYTES }

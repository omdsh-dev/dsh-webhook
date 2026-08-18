/**
 * Outbound callbacks for dsh-webhook: delivery settles (and, through the
 * `callbacks` service, other plugins' events) fan out to configured targets —
 * HTTP POST with an optional bearer secret, or a macOS notification. Attempts
 * are recorded on the store's bounded callback log.
 * @module dsh-webhook/callbacks
 */

import { execFile } from 'node:child_process'
import type { CallbackLogEntry, CallbackTarget, PendingRetry, WebhookDelivery, WebhookStore } from './store.ts'

/** Event origin; `'cron'` events arrive through the published service. */
export type CallbackEventSource = 'webhook' | 'cron'

/** One event offered to the callback rules. */
export interface CallbackEvent {
  readonly source: CallbackEventSource
  /** Short human title, e.g. `github-ci · dl-2 delivered`. */
  readonly subject: string
  /** Delivery status when known: `delivered` | `held` | `rejected`. */
  readonly status?: string
  /** Task outcome when known: `completed` | `error` | `cancelled` | `timeout`. */
  readonly outcome?: string
  /** Bounded result excerpt. */
  readonly excerpt?: string
  readonly eventId?: string | null
  readonly hookId?: string
  readonly deliveryId?: string
  readonly jobId?: string
  readonly runId?: string
  readonly firedAt?: string
  readonly receivedAt?: string
  readonly completedAt?: string
}

/** Global callback rule; absent filters match anything. */
export interface CallbackRule {
  readonly source?: CallbackEventSource
  readonly statuses?: readonly string[]
  readonly outcomes?: readonly string[]
  readonly target: string
  readonly secretRef?: string
}

/** A target verified to be one of the supported schemes. */
export interface CallbackTargetConfig {
  readonly target: string
  readonly secretRef?: string
}

/** Retry policy for failed outbound callbacks. */
export interface CallbackRetryPolicy {
  /** Total attempts including the initial one; 1 disables retries. */
  readonly maxAttempts: number
  /** Delay before the first retry; doubles per attempt, capped. */
  readonly backoffBaseMs: number
  /** Cap on the per-attempt delay. */
  readonly maxBackoffMs: number
}

export interface CallbackDispatcherOptions {
  readonly store: WebhookStore
  /** Resolve a credential reference to its current value. */
  resolveSecret(ref: string): Promise<string | undefined>
  /** Wall clock in epoch milliseconds. */
  now(): number
  /** Log a recoverable problem. */
  warn(message: string): void
  /** Log an informational message. */
  info(message: string): void
  /**
   * Command runner for local targets, injectable for tests. Returns the
   * command's exit success. Defaults to `osascript` on macOS.
   */
  runLocal?(script: string): Promise<{ ok: boolean; error?: string }>
  /**
   * HTTP sender, injectable for tests. Defaults to the global `fetch`.
   */
  sendHttp?(url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{ ok: boolean; error?: string }>
  /** Called after each attempt so the originating delivery can record it. */
  onAttempt?(deliveryId: string, attempt: { target: string; status: 'sent' | 'failed'; sentAt: string; attempt?: number; error?: string }): void
  /**
   * Retry policy for failed attempts. Absent defaults to 4 total attempts
   * with a 2 s base delay (2 s, 4 s, 8 s) capped at 5 minutes; the queue is
   * persisted in the store and survives restarts.
   */
  retry?: CallbackRetryPolicy
}

/** Scheme prefix for the macOS notification target. */
export const LOCAL_NOTIFICATION_SCHEME = 'local://macos-notification'

const HTTP_TIMEOUT_MS = 10_000

/** Whether a rule target is a supported scheme; throws with the reason. */
export function validateTarget(target: string): string {
  if (/^https?:\/\//.test(target)) return target
  if (target === LOCAL_NOTIFICATION_SCHEME) return target
  throw new Error(`dsh-webhook: callback target must be http(s):// or ${LOCAL_NOTIFICATION_SCHEME}; got "${target}"`)
}

function matches(rule: CallbackRule, event: CallbackEvent): boolean {
  if (rule.source !== undefined && rule.source !== event.source) return false
  if (rule.statuses !== undefined && rule.statuses.length > 0
    && (event.status === undefined || !rule.statuses.includes(event.status))) return false
  if (rule.outcomes !== undefined && rule.outcomes.length > 0
    && (event.outcome === undefined || !rule.outcomes.includes(event.outcome))) return false
  return true
}

function defaultRunLocal(script: string): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    return Promise.resolve({ ok: false, error: 'osascript is only available on macOS' })
  }
  return new Promise(resolve => {
    execFile('osascript', ['-e', script], { timeout: HTTP_TIMEOUT_MS }, (error) => {
      resolve(error === null ? { ok: true } : { ok: false, error: error.message })
    })
  })
}

async function defaultSendHttp(
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal: init.signal })
    if (response.ok) return { ok: true }
    return { ok: false, error: `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function notificationScript(title: string, body: string): string {
  return `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`
}

/**
 * Fan-out engine for outbound callbacks. One `emit` runs every matching rule
 * against its target; attempts are recorded on the store's bounded log, and
 * failed attempts are queued for later retries with exponential backoff when
 * a retry policy is configured.
 */
export class CallbackDispatcher {
  private readonly runLocal: (script: string) => Promise<{ ok: boolean; error?: string }>
  private readonly sendHttp: (url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; error?: string }>
  private readonly maxAttempts: number
  private readonly backoffBaseMs: number
  private readonly maxBackoffMs: number

  constructor(private readonly options: CallbackDispatcherOptions) {
    this.runLocal = options.runLocal ?? defaultRunLocal
    this.sendHttp = options.sendHttp ?? defaultSendHttp
    this.maxAttempts = options.retry?.maxAttempts ?? 4
    this.backoffBaseMs = options.retry?.backoffBaseMs ?? 2_000
    this.maxBackoffMs = options.retry?.maxBackoffMs ?? 300_000
  }

  /**
   * Offer an event to every matching rule (global rules plus, for `webhook`
   * events, the hook's own targets) and record each attempt. Fire-and-forget
   * by design: callback failures never block delivery settling, and failed
   * attempts are queued for the retry worker.
   */
  emit(event: CallbackEvent, globalRules: readonly CallbackRule[], hookTargets: readonly CallbackTarget[] = []): void {
    const webhookRules: CallbackRule[] = hookTargets.map(target => ({
      ...(target.statuses === undefined ? {} : { statuses: target.statuses }),
      ...(target.outcomes === undefined ? {} : { outcomes: target.outcomes }),
      target: target.target,
      ...(target.secretRef === undefined ? {} : { secretRef: target.secretRef }),
    }))
    for (const rule of [...globalRules, ...webhookRules]) {
      if (!matches(rule, event)) continue
      void this.dispatch(event, rule).then(result => {
        this.recordAttempt(event, rule, result, 1)
        if (result.ok) {
          this.options.info(`dsh-webhook: callback sent to ${rule.target} (${event.subject})`)
        } else if (this.maxAttempts > 1) {
          this.enqueueRetry(event, rule, result, 1)
        } else {
          this.options.warn(`dsh-webhook: callback to ${rule.target} failed: ${result.error ?? 'unknown error'}`)
        }
      })
    }
  }

  /**
   * Run one retry tick: claim the due retries from the store queue and
   * dispatch each. Serialized across processes by the store write lock, so a
   * delivery's callback chain is attempted by exactly one process at a time.
   */
  async retryDue(): Promise<void> {
    const due = this.options.store.claimDueRetries(this.options.now(), this.backoffBaseMs, this.maxBackoffMs)
    for (const item of due) {
      try {
        await this.attempt(item)
      } catch (error) {
        this.options.warn(`dsh-webhook: callback retry crashed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Deliver one event to one target; returns the outcome. */
  async dispatch(event: CallbackEvent, rule: CallbackRule): Promise<{ ok: boolean; error?: string }> {
    const body = JSON.stringify({
      source: event.source,
      subject: event.subject,
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      ...(event.excerpt === undefined ? {} : { excerpt: event.excerpt }),
      ...(event.eventId === undefined || event.eventId === null ? {} : { eventId: event.eventId }),
      ...(event.hookId === undefined ? {} : { hookId: event.hookId }),
      ...(event.deliveryId === undefined ? {} : { deliveryId: event.deliveryId }),
      ...(event.jobId === undefined ? {} : { jobId: event.jobId }),
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(event.firedAt === undefined ? {} : { firedAt: event.firedAt }),
      ...(event.receivedAt === undefined ? {} : { receivedAt: event.receivedAt }),
      ...(event.completedAt === undefined ? {} : { completedAt: event.completedAt }),
    })
    try {
      const target = validateTarget(rule.target)
      if (target === LOCAL_NOTIFICATION_SCHEME) {
        const title = `dsh-webhook · ${event.subject}`.slice(0, 80)
        const bodyText = (event.excerpt ?? 'no result excerpt').slice(0, 200)
        return this.runLocal(notificationScript(title, bodyText))
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (rule.secretRef !== undefined) {
        const secret = await this.options.resolveSecret(rule.secretRef)
        if (secret === undefined) {
          return { ok: false, error: `credential ${rule.secretRef} did not resolve` }
        }
        headers.authorization = `Bearer ${secret}`
      }
      return this.sendHttp(target, { headers, body, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** One retry attempt: dispatch, record the receipt, settle or re-queue. */
  private async attempt(item: PendingRetry): Promise<void> {
    const event = this.eventFromRetry(item)
    const rule: CallbackRule = {
      target: item.target,
      ...(item.secretRef === undefined ? {} : { secretRef: item.secretRef }),
    }
    const result = await this.dispatch(event, rule)
    this.recordAttempt(event, rule, result, item.attempts)
    if (result.ok) {
      this.options.store.settleRetry(item.id)
      this.options.info(`dsh-webhook: callback sent to ${item.target} (${item.subject}, attempt ${item.attempts})`)
      return
    }
    if (item.attempts >= this.maxAttempts) {
      this.options.store.settleRetry(item.id)
      this.options.warn(`dsh-webhook: callback to ${item.target} failed after ${item.attempts} attempt(s): ${result.error ?? 'unknown error'}`)
      return
    }
    // A retry stays queued; the claim already re-dated it for the next attempt.
    this.options.warn(`dsh-webhook: callback to ${item.target} failed (attempt ${item.attempts}): ${result.error ?? 'unknown error'}; retrying`)
  }

  /** Record one dispatch outcome on the store's log and the delivery. */
  private recordAttempt(event: CallbackEvent, rule: CallbackRule, result: { ok: boolean; error?: string }, attempt: number): void {
    const sentAt = new Date(this.options.now()).toISOString()
    const entry: CallbackLogEntry = {
      id: this.options.store.allocateId('cb'),
      source: event.source,
      subject: event.subject,
      target: rule.target,
      status: result.ok ? 'sent' : 'failed',
      attempt,
      ...(result.ok ? {} : { error: result.error }),
      sentAt,
    }
    this.options.store.appendCallbackLog(entry)
    if (event.deliveryId !== undefined) {
      this.options.onAttempt?.(event.deliveryId, {
        target: rule.target,
        status: entry.status,
        sentAt: entry.sentAt,
        attempt,
        ...(result.ok ? {} : { error: result.error }),
      })
    }
  }

  /** Queue a failed attempt for a later try with exponential backoff. */
  private enqueueRetry(event: CallbackEvent, rule: CallbackRule, result: { ok: boolean; error?: string }, attempt: number): void {
    this.options.store.appendRetry({
      id: this.options.store.allocateId('rt'),
      source: event.source,
      subject: event.subject,
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      ...(event.excerpt === undefined ? {} : { excerpt: event.excerpt }),
      ...(event.eventId === undefined || event.eventId === null ? {} : { eventId: event.eventId }),
      ...(event.hookId === undefined ? {} : { hookId: event.hookId }),
      ...(event.deliveryId === undefined ? {} : { deliveryId: event.deliveryId }),
      ...(event.jobId === undefined ? {} : { jobId: event.jobId }),
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(event.firedAt === undefined ? {} : { firedAt: event.firedAt }),
      ...(event.receivedAt === undefined ? {} : { receivedAt: event.receivedAt }),
      ...(event.completedAt === undefined ? {} : { completedAt: event.completedAt }),
      target: rule.target,
      ...(rule.secretRef === undefined ? {} : { secretRef: rule.secretRef }),
      attempts: attempt,
      nextDueAt: this.options.now() + this.backoff(attempt),
      ...(result.error === undefined ? {} : { lastError: result.error }),
    })
  }

  /** Delay after the n-th attempt, doubling and capped. */
  private backoff(attempt: number): number {
    return Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.maxBackoffMs)
  }

  /** Rebuild the callback event a queued retry was originally emitted for. */
  private eventFromRetry(item: PendingRetry): CallbackEvent {
    return {
      source: item.source,
      subject: item.subject,
      ...(item.status === undefined ? {} : { status: item.status }),
      ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
      ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
      ...(item.eventId === undefined || item.eventId === null ? {} : { eventId: item.eventId }),
      ...(item.hookId === undefined ? {} : { hookId: item.hookId }),
      ...(item.deliveryId === undefined ? {} : { deliveryId: item.deliveryId }),
      ...(item.jobId === undefined ? {} : { jobId: item.jobId }),
      ...(item.runId === undefined ? {} : { runId: item.runId }),
      ...(item.firedAt === undefined ? {} : { firedAt: item.firedAt }),
      ...(item.receivedAt === undefined ? {} : { receivedAt: item.receivedAt }),
      ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
    }
  }
}

/** Build a callback event from a settled delivery receipt. */
export function deliveryCallbackEvent(delivery: WebhookDelivery, subject: string, completedAt?: string): CallbackEvent {
  return {
    source: 'webhook',
    subject,
    status: delivery.status,
    ...(delivery.outcome === undefined ? {} : { outcome: delivery.outcome }),
    ...(delivery.excerpt === undefined ? {} : { excerpt: delivery.excerpt }),
    ...(delivery.eventId === undefined || delivery.eventId === null ? {} : { eventId: delivery.eventId }),
    ...(delivery.hookId === undefined ? {} : { hookId: delivery.hookId }),
    deliveryId: delivery.id,
    receivedAt: delivery.receivedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}
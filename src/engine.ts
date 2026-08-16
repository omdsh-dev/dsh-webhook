/**
 * Webhook engine: verification, deduplication, delivery, receipts, and replay.
 * All host contact goes through an injected boundary so tests can fake
 * secrets, agents, and clock.
 * @module dsh-webhook/engine
 */

import { isIP } from 'node:net'
import type { InboundEvent, VerifyResult } from './server.ts'
import { verifyRequest } from './sign.ts'
import { buildPrompt } from './template.ts'
import {
  MAX_STORED_PAYLOAD_BYTES,
  type HookAuth,
  type WebhookDelivery,
  type WebhookHook,
  type WebhookStore,
} from './store.ts'

/** A live agent that can receive an event task. */
export interface WebhookTarget {
  readonly id: string
  /** Agent status; `'idle'` receives a follow-up turn, anything else an inject. */
  readonly status: string
  followup(message: unknown): void
  inject(message: unknown): void
}

/** Input accepted from tools, commands, and the provided `webhook` service. */
export interface AddHookInput {
  /** URL slug; the endpoint is `POST /hooks/<name>`. */
  readonly name: string
  /** Prompt template; `{{payload.path}}` and `{{header.name}}` interpolate. */
  readonly promptTemplate: string
  readonly auth: HookAuth
  /** Preferred delivery target session id, optional. */
  readonly target?: string | null
  /** Creating session id, preferred at delivery when no explicit target. */
  readonly createdBy?: string | null
}

export interface AddHookResult {
  readonly hook: WebhookHook
  readonly url: string
}

export interface ReplayResult {
  readonly delivered: boolean
  readonly deliveryId?: string
  readonly reason?: string
}

/** Headers consulted (in order) for a source-supplied event id. */
const EVENT_ID_HEADERS = ['x-github-delivery', 'x-gitlab-delivery', 'x-request-id']

const HOOK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

function isLoopback(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, '')
  return normalized === '127.0.0.1' || normalized === '::1'
}

/** Whether a source address may hit a secret-less hook. */
function sourceAllowed(ip: string): boolean {
  if (ip === '' || isIP(ip) === 0) return false
  return isLoopback(ip)
}

/** Host boundary injected into the engine. */
export interface WebhookEngineOptions {
  readonly store: WebhookStore
  /** Wall clock in epoch milliseconds. */
  now(): number
  /** Live delivery targets, in preference order. */
  targets(): readonly WebhookTarget[]
  /** Resolve a credential reference to its current value. */
  resolveSecret(ref: string): Promise<string | undefined>
  /** Build the model-facing event-task message. */
  buildMessage(hook: WebhookHook, prompt: string, receivedAt: string, replayOf?: string): unknown
  /** Deliver a built message to one target. */
  deliver(target: WebhookTarget, message: unknown): void
  /** Called after a successful delivery so the host can track the turn. */
  readonly onDelivered?: ((deliveryId: string, target: WebhookTarget) => void) | undefined
  /**
   * Wake a hook's cold creating session and return it as a target, or null to
   * leave the event held. Absent disables cold wake entirely.
   */
  readonly wakeCold?: ((hook: WebhookHook) => Promise<WebhookTarget | null>) | undefined
  /** Log a recoverable problem. */
  readonly warn?: ((message: string) => void) | undefined
  /** Whether a public bind must refuse secret-less hooks. */
  readonly requireSecretsOnPublicBind: boolean
}

/** Programmatic service published as `ctx.webhook` for other plugins. */
export interface WebhookService {
  add(input: AddHookInput): AddHookResult
  remove(name: string): boolean
  list(): readonly WebhookHook[]
  deliveries(name: string): readonly WebhookDelivery[]
  replay(deliveryId: string): Promise<ReplayResult>
}

/**
 * The webhook engine. Durability lives in the store; the listener wiring is
 * provided by the runtime.
 */
export class WebhookEngine {
  constructor(private readonly options: WebhookEngineOptions) {}

  /** Service view published to other plugins. */
  service(): WebhookService {
    return {
      add: input => this.addHook(input),
      remove: name => this.removeHook(name),
      list: () => this.options.store.hooks(),
      deliveries: name => {
        const hook = this.options.store.hookByName(name)
        return hook === undefined ? [] : this.options.store.deliveries(hook.id)
      },
      replay: id => this.replay(id),
    }
  }

  /** Whether a hook name resolves. */
  isKnownHook(name: string): boolean {
    return this.options.store.hookByName(name) !== undefined
  }

  /** Validate an auth profile against the bind security policy. */
  validateAuth(auth: HookAuth, name: string): void {
    if (this.options.requireSecretsOnPublicBind && auth.kind === 'none') {
      throw new Error(`webhook_add: hook "${name}" has no secret but the server binds a public address; give it a secretRef or bind 127.0.0.1`)
    }
  }

  /** Add a hook; throws an `Error` prefixed with a stable reason code. */
  addHook(input: AddHookInput): AddHookResult {
    const name = input.name.trim()
    if (!HOOK_NAME.test(name)) {
      throw new Error('webhook_add: name must match ^[a-z0-9][a-z0-9-]{0,63}$')
    }
    if (input.promptTemplate.trim().length === 0) {
      throw new Error('webhook_add: promptTemplate must be non-blank')
    }
    if (this.options.store.hookByName(name) !== undefined) {
      throw new Error(`webhook_add: a hook named "${name}" already exists`)
    }
    this.validateAuth(input.auth, name)
    const now = new Date(this.options.now()).toISOString()
    const hook: WebhookHook = {
      id: this.options.store.allocateId('wh'),
      name,
      promptTemplate: input.promptTemplate.trim(),
      auth: input.auth,
      target: input.target ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      deliveryCount: 0,
      lastDeliveryAt: null,
    }
    this.options.store.insertHook(hook)
    return { hook, url: `/hooks/${name}` }
  }

  /** Remove a hook and its history; returns false when unknown. */
  removeHook(name: string): boolean {
    const hook = this.options.store.hookByName(name)
    if (hook === undefined) return false
    return this.options.store.removeHook(hook.id)
  }

  /**
   * Verify an inbound request against its hook. Runs before the HTTP response
   * so senders receive honest status codes.
   */
  async verify(event: InboundEvent): Promise<VerifyResult> {
    const hook = this.options.store.hookByName(event.hookName)
    if (hook === undefined) return { ok: false, code: 404, reason: 'unknown hook' }
    if (hook.auth.kind === 'none' && !sourceAllowed(event.sourceIp)) {
      return { ok: false, code: 403, reason: 'this hook is loopback-only' }
    }
    const result = await verifyRequest(hook.auth, { headers: event.headers, body: event.rawBody }, ref => this.options.resolveSecret(ref))
    if (!result.ok) return { ok: false, code: 401, reason: result.reason }
    return { ok: true }
  }

  /**
   * Accept a verified event: deduplicate, record the receipt, deliver into a
   * target, and hand the turn to the outcome tracker.
   */
  async accept(event: InboundEvent): Promise<void> {
    const hook = this.options.store.hookByName(event.hookName)
    if (hook === undefined) return
    const receivedAt = new Date(this.options.now()).toISOString()
    const eventId = EVENT_ID_HEADERS
      .map(header => event.headers[header] ?? null)
      .find(value => value !== null && value.length > 0) ?? null

    if (eventId !== null && this.options.store.hasEvent(hook.id, eventId)) {
      this.options.warn?.(`dsh-webhook: duplicate event ${eventId} for ${hook.name}; dropped`)
      this.options.store.appendDelivery(this.makeDelivery(hook, receivedAt, event, eventId, 'rejected', 'duplicate event id'))
      return
    }

    const delivery = this.makeDelivery(hook, receivedAt, event, eventId, 'accepted')
    this.options.store.appendDelivery(delivery)
    hook.deliveryCount += 1

    const delivered = await this.deliver(hook, delivery)
    if (delivered) {
      delivery.status = 'delivered'
      hook.lastDeliveryAt = receivedAt
      this.options.store.flush()
      return
    }
    delivery.status = 'held'
    delivery.reason = 'no delivery target was available'
    this.options.store.flush()
    this.options.warn?.(`dsh-webhook: event ${delivery.id} held: no target for ${hook.name}`)
  }

  /**
   * Re-deliver a recorded event through the ordinary path, bypassing signature
   * (it was verified once) but preserving deduplication against the log.
   */
  async replay(deliveryId: string): Promise<ReplayResult> {
    const original = this.options.store.deliveryById(deliveryId)
    if (original === undefined) return { delivered: false, reason: 'delivery not found' }
    if (original.payload === undefined) {
      return { delivered: false, reason: 'original payload was too large to store; replay is unavailable' }
    }
    const hook = this.options.store.hookById(original.hookId)
    if (hook === undefined) return { delivered: false, reason: 'hook no longer exists' }
    const now = new Date(this.options.now()).toISOString()
    const replay: WebhookDelivery = {
      id: this.options.store.allocateId('dl'),
      hookId: hook.id,
      receivedAt: now,
      eventId: null,
      headers: original.headers,
      status: 'accepted',
      payload: original.payload,
      payloadExcerpt: original.payloadExcerpt,
    }
    this.options.store.appendDelivery(replay)
    hook.deliveryCount += 1
    const delivered = await this.deliver(hook, replay, original.id)
    if (delivered) {
      replay.status = 'delivered'
      hook.lastDeliveryAt = now
      this.options.store.flush()
      return { delivered: true, deliveryId: replay.id }
    }
    replay.status = 'held'
    replay.reason = 'no delivery target was available'
    this.options.store.flush()
    return { delivered: false, reason: 'no delivery target was available', deliveryId: replay.id }
  }

  private makeDelivery(
    hook: WebhookHook,
    receivedAt: string,
    event: InboundEvent,
    eventId: string | null,
    status: WebhookDelivery['status'],
    reason?: string,
  ): WebhookDelivery {
    const stored = event.text.length <= MAX_STORED_PAYLOAD_BYTES ? event.text : undefined
    const headers: Record<string, string> = {}
    let budget = 4_096
    for (const [key, value] of Object.entries(event.headers)) {
      if (budget <= 0) break
      headers[key] = value.slice(0, budget)
      budget -= headers[key].length
    }
    const delivery: WebhookDelivery = {
      id: this.options.store.allocateId('dl'),
      hookId: hook.id,
      receivedAt,
      eventId,
      headers,
      status,
      ...(stored !== undefined ? { payload: stored } : {}),
      ...(reason !== undefined ? { reason } : {}),
      payloadExcerpt: event.text.slice(0, 400),
    }
    return delivery
  }

  private async deliver(hook: WebhookHook, delivery: WebhookDelivery, replayOf?: string): Promise<boolean> {
    let target = this.pickTarget(hook)
    if (target === undefined && this.options.wakeCold !== undefined && hook.createdBy !== null) {
      try {
        target = await this.options.wakeCold(hook) ?? undefined
      } catch (error) {
        this.options.warn?.(`dsh-webhook: cold wake failed for ${hook.name}: ${error instanceof Error ? error.message : String(error)}`)
        target = undefined
      }
    }
    if (target === undefined) return false
    const payloadText = delivery.payload ?? ''
    const prompt = buildPrompt(hook.promptTemplate, payloadText, delivery.headers)
    try {
      this.options.deliver(target, this.options.buildMessage(hook, prompt, delivery.receivedAt, replayOf))
    } catch (error) {
      this.options.warn?.(`dsh-webhook: delivery failed for ${delivery.id}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    this.options.onDelivered?.(delivery.id, target)
    return true
  }

  private pickTarget(hook: WebhookHook): WebhookTarget | undefined {
    const targets = this.options.targets()
    if (targets.length === 0) return undefined
    const explicit = hook.target === null ? undefined : targets.find(target => target.id === hook.target)
    if (explicit !== undefined) return explicit
    const owned = hook.createdBy === null ? undefined : targets.find(target => target.id === hook.createdBy)
    if (owned !== undefined) return owned
    return targets.find(target => target.status === 'idle') ?? targets[0]
  }
}

/** Verification, receipt durability, deduplication, replay, and Automation submission. */

import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import type { WebhookAutomationAdapter } from './adapter.ts'
import type { AutomationTarget } from './automation.ts'
import type { InboundEvent, VerifyResult } from './server.ts'
import { verifyRequest } from './sign.ts'
import {
  MAX_STORED_PAYLOAD_BYTES,
  type CallbackLogEntry,
  type CallbackTarget,
  type HookAuth,
  type WebhookDelivery,
  type WebhookHook,
  type WebhookStore,
} from './store.ts'

export interface AddHookInput {
  readonly name: string
  readonly promptTemplate: string
  readonly auth: HookAuth
  readonly target?: AutomationTarget
  readonly createdBy?: string | null
  readonly concurrencyLimit?: number
  readonly paused?: boolean
  readonly callbacks?: readonly CallbackTarget[]
}

export interface AddHookResult {
  readonly hook: WebhookHook
  readonly url: string
}

export interface ReplayResult {
  readonly submitted: boolean
  readonly deliveryId?: string
  readonly reason?: string
}

export interface WebhookEngineOptions {
  readonly store: WebhookStore
  readonly adapter: WebhookAutomationAdapter
  readonly now: () => number
  readonly resolveSecret: (ref: string) => Promise<string | undefined>
  readonly warn?: (message: string) => void
  readonly defaultTarget?: AutomationTarget
  readonly requireSecretsOnPublicBind: boolean
}

export interface WebhookService {
  add(input: AddHookInput): AddHookResult
  remove(name: string): boolean
  list(): readonly WebhookHook[]
  deliveries(name: string): readonly WebhookDelivery[]
  replay(deliveryId: string): Promise<ReplayResult>
  pause(name: string): boolean
  resume(name: string): boolean
  setTarget(name: string, target: AutomationTarget): boolean
  callbacks(limit?: number): readonly CallbackLogEntry[]
}

const EVENT_ID_HEADERS = ['x-github-delivery', 'x-gitlab-delivery', 'x-request-id']
const HOOK_NAME = new RegExp('^[a-z0-9][a-z0-9-]{0,63}$')

export class WebhookEngine {
  constructor(private readonly options: WebhookEngineOptions) {}

  service(): WebhookService {
    return {
      add: input => this.addHook(input), remove: name => this.removeHook(name), list: () => this.options.store.hooks(),
      deliveries: name => {
        const hook = this.options.store.hookByName(name)
        return hook === undefined ? [] : this.options.store.deliveries(hook.id)
      },
      replay: id => this.replay(id), pause: name => this.setPaused(name, true), resume: name => this.setPaused(name, false),
      setTarget: (name, target) => this.setTarget(name, target),
      callbacks: (limit = 20) => this.options.store.callbackLogs(limit),
    }
  }

  isKnownHook(name: string): boolean {
    return this.options.store.hookByName(name) !== undefined
  }

  validateAuth(auth: HookAuth, name: string): void {
    if (this.options.requireSecretsOnPublicBind && auth.kind === 'none') {
      throw new Error(`webhook_add: hook "${name}" has no secret but the server binds a public address; give it a secretRef or bind 127.0.0.1`)
    }
  }

  addHook(input: AddHookInput): AddHookResult {
    const name = input.name.trim()
    if (!HOOK_NAME.test(name)) throw new Error('webhook_add: name must match ^[a-z0-9][a-z0-9-]{0,63}$')
    if (input.promptTemplate.trim().length === 0) throw new Error('webhook_add: promptTemplate must be non-blank')
    if (this.options.store.hookByName(name) !== undefined) throw new Error(`webhook_add: a hook named "${name}" already exists`)
    this.validateAuth(input.auth, name)
    const target = input.target ?? this.options.defaultTarget
    if (target === undefined) throw new Error('webhook_add: a fresh Session target cwd is required')
    validTarget(target)
    const concurrencyLimit = input.concurrencyLimit ?? 1
    if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 1_000) {
      throw new Error('webhook_add: concurrencyLimit must be between 1 and 1000')
    }
    const now = new Date(this.options.now()).toISOString()
    const hook: WebhookHook = {
      id: this.options.store.allocateId('wh'), name, promptTemplate: input.promptTemplate.trim(), auth: input.auth,
      runTarget: target, concurrencyLimit, createdBy: input.createdBy ?? null, createdAt: now,
      deliveryCount: 0, lastDeliveryAt: null, paused: input.paused ?? false,
      ...(input.callbacks === undefined || input.callbacks.length === 0 ? {} : { callbacks: input.callbacks }),
    }
    this.options.store.insertHook(hook)
    return { hook, url: `/hooks/${name}` }
  }

  removeHook(name: string): boolean {
    const hook = this.options.store.hookByName(name)
    return hook === undefined ? false : this.options.store.removeHook(hook.id)
  }

  async verify(event: InboundEvent): Promise<VerifyResult> {
    const hook = this.options.store.hookByName(event.hookName)
    if (hook === undefined) return { ok: false, code: 404, reason: 'unknown hook' }
    if (hook.paused) return { ok: false, code: 403, reason: 'hook is paused' }
    if (hook.auth.kind === 'none' && !sourceAllowed(event.sourceIp)) {
      return { ok: false, code: 403, reason: 'this hook is loopback-only' }
    }
    const result = await verifyRequest(
      hook.auth, { headers: event.headers, body: event.rawBody }, ref => this.options.resolveSecret(ref),
    )
    return result.ok ? { ok: true } : { ok: false, code: 401, reason: result.reason }
  }

  async accept(event: InboundEvent): Promise<void> {
    const hook = this.options.store.hookByName(event.hookName)
    if (hook === undefined) return
    const receivedAt = new Date(this.options.now()).toISOString()
    const eventId = EVENT_ID_HEADERS.map(header => event.headers[header] ?? null)
      .find(value => value !== null && value.length > 0) ?? null
    if (eventId !== null && this.options.store.hasEvent(hook.id, eventId)) {
      this.options.warn?.(`dsh-webhook: duplicate event ${eventId} for ${hook.name}; dropped`)
      this.options.store.appendDelivery(this.makeDelivery(hook, receivedAt, event, eventId, 'rejected', 'duplicate event id'))
      return
    }
    const delivery = this.makeDelivery(hook, receivedAt, event, eventId, 'accepted')
    hook.deliveryCount += 1
    hook.lastDeliveryAt = receivedAt
    this.options.store.appendDelivery(delivery)
    await this.options.adapter.submit(hook, delivery)
  }

  async replay(deliveryId: string): Promise<ReplayResult> {
    const original = this.options.store.deliveryById(deliveryId)
    if (original === undefined) return { submitted: false, reason: 'delivery not found' }
    if (original.payload === undefined) return { submitted: false, reason: 'original payload was too large to store; replay is unavailable' }
    const hook = this.options.store.hookById(original.hookId)
    if (hook === undefined) return { submitted: false, reason: 'hook no longer exists' }
    if (hook.runTarget === null) return { submitted: false, reason: 'hook requires a fresh Session target' }
    const receivedAt = new Date(this.options.now()).toISOString()
    const replay: WebhookDelivery = {
      id: this.options.store.allocateId('dl'), hookId: hook.id, receivedAt, eventId: null,
      headers: original.headers, status: 'accepted', payload: original.payload,
      payloadExcerpt: original.payloadExcerpt, replayOf: original.id,
    }
    hook.deliveryCount += 1
    hook.lastDeliveryAt = receivedAt
    this.options.store.appendDelivery(replay)
    await this.options.adapter.submit(hook, replay)
    return { submitted: replay.automationRunId !== undefined, deliveryId: replay.id }
  }

  private setPaused(name: string, paused: boolean): boolean {
    const hook = this.options.store.hookByName(name)
    if (hook === undefined || (hook.runTarget === null && !paused)) return false
    return this.options.store.setPaused(hook.id, paused)
  }

  private setTarget(name: string, target: AutomationTarget): boolean {
    validTarget(target)
    const hook = this.options.store.hookByName(name)
    if (hook === undefined) return false
    hook.runTarget = target
    delete hook.migrationIssue
    this.options.store.flush()
    return true
  }

  private makeDelivery(
    hook: WebhookHook, receivedAt: string, event: InboundEvent, eventId: string | null,
    status: WebhookDelivery['status'], reason?: string,
  ): WebhookDelivery {
    const stored = event.text.length <= MAX_STORED_PAYLOAD_BYTES ? event.text : undefined
    const headers: Record<string, string> = {}
    let budget = 4_096
    for (const [key, value] of Object.entries(event.headers)) {
      if (budget <= 0) break
      headers[key] = value.slice(0, budget)
      budget -= headers[key].length
    }
    return {
      id: this.options.store.allocateId('dl'), hookId: hook.id, receivedAt, eventId, headers, status,
      ...(stored === undefined ? {} : { payload: stored }),
      ...(reason === undefined ? {} : { reason }), payloadExcerpt: event.text.slice(0, 400),
    }
  }
}

function sourceAllowed(ip: string): boolean {
  if (ip === '' || isIP(ip) === 0) return false
  const normalized = ip.replace(/^::ffff:/, '')
  return normalized === '127.0.0.1' || normalized === '::1'
}

function validTarget(target: AutomationTarget): void {
  if (target.kind !== 'fresh' || !isAbsolute(target.cwd)) throw new Error('webhook_add: fresh Session cwd must be absolute')
  if ((target.provider === undefined) !== (target.model === undefined)) throw new Error('webhook_add: provider and model must be supplied together')
}

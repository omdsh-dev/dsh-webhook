/** Cordis activation for the inbound webhook Trigger adapter. */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { WebhookAutomationAdapter } from './adapter.ts'
import { requireAutomation, type AutomationTarget } from './automation.ts'
import { deliveryCallbackEvent, CallbackDispatcher, type CallbackEvent } from './callbacks.ts'
import { registerWebhookCommand } from './command.ts'
import { isPublicBind, resolveConfig, type Config } from './config.ts'
import { WebhookEngine } from './engine.ts'
import { acquireListenerLock } from './lock.ts'
import { RateLimiter, WebhookServer } from './server.ts'
import { WebhookStore, type WebhookDelivery, type WebhookHook } from './store.ts'
import { registerWebhookTools } from './tools.ts'

export interface PluginRuntime {
  now(): number
  resolveSecret(ref: string): Promise<string | undefined>
  warn(message: string): void
  info(message: string): void
}

export function createPluginRuntime(ctx: Context): PluginRuntime {
  return {
    now: () => Date.now(),
    resolveSecret: async ref => {
      const credentials = ctx.get('credentials') as { resolve(ref: string): Promise<{ value: string } | undefined> } | undefined
      return (await credentials?.resolve(ref))?.value
    },
    warn: message => { ctx.logger.warn(message) },
    info: message => { ctx.logger.info(message) },
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const runtime = createPluginRuntime(ctx)
  const automation = requireAutomation(ctx.get('automation'))
  const dataDir = resolved.dataDir ?? join(resolveDshHome(), 'webhook')
  const defaultTarget: AutomationTarget | undefined = resolved.defaultCwd === undefined
    ? undefined
    : { kind: 'fresh', cwd: resolved.defaultCwd }
  const store = new WebhookStore(join(dataDir, 'store.json'), message => runtime.warn(message), defaultTarget)
  store.load()

  const dispatcher = createDispatcher(store, resolved.callbackRetries, runtime)
  const emitCallbacks = (
    event: CallbackEvent,
    hookTargets: readonly { target: string; secretRef?: string; statuses?: readonly string[]; outcomes?: readonly string[] }[] = [],
  ): void => { dispatcher.emit(event, resolved.callbacks, hookTargets) }
  const adapter = new WebhookAutomationAdapter(
    store, automation, message => runtime.warn(message),
    (hook, delivery) => emitSettled(delivery, hook, emitCallbacks),
  )
  const engine = new WebhookEngine({
    store, adapter, now: () => runtime.now(), resolveSecret: ref => runtime.resolveSecret(ref),
    ...(defaultTarget === undefined ? {} : { defaultTarget }),
    requireSecretsOnPublicBind: isPublicBind(resolved.bind), warn: message => runtime.warn(message),
  })

  installStaticHooks(engine, resolved.hooks, defaultTarget, runtime)
  const server = new WebhookServer({
    bind: resolved.bind, port: resolved.port, maxPayloadBytes: resolved.maxPayloadBytes,
    rateLimit: new RateLimiter(resolved.rateLimitPerMinute),
    isKnownHook: name => engine.isKnownHook(name), verify: event => engine.verify(event),
    onAccepted: event => engine.accept(event),
    onReject: (event, reason, detail) => {
      runtime.warn(`dsh-webhook: rejected ${reason} for ${event.hookName} (${event.sourceIp}): ${detail}`)
    },
    onListening: (host, port) => { runtime.info(`dsh-webhook: listening on ${host}:${port}`) },
  })

  ctx.provide('webhook', engine.service())
  ctx.provide('callbacks', { emit: (event: CallbackEvent) => { emitCallbacks(event) } })
  registerWebhookTools(ctx, engine)
  ctx.inject(['commands'], commandCtx => {
    commandCtx.effect(() => registerWebhookCommand(commandCtx, engine), 'dsh-webhook: command')
  })
  ctx.effect(() => store.watch(hooks => {
    runtime.info(`dsh-webhook: store reloaded (${hooks} hook(s))`)
  }), 'dsh-webhook: store watch')
  ctx.effect(() => {
    const timer = setInterval(() => { void dispatcher.retryDue() }, 5_000)
    timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-webhook: callback retries')
  ctx.effect(() => mountListener(dataDir, store, server, adapter, resolved.reconcilePollMs, runtime), 'dsh-webhook: listener')
}

function createDispatcher(store: WebhookStore, callbackRetries: number, runtime: PluginRuntime): CallbackDispatcher {
  return new CallbackDispatcher({
    store, now: () => runtime.now(), resolveSecret: ref => runtime.resolveSecret(ref),
    warn: message => runtime.warn(message), info: message => runtime.info(message),
    retry: { maxAttempts: callbackRetries, backoffBaseMs: 2_000, maxBackoffMs: 300_000 },
    onAttempt: (deliveryId, attempt) => {
      const delivery = store.deliveryById(deliveryId)
      if (delivery === undefined) return
      delivery.lastCallback = attempt
      store.flush()
    },
  })
}

type HookCallback = NonNullable<WebhookHook['callbacks']>[number]

function emitSettled(
  delivery: WebhookDelivery,
  hook: WebhookHook | undefined,
  emit: (event: CallbackEvent, targets?: readonly HookCallback[]) => void,
): void {
  const subject = hook === undefined
    ? `${delivery.id} ${delivery.executionState ?? 'settled'}`
    : `${hook.name} · ${delivery.id} ${delivery.executionState ?? 'settled'}`
  emit(deliveryCallbackEvent(delivery, subject, delivery.completedAt), hook?.callbacks ?? [])
}

function installStaticHooks(
  engine: WebhookEngine,
  hooks: ReturnType<typeof resolveConfig>['hooks'],
  defaultTarget: AutomationTarget | undefined,
  runtime: PluginRuntime,
): void {
  for (const hook of hooks) {
    try {
      const authKind = hook.authKind ?? 'none'
      if (authKind !== 'none' && (hook.secretRef ?? '').length === 0) {
        throw new Error(`dsh-webhook: static hook "${hook.name}" uses ${authKind} auth but no secretRef is configured`)
      }
      const target: AutomationTarget | undefined = hook.cwd === undefined ? defaultTarget : { kind: 'fresh', cwd: hook.cwd }
      engine.addHook({
        name: hook.name, promptTemplate: hook.promptTemplate,
        auth: authKind === 'none'
          ? { kind: 'none' }
          : authKind === 'bearer'
            ? { kind: 'bearer', secretRef: hook.secretRef as string, ...(hook.header === undefined ? {} : { header: hook.header }) }
            : { kind: 'hmac-sha256', secretRef: hook.secretRef as string, ...(hook.header === undefined ? {} : { header: hook.header }) },
        ...(target === undefined ? {} : { target }),
        ...(hook.concurrencyLimit === undefined ? {} : { concurrencyLimit: hook.concurrencyLimit }),
        createdBy: null,
        ...(hook.paused === undefined ? {} : { paused: hook.paused }),
        ...(hook.callbacks === undefined || hook.callbacks.length === 0 ? {} : { callbacks: hook.callbacks }),
      })
    } catch (error) {
      if ((error as Error).message.includes('already exists')) {
        runtime.warn(`dsh-webhook: static hook "${hook.name}" skipped (already registered)`)
        continue
      }
      throw error
    }
  }
}

function mountListener(
  dataDir: string,
  store: WebhookStore,
  server: WebhookServer,
  adapter: WebhookAutomationAdapter,
  reconcilePollMs: number,
  runtime: PluginRuntime,
): () => void {
  let lock = acquireListenerLock(dataDir, value => runtime.warn(value))
  let takeover: ReturnType<typeof setInterval> | null = null
  let reconcile: ReturnType<typeof setInterval> | null = null
  let started = false
  const reconcileNow = (): void => {
    void adapter.submitPending().then(() => adapter.reconcile()).catch(error => {
      runtime.warn(`dsh-webhook: Automation reconciliation failed: ${message(error)}`)
    })
  }
  const start = (): void => {
    if (started) return
    started = true
    store.load()
    reconcileNow()
    reconcile = setInterval(reconcileNow, reconcilePollMs)
    reconcile.unref()
    void server.start().catch(error => { runtime.warn(`dsh-webhook: failed to listen: ${message(error)}`) })
  }
  if (lock.acquired) start()
  else {
    takeover = setInterval(() => {
      lock = acquireListenerLock(dataDir, value => runtime.warn(value))
      if (!lock.acquired) return
      if (takeover !== null) clearInterval(takeover)
      takeover = null
      start()
      runtime.info('dsh-webhook: took over the listener')
    }, 60_000)
  }
  return () => {
    if (takeover !== null) clearInterval(takeover)
    if (reconcile !== null) clearInterval(reconcile)
    void server.close()
    lock.release()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

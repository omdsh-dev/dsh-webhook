/**
 * dsh-webhook: inbound webhooks for DeepSeek Harness. Signed HTTP events
 * become idempotent fresh-Session Automation Runs with durable receipts,
 * deduplication, reconciliation, and replay.
 * @module dsh-webhook
 */

export const name = 'dsh-webhook'

/** Services that must exist before the plugin is applied. */
export const inject = ['automation', 'tools']

export { Config } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { apply } from './runtime.ts'
export type { PluginRuntime } from './runtime.ts'
export type { WebhookService, AddHookInput, AddHookResult, ReplayResult } from './engine.ts'
export type { WebhookHook, WebhookDelivery, HookAuth, CallbackTarget, CallbackLogEntry, PendingRetry } from './store.ts'
export type { CallbackEvent, CallbackRule, CallbackEventSource, CallbackRetryPolicy } from './callbacks.ts'

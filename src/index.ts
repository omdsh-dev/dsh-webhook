/**
 * dsh-webhook: inbound webhooks for DeepSeek Harness. Signed HTTP events
 * become executed agent tasks with delivery receipts, deduplication, and
 * replay — the event-driven counterpart to dsh-cron's schedules.
 * @module dsh-webhook
 */

export const name = 'dsh-webhook'

/** Services that must exist before the plugin is applied. */
export const inject = ['agents', 'tools']

export { Config } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { apply } from './runtime.ts'
export type { PluginRuntime } from './runtime.ts'
export type { WebhookService, WebhookTarget, AddHookInput, AddHookResult, ReplayResult } from './engine.ts'
export type { WebhookHook, WebhookDelivery, HookAuth } from './store.ts'

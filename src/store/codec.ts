import type { AutomationTarget } from '../automation.ts'
import type { CallbackLogEntry, PendingRetry, WebhookDelivery, WebhookHook } from './types.ts'

export const STORE_VERSION = 3
export const MAX_DELIVERIES_PER_HOOK = 50
export const MAX_CALLBACK_LOG = 100
export const MAX_PENDING_RETRIES = 100
export const MAX_STORED_PAYLOAD_BYTES = 8_192

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isValidHook(value: unknown): value is WebhookHook {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return false
  if (typeof value.promptTemplate !== 'string' || typeof value.createdAt !== 'string') return false
  if (value.target !== undefined && value.target !== null && typeof value.target !== 'string') return false
  if (value.runTarget !== undefined && value.runTarget !== null && !isRecord(value.runTarget)) return false
  if (value.createdBy !== null && typeof value.createdBy !== 'string') return false
  if (typeof value.deliveryCount !== 'number') return false
  if (value.lastDeliveryAt !== null && typeof value.lastDeliveryAt !== 'string') return false
  if (value.paused !== undefined && typeof value.paused !== 'boolean') return false
  const auth = value.auth
  if (!isRecord(auth)) return false
  if (auth.kind === 'none') return true
  return (auth.kind === 'hmac-sha256' || auth.kind === 'bearer') && typeof auth.secretRef === 'string'
}

export function normalizeHook(hook: WebhookHook, fallback: AutomationTarget | undefined): WebhookHook {
  hook.runTarget ??= fallback ?? null
  hook.concurrencyLimit ??= 1
  hook.paused ??= false
  if (hook.runTarget === null) {
    hook.paused = true
    hook.migrationIssue ??= 'legacy hook requires a fresh Session target before it can resume'
  }
  return hook
}

export function isValidDelivery(value: unknown): value is WebhookDelivery {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.hookId !== 'string') return false
  if (typeof value.receivedAt !== 'string' || typeof value.payloadExcerpt !== 'string') return false
  if (value.eventId !== null && typeof value.eventId !== 'string') return false
  if (!isRecord(value.headers)) return false
  return value.status === 'accepted' || value.status === 'rejected' || value.status === 'submitted' || value.status === 'settled'
    || value.status === 'delivered' || value.status === 'held'
}

export function normalizeDelivery(delivery: WebhookDelivery): WebhookDelivery {
  if ((delivery.status === 'delivered' || delivery.status === 'held') && delivery.executionState === undefined) {
    delivery.executionState = 'legacy'
  }
  return delivery
}

export function isValidCallbackEntry(value: unknown): value is CallbackLogEntry {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.subject !== 'string') return false
  if (typeof value.target !== 'string' || typeof value.sentAt !== 'string') return false
  if (value.source !== 'webhook' && value.source !== 'cron') return false
  if (value.status !== 'sent' && value.status !== 'failed') return false
  if (value.attempt !== undefined && (typeof value.attempt !== 'number' || !Number.isSafeInteger(value.attempt) || value.attempt < 1)) return false
  return value.error === undefined || typeof value.error === 'string'
}

export function isValidRetry(value: unknown): value is PendingRetry {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.subject !== 'string' || typeof value.target !== 'string') return false
  if (value.source !== 'webhook' && value.source !== 'cron') return false
  if (typeof value.nextDueAt !== 'number' || !Number.isSafeInteger(value.nextDueAt)) return false
  if (typeof value.attempts !== 'number' || !Number.isSafeInteger(value.attempts) || value.attempts < 1) return false
  if (value.eventId !== undefined && value.eventId !== null && typeof value.eventId !== 'string') return false
  if (value.secretRef !== undefined && typeof value.secretRef !== 'string') return false
  for (const key of ['status', 'outcome', 'excerpt', 'hookId', 'deliveryId', 'jobId', 'runId', 'firedAt', 'receivedAt', 'completedAt', 'lastError'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false
  }
  return true
}

export function terminalDelivery(delivery: WebhookDelivery): boolean {
  return delivery.status === 'rejected' || delivery.status === 'settled'
    || delivery.status === 'delivered' || delivery.status === 'held'
}

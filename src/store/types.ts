import type { AutomationRunState, AutomationTarget } from '../automation.ts'

export interface HmacAuth {
  readonly kind: 'hmac-sha256'
  readonly secretRef: string
  readonly header?: string
}

export interface TokenAuth {
  readonly kind: 'bearer'
  readonly secretRef: string
  readonly header?: string
}

export interface NoneAuth { readonly kind: 'none' }
export type HookAuth = HmacAuth | TokenAuth | NoneAuth

export interface CallbackTarget {
  readonly target: string
  readonly secretRef?: string
  readonly statuses?: readonly string[]
  readonly outcomes?: readonly string[]
}

export interface WebhookHook {
  readonly id: string
  readonly name: string
  readonly promptTemplate: string
  readonly auth: HookAuth
  /** Legacy Session id retained only for migration audit. */
  readonly target?: string | null
  readonly createdBy: string | null
  runTarget: AutomationTarget | null
  concurrencyLimit: number
  migrationIssue?: string
  readonly createdAt: string
  deliveryCount: number
  lastDeliveryAt: string | null
  paused: boolean
  callbacks?: readonly CallbackTarget[]
}

export interface WebhookDelivery {
  readonly id: string
  readonly hookId: string
  readonly receivedAt: string
  readonly eventId: string | null
  readonly headers: Record<string, string>
  status: 'accepted' | 'rejected' | 'submitted' | 'settled' | 'delivered' | 'held'
  reason?: string
  payload?: string
  readonly payloadExcerpt: string
  automationRunId?: string
  idempotencyKey?: string
  executionState?: AutomationRunState | 'legacy'
  outcome?: string
  excerpt?: string
  error?: string
  completedAt?: string
  lastEventSeq?: number
  replayOf?: string
  lastCallback?: {
    readonly target: string
    readonly status: 'sent' | 'failed'
    readonly sentAt: string
    readonly attempt?: number
    readonly error?: string
  }
}

export interface CallbackLogEntry {
  readonly id: string
  readonly source: 'webhook' | 'cron'
  readonly subject: string
  readonly target: string
  readonly status: 'sent' | 'failed'
  readonly attempt?: number
  readonly error?: string
  readonly sentAt: string
}

export interface PendingRetry {
  readonly id: string
  readonly source: 'webhook' | 'cron'
  readonly subject: string
  readonly status?: string
  readonly outcome?: string
  readonly excerpt?: string
  readonly eventId?: string | null
  readonly hookId?: string
  readonly deliveryId?: string
  readonly jobId?: string
  readonly runId?: string
  readonly firedAt?: string
  readonly receivedAt?: string
  readonly completedAt?: string
  readonly target: string
  readonly secretRef?: string
  attempts: number
  nextDueAt: number
  readonly lastError?: string
}

export interface StoreSnapshot {
  hooks: WebhookHook[]
  deliveries: WebhookDelivery[]
  callbacks: CallbackLogEntry[]
  retries: PendingRetry[]
}

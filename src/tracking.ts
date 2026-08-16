/**
 * Dispatch outcome tracking: after an event task is delivered into a session,
 * watch that session's event stream until the turn settles and record the
 * outcome back onto the delivery receipt.
 * @module dsh-webhook/tracking
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { WebhookDelivery } from './store.ts'

/** How long a delivered event task may run before its outcome records as timeout. */
const RUN_TIMEOUT_MS = 10 * 60_000

/** Assistant text kept for the excerpt; the record keeps a bounded prefix. */
const EXCERPT_CHARS = 200
const EXCERPT_BUFFER_CHARS = 8_192

interface PendingRun {
  readonly deliveryId: string
  chunks: string[]
  readonly timer: ReturnType<typeof setTimeout>
}

export function outcomeOf(reason: TurnEndReason): Exclude<WebhookDelivery['outcome'], undefined> {
  switch (reason.kind) {
    case 'completed':
    case 'max-tokens':
    case 'blocked':
      return 'completed'
    case 'aborted':
    case 'interrupted':
      return 'cancelled'
    case 'error':
      return 'error'
    default:
      // Merge-extensible union: unknown future reasons mean the turn ended.
      return 'completed'
  }
}

export interface OutcomeTracker {
  /** Begin watching the target session for one dispatched event. */
  track(deliveryId: string, sessionId: string): void
}

/**
 * Create the tracker. One pending run per session; a new dispatch to the same
 * session supersedes the previous watch.
 * @param ctx - plugin context providing the session/event feed.
 * @param recordOutcome - persists one settled outcome onto a delivery.
 * @param now - wall clock, injectable for tests.
 */
export function createOutcomeTracker(
  ctx: Context,
  recordOutcome: (deliveryId: string, run: { outcome: NonNullable<WebhookDelivery['outcome']>; excerpt?: string; completedAt: string }) => void,
  now: () => number = () => Date.now(),
): OutcomeTracker {
  const pending = new Map<string, PendingRun>()

  const settle = (sessionId: string, outcome: NonNullable<WebhookDelivery['outcome']>): void => {
    const run = pending.get(sessionId)
    if (run === undefined) return
    pending.delete(sessionId)
    clearTimeout(run.timer)
    const excerpt = run.chunks.join('').slice(0, EXCERPT_CHARS)
    recordOutcome(run.deliveryId, {
      outcome,
      ...(excerpt.length > 0 ? { excerpt } : {}),
      completedAt: new Date(now()).toISOString(),
    })
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const run = pending.get(String(session.id))
      if (run === undefined) return
      if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
        const total = run.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        if (total < EXCERPT_BUFFER_CHARS) run.chunks.push(event.data.chunk.text)
        return
      }
      if (event.type === 'turn/end') settle(String(session.id), outcomeOf(event.data.reason))
    })
    return () => {
      off()
      for (const run of pending.values()) clearTimeout(run.timer)
      pending.clear()
    }
  }, 'dsh-webhook: outcome-tracker')

  return {
    track(deliveryId, sessionId) {
      const existing = pending.get(sessionId)
      if (existing !== undefined) {
        clearTimeout(existing.timer)
        pending.delete(sessionId)
      }
      const timer = setTimeout(() => { settle(sessionId, 'timeout') }, RUN_TIMEOUT_MS)
      pending.set(sessionId, { deliveryId, chunks: [], timer })
    },
  }
}

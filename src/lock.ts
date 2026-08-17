/**
 * Single-instance listener lock. Two dsh processes sharing one Harness home
 * both load this plugin; without coordination each would bind the same port.
 * The lock holder runs the HTTP listener; other instances stay management-only.
 * @module dsh-webhook/lock
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { acquireDirLock } from './filelock.ts'

export interface ListenerLock {
  /** Whether this process holds the lock and may run the listener. */
  readonly acquired: boolean
  /** Release the lock; a no-op when not held. */
  release(): void
}

/**
 * Acquire the listener lock under the store directory.
 * @param dataDir - the webhook store directory.
 * @param warn - sink for the passive-mode notice.
 * @returns the lock handle; `acquired: false` means another live process owns it.
 */
export function acquireListenerLock(dataDir: string, warn: (message: string) => void): ListenerLock {
  // The store directory may not exist yet on a fresh home; the lock mkdir
  // itself must stay non-recursive so an existing lock keeps failing.
  mkdirSync(dataDir, { recursive: true })
  const lock = acquireDirLock(join(dataDir, 'listener.lock'))
  if (!lock.acquired) {
    if (lock.reason === 'held') {
      warn(`dsh-webhook: another instance (pid ${lock.heldBy}) owns the listener; this one is management-only`)
    } else {
      warn('dsh-webhook: listener lock contention; this instance is management-only')
    }
  }
  return { acquired: lock.acquired, release: lock.release }
}

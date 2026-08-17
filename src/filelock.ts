/**
 * Cross-process directory-lock primitives. A directory acts as an atomic
 * lock: mkdir succeeds for exactly one process, and a pid file records the
 * holder so a lock left behind by a dead process can be taken over.
 * @module dsh-webhook/filelock
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DirLock {
  readonly acquired: boolean
  /** Why the lock was not acquired, when `acquired` is false. */
  readonly reason: 'acquired' | 'held' | 'exhausted'
  /** Pid of the live holder, when another process holds the lock. */
  readonly heldBy: number | null
  /** Release the lock; a no-op when not held. */
  release(): void
}

/** Read the holder pid recorded in a lock directory, or null. */
export function readLockPid(lockDir: string): number | null {
  try {
    const text = readFileSync(join(lockDir, 'pid'), 'utf8').trim()
    const pid = Number(text)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Whether a pid refers to a live process on this host. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH means the holder is gone and the lock is stale; EPERM means it
    // exists but is owned by another user — still held.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Try to acquire a directory lock, taking over a stale lock left by a dead
 * holder. Never blocks: on contention it reports `held` (a live holder owns
 * it) or `exhausted` (takeover rounds raced), and the caller decides how to
 * degrade.
 * @param lockDir - lock directory; the parent must already exist.
 * @param attempts - how many stale-takeover rounds to try.
 */
export function acquireDirLock(lockDir: string, attempts = 2): DirLock {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), String(process.pid))
      let held = true
      return {
        acquired: true,
        reason: 'acquired',
        heldBy: null,
        release() {
          if (!held) return
          held = false
          rmSync(lockDir, { recursive: true, force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = readLockPid(lockDir)
      if (pid !== null && pidAlive(pid)) {
        return { acquired: false, reason: 'held', heldBy: pid, release: () => {} }
      }
      // The holder died without cleanup; take the lock over.
      rmSync(lockDir, { recursive: true, force: true })
    }
  }
  return { acquired: false, reason: 'exhausted', heldBy: null, release: () => {} }
}

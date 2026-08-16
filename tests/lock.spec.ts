import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireListenerLock } from '../src/lock.ts'

describe('acquireListenerLock', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-webhook-lock-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('acquires, then releases, the listener lock', () => {
    const warn = vi.fn()
    const lock = acquireListenerLock(dir, warn)
    expect(lock.acquired).toBe(true)
    lock.release()
    const second = acquireListenerLock(dir, warn)
    expect(second.acquired).toBe(true)
    second.release()
    expect(warn).not.toHaveBeenCalled()
  })

  it('goes management-only when another live process holds the lock', () => {
    const warn = vi.fn()
    const holder = acquireListenerLock(dir, warn)
    const contender = acquireListenerLock(dir, warn)
    expect(holder.acquired).toBe(true)
    expect(contender.acquired).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('another instance'))
    contender.release()
    holder.release()
  })

  it('takes over a stale lock left by a dead holder', () => {
    const warn = vi.fn()
    const stale = acquireListenerLock(dir, warn)
    stale.release()
    expect(acquireListenerLock(dir, warn).acquired).toBe(true)
  })
})

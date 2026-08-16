import { createHmac } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { verifyRequest } from '../src/sign.ts'
import type { HookAuth } from '../src/store.ts'

function hmacSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

describe('verifyRequest', () => {
  const resolve = async (ref: string) => ref === 'SECRET' ? 's3cret' : undefined

  it('accepts a valid hmac-sha256 signature', async () => {
    const auth: HookAuth = { kind: 'hmac-sha256', secretRef: 'SECRET' }
    const body = Buffer.from('{"ok":true}')
    const result = await verifyRequest(auth, { headers: { 'x-hub-signature-256': hmacSignature('s3cret', body.toString()) }, body }, resolve)
    expect(result).toEqual({ ok: true })
  })

  it('rejects a tampered body', async () => {
    const auth: HookAuth = { kind: 'hmac-sha256', secretRef: 'SECRET' }
    const body = Buffer.from('{"ok":true}')
    const result = await verifyRequest(auth, { headers: { 'x-hub-signature-256': hmacSignature('s3cret', '{"ok":false}') }, body }, resolve)
    expect(result.ok).toBe(false)
  })

  it('rejects a missing or malformed signature header', async () => {
    const auth: HookAuth = { kind: 'hmac-sha256', secretRef: 'SECRET' }
    const body = Buffer.from('{}')
    expect((await verifyRequest(auth, { headers: {}, body }, resolve)).ok).toBe(false)
    expect((await verifyRequest(auth, { headers: { 'x-hub-signature-256': 'nonsense' }, body }, resolve)).ok).toBe(false)
  })

  it('rejects when the referenced secret is not configured', async () => {
    const auth: HookAuth = { kind: 'hmac-sha256', secretRef: 'MISSING' }
    const body = Buffer.from('{}')
    const result = await verifyRequest(auth, { headers: { 'x-hub-signature-256': 'sha256=aa' }, body }, resolve)
    expect(result.ok).toBe(false)
  })

  it('honors a custom signature header name', async () => {
    const auth: HookAuth = { kind: 'hmac-sha256', secretRef: 'SECRET', header: 'x-signature' }
    const body = Buffer.from('{}')
    const result = await verifyRequest(auth, { headers: { 'x-signature': hmacSignature('s3cret', '{}') }, body }, resolve)
    expect(result).toEqual({ ok: true })
  })

  it('accepts a matching bearer token in the Authorization header', async () => {
    const auth: HookAuth = { kind: 'bearer', secretRef: 'SECRET' }
    const body = Buffer.from('{}')
    const ok = await verifyRequest(auth, { headers: { authorization: 'Bearer s3cret' }, body }, resolve)
    expect(ok).toEqual({ ok: true })
  })

  it('rejects a mismatched bearer token', async () => {
    const auth: HookAuth = { kind: 'bearer', secretRef: 'SECRET' }
    const body = Buffer.from('{}')
    const result = await verifyRequest(auth, { headers: { authorization: 'Bearer wrong' }, body }, resolve)
    expect(result.ok).toBe(false)
  })

  it('passes none-auth without secret resolution', async () => {
    const result = await verifyRequest({ kind: 'none' }, { headers: {}, body: Buffer.from('{}') }, resolve)
    expect(result).toEqual({ ok: true })
  })
})

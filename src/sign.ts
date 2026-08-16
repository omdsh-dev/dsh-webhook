/**
 * Signature and token verification for inbound webhook requests.
 * @module dsh-webhook/sign
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { HookAuth } from './store.js'

/** Resolves a credential reference to its current value, or undefined. */
export type SecretResolver = (secretRef: string) => Promise<string | undefined>

const DEFAULT_HMAC_HEADER = 'x-hub-signature-256'
const DEFAULT_BEARER_HEADER = 'authorization'

export interface VerifyContext {
  readonly headers: Record<string, string | undefined>
  /** Raw request body; verified only after HMAC/Bearer check. */
  readonly body: Buffer
}

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Verify a request against the hook's auth profile. Secret resolution happens
 * here, at verify time, so credential rotation takes effect without touching
 * the hook definition.
 */
export async function verifyRequest(
  auth: HookAuth,
  context: VerifyContext,
  resolve: SecretResolver,
): Promise<VerifyResult> {
  switch (auth.kind) {
    case 'none':
      // Callers must have already enforced loopback-only reachability.
      return { ok: true }
    case 'bearer': {
      const expected = await resolve(auth.secretRef)
      if (!expected) return { ok: false, reason: `secret ${auth.secretRef} is not configured` }
      const headerName = (auth.header ?? DEFAULT_BEARER_HEADER).toLowerCase()
      const provided = context.headers[headerName]
      if (!provided) return { ok: false, reason: `missing ${headerName} header` }
      const token = auth.header ? provided : provided.replace(/^Bearer\s+/i, '')
      if (!token || !constantTimeEqual(Buffer.from(token), Buffer.from(expected))) {
        return { ok: false, reason: 'token mismatch' }
      }
      return { ok: true }
    }
    case 'hmac-sha256': {
      const expected = await resolve(auth.secretRef)
      if (!expected) return { ok: false, reason: `secret ${auth.secretRef} is not configured` }
      const headerName = (auth.header ?? DEFAULT_HMAC_HEADER).toLowerCase()
      const signature = context.headers[headerName]
      if (!signature) return { ok: false, reason: `missing ${headerName} header` }
      const match = /^sha256=(.+)$/i.exec(signature)
      if (!match) return { ok: false, reason: `malformed ${headerName} header` }
      const digest = createHmac('sha256', expected).update(context.body).digest()
      const provided = Buffer.from(match[1] ?? '', 'hex')
      if (provided.length === 0 || !constantTimeEqual(digest, provided)) {
        return { ok: false, reason: 'signature mismatch' }
      }
      return { ok: true }
    }
  }
}

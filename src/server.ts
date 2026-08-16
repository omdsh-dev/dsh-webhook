/**
 * Inbound HTTP server for dsh-webhook. Owns its own node:http listener so it
 * works in every profile (headless included) with an explicit bind/port.
 * Verification runs before the response so senders see honest status codes:
 * 401 for a bad signature, 403 for loopback-only hooks hit off-loopback,
 * 404 for unknown hooks, 429 when rate-limited, 413 when the body is too big.
 * @module dsh-webhook/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'

/** How the server classifies a request for logging and tracking. */
export type RejectionReason =
  | 'method'
  | 'path'
  | 'unknown-hook'
  | 'payload-too-large'
  | 'body-invalid'
  | 'rate-limited'
  | 'signature'
  | 'forbidden-source'

export interface InboundEvent {
  readonly hookName: string
  readonly headers: Record<string, string>
  readonly rawBody: Buffer
  readonly text: string
  /** Source address of the request, for loopback enforcement. */
  readonly sourceIp: string
}

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 401 | 403 | 404; readonly reason: string }

/** Caller-provided verification; runs before the response is written. */
export type VerifyHandler = (event: InboundEvent) => Promise<VerifyResult>

/** Caller-provided accepted handler; runs asynchronously after the 200 ack. */
export type AcceptedHandler = (event: InboundEvent) => Promise<void> | void

/** Rejection sink; receives the classification and a human reason. */
export type RejectHandler = (event: InboundEvent, reason: RejectionReason, detail: string) => void

export interface ServerOptions {
  readonly bind: string
  readonly port: number
  /** Request body cap in bytes; larger requests are rejected before parsing. */
  readonly maxPayloadBytes: number
  readonly rateLimit: RateLimiter
  /** Whether a hook name resolves to a registered endpoint. */
  readonly isKnownHook: (name: string) => boolean
  readonly verify: VerifyHandler
  readonly onAccepted: AcceptedHandler
  readonly onReject: RejectHandler
  /** Called with the resolved listen address after start. */
  readonly onListening: (host: string, port: number) => void
}

/** Per-hook sliding-window rate limiter. */
export class RateLimiter {
  private readonly stamps = new Map<string, number[]>()

  constructor(private readonly perMinute: number) {}

  /** Whether a request from the key is within budget; records on allowance. */
  allow(key: string, now = Date.now()): boolean {
    const window = now - 60_000
    const recent = (this.stamps.get(key) ?? []).filter(stamp => stamp > window)
    if (recent.length >= this.perMinute) {
      this.stamps.set(key, recent)
      return false
    }
    recent.push(now)
    this.stamps.set(key, recent)
    return true
  }

  /** Forget a key (used when a hook is removed). */
  reset(key: string): void {
    this.stamps.delete(key)
  }
}

function writeStatus(response: ServerResponse, code: number, body: string): void {
  response.writeHead(code, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ status: code, message: body }))
}

/** Read the request body up to a byte cap, rejecting oversized payloads. */
function readBody(request: IncomingMessage, cap: number): Promise<{ buffer: Buffer; tooLarge: boolean }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > cap) {
        // Discard the rest; the 413 response is written once the stream ends.
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      resolve({ buffer: Buffer.concat(chunks), tooLarge })
    })
    request.on('error', () => {
      if (!tooLarge) resolve({ buffer: Buffer.alloc(0), tooLarge: false })
    })
  })
}

function collectHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[key] = value
    else if (Array.isArray(value)) headers[key] = value.join(', ')
  }
  return headers
}

/**
 * Inbound webhook listener. Exposes one route: `POST /hooks/<name>`. Every
 * other method or path is rejected immediately. A request is acknowledged as
 * soon as it passes verification; the caller then processes it asynchronously.
 */
export class WebhookServer {
  private server: Server | undefined

  constructor(private readonly options: ServerOptions) {}

  /** Start listening; resolves with the actual bind address. */
  start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('dsh-webhook: server already started')
    const server = createServer((request, response) => void this.handle(request, response))
    this.server = server
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        const address = server.address() as AddressInfo
        resolve({ host: address.address, port: address.port })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.port, this.options.bind)
    })
  }

  /** Current listening port, once started. */
  get port(): number {
    const address = this.server?.address() as AddressInfo | undefined
    return address ? address.port : 0
  }

  /** Stop listening and release the port. */
  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      // Force-close lingering sockets so shutdown does not hang.
      server.closeAllConnections()
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      writeStatus(response, 405, 'method not allowed; use POST')
      return
    }
    const path = request.url ?? ''
    const match = /^\/hooks\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(path)
    if (!match) {
      writeStatus(response, 404, 'unknown endpoint')
      return
    }
    const hookName = match[1] ?? ''
    const headers = collectHeaders(request)
    const sourceIp = request.socket.remoteAddress ?? ''

    if (!this.options.isKnownHook(hookName)) {
      writeStatus(response, 404, 'unknown hook')
      const event = this.buildEvent(hookName, headers, Buffer.alloc(0), sourceIp)
      this.options.onReject(event, 'unknown-hook', 'no hook registered under this name')
      return
    }

    if (!this.options.rateLimit.allow(hookName)) {
      writeStatus(response, 429, 'rate limit exceeded')
      const event = this.buildEvent(hookName, headers, Buffer.alloc(0), sourceIp)
      this.options.onReject(event, 'rate-limited', 'rate limit exceeded')
      return
    }

    const { buffer, tooLarge } = await readBody(request, this.options.maxPayloadBytes)
    if (tooLarge) {
      writeStatus(response, 413, 'payload too large')
      const event = this.buildEvent(hookName, headers, buffer, sourceIp)
      this.options.onReject(event, 'payload-too-large', 'payload exceeds maxPayloadBytes')
      return
    }

    const event = this.buildEvent(hookName, headers, buffer, sourceIp)
    const verified = await this.options.verify(event)
    if (!verified.ok) {
      writeStatus(response, verified.code, verified.reason)
      const reason: RejectionReason = verified.code === 403 ? 'forbidden-source' : 'signature'
      this.options.onReject(event, reason, verified.reason)
      return
    }
    writeStatus(response, 200, 'accepted')
    await this.options.onAccepted(event)
  }

  private buildEvent(
    hookName: string,
    headers: Record<string, string>,
    buffer: Buffer,
    sourceIp: string,
  ): InboundEvent {
    const text = buffer.toString('utf8')
    return { hookName, headers, rawBody: buffer, text, sourceIp }
  }
}

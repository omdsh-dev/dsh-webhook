/**
 * Plugin configuration for dsh-webhook.
 * @module dsh-webhook/config
 */

import z from '@deepseek-ai/schemastery'

/** Static hook definitions declared in configuration. */
export interface StaticHook {
  /** URL slug; the endpoint is `POST /hooks/<name>`. */
  name: string
  /** Prompt template; `{{payload.path}}` and `{{header.name}}` interpolate. */
  promptTemplate: string
  /** Verification kind; defaults to `none` (loopback only). */
  authKind?: 'none' | 'hmac-sha256' | 'bearer'
  /** Credential reference holding the secret; required for signed kinds. */
  secretRef?: string
  /** Custom header name carrying the signature or token. */
  header?: string
  /** Preferred delivery target session id, optional. */
  target?: string | null
}

export interface Config {
  /** Listen address. A public bind refuses secret-less hooks. */
  readonly bind?: '127.0.0.1' | '0.0.0.0'
  /** Listen port. */
  readonly port?: number
  /** Request body cap in bytes. */
  readonly maxPayloadBytes?: number
  /** Per-hook accepted-request budget per minute. */
  readonly rateLimitPerMinute?: number
  /** Delivery mode into a busy target: follow-up turn, or injected notice. */
  readonly busyDelivery?: 'followup' | 'inject'
  /** Resume a cold creating session for delivery. */
  readonly coldWake?: boolean
  /** Data directory; defaults to `$DSH_HOME/webhook`. */
  readonly dataDir?: string
  /** Static hooks installed on load. */
  readonly hooks?: readonly StaticHook[]
}

export interface ResolvedConfig {
  readonly bind: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  readonly maxPayloadBytes: number
  readonly rateLimitPerMinute: number
  readonly busyDelivery: 'followup' | 'inject'
  readonly coldWake: boolean
  readonly dataDir: string | null
  readonly hooks: readonly StaticHook[]
}

/** Public bind: secret-less hooks are refused everywhere. */
export function isPublicBind(bind: string): boolean {
  return bind !== '127.0.0.1'
}

const staticHookSchema = z.object({
  name: z.string(),
  promptTemplate: z.string(),
  authKind: z.union([z.const('none'), z.const('hmac-sha256'), z.const('bearer')]).default('none'),
  secretRef: z.string(),
  header: z.string(),
  target: z.string(),
})

/**
 * Loader-visible configuration schema and defaults. The schema's inferred
 * output widens every field to `| null`; the plugin-facing {@link Config}
 * interface keeps the honest optional shape, so the cast bridges them and
 * validation is asserted by tests.
 */
export const Config = z.object({
  bind: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).default('127.0.0.1'),
  port: z.natural().max(65535).default(8788),
  maxPayloadBytes: z.natural().default(262_144),
  rateLimitPerMinute: z.natural().default(60),
  busyDelivery: z.union([z.const('followup'), z.const('inject')]).default('followup'),
  coldWake: z.boolean().default(false),
  dataDir: z.string(),
  hooks: z.array(staticHookSchema),
}) as unknown as z<Config>

export function resolveConfig(config: Config): ResolvedConfig {
  const bind = config.bind ?? '127.0.0.1'
  const port = config.port ?? 8788
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`dsh-webhook: port must be an integer in 1..65535, got ${port}`)
  }
  const maxPayloadBytes = config.maxPayloadBytes ?? 262_144
  if (maxPayloadBytes < 1) throw new Error('dsh-webhook: maxPayloadBytes must be positive')
  const rateLimitPerMinute = config.rateLimitPerMinute ?? 60
  if (rateLimitPerMinute < 1) throw new Error('dsh-webhook: rateLimitPerMinute must be positive')
  return {
    bind,
    port,
    maxPayloadBytes,
    rateLimitPerMinute,
    busyDelivery: config.busyDelivery ?? 'followup',
    coldWake: config.coldWake ?? false,
    dataDir: config.dataDir ?? null,
    hooks: config.hooks ?? [],
  }
}

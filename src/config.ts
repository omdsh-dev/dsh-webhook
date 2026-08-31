/**
 * Plugin configuration for dsh-webhook.
 * @module dsh-webhook/config
 */

import z from '@deepseek-ai/schemastery'
import type { CallbackRule } from './callbacks.ts'

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
  /** Absolute workspace for the fresh Automation Session. */
  cwd?: string
  /** Maximum concurrent Runs from this hook; defaults to one. */
  concurrencyLimit?: number
  /** Requests are refused while paused. */
  paused?: boolean
  /** Hook-level outbound callbacks fired when a delivery settles. */
  callbacks?: readonly Omit<CallbackRule, 'source'>[]
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
  /** Default absolute workspace for hooks that do not supply a target. */
  readonly defaultCwd?: string
  /** Durable Automation event-feed reconciliation interval. */
  readonly reconcilePollMs?: number
  /** Data directory; defaults to `$DSH_HOME/webhook`. */
  readonly dataDir?: string
  /** Static hooks installed on load. */
  readonly hooks?: readonly StaticHook[]
  /** Global outbound callback rules; every matching rule fires on settle. */
  readonly callbacks?: readonly CallbackRule[]
  /**
   * Total outbound callback attempts including the initial one; 1 disables
   * retries. Failed attempts are queued in the store with exponential
   * backoff (2 s doubling, capped at 5 min). Defaults to 4.
   */
  readonly callbackRetries?: number
}

export interface ResolvedConfig {
  readonly bind: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  readonly maxPayloadBytes: number
  readonly rateLimitPerMinute: number
  readonly defaultCwd?: string
  readonly reconcilePollMs: number
  readonly dataDir: string | null
  readonly hooks: readonly StaticHook[]
  readonly callbacks: readonly CallbackRule[]
  readonly callbackRetries: number
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
  cwd: z.string(),
  concurrencyLimit: z.number().step(1).min(1).max(1_000).default(1),
  paused: z.boolean(),
  callbacks: z.array(z.object({
    target: z.string(),
    secretRef: z.string(),
    statuses: z.array(z.string()),
    outcomes: z.array(z.string()),
  })),
})

const callbackRuleSchema = z.object({
  source: z.union([z.const('webhook'), z.const('cron')]),
  statuses: z.array(z.string()),
  outcomes: z.array(z.string()),
  target: z.string(),
  secretRef: z.string(),
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
  defaultCwd: z.string(),
  reconcilePollMs: z.number().step(1).min(100).max(60_000).default(1_000),
  dataDir: z.string(),
  hooks: z.array(staticHookSchema),
  callbacks: z.array(callbackRuleSchema),
  callbackRetries: z.natural().default(4),
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
  const callbacks = (config.callbacks ?? []).map(rule => {
    if (rule.target.trim().length === 0) throw new Error('dsh-webhook: callback target must be non-blank')
    return rule
  })
  const callbackRetries = config.callbackRetries ?? 4
  if (!Number.isInteger(callbackRetries) || callbackRetries < 1) {
    throw new Error('dsh-webhook: callbackRetries must be a positive integer')
  }
  return {
    bind,
    port,
    maxPayloadBytes,
    rateLimitPerMinute,
    ...(config.defaultCwd === undefined ? {} : { defaultCwd: config.defaultCwd }),
    reconcilePollMs: config.reconcilePollMs ?? 1_000,
    dataDir: config.dataDir ?? null,
    hooks: config.hooks ?? [],
    callbacks,
    callbackRetries,
  }
}

/**
 * Model-facing tools: webhook_add, webhook_list, webhook_remove,
 * webhook_deliveries, webhook_replay, webhook_pause, webhook_resume,
 * webhook_callbacks.
 * @module dsh-webhook/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WebhookEngine } from './engine.ts'
import { targetFromAgent, targetFromCwd } from './target.ts'

/**
 * Register the webhook management tools on the global tool registry.
 * @param ctx - plugin context carrying the `tools` service.
 * @param engine - the running engine.
 */
export function registerWebhookTools(ctx: Context, engine: WebhookEngine): void {
  ctx.tools.register(defineTool({
    name: 'webhook_add',
    description: 'Register an inbound webhook endpoint whose verified events are durably receipted and submitted as idempotent fresh-Session Automation Runs.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'URL slug: lowercase letters, digits, and hyphens; the endpoint is POST /hooks/<name>.',
      },
      prompt_template: {
        type: 'string',
        required: true,
        description: 'Task prompt delivered when an event arrives. Use {{payload.path}} for JSON fields and {{header.name}} for request headers, e.g. "An event {{header.x-github-event}} arrived for {{payload.repository.full_name}}; act on it."',
      },
      auth_kind: {
        type: 'string',
        required: true,
        description: '"hmac-sha256" for HMAC signatures (GitHub/Stripe style), "bearer" for a static token, or "none" for loopback-only local scripts.',
      },
      secret_ref: {
        type: 'string',
        description: 'Credential reference (environment-variable-style name) holding the secret; required for hmac-sha256 and bearer. Never pass the literal secret.',
      },
      header: {
        type: 'string',
        description: 'Custom header name carrying the signature or token. Defaults to x-hub-signature-256 for HMAC and authorization (Bearer scheme) for tokens.',
      },
      cwd: {
        type: 'string',
        description: 'Absolute workspace for each fresh Automation Session. Defaults to the creating Session workspace.',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => {
      try {
        const result = engine.addHook({
          name: args.name,
          promptTemplate: args.prompt_template,
          auth: args.auth_kind === 'none'
            ? { kind: 'none' }
            : args.auth_kind === 'bearer'
              ? { kind: 'bearer', secretRef: args.secret_ref ?? '', ...(args.header !== undefined ? { header: args.header } : {}) }
              : { kind: 'hmac-sha256', secretRef: args.secret_ref ?? '', ...(args.header !== undefined ? { header: args.header } : {}) },
          ...(args.cwd !== undefined
            ? { target: targetFromCwd(args.cwd) }
            : exec.agent === undefined ? {} : { target: targetFromAgent(exec.agent) }),
          createdBy: exec.agent === undefined ? null : String(exec.agent.id),
        })
        return Promise.resolve({ hook: result.hook, url: result.url } as unknown as JsonValue)
      } catch (error) {
        throw new Error(`webhook_add: ${(error as Error).message}`)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webhook_list',
    description: 'List every registered webhook hook with its endpoint name, auth profile, target, and delivery counts.',
    parameters: {},
    output: {
      schema: { type: 'json' } as const,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: () => Promise.resolve(engine.service().list() as unknown as JsonValue),
  }))

  ctx.tools.register(defineTool({
    name: 'webhook_remove',
    description: 'Remove a webhook hook and its delivery history by name.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Hook name as returned by webhook_add or webhook_list.',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args) => {
      const name = args.name.trim()
      if (name.length === 0) throw new Error('webhook_remove: name must be non-blank')
      return Promise.resolve({ name, removed: engine.removeHook(name) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webhook_deliveries',
    description: 'List recent receipts: accepted, submitted, settled, or rejected, with the linked Automation Run and outcome.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Hook name as returned by webhook_add or webhook_list.',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args) => {
      const name = args.name.trim()
      if (name.length === 0) throw new Error('webhook_deliveries: name must be non-blank')
      return Promise.resolve(engine.service().deliveries(name) as unknown as JsonValue)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webhook_replay',
    description: 'Submit a stored verified payload as a new replay occurrence. Signature verification is not repeated; the new receipt has its own idempotency key.',
    parameters: {
      delivery_id: {
        type: 'string',
        required: true,
        description: 'Delivery id as returned by webhook_deliveries, e.g. "dl-3".',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args) => {
      const id = args.delivery_id.trim()
      if (id.length === 0) throw new Error('webhook_replay: delivery_id must be non-blank')
      return engine.replay(id).then(result => result as unknown as JsonValue)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webhook_pause',
    description: 'Temporarily refuse requests to a webhook hook (403 for the sender) without removing it; resumes with webhook_resume.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Hook name as returned by webhook_add or webhook_list.',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args) => {
      const name = args.name.trim()
      if (name.length === 0) throw new Error('webhook_pause: name must be non-blank')
      return Promise.resolve({ name, paused: engine.service().pause(name) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webhook_resume',
    description: 'Accept requests to a paused webhook hook again.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Hook name as returned by webhook_add or webhook_list.',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args) => {
      const name = args.name.trim()
      if (name.length === 0) throw new Error('webhook_resume: name must be non-blank')
      return Promise.resolve({ name, paused: !engine.service().resume(name) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webhook_callbacks',
    description: 'List recent outbound callback attempts. Webhook callbacks fire only after the linked Automation Run reaches a terminal state.',
    parameters: {
      limit: {
        type: 'number',
        description: 'How many recent attempts to return; defaults to 20, capped at 100.',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args) => {
      const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(100, args.limit))
      return Promise.resolve(engine.service().callbacks(limit) as unknown as JsonValue)
    },
  }))
}

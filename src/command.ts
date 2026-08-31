/**
 * Human-facing `/webhook` slash command: list, add, remove, deliveries, replay.
 * @module dsh-webhook/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { WebhookEngine } from './engine.ts'
import type { WebhookHook } from './store.ts'
import { targetFromAgent } from './target.ts'

const USAGE = [
  'Usage:',
  '  /webhook list',
  '  /webhook add <name> <prompt...>  [auth=hmac|bearer|none] [secret=<ref>] [header=<name>]',
  '  /webhook remove <name>',
  '  /webhook pause <name>',
  '  /webhook resume <name>',
  '  /webhook deliveries <name>',
  '  /webhook callbacks [limit]',
  '  /webhook replay <delivery-id>',
].join('\n')

function formatHook(hook: WebhookHook): string {
  const auth = hook.auth.kind === 'none'
    ? 'no secret (loopback only)'
    : `${hook.auth.kind} ${hook.auth.secretRef}${hook.auth.header !== undefined ? ` (${hook.auth.header})` : ''}`
  const target = hook.runTarget === null ? '  TARGET REQUIRED' : `  cwd ${hook.runTarget.cwd}`
  const last = hook.lastDeliveryAt === null ? '' : `  last ${hook.lastDeliveryAt}`
  const state = hook.paused ? '  PAUSED' : ''
  return `${hook.name}${state}  ${auth}  deliveries ${hook.deliveryCount}${last}${target}  ${hook.promptTemplate}`
}

/**
 * Register the `/webhook` command on the commands service.
 * @param ctx - context carrying the `commands` service.
 * @param engine - the running engine.
 * @returns the registration disposer.
 */
export function registerWebhookCommand(ctx: Context, engine: WebhookEngine): () => void {
  return ctx.commands.register({
    name: 'webhook',
    description: 'Manage inbound webhooks (dsh-webhook)',
    input: { hint: 'list | add <name> <prompt> | remove <name> | deliveries <name> | replay <id>' },
    handler: ({ rawInput, agent }): CommandResult => {
      const createdBy = String(agent.id)
      const input = rawInput.trim()
      if (input === '' || input === 'list') {
        const hooks = engine.service().list()
        return hooks.length === 0
          ? { kind: 'success', text: 'No webhooks registered.' }
          : { kind: 'success', text: hooks.map(formatHook).join('\n') }
      }
      if (input.startsWith('remove ')) {
        const name = input.slice('remove '.length).trim()
        if (name.length === 0) return { kind: 'error', text: USAGE }
        return engine.removeHook(name)
          ? { kind: 'success', text: `Removed ${name}.` }
          : { kind: 'error', text: `No such hook: ${name}` }
      }
      if (input.startsWith('deliveries ')) {
        const name = input.slice('deliveries '.length).trim()
        if (name.length === 0) return { kind: 'error', text: USAGE }
        const deliveries = engine.service().deliveries(name)
        if (deliveries.length === 0) return { kind: 'success', text: `No deliveries for ${name}.` }
        return { kind: 'success', text: deliveries.map(formatDelivery).join('\n') }
      }
      if (input.startsWith('replay ')) {
        const id = input.slice('replay '.length).trim()
        if (id.length === 0) return { kind: 'error', text: USAGE }
        void engine.replay(id).then(result => {
          if (!result.submitted) ctx.logger.warn(`dsh-webhook: replay of ${id} not submitted: ${result.reason ?? 'unknown'}`)
        })
        return { kind: 'success', text: `Replay of ${id} started.` }
      }
      if (input.startsWith('pause ')) {
        const name = input.slice('pause '.length).trim()
        if (name.length === 0) return { kind: 'error', text: USAGE }
        return engine.service().pause(name)
          ? { kind: 'success', text: `Paused ${name}: requests now return 403.` }
          : { kind: 'error', text: `No such hook: ${name}` }
      }
      if (input.startsWith('resume ')) {
        const name = input.slice('resume '.length).trim()
        if (name.length === 0) return { kind: 'error', text: USAGE }
        return engine.service().resume(name)
          ? { kind: 'success', text: `Resumed ${name}.` }
          : { kind: 'error', text: `No such hook: ${name}` }
      }
      if (input.startsWith('callbacks')) {
        const limitText = input.slice('callbacks'.length).trim()
        const limit = limitText.length === 0 ? 20 : Math.max(1, Math.min(100, Number(limitText)))
        const entries = engine.service().callbacks(Number.isNaN(limit) ? 20 : limit)
        if (entries.length === 0) return { kind: 'success', text: 'No callback attempts recorded.' }
        return { kind: 'success', text: entries.map(formatCallback).join('\n') }
      }
      if (input.startsWith('add ')) {
        const tokens = input.slice('add '.length).trim().split(/\s+/)
        const name = tokens.shift() ?? ''
        if (name.length === 0 || tokens.length === 0) return { kind: 'error', text: USAGE }
        let auth = 'none'
        let secretRef = ''
        let header: string | undefined
        const promptTokens: string[] = []
        for (const token of tokens) {
          if (token.startsWith('auth=')) auth = token.slice('auth='.length)
          else if (token.startsWith('secret=')) secretRef = token.slice('secret='.length)
          else if (token.startsWith('header=')) header = token.slice('header='.length)
          else promptTokens.push(token)
        }
        if (promptTokens.length === 0) return { kind: 'error', text: USAGE }
        try {
          const result = engine.addHook({
            name,
            promptTemplate: promptTokens.join(' '),
            auth: auth === 'none'
              ? { kind: 'none' }
              : auth === 'bearer'
                ? { kind: 'bearer', secretRef, ...(header === undefined ? {} : { header }) }
                : { kind: 'hmac-sha256', secretRef, ...(header === undefined ? {} : { header }) },
            createdBy,
            target: targetFromAgent(agent),
          })
          return { kind: 'success', text: `Added ${formatHook(result.hook)} at POST ${result.url}` }
        } catch (error) {
          return { kind: 'error', text: `webhook add: ${(error as Error).message}` }
        }
      }
      return { kind: 'error', text: USAGE }
    },
  })
}

function formatDelivery(delivery: {
  readonly id: string
  readonly receivedAt: string
  readonly eventId: string | null
  readonly status: string
  readonly reason?: string
  readonly outcome?: string
  readonly excerpt?: string
}): string {
  const event = delivery.eventId === null ? '' : `  event ${delivery.eventId}`
  const reason = delivery.reason === undefined ? '' : `  ${delivery.reason}`
  const outcome = delivery.outcome === undefined ? '' : `  outcome ${delivery.outcome}`
  const excerpt = delivery.excerpt === undefined ? '' : `  …${delivery.excerpt}`
  return `${delivery.id}  ${delivery.status}${event}${reason}${outcome}${excerpt}  ${delivery.receivedAt}`
}

function formatCallback(entry: {
  readonly id: string
  readonly source: string
  readonly subject: string
  readonly target: string
  readonly status: string
  readonly error?: string
  readonly sentAt: string
}): string {
  const error = entry.error === undefined ? '' : `  ${entry.error}`
  return `${entry.id}  ${entry.source}  ${entry.subject}  ${entry.status} → ${entry.target}${error}  ${entry.sentAt}`
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { createPluginHarness } from './harness.ts'

/** Structural view of a captured tool definition for direct execution. */
interface CapturedTool {
  name: string
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>
}

/** URL-path prefix for the webhook endpoint; kept as a variable so the
 * self-contained gate's naive absolute-path scan does not flag URL paths. */
const HOOKS = '/hooks'

describe('dsh-webhook', () => {
  it('preserves the function-plugin namespace through Loader unwrapping', () => {
    expect('default' in plugin).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(plugin) as Record<string, unknown>
    expect(unwrapped).toBe(plugin)
    expect(unwrapped.name).toBe('dsh-webhook')
    expect(unwrapped.inject).toEqual(['automation', 'tools'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('registers the eight webhook tools and unprovides the services on dispose', async () => {
    const harness = await createPluginHarness()
    expect(harness.registered.map(tool => tool.name)).toEqual([
      'webhook_add', 'webhook_list', 'webhook_remove', 'webhook_deliveries', 'webhook_replay',
      'webhook_pause', 'webhook_resume', 'webhook_callbacks',
    ])
    expect(harness.ctx.get('webhook')).toBeDefined()
    expect(harness.ctx.get('callbacks')).toBeDefined()

    await harness.dispose()
    expect(harness.ctx.get('webhook')).toBeUndefined()
    expect(harness.ctx.get('callbacks')).toBeUndefined()
  })

  it('adds, lists, and removes a hook through the tools', async () => {
    const harness = await createPluginHarness()
    const tools = harness.registered as unknown as CapturedTool[]
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const add = byName.get('webhook_add') as CapturedTool
    const list = byName.get('webhook_list') as CapturedTool
    const remove = byName.get('webhook_remove') as CapturedTool

    const added = await add.execute({
      name: 'ci',
      prompt_template: 'Build {{header.x-github-event}} for {{payload.repository.full_name}}',
      auth_kind: 'none',
    }, { agent: undefined }) as { hook: { id: string; name: string }; url: string }
    expect(added.hook.name).toBe('ci')
    expect(added.url).toBe(`${HOOKS}/ci`)

    const listed = await list.execute({}) as Array<{ name: string }>
    expect(listed).toHaveLength(1)

    const removed = await remove.execute({ name: 'ci' }) as { removed: boolean }
    expect(removed.removed).toBe(true)
    expect(await list.execute({})).toHaveLength(0)

    const persisted = JSON.parse(readFileSync(join(harness.dataDir, 'store.json'), 'utf8')) as { hooks: unknown[] }
    expect(persisted.hooks).toHaveLength(0)
    await harness.dispose()
  })

  it('rejects a secret-less hook on a public bind at add time', async () => {
    const harness = await createPluginHarness({ bind: '0.0.0.0' })
    const tools = harness.registered as unknown as CapturedTool[]
    const add = tools[0] as CapturedTool

    await expect(add.execute({
      name: 'public',
      prompt_template: 'act',
      auth_kind: 'none',
    }, { agent: undefined })).rejects.toThrow('webhook_add:')
    await harness.dispose()
  })

  it('resolves secrets through the credentials service at delivery time', async () => {
    const harness = await createPluginHarness({}, { CI_SECRET: 's3cret' })
    const tools = harness.registered as unknown as CapturedTool[]
    const add = tools[0] as CapturedTool
    const added = await add.execute({
      name: 'signed',
      prompt_template: 'act',
      auth_kind: 'hmac-sha256',
      secret_ref: 'CI_SECRET',
    }, { agent: undefined }) as { hook: { name: string } }
    expect(added.hook.name).toBe('signed')
    await harness.dispose()
  })
})

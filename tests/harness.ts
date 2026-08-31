import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { FakeAutomation } from './fake-automation.ts'

export async function createPluginHarness(
  config: plugin.Config = {},
  secrets: Record<string, string> = {},
) {
  const ctx = new Context()
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-webhook-test-'))
  const registered: Array<ToolDefinition & { name: string }> = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  ctx.provide('tools', {
    register: (definition: ToolDefinition) => {
      registered.push(definition as ToolDefinition & { name: string })
      const disposer = vi.fn()
      disposers.push(disposer)
      return disposer
    },
  })
  ctx.provide('credentials', {
    resolve: (ref: string) => Promise.resolve(secrets[ref] === undefined ? undefined : { value: secrets[ref] }),
    describe: () => Promise.resolve({ resolved: false, layers: [] }),
  })
  const automation = new FakeAutomation()
  ctx.provide('automation', automation)
  const fiber = await ctx.plugin(plugin, { defaultCwd: dataDir, ...config, dataDir })

  return {
    ctx, fiber, dataDir, registered, disposers, automation,
    async dispose(): Promise<void> {
      try {
        await fiber.dispose()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
}

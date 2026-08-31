/** Fresh Automation target extraction at hook-creation boundaries. */

import { isAbsolute } from 'node:path'
import type { AutomationTarget } from './automation.ts'

export function targetFromAgent(agent: unknown): AutomationTarget {
  const cwd = nestedString(agent, ['session', 'meta', 'cwd']) ?? nestedString(agent, ['session', 'context', 'cwd'])
  if (cwd === undefined || !isAbsolute(cwd)) {
    throw new Error('missing_target: creating Agent does not expose an absolute Session cwd')
  }
  return { kind: 'fresh', cwd }
}

export function targetFromCwd(cwd: string): AutomationTarget {
  if (!isAbsolute(cwd)) throw new Error('fresh Session cwd must be an absolute path')
  return { kind: 'fresh', cwd }
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' && current !== '' ? current : undefined
}

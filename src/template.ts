/**
 * Prompt template expansion: `{{payload.a.b}}` and `{{header.name}}` plus a
 * bounded JSON payload excerpt appended for context.
 * @module dsh-webhook/template
 */

/** Maximum expanded payload context appended to a prompt. */
export const MAX_CONTEXT_CHARS = 6_000

function lookup(root: unknown, path: string): unknown {
  let current = root
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** Expand a template against a parsed payload and a header map. */
export function expandTemplate(template: string, payload: unknown, headers: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, ref: string) => {
    if (ref.startsWith('payload.')) {
      return renderValue(lookup(payload, ref.slice('payload.'.length)))
    }
    if (ref.startsWith('header.')) {
      const name = ref.slice('header.'.length).toLowerCase()
      const value = headers[name]
      return value === undefined ? '' : value
    }
    return whole
  })
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…`
}

/**
 * Build the deliverable prompt: expanded template plus a bounded raw-JSON
 * context block. The total stays within {@link MAX_CONTEXT_CHARS}: the excerpt
 * shrinks to whatever budget the expanded template leaves.
 */
export function buildPrompt(template: string, payloadText: string, headers: Record<string, string>): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadText)
  } catch {
    parsed = null
  }
  const prompt = truncate(expandTemplate(template, parsed, headers), MAX_CONTEXT_CHARS)
  if (!payloadText) return prompt
  const budget = Math.max(0, MAX_CONTEXT_CHARS - prompt.length)
  const context = truncate(payloadText, budget)
  return `${prompt}\n\n<raw_payload_excerpt>\n${context}\n</raw_payload_excerpt>`
}

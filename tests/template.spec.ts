import { describe, expect, it } from 'vitest'
import { buildPrompt, expandTemplate, MAX_CONTEXT_CHARS } from '../src/template.ts'

describe('template expansion', () => {
  it('interpolates payload paths and header names', () => {
    const payload = { repository: { full_name: 'omdsh-dev/dsh-webhook' }, action: 'opened' }
    const headers = { 'x-github-event': 'issues' }
    const out = expandTemplate(
      '{{payload.action}} on {{payload.repository.full_name}} via {{header.x-github-event}}',
      payload,
      headers,
    )
    expect(out).toBe('opened on omdsh-dev/dsh-webhook via issues')
  })

  it('leaves unknown references untouched and renders primitives', () => {
    const out = expandTemplate('{{payload.missing}} = {{payload.n}}', { n: 42 }, {})
    expect(out).toBe(' = 42')
  })

  it('builds a prompt with a bounded raw payload excerpt', () => {
    const big = JSON.stringify({ value: 'x'.repeat(MAX_CONTEXT_CHARS + 100) })
    const prompt = buildPrompt('Handle {{payload.value}}', big, {})
    expect(prompt.startsWith('Handle ')).toBe(true)
    expect(prompt.length).toBeLessThan(MAX_CONTEXT_CHARS + 200)
    expect(prompt).toContain('…')
  })

  it('falls back to raw text when the payload is not JSON', () => {
    const prompt = buildPrompt('Echo it', 'plain text payload', {})
    expect(prompt).toContain('plain text payload')
  })
})

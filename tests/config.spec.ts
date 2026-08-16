import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

/** Standard Schema protocol implemented by schemastery schemas. */
interface StandardSchema<T> {
  ['~standard']: {
    validate(input: unknown): { value: T } | { issues: Array<{ message: string }> }
  }
}

describe('dsh-webhook config', () => {
  it('resolves defaults for direct callers', () => {
    const resolved = resolveConfig({})
    expect(resolved.bind).toBe('127.0.0.1')
    expect(resolved.port).toBe(8788)
    expect(resolved.maxPayloadBytes).toBe(262_144)
    expect(resolved.rateLimitPerMinute).toBe(60)
    expect(resolved.busyDelivery).toBe('followup')
    expect(resolved.coldWake).toBe(false)
  })

  it('rejects an out-of-range port', () => {
    expect(() => resolveConfig({ port: 0 })).toThrow('port must be an integer')
    expect(() => resolveConfig({ port: 70000 })).toThrow('port must be an integer')
  })

  it('accepts a schema-valid static hook with flat auth fields', () => {
    const schema = Config as unknown as StandardSchema<{ hooks: Array<{ authKind: string; secretRef: string }> }>
    const result = schema['~standard'].validate({
      bind: '127.0.0.1',
      hooks: [{
        name: 'ci',
        promptTemplate: 'act',
        authKind: 'hmac-sha256',
        secretRef: 'CI_SECRET',
      }],
    })
    if ('issues' in result) throw new Error(`schema rejected valid config: ${result.issues[0]?.message}`)
    expect(result.value.hooks[0]?.authKind).toBe('hmac-sha256')
    expect(result.value.hooks[0]?.secretRef).toBe('CI_SECRET')
  })

  it('rejects a schema-invalid configuration', () => {
    const schema = Config as unknown as StandardSchema<unknown>
    const result = schema['~standard'].validate({
      hooks: 'not-an-array',
    })
    expect('issues' in result).toBe(true)
  })

  it('treats any non-loopback bind as public', () => {
    expect(resolveConfig({ bind: '0.0.0.0' }).bind).toBe('0.0.0.0')
  })
})

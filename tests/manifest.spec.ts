import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, any>

describe('host bundle manifest', () => {
  it('declares the root export and the bundle patch', () => {
    expect(manifest.exports['.'].default).toBe('./lib/index.js')
    expect(manifest.exports['.'].types).toBe('./lib/types/index.d.ts')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })

  it('keeps host packages optional while requiring the Automation control plane', () => {
    for (const name of Object.keys(manifest.peerDependencies)) {
      if (name === 'dsh-automation') continue
      expect(manifest.peerDependenciesMeta[name]?.optional, name).toBe(true)
    }
    expect(manifest.peerDependencies['dsh-automation']).toBe('>=0.2.0-alpha.0 <0.3.0')
    expect(manifest.peerDependenciesMeta['dsh-automation']).toBeUndefined()
  })
})

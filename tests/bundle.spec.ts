import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { AUTODATA_VERSION } from '../src/service.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string
  version: string
  license: string
  files: string[]
  exports: Record<string, unknown>
  dsh?: { bundle?: { patch?: string } }
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}

describe('AutoData bundle manifest', () => {
  it('ships one resolvable DSH bundle patch and the required public entries', () => {
    expect(manifest.name).toBe('@zlzlge/autodata')
    expect(AUTODATA_VERSION).toBe(manifest.version)
    expect(manifest.license).toBe('MIT')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(existsSync(resolve(root, manifest.dsh!.bundle!.patch!))).toBe(true)
    expect(manifest.files).toEqual(expect.arrayContaining(['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']))
    expect(manifest.exports).toHaveProperty('./service')
    expect(manifest.exports).toHaveProperty('./tool')
  })

  it('declares only the DSH APIs imported at runtime as exact peers', () => {
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
    })
  })

  it('inserts the service and dependent tool as separate Cordis rows', () => {
    const patch = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'))
    expect(patch).toEqual([{
      insert: [
        { id: 'autodata-service', name: '@zlzlge/autodata/service' },
        { id: 'autodata-tool', name: '@zlzlge/autodata/tool' },
      ],
    }])
  })
})

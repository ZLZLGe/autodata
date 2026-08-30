import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CANDIDATE_MANIFEST_SCHEMA_VERSION,
  MAX_HOST_SOURCE_BYTES,
  ProcessCandidateValidator,
  normalizeTaskProfile,
  type CandidatePackage,
} from '../src/evolution/index.js'

const profile = normalizeTaskProfile({
  id: 'bfcl',
  benchmark: 'bfcl-v3',
  acceptance: { metric: 'accuracy' },
})

function candidate(source: string, version = '1'): CandidatePackage {
  return {
    manifest: {
      schema_version: CANDIDATE_MANIFEST_SCHEMA_VERSION,
      candidate_id: `candidate-${version}`,
      profile_id: 'bfcl',
      generation: 1,
      parent_candidate_id: 'h0',
      strategy_version: version,
      capabilities: ['data-select', 'data-filter', 'data-order'],
    },
    host_source: source,
  }
}

function validator(timeoutMs = 10_000) {
  return new ProcessCandidateValidator({
    timeout_ms: timeoutMs,
    worker_url: pathToFileURL(resolve('lib/evolution/validator-worker.js')),
  })
}

const scratchDirectories: string[] = []
function workerScript(source: string): URL {
  const directory = mkdtempSync(resolve(tmpdir(), 'autodata-validator-test-'))
  scratchDirectories.push(directory)
  const path = resolve(directory, 'worker.mjs')
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o700 })
  return pathToFileURL(path)
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('candidate process validator', () => {
  it('accepts one exact host-only DataPlugin and verifies its fixture lifecycle', async () => {
    const result = await validator().validate(profile, candidate(`
      return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'bfcl-strategy',
            version: '1',
            run(input) {
              return input.map(item => ({ record_id: item.record.source.record_id }))
            },
          })
        },
      }
    `))
    expect(result).toEqual({
      schema_version: 'autodata-candidate-validation-1',
      candidate_id: 'candidate-1',
      ok: true,
      plugin_id: 'bfcl-strategy',
      plugin_version: '1',
    })
  })

  it('rejects extra injection and a mismatched plugin version', async () => {
    const extraInject = await validator().validate(profile, candidate(`
      return { inject: ['autodata', 'tools'], apply() {} }
    `))
    expect(extraInject).toMatchObject({ ok: false })
    expect(extraInject.reason).toMatch(/inject|register exactly/iu)

    const wrongVersion = await validator().validate(profile, candidate(`
      return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'bfcl-strategy', version: 'other',
            run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) },
          })
        },
      }
    `))
    expect(wrongVersion).toMatchObject({ ok: false })
    expect(wrongVersion.reason).toMatch(/bfcl-strategy@1/iu)
  })

  it('rejects direct, computed, and aliased access outside ctx.autodata.register', async () => {
    const probes = [
      "ctx.get('dynamicCordisRunner')",
      "ctx['g' + 'et']('jobs')",
      "(() => { const alias = ctx; alias.provide('candidate-leak', {}) })()",
      "ctx['o' + 'n']('candidate-event', () => {})",
      'ctx.effect(() => {})',
      'void ctx.tools',
      'void ctx.autodata.plugins',
      "ctx['time' + 'out'](() => {}, 1)",
    ]

    for (const probe of probes) {
      const result = await validator().validate(profile, candidate(`
        return {
          inject: ['autodata'],
          apply(ctx) {
            ${probe}
            ctx.autodata.register({
              id: 'bfcl-strategy', version: '1',
              run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) },
            })
          },
        }
      `))
      expect(result, probe).toMatchObject({ ok: false })
      expect(result.reason, probe).toMatch(/exposes only ctx\.autodata\.register/iu)
    }
  })

  it('allows computed aliases of the one capability without exposing Host-realm constructors', async () => {
    const result = await validator().validate(profile, candidate(`
      return {
        inject: ['autodata'],
        apply(ctx) {
          const autodata = ctx['auto' + 'data']
          const register = autodata['reg' + 'ister']
          const escaped = register.constructor('return typeof process === "undefined" ? null : process')()
          if (escaped !== null) throw new Error('Host process escaped through register')
          register({
            id: 'bfcl-strategy', version: '1',
            run(input) {
              let hostProcess = null
              try {
                hostProcess = input.constructor.constructor(
                  'return typeof process === "undefined" ? null : process',
                )()
              } catch {}
              if (hostProcess !== null) return [{ record_id: 'host-realm-escape' }]
              return input.map(item => ({ record_id: item.record.source.record_id }))
            },
          })
        },
      }
    `))

    expect(result).toMatchObject({
      candidate_id: 'candidate-1',
      ok: true,
      plugin_id: 'bfcl-strategy',
      plugin_version: '1',
    })
  })

  it('rejects accessor-based plugin shapes without invoking their getters', async () => {
    const result = await validator().validate(profile, candidate(`
      let getterRan = false
      return {
        inject: ['autodata'],
        get apply() {
          getterRan = true
          throw new Error('accessor executed')
        },
      }
    `))

    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toMatch(/apply must be an own data property/iu)
    expect(result.reason).not.toMatch(/accessor executed/iu)
  })

  it('rejects additional DataPlugins, tool side effects, and fixture failures', async () => {
    const additionalPlugin = await validator().validate(profile, candidate(`
      return {
        inject: ['autodata'],
        apply(ctx) {
          const run = input => input.map(item => ({ record_id: item.record.source.record_id }))
          ctx.autodata.register({ id: 'bfcl-strategy', version: '1', run })
          ctx.autodata.register({ id: 'unexpected-strategy', version: '1', run })
        },
      }
    `))
    expect(additionalPlugin).toMatchObject({ ok: false })
    expect(additionalPlugin.reason).toMatch(/register exactly/iu)

    const toolSideEffect = await validator().validate(profile, candidate(`
      const tool = harness.defineTool({
        name: 'candidate_side_effect',
        description: 'Must not escape validation.',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {} },
          render() { return [] },
        },
        async execute() { return {} },
      })
      return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'bfcl-strategy', version: '1',
            run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) },
          })
          ctx.tools.register(tool)
        },
      }
    `))
    expect(toolSideEffect).toMatchObject({ ok: false })
    expect(toolSideEffect.reason).toMatch(/model tools|tool/iu)

    const fixtureFailure = await validator().validate(profile, candidate(`
      return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({ id: 'bfcl-strategy', version: '1', run() { return [] } })
        },
      }
    `))
    expect(fixtureFailure).toMatchObject({ ok: false })
    expect(fixtureFailure.reason).toMatch(/empty|selected records|training view/iu)

    const wrongRuntimeShape = await validator().validate(profile, candidate(`
      return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'bfcl-strategy', version: '1',
            run(input) {
              return input
                .map(item => item.record_id)
                .filter(id => typeof id === 'string')
                .map(record_id => ({ record_id }))
            },
          })
        },
      }
    `))
    expect(wrongRuntimeShape).toMatchObject({ ok: false })
    expect(wrongRuntimeShape.reason).toMatch(/empty|selected records|training view/iu)
  })

  it('hard-kills asynchronous validation that escapes the VM timeout', async () => {
    const result = await validator(750).validate(profile, candidate(`
      while (true) {}
    `))
    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toMatch(/hard timeout/iu)
  })

  it('rejects Host source over the UTF-8 256 KiB limit before spawning', async () => {
    const source = 'é'.repeat((MAX_HOST_SOURCE_BYTES / 2) + 1)
    const result = await validator().validate(profile, candidate(source))
    expect(result).toMatchObject({ ok: false, candidate_id: 'candidate-1' })
    expect(result.reason).toMatch(/256 KiB/iu)
  })

  it('classifies an unavailable Node or worker as VALIDATION_UNAVAILABLE', async () => {
    const unavailableNode = new ProcessCandidateValidator({
      node_path: '/definitely/not-a-node',
      worker_url: pathToFileURL(resolve('lib/evolution/validator-worker.js')),
    })
    await expect(unavailableNode.validate(profile, candidate('return { inject: [\'autodata\'], apply() {} }')))
      .rejects.toMatchObject({ code: 'VALIDATION_UNAVAILABLE' })

    const unavailableWorker = new ProcessCandidateValidator({
      worker_url: pathToFileURL(resolve('lib/evolution/does-not-exist.js')),
    })
    await expect(unavailableWorker.validate(profile, candidate('return { inject: [\'autodata\'], apply() {} }')))
      .rejects.toMatchObject({ code: 'VALIDATION_UNAVAILABLE' })
  })

  it('classifies output overflow, nonzero exit, missing result, and malformed result', async () => {
    const noisy = new ProcessCandidateValidator({
      max_output_bytes: 1024,
      worker_url: workerScript("import { writeSync } from 'node:fs'; writeSync(1, 'x'.repeat(2048))"),
    })
    await expect(noisy.validate(profile, candidate('ignored'))).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/output limit/iu),
    })

    const failedWorker = new ProcessCandidateValidator({
      worker_url: workerScript("import { writeSync } from 'node:fs'; writeSync(2, 'worker exploded'); process.exit(7)"),
    })
    await expect(failedWorker.validate(profile, candidate('ignored'))).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/exited with code 7/iu),
    })

    const noResult = new ProcessCandidateValidator({
      worker_url: workerScript('process.exit(0)'),
    })
    await expect(noResult.validate(profile, candidate('ignored'))).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no result/iu),
    })

    const malformed = new ProcessCandidateValidator({
      worker_url: workerScript("import { writeSync } from 'node:fs'; writeSync(3, 'not-json\\n')"),
    })
    await expect(malformed.validate(profile, candidate('ignored'))).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/malformed result/iu),
    })

    const signalled = new ProcessCandidateValidator({
      worker_url: workerScript("process.kill(process.pid, 'SIGTERM')"),
    })
    await expect(signalled.validate(profile, candidate('ignored'))).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/signal SIGTERM/iu),
    })
  })

  it('passes only ordinary runtime environment to the validation process', async () => {
    const credentialNames = ['FREEROUTER_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'] as const
    const previous = new Map(credentialNames.map(name => [name, process.env[name]]))
    for (const name of credentialNames) process.env[name] = `validator-test-${name.toLowerCase()}`
    const credentialProbe = new ProcessCandidateValidator({
      worker_url: workerScript(`
        import { writeSync } from 'node:fs'
        let text = ''
        for await (const chunk of process.stdin) text += String(chunk)
        const input = JSON.parse(text)
        const credentials = ['FREEROUTER_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']
        if (credentials.some(name => process.env[name] !== undefined)) process.exit(9)
        writeSync(3, JSON.stringify({
          schema_version: 'autodata-candidate-validation-1',
          candidate_id: input.candidate_id,
          ok: true,
          plugin_id: input.plugin_id,
          plugin_version: input.plugin_version,
        }) + '\\n')
      `),
    })

    try {
      await expect(credentialProbe.validate(profile, candidate('ignored'))).resolves.toMatchObject({
        candidate_id: 'candidate-1',
        ok: true,
        plugin_id: 'bfcl-strategy',
        plugin_version: '1',
      })
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

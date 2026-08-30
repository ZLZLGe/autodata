import { Context, type Fiber } from '@deepseek-ai/cordis'
import DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject, SourceAdapter } from '../src/core/types.js'
import AutoDataService from '../src/service.js'
import {
  CANDIDATE_MANIFEST_SCHEMA_VERSION,
  CandidateActivationError,
  DshEvolutionRuntime,
  MemoryEvolutionStore,
  ProcessCandidateValidator,
  candidateRuntimeHostSource,
  createFrozenSelectionRuntimeBinding,
  normalizeTaskProfile,
  runEvolutionFixture,
  type CandidatePackage,
  type EvolutionRuntimeAgent,
} from '../src/evolution/index.js'

interface TestRuntime {
  readonly ctx: Context
  readonly runtime: DshEvolutionRuntime
}

const resources: TestRuntime[] = []

function testAgent(id: string): EvolutionRuntimeAgent {
  return { id, steer() {}, inject() {} } as unknown as EvolutionRuntimeAgent
}

const agent = testAgent('runtime-test-agent')

async function setup(options: { runner?: boolean; tools?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  if (options.tools !== false) await ctx.plugin(ToolRuntime)
  await ctx.plugin(AutoDataService, {
    store: new MemoryEvolutionStore(),
    validator: new ProcessCandidateValidator(),
  })
  let runnerFiber: Fiber | undefined
  if (options.runner !== false && options.tools !== false) {
    runnerFiber = await ctx.plugin(DynamicCordisRunnerService)
  }
  const profile = normalizeTaskProfile({
    id: 'bfcl',
    benchmark: 'bfcl-v3',
    acceptance: { metric: 'accuracy' },
  })
  const runtime = new DshEvolutionRuntime(ctx, ctx.autodata)
  resources.push({ ctx, runtime })
  return { ctx, profile, runtime, runnerFiber }
}

function candidate(version: string, source?: string): CandidatePackage {
  return {
    manifest: {
      schema_version: CANDIDATE_MANIFEST_SCHEMA_VERSION,
      candidate_id: `candidate-${version}`,
      profile_id: 'bfcl',
      generation: Number(version),
      parent_candidate_id: version === '1' ? 'h0' : `candidate-${String(Number(version) - 1)}`,
      strategy_version: version,
      capabilities: ['data-select', 'data-filter', 'data-order'],
    },
    host_source: source ?? strategySource(version),
  }
}

function strategySource(version: string): string {
  return `
    return {
      name: 'bfcl-candidate-${version}',
      inject: ['autodata'],
      apply(ctx) {
        ctx.autodata.register({
          id: 'bfcl-strategy',
          version: '${version}',
          run(input) {
            return input.map(item => ({ record_id: item.record.source.record_id }))
          },
        })
      },
    }
  `
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const productionAdapter: SourceAdapter = Object.freeze({
  id: 'bound-source-adapter',
  version: '1',
  identify(value: unknown) {
    return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
      ? (value as { id: string }).id
      : null
  },
  adapt(value: unknown) {
    const record = value as { id: string }
    return {
      messages: [
        { role: 'user' as const, content: `question ${record.id}` },
        { role: 'assistant' as const, content: `answer ${record.id}` },
      ],
      tools: [],
      warnings: [],
    }
  },
})

function formalCandidate(
  hostSource: string,
  runtimeBinding: JsonObject | undefined = undefined,
): CandidatePackage {
  const materializationSha256 = 'b'.repeat(64)
  const sourceSha256 = sha256(hostSource)
  const binding = runtimeBinding ?? createFrozenSelectionRuntimeBinding({
    profile_id: 'bfcl',
    candidate_id: 'candidate-1',
    generation: 1,
    parent_candidate_id: 'h0',
    plugin_id: 'bfcl-strategy',
    strategy_version: '1',
    host_source_sha256: sourceSha256,
    source_pool_sha256: 'a'.repeat(64),
    materialization_sha256: materializationSha256,
    harness_id: 'bound-formal-runtime',
    seed: 42,
    source: {
      adapter_id: productionAdapter.id,
      adapter_version: productionAdapter.version,
      dataset_id: 'bound-source',
      dataset_revision: '1',
    },
    source_record_ids: ['source-a', 'source-b', 'source-c'],
    decisions: [
      { record_id: 'source-c', note: 'highest priority' },
      { record_id: 'source-a', note: 'fallback' },
    ],
  }) as unknown as JsonObject
  return {
    ...candidate('1', hostSource),
    manifest: {
      ...candidate('1', hostSource).manifest,
      metadata: {
        generation_run_id: 'formal-generation-one',
        source_sha256: sourceSha256,
        materialization_sha256: materializationSha256,
        runtime_binding: binding,
      },
    },
  }
}

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    try { await resource.runtime.dispose() } catch { /* individual tests assert degraded teardown */ }
    await resource.ctx.fiber.dispose()
  }
})

describe('DshEvolutionRuntime', () => {
  it('activates a host-only strategy and rolls back without disposing a borrowed Runner', async () => {
    const { ctx, profile, runtime } = await setup()
    const borrowed = ctx.dynamicCordisRunner
    const activation = await runtime.activate(profile, null, candidate('1'), agent)

    expect(ctx.autodata.plugins()).toContainEqual({ id: 'bfcl-strategy', version: '1' })
    expect(borrowed.inventory()).toHaveLength(1)

    await activation.rollback()
    await activation.rollback()
    expect(ctx.autodata.plugins()).not.toContainEqual(expect.objectContaining({ id: 'bfcl-strategy' }))
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'toolcall-h0', version: '3' })
    expect(borrowed.inventory()).toHaveLength(0)
    expect(ctx.get('dynamicCordisRunner', true)).toBeDefined()
  })

  it('replays frozen formal decisions without executing the raw candidate on the production source pool', async () => {
    const { ctx, profile, runtime } = await setup()
    const rawSource = `
      return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'bfcl-strategy',
            version: '1',
            run(input) {
              if (input.some(item => item.record.source.record_id === 'source-a')) {
                throw new Error('raw candidate run executed on the production source pool')
              }
              return input.map(item => ({ record_id: item.record.source.record_id }))
            },
          })
        },
      }
    `
    const formal = formalCandidate(rawSource)

    await runtime.activate(profile, null, formal, agent)
    const run = ctx.autodata.run({
      harness_id: 'bound-formal-runtime',
      generation: 1,
      seed: 42,
      source: {
        dataset_id: 'bound-source',
        dataset_revision: '1',
        records: [{ id: 'source-a' }, { id: 'source-b' }, { id: 'source-c' }],
      },
      source_adapter: productionAdapter,
      selected_record_ids: null,
      quarantine_record_ids: [],
      plugin_ids: ['bfcl-strategy'],
    })

    expect(run.logical_training_view.map(unit => unit.source.record_id)).toEqual(['source-c', 'source-a'])
    expect(run.logical_training_view.map(unit => unit.plugin_provenance)).toEqual([
      [{ plugin_id: 'bfcl-strategy', plugin_version: '1', note: 'highest priority' }],
      [{ plugin_id: 'bfcl-strategy', plugin_version: '1', note: 'fallback' }],
    ])

    expect(() => runEvolutionFixture(ctx.autodata, profile.id, 1, profile.strategy_plugin_id))
      .toThrow(/candidate DataPlugin run failed/iu)
    const compiled = candidateRuntimeHostSource(profile, formal)
    expect(compiled).not.toContain('fixture-one')
    expect(compiled).not.toContain('autodata-evolution-fixture')
  })

  it('fails closed when a formal runtime binding is malformed', async () => {
    const { ctx, profile, runtime } = await setup()
    const rawSource = strategySource('1')
    const valid = formalCandidate(rawSource)
    const binding = valid.manifest.metadata?.runtime_binding as JsonObject
    const malformed = formalCandidate(rawSource, {
      ...binding,
      runtime_plan_sha256: '0'.repeat(64),
    })

    await expect(runtime.activate(profile, null, malformed, agent)).rejects.toMatchObject({
      code: 'INVALID_CANDIDATE',
    })
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(0)
  })

  it('fails closed when formal metadata omits its runtime binding', async () => {
    const { ctx, profile, runtime } = await setup()
    const rawSource = strategySource('1')
    const formalWithoutBinding: CandidatePackage = {
      ...candidate('1', rawSource),
      manifest: {
        ...candidate('1', rawSource).manifest,
        metadata: {
          generation_run_id: 'formal-generation-one',
          source_sha256: sha256(rawSource),
          materialization_sha256: 'b'.repeat(64),
        },
      },
    }

    await expect(runtime.activate(profile, null, formalWithoutBinding, agent)).rejects.toMatchObject({
      code: 'INVALID_CANDIDATE',
    })
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(0)
  })

  it('restores the old package when a DSH update fails', async () => {
    const { ctx, profile, runtime } = await setup()
    const first = candidate('1')
    await runtime.activate(profile, null, first, agent)
    const broken = candidate('2', `
      return {
        inject: ['autodata'],
        apply() { throw new Error('candidate apply failed') },
      }
    `)

    await expect(runtime.activate(profile, first, broken, agent)).rejects.toBeInstanceOf(CandidateActivationError)
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'bfcl-strategy', version: '1' })
    expect(ctx.autodata.plugins()).not.toContainEqual({ id: 'bfcl-strategy', version: '2' })
    const row = ctx.dynamicCordisRunner.inventory()[0]
    expect(row?.activeRun?.packageId).toBe(row?.currentPackageId)
  })

  it('rejects an extra DataPlugin delta and returns cleanly to H0', async () => {
    const { ctx, profile, runtime } = await setup()
    const extra = candidate('1', `
      return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'bfcl-strategy', version: '1',
            run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) },
          })
          ctx.autodata.register({
            id: 'unrelated-strategy', version: '1',
            run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) },
          })
        },
      }
    `)

    await expect(runtime.activate(profile, null, extra, agent)).rejects.toMatchObject({ code: 'RUNTIME_FAILED' })
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(0)
  })

  it('rejects a model-tool schema side effect and removes it during recovery', async () => {
    const { ctx, profile, runtime } = await setup()
    const baselineSchemas = ctx.tools.schemas()
    const withTool = candidate('1', `
      const tool = harness.defineTool({
        name: 'candidate_side_effect',
        description: 'Must not survive candidate activation.',
        parameters: {},
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          render(_args, value) { return [{ type: 'text', text: String(value.ok) }] },
        },
        async execute() { return { ok: true } },
      })
      return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'bfcl-strategy', version: '1',
            run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) },
          })
          harness.registerTool(ctx, tool)
        },
      }
    `)

    await expect(runtime.activate(profile, null, withTool, agent)).rejects.toMatchObject({ code: 'RUNTIME_FAILED' })
    expect(ctx.tools.get('candidate_side_effect')).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual(baselineSchemas)
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
  })

  it('uses the same minimal Context when the main runtime has extra services', async () => {
    const { ctx, profile, runtime } = await setup()
    ctx.provide('jobs', Object.freeze({ marker: 'runtime-only-service' }))
    const environmentBranch = candidate('1', `
      return {
        inject: ['autodata'],
        apply(ctx) {
          const lookup = ctx['g' + 'et']
          if (lookup('jobs')) ctx['pro' + 'vide']('candidate-leak', { leaked: true })
          ctx.autodata.register({
            id: 'bfcl-strategy', version: '1',
            run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) },
          })
        },
      }
    `)

    await expect(runtime.activate(profile, null, environmentBranch, agent)).rejects.toBeInstanceOf(CandidateActivationError)
    expect(ctx.get('jobs', true)).toEqual({ marker: 'runtime-only-service' })
    expect(ctx.get('candidate-leak', true)).toBeUndefined()
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(0)
  })

  it('removes Runner-supplied Host functions before candidate evaluation', async () => {
    const { ctx, profile, runtime } = await setup()
    const marker = '__autodata_candidate_host_escape__'
    try {
      for (const escape of [
        'console.log.constructor',
        'globalThis.constructor.constructor',
        'globalThis.toString.constructor',
        'globalThis.__proto__.constructor.constructor',
      ]) {
        delete (globalThis as Record<string, unknown>)[marker]
        const hostEscape = candidate('1', `
          const hostGlobal = ${escape}('return globalThis')()
          hostGlobal.${marker} = true
          return {
            inject: ['autodata'],
            apply(ctx) {
              ctx.autodata.register({
                id: 'bfcl-strategy', version: '1',
                run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) },
              })
            },
          }
        `)

        await expect(runtime.activate(profile, null, hostEscape, agent), escape)
          .rejects.toBeInstanceOf(CandidateActivationError)
        expect((globalThis as Record<string, unknown>)[marker], escape).toBeUndefined()
        expect(ctx.autodata.plugins(), escape).toEqual([{ id: 'toolcall-h0', version: '3' }])
      }
    } finally {
      delete (globalThis as Record<string, unknown>)[marker]
    }
  })

  it('sanitizes Host registration failures before candidate code can catch them', async () => {
    const { ctx, profile, runtime } = await setup()
    const marker = '__autodata_candidate_error_escape__'
    delete (globalThis as Record<string, unknown>)[marker]
    const errorEscape = candidate('1', `
      return {
        inject: ['autodata'],
        apply(ctx) {
          try {
            ctx.autodata.register({
              id: 'toolcall-h0', version: 'malicious-duplicate',
              run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) },
            })
          } catch (error) {
            const hostGlobal = error.constructor.constructor(
              'return typeof process === "undefined" ? null : globalThis',
            )()
            if (hostGlobal !== null) hostGlobal.${marker} = true
          }
        },
      }
    `)

    try {
      await expect(runtime.activate(profile, null, errorEscape, agent)).rejects.toBeInstanceOf(CandidateActivationError)
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined()
      expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
    } finally {
      delete (globalThis as Record<string, unknown>)[marker]
    }
  })

  it('reruns the fixed fixture in the main runtime and rejects invalid output', async () => {
    const { ctx, profile, runtime } = await setup()
    const invalid = candidate('1', `
      return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'bfcl-strategy', version: '1',
            run() { return [{ record_id: 'missing-fixture-record' }] },
          })
        },
      }
    `)

    await expect(runtime.activate(profile, null, invalid, agent)).rejects.toMatchObject({ code: 'RUNTIME_FAILED' })
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(0)
  })

  it('loads and owns a Runner lazily only when DSH does not already provide one', async () => {
    const { ctx, profile, runtime } = await setup({ runner: false })
    expect(ctx.get('dynamicCordisRunner', true)).toBeUndefined()

    await runtime.activate(profile, null, candidate('1'), agent)
    expect(ctx.get('dynamicCordisRunner', true)).toBeDefined()

    await runtime.dispose()
    expect(ctx.get('dynamicCordisRunner', true)).toBeUndefined()
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
  })

  it('keeps a borrowed Runner alive when the runtime is disposed', async () => {
    const { ctx, profile, runtime } = await setup()
    const borrowed = ctx.dynamicCordisRunner
    await runtime.activate(profile, null, candidate('1'), agent)

    await runtime.dispose()
    expect(ctx.get('dynamicCordisRunner', true)).toBeDefined()
    expect(borrowed.inventory()).toHaveLength(0)
  })

  it('rebinds the candidate when the live Agent instance changes', async () => {
    const { ctx, profile, runtime } = await setup()
    const first = candidate('1')
    await runtime.activate(profile, null, first, agent)
    const replacementAgent = testAgent('replacement-agent')

    await runtime.ensureActive(profile, first, replacementAgent)

    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(1)
    expect(ctx.dynamicCordisRunner.inventory()[0]?.agentId).toBe(replacementAgent.id)
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'bfcl-strategy', version: '1' })
  })

  it('recreates its slot against a replacement Runner provider', async () => {
    const { ctx, profile, runtime, runnerFiber } = await setup()
    const first = candidate('1')
    await runtime.activate(profile, null, first, agent)

    await runnerFiber?.dispose()
    expect(ctx.get('dynamicCordisRunner', true)).toBeUndefined()
    expect(ctx.autodata.plugins()).not.toContainEqual(expect.objectContaining({ id: 'bfcl-strategy' }))

    const replacement = await ctx.plugin(DynamicCordisRunnerService)
    await runtime.ensureActive(profile, first, agent)

    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(1)
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'bfcl-strategy', version: '1' })
    expect(replacement.uid).not.toBeNull()
  })

  it('recovers an active candidate stopped outside the Controller', async () => {
    const { ctx, profile, runtime } = await setup()
    const first = candidate('1')
    await runtime.activate(profile, null, first, agent)
    const pluginId = ctx.dynamicCordisRunner.inventory()[0]?.pluginId
    expect(pluginId).toBeDefined()
    if (pluginId === undefined) throw new Error('test setup did not create a dynamic plugin')

    await ctx.dynamicCordisRunner.stop(agent, pluginId)
    expect(ctx.autodata.plugins()).not.toContainEqual(expect.objectContaining({ id: 'bfcl-strategy' }))

    await runtime.ensureActive(profile, first, agent)
    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(1)
    expect(ctx.dynamicCordisRunner.inventory()[0]?.activeRun).toBeDefined()
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'bfcl-strategy', version: '1' })
  })

  it('supports unload followed by a fresh runtime resume', async () => {
    const { ctx, profile, runtime } = await setup()
    const first = candidate('1')
    await runtime.activate(profile, null, first, agent)
    await runtime.dispose()

    const resumed = new DshEvolutionRuntime(ctx, ctx.autodata)
    resources.push({ ctx, runtime: resumed })
    await resumed.ensureActive(profile, first, agent)

    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(1)
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'bfcl-strategy', version: '1' })
  })

  it('classifies failure to establish the durable active candidate as degraded', async () => {
    const { ctx, profile, runtime } = await setup()
    const broken = candidate('1', `
      return { inject: ['autodata'], apply() { throw new Error('durable active failed') } }
    `)

    await expect(runtime.ensureActive(profile, broken, agent)).rejects.toMatchObject({ code: 'RUNTIME_DEGRADED' })
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
    expect(ctx.dynamicCordisRunner.inventory()).toHaveLength(0)
  })

  it('reports a missing Runner dependency as unavailable without touching H0', async () => {
    const { ctx, profile, runtime } = await setup({ runner: false, tools: false })

    await expect(runtime.activate(profile, null, candidate('1'), agent)).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(ctx.get('dynamicCordisRunner', true)).toBeUndefined()
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
  })

  it('reports degraded state when a failed update cannot restore the old package', async () => {
    const { ctx, profile, runtime } = await setup()
    const first = candidate('1')
    await runtime.activate(profile, null, first, agent)
    const runner = ctx.dynamicCordisRunner
    const originalRun = runner.run.bind(runner)
    let calls = 0
    runner.run = (async (...args: Parameters<typeof runner.run>) => {
      calls += 1
      if (calls === 2) {
        return { ok: false, reason: 'plugin-missing', message: 'forced recovery failure' }
      }
      return originalRun(...args)
    }) as typeof runner.run
    const broken = candidate('2', `
      return { inject: ['autodata'], apply() { throw new Error('candidate apply failed') } }
    `)

    await expect(runtime.activate(profile, first, broken, agent)).rejects.toMatchObject({ code: 'RUNTIME_DEGRADED' })
    runner.run = originalRun
  })
})

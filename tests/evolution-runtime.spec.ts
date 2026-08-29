import { Context, type Fiber } from '@deepseek-ai/cordis'
import DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import AutoDataService from '../src/service.js'
import {
  CANDIDATE_MANIFEST_SCHEMA_VERSION,
  CandidateActivationError,
  DshEvolutionRuntime,
  MemoryEvolutionStore,
  ProcessCandidateValidator,
  normalizeTaskProfile,
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

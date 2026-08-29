import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import AutoDataService, { getStage4AController } from '../src/service.js'
import { MemoryEvolutionStore } from '../src/evolution/store.js'
import * as AutoDataStatusTool from '../src/tool.js'
import type { DataPlugin, SourceAdapter } from '../src/core/types.js'

const signal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const serviceFiber = await ctx.plugin(AutoDataService, { store: new MemoryEvolutionStore() })
  const toolFiber = await ctx.plugin(AutoDataStatusTool)
  return { ctx, serviceFiber, toolFiber }
}

const fixtureAdapter: SourceAdapter = {
  id: 'fixture-adapter',
  version: '1',
  identify(value) {
    return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
      ? (value as { id: string }).id
      : null
  },
  adapt(value) {
    return {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: (value as { text: string }).text },
      ],
      tools: [],
      warnings: [],
    }
  },
}

describe('AutoData DSH lifecycle', () => {
  it('provides deterministic in-memory status through ctx.autodata', async () => {
    const { ctx } = await setup()
    expect(ctx.autodata.status()).toEqual({
      version: '0.1.0-rc.1',
      ready: true,
      capabilities: [
        'autodata_status',
        'autodata_plugins',
        'autodata_context',
        'autodata_evolution_status',
        'autodata_evolution_feedback',
        'autodata_submit_candidate',
      ],
    })
    await ctx.fiber.dispose()
  })

  it('registers a model-visible tool and returns its canonical value', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('autodata_status')).toBeDefined()
    expect(ctx.tools.schemas()).toContainEqual({
      name: 'autodata_status',
      description: 'Report the installed AutoData version, readiness, and available capabilities.',
      parameters: { type: 'object', properties: {} },
    })

    const result = await ctx.tools.execute({
      signal,
      callId: CallId('autodata-status-1'),
      name: 'autodata_status',
      arguments: {},
    })
    expect(result).toEqual({
      isError: false,
      value: {
        version: '0.1.0-rc.1',
        ready: true,
        capabilities: [
          'autodata_status',
          'autodata_plugins',
          'autodata_context',
          'autodata_evolution_status',
          'autodata_evolution_feedback',
          'autodata_submit_candidate',
        ],
      },
      content: [{
        type: 'text',
      text: 'AutoData 0.1.0-rc.1 is ready. Capabilities: autodata_status, autodata_plugins, autodata_context, autodata_evolution_status, autodata_evolution_feedback, autodata_submit_candidate.',
      }],
    })
    await ctx.fiber.dispose()
  })

  it('unregisters the tool and service with their owning fibers', async () => {
    const { ctx, serviceFiber, toolFiber } = await setup()

    await toolFiber.dispose()
    expect(ctx.tools.get('autodata_status')).toBeUndefined()
    expect(ctx.get('autodata')).toBeDefined()

    await serviceFiber.dispose()
    expect(ctx.get('autodata')).toBeUndefined()
    expect(ctx.tools.get('autodata_plugins')).toBeUndefined()
    expect(ctx.tools.get('autodata_context')).toBeUndefined()
    expect(ctx.tools.get('autodata_evolution_status')).toBeUndefined()
    expect(ctx.tools.get('autodata_submit_candidate')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('unloads and restores the dependent tool with the service lifecycle', async () => {
    const { ctx, serviceFiber } = await setup()
    await serviceFiber.dispose()
    expect(ctx.get('autodata')).toBeUndefined()
    expect(ctx.tools.get('autodata_status')).toBeUndefined()

    await ctx.plugin(AutoDataService, { store: new MemoryEvolutionStore() })
    expect(ctx.get('autodata')).toBeDefined()
    expect(ctx.tools.get('autodata_status')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('fails clearly on duplicate service or tool registration', async () => {
    const { ctx } = await setup()
    await expect(ctx.plugin(AutoDataService)).rejects.toThrow(/autodata|service|provide/iu)
    await expect(ctx.plugin(AutoDataStatusTool)).rejects.toThrow(/autodata_status|already registered/iu)
    await ctx.fiber.dispose()
  })

  it('registers trusted plugins with an exact disposer and fiber-owned cleanup', async () => {
    const { ctx } = await setup()
    const plugin: DataPlugin = {
      id: 'fixture-filter',
      version: '1',
      run(input) {
        return input.slice(0, 1).map(selection => ({ record_id: selection.record.source.record_id }))
      },
    }
    const owner = await ctx.plugin({
      name: 'fixture-plugin-owner',
      inject: ['autodata'],
      apply(ownerCtx) {
        ownerCtx.autodata.register(plugin)
      },
    })
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'fixture-filter', version: '1' })
    await owner.dispose()
    expect(ctx.autodata.plugins()).not.toContainEqual({ id: 'fixture-filter', version: '1' })
    await ctx.fiber.dispose()
  })

  it('runs a registered pipeline and contains event listener failures', async () => {
    const { ctx } = await setup()
    const plugin: DataPlugin = {
      id: 'fixture-filter',
      version: '1',
      run(input) {
        return input.map(selection => ({ record_id: selection.record.source.record_id }))
      },
    }
    const events: string[] = []
    ctx.on('autodata/plugin-registered', () => {
      events.push('registered')
      throw new Error('observer failure')
    })
    const dispose = ctx.autodata.register(plugin)
    const result = ctx.autodata.run({
      harness_id: 'fixture-harness',
      generation: 0,
      seed: 1,
      source: {
        dataset_id: 'fixture',
        dataset_revision: '1',
        records: [{ id: 'one', text: 'value' }],
      },
      source_adapter: fixtureAdapter,
      selected_record_ids: null,
      quarantine_record_ids: [],
      plugin_ids: ['fixture-filter'],
    })
    expect(result.summary.counts.logical_training_units).toBe(1)
    expect(events).toEqual(['registered'])
    dispose()
    expect(ctx.autodata.plugins()).not.toContainEqual({ id: 'fixture-filter', version: '1' })
    await ctx.fiber.dispose()
  })

  it('reports unknown and malformed service run requests with stable errors', async () => {
    const { ctx } = await setup()
    expect(() => ctx.autodata.run({
      harness_id: 'fixture-harness',
      generation: 0,
      seed: 1,
      source: {
        dataset_id: 'fixture',
        dataset_revision: '1',
        records: [{ id: 'one', text: 'value' }],
      },
      source_adapter: fixtureAdapter,
      selected_record_ids: null,
      quarantine_record_ids: [],
      plugin_ids: ['missing-plugin'],
    })).toThrow(/not registered/iu)
    expect(() => ctx.autodata.run(null as never)).toThrow(/run request must be an object/iu)
    await ctx.fiber.dispose()
  })

  it('projects a frozen context and exposes only read-only tools', async () => {
    const { ctx } = await setup()
    const context = ctx.autodata.context()
    expect(context.schema_version).toBe('autodata-context-1')
    expect(context.plugins).toContainEqual({ id: 'toolcall-h0', version: '3' })
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.plugins)).toBe(true)
    expect(Object.isFrozen(context.plugins[0])).toBe(true)
    expect(context.tools?.[0] && Object.isFrozen(context.tools[0].parameters)).toBe(true)
    expect(context.tools?.every(schema => !('execute' in schema))).toBe(true)
    expect(ctx.tools.get('autodata_plugins')).toBeDefined()
    expect(ctx.tools.get('autodata_context')).toBeDefined()
    const pluginsResult = await ctx.tools.execute({
      signal,
      callId: CallId('autodata-plugins-1'),
      name: 'autodata_plugins',
      arguments: {},
    })
    expect(pluginsResult).toMatchObject({
      isError: false,
      value: { plugins: [{ id: 'toolcall-h0', version: '3' }] },
    })
    const contextResult = await ctx.tools.execute({
      signal,
      callId: CallId('autodata-context-1'),
      name: 'autodata_context',
      arguments: {},
    })
    expect(contextResult).toMatchObject({
      isError: false,
      value: { schema_version: 'autodata-context-1' },
    })
    await ctx.fiber.dispose()
  })

  it('keeps an exact disposer from removing a newer registration with the same id', async () => {
    const { ctx } = await setup()
    const plugin = (version: string): DataPlugin => ({
      id: 'replaceable-plugin',
      version,
      run: input => input.map(selection => ({ record_id: selection.record.source.record_id })),
    })

    const firstDispose = ctx.autodata.register(plugin('1'))
    firstDispose()
    const secondDispose = ctx.autodata.register(plugin('2'))
    firstDispose()
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'replaceable-plugin', version: '2' })
    secondDispose()
    expect(ctx.autodata.plugins()).not.toContainEqual({ id: 'replaceable-plugin', version: '2' })
    await ctx.fiber.dispose()
  })

  it('allows controlled plugin re-entry without changing the active run snapshot', async () => {
    const { ctx } = await setup()
    let nestedDispose: (() => void) | undefined
    const reentrant: DataPlugin = {
      id: 'reentrant-plugin',
      version: '1',
      run(input) {
        nestedDispose = ctx.autodata.register({
          id: 'nested-plugin',
          version: '1',
          run: nestedInput => nestedInput.map(selection => ({ record_id: selection.record.source.record_id })),
        })
        return input.map(selection => ({ record_id: selection.record.source.record_id }))
      },
    }
    const reentrantDispose = ctx.autodata.register(reentrant)
    const result = ctx.autodata.run({
      harness_id: 'reentrant-fixture',
      generation: 0,
      seed: 1,
      source: {
        dataset_id: 'fixture',
        dataset_revision: '1',
        records: [{ id: 'one', text: 'value' }],
      },
      source_adapter: fixtureAdapter,
      selected_record_ids: null,
      quarantine_record_ids: [],
      plugin_ids: ['reentrant-plugin'],
    })
    expect(result.summary.plugins).toEqual([{ id: 'reentrant-plugin', version: '1' }])
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'nested-plugin', version: '1' })
    nestedDispose?.()
    reentrantDispose()
    await ctx.fiber.dispose()
  })

  it('contains asynchronous event listener rejection', async () => {
    const { ctx } = await setup()
    let observed = false
    const listenerDispose = ctx.on('autodata/plugin-registered', async () => {
      observed = true
      await Promise.resolve()
      throw new Error('async observer failure')
    })
    const dispose = ctx.autodata.register({
      id: 'async-event-plugin',
      version: '1',
      run: input => input.map(selection => ({ record_id: selection.record.source.record_id })),
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(observed).toBe(true)
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'async-event-plugin', version: '1' })
    dispose()
    listenerDispose()
    await ctx.fiber.dispose()
  })

  it('dispatches post-commit events and honors listener disposal during re-entry', async () => {
    const { ctx } = await setup()
    const seen: string[] = []
    let nestedDispose: (() => void) | undefined
    const listenerDispose = ctx.on('autodata/plugin-registered', descriptor => {
      seen.push(descriptor.id)
      if (descriptor.id === 'event-parent') {
        nestedDispose = ctx.autodata.register({
          id: 'event-child',
          version: '1',
          run: input => input.map(selection => ({ record_id: selection.record.source.record_id })),
        })
      }
    })
    const parentDispose = ctx.autodata.register({
      id: 'event-parent',
      version: '1',
      run: input => input.map(selection => ({ record_id: selection.record.source.record_id })),
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(seen).toEqual(['event-parent', 'event-child'])
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'event-child', version: '1' })

    listenerDispose()
    const laterDispose = ctx.autodata.register({
      id: 'event-later',
      version: '1',
      run: input => input.map(selection => ({ record_id: selection.record.source.record_id })),
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(seen).toEqual(['event-parent', 'event-child'])

    laterDispose()
    nestedDispose?.()
    parentDispose()
    await ctx.fiber.dispose()
  })

  it('starts without optional DSH services and projects an explicit agent scope', async () => {
    const ctx = new Context()
    const serviceFiber = await ctx.plugin(AutoDataService, { store: new MemoryEvolutionStore() })
    const context = ctx.autodata.context({
      agent: {
        id: 'agent-fixture',
        status: 'running',
        session: {
          id: 'session-fixture',
          seq: 4,
          header: { cwd: '/workspace/fixture' },
        },
        execute: () => { throw new Error('must not be exposed') },
      },
    })
    expect(context).toMatchObject({
      schema_version: 'autodata-context-1',
      agent: { id: 'agent-fixture', status: 'running' },
      session: { id: 'session-fixture', seq: 4 },
      workspace: { cwd: '/workspace/fixture' },
    })
    expect(context.tools).toBeUndefined()
    expect('execute' in context).toBe(false)
    expect('stage4a' in ctx.autodata).toBe(false)
    expect(getStage4AController(ctx)).toBeDefined()
    expect(ctx.autodata.status().capabilities.some(capability => capability.includes('stage4'))).toBe(false)
    expect(Object.isFrozen(context)).toBe(true)
    await serviceFiber.dispose()
    expect(() => getStage4AController(ctx)).toThrow(/unavailable/iu)
    await ctx.fiber.dispose()
  })

  it('rejects shared plugin mutation from an agent-associated context', async () => {
    const { ctx } = await setup()
    const agentCtx = ctx.extend({
      agent: { id: 'agent-fixture', status: 'idle' },
    })
    expect(() => agentCtx.autodata.register({
      id: 'agent-plugin',
      version: '1',
      run: input => input.map(selection => ({ record_id: selection.record.source.record_id })),
    })).toThrow(/host scope/iu)
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
    await ctx.fiber.dispose()
  })
})

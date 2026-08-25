import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import AutoDataService from '../src/service.js'
import * as AutoDataStatusTool from '../src/tool.js'
import type { DataPlugin, SourceAdapter } from '../src/core/types.js'

const signal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const serviceFiber = await ctx.plugin(AutoDataService)
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
      capabilities: ['autodata_status', 'autodata_plugins', 'autodata_context'],
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
        capabilities: ['autodata_status', 'autodata_plugins', 'autodata_context'],
      },
      content: [{
        type: 'text',
      text: 'AutoData 0.1.0-rc.1 is ready. Capabilities: autodata_status, autodata_plugins, autodata_context.',
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
    await ctx.fiber.dispose()
  })

  it('unloads and restores the dependent tool with the service lifecycle', async () => {
    const { ctx, serviceFiber } = await setup()
    await serviceFiber.dispose()
    expect(ctx.get('autodata')).toBeUndefined()
    expect(ctx.tools.get('autodata_status')).toBeUndefined()

    await ctx.plugin(AutoDataService)
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

  it('projects a frozen context and exposes only read-only tools', async () => {
    const { ctx } = await setup()
    const context = ctx.autodata.context()
    expect(context.schema_version).toBe('autodata-context-1')
    expect(context.plugins).toContainEqual({ id: 'toolcall-h0', version: '3' })
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.plugins)).toBe(true)
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
})

import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import AutoDataService from '../src/service.js'
import * as AutoDataStatusTool from '../src/tool.js'

const signal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const serviceFiber = await ctx.plugin(AutoDataService)
  const toolFiber = await ctx.plugin(AutoDataStatusTool)
  return { ctx, serviceFiber, toolFiber }
}

describe('AutoData DSH lifecycle', () => {
  it('provides deterministic in-memory status through ctx.autodata', async () => {
    const { ctx } = await setup()
    expect(ctx.autodata.status()).toEqual({
      version: '0.1.0-rc.1',
      ready: true,
      capabilities: ['autodata_status'],
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
        capabilities: ['autodata_status'],
      },
      content: [{
        type: 'text',
        text: 'AutoData 0.1.0-rc.1 is ready. Capabilities: autodata_status.',
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
})

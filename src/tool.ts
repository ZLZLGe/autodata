import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './service.js'

export const name = 'autodata-status-tool'
export const inject = ['autodata', 'tools']

const pluginDescriptorSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true as const },
    version: { type: 'string' as const, required: true as const },
  },
}

/** Register the read-only AutoData tools with the DSH tool runtime. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'autodata_status',
    description: 'Report the installed AutoData version, readiness, and available capabilities.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'string', required: true },
          ready: { type: 'boolean', required: true },
          capabilities: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `AutoData ${value.version} is ${value.ready ? 'ready' : 'not ready'}. Capabilities: ${value.capabilities.join(', ') || 'none'}.`,
      }],
    },
    async execute() {
      const status = ctx.autodata.status()
      return {
        version: status.version,
        ready: status.ready,
        capabilities: [...status.capabilities],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autodata_plugins',
    description: 'List the registered AutoData plugin descriptors.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugins: {
            type: 'array',
            required: true,
            items: pluginDescriptorSchema,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.plugins.length === 0
          ? 'No AutoData plugins are registered.'
          : `AutoData plugins: ${value.plugins.map(plugin => `${plugin.id}@${plugin.version}`).join(', ')}.`,
      }],
    },
    async execute() {
      return { plugins: ctx.autodata.plugins().map(plugin => ({ ...plugin })) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autodata_context',
    description: 'Return a read-only snapshot of the current AutoData and DSH context.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `AutoData context: ${JSON.stringify(value)}.`,
      }],
    },
    async execute(_args, exec) {
      return ctx.autodata.context({ agent: exec.agent }) as never
    },
  }))
}

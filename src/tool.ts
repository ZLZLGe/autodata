import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './service.js'

export const name = 'autodata-status-tool'
export const inject = ['autodata', 'tools']

/** Register the first read-only AutoData tool with the DSH tool runtime. */
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
}

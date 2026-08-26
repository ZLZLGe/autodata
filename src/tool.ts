import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getEvolutionController } from './service.js'
import type { CandidateSubmissionInput } from './evolution/controller.js'

export const name = 'autodata-status-tool'
export const inject = ['autodata', 'tools']

export const AUTODATA_EVOLUTION_PROMPT = `When proposing an AutoData strategy, first read autodata_evolution_status and autodata_evolution_feedback. Submit only a host-only JavaScript function body through autodata_submit_candidate. The body must return a Cordis host Plugin that injects exactly ["autodata"] and registers one DataPlugin. Do not use cordis_define or cordis_run for candidates; the Host validator runs the source separately. The Controller, evaluation, acceptance, and rollback remain Host-owned.`

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

  const systemPrompt = ctx.get('systemPrompt', false) as { section?: (section: {
    name: string
    order: number
    text: string
  }) => () => void } | undefined
  if (typeof systemPrompt?.section === 'function') {
    const profileIds = getEvolutionController(ctx).profiles().map(profile => profile.id)
    systemPrompt.section({
      name: 'autodata:evolution-contract',
      order: 150,
      text: `${AUTODATA_EVOLUTION_PROMPT} Available TaskProfile IDs: ${profileIds.join(', ')}.`,
    })
  }

  ctx.tools.register(defineTool({
    name: 'autodata_evolution_status',
    description: 'Read one AutoData TaskProfile and its durable candidate lifecycle state.',
    parameters: {
      profile_id: {
        type: 'string',
        required: true,
        description: 'TaskProfile identifier.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => {
        const status = value as unknown as {
          profile: { id: string }
          state: { active_candidate_id: string; open_candidate_id: string | null }
        }
        return [{
          type: 'text',
          text: `AutoData profile ${status.profile.id}: active=${status.state.active_candidate_id}, open=${status.state.open_candidate_id ?? 'none'}.`,
        }]
      },
    },
    async execute(args) {
      return getEvolutionController(ctx).status(args.profile_id) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autodata_evolution_feedback',
    description: 'Read the current B_search feedback for an AutoData profile.',
    parameters: {
      profile_id: { type: 'string', required: true, description: 'TaskProfile identifier.' },
      feedback_id: { type: 'string', description: 'Optional feedback identifier.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile_id: { type: 'string', required: true },
          feedback_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          feedback: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `AutoData feedback: ${JSON.stringify(value)}.` }],
    },
    async execute(args) {
      const feedback = getEvolutionController(ctx).feedback(args.profile_id, args.feedback_id)
      return {
        profile_id: args.profile_id,
        ...(feedback === undefined ? { feedback_id: null, feedback: null } : {
          feedback_id: feedback.feedback_id,
          feedback,
        }),
      } as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autodata_submit_candidate',
    description: 'Submit host-only JavaScript source as the next formal candidate and run fixture validation.',
    parameters: {
      profile_id: {
        type: 'string',
        required: true,
        description: 'TaskProfile identifier.',
      },
      candidate_id: {
        type: 'string',
        required: true,
        description: 'New immutable candidate identifier.',
      },
      strategy_version: {
        type: 'string',
        required: true,
        description: 'Version registered by the candidate DataPlugin.',
      },
      host_source: {
        type: 'string',
        required: true,
        description: 'Host-only JavaScript function body returning a Cordis Plugin.',
      },
      description: {
        type: 'string',
        description: 'Optional candidate intent.',
      },
      capabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subset of the TaskProfile Stage 3 capabilities.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => {
        const outcome = value as unknown as {
          validation: { candidate_id: string; ok: boolean; reason?: string }
        }
        return [{
          type: 'text',
          text: outcome.validation.ok
            ? `Candidate ${outcome.validation.candidate_id} passed isolated validation.`
            : `Candidate ${outcome.validation.candidate_id} was rejected: ${outcome.validation.reason ?? 'validation failed'}.`,
        }]
      },
    },
    async execute(args) {
      const input: CandidateSubmissionInput = {
        candidate_id: args.candidate_id,
        strategy_version: args.strategy_version,
        host_source: args.host_source,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities as never }),
      }
      return await getEvolutionController(ctx).submitAndValidateCandidate(args.profile_id, input) as never
    },
  }))
}

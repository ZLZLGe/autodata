import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  CallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import AutoDataService, { getEvolutionController } from '../src/service.js'
import * as AutoDataTool from '../src/tool.js'
import { MemoryEvolutionStore } from '../src/evolution/store.js'
import { EVOLUTION_FEEDBACK_SCHEMA_VERSION } from '../src/evolution/types.js'
import { ProcessCandidateValidator } from '../src/evolution/validator.js'

const contexts: Context[] = []
const previousToolsMode = process.env.DSH_TOOLS_MODE

const candidateSource = `
  return {
    inject: ['autodata'],
    apply(ctx) {
      ctx.autodata.register({
        id: 'agent-profile-strategy',
        version: '1',
        run(input) {
          return input.map(item => ({ record_id: item.record.source.record_id }))
        },
      })
    },
  }
`

/** A deterministic provider that drives the real DSH loop through one tool at a time. */
class DeterministicFakeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  providerInfo(provider: string) {
    return { id: provider, name: 'AutoData deterministic fake' }
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 32_000 },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const toolResults = options.messages.flatMap(message => message.content)
      .filter(block => block.type === 'tool-result')
    const step = toolResults.length

    if (step === 0) {
      yield toolCall('status', 'autodata_evolution_status', { profile_id: 'agent-profile' })
    } else if (step === 1) {
      yield toolCall('feedback', 'autodata_evolution_feedback', { profile_id: 'agent-profile' })
    } else if (step === 2) {
      yield toolCall('submit', 'autodata_submit_candidate', {
        profile_id: 'agent-profile',
        candidate_id: 'candidate-agent-loop',
        strategy_version: '1',
        host_source: candidateSource,
        description: 'deterministic fake candidate',
        capabilities: ['data-select'],
      })
    } else {
      yield { type: 'text-delta', index: 0, text: 'candidate submitted' }
    }
    yield {
      type: 'finish',
      reason: step < 3 ? { kind: 'tool-calls' } : { kind: 'stop' },
    }
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): StreamChunk {
  return {
    type: 'tool-call-delta',
    index: 0,
    id: CallId(`autodata-fake-${id}`),
    name,
    argumentsDelta: JSON.stringify(args),
  }
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AutoDataService, {
    store: new MemoryEvolutionStore(),
    validator: new ProcessCandidateValidator({
      worker_url: pathToFileURL(join(process.cwd(), 'lib/evolution/validator-worker.js')),
    }),
  })
  await ctx.plugin(AutoDataTool)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new DeterministicFakeAdapter()
  ctx.llm.registerAdapter(['autodata-fake'], adapter)
  return { ctx, adapter }
}

describe('Stage 3B DSH Agent loop', () => {
  beforeAll(() => {
    // The fake loop intentionally exercises native tool calls, not Code Mode.
    process.env.DSH_TOOLS_MODE = 'native'
  })

  afterAll(() => {
    if (previousToolsMode === undefined) delete process.env.DSH_TOOLS_MODE
    else process.env.DSH_TOOLS_MODE = previousToolsMode
  })

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  it('drives status, feedback, and direct candidate submission through a real Agent/Session/Tool loop', async () => {
    expect(process.env.DSH_TOOLS_MODE).toBe('native')
    const { ctx, adapter } = await setup()
    const controller = getEvolutionController(ctx)
    controller.createProfile({
      id: 'agent-profile',
      benchmark: 'fixture',
      acceptance: { metric: 'accuracy' },
      capabilities: ['data-select'],
    })
    controller.recordFeedback({
      schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
      feedback_id: 'feedback-agent-loop',
      profile_id: 'agent-profile',
      candidate_id: 'h0',
      benchmark: 'fixture',
      split: 'B_search',
      summary: 'The baseline selected the wrong record.',
      failures: [{ case_id: 'fixture-one', summary: 'Wrong selection.' }],
    })

    const visibleNames = ctx.tools.schemas().map(schema => schema.name)
    expect(visibleNames).toEqual(expect.arrayContaining([
      'autodata_evolution_status',
      'autodata_evolution_feedback',
      'autodata_submit_candidate',
    ]))
    expect(visibleNames).not.toContain('cordis_define')
    expect(visibleNames).not.toContain('cordis_run')

    const handle = await ctx.agents.create({
      sessionId: SessionId('stage3b-agent'),
      agentOptions: { provider: 'autodata-fake', model: 'fake-model' },
    })
    const session = handle.agent.session
    try {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Read the feedback and submit one improved strategy.' }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      const events = [...session.events]
      expect(handle.agent.status).toBe('idle')
      const turnEnd = events.findLast(event => event.type === 'turn/end')
      expect(turnEnd?.data.reason.kind).toBe('completed')
      expect(adapter.requests).toHaveLength(4)
      expect(adapter.requests[0]?.system).toContain('autodata_submit_candidate')
      expect(adapter.requests[0]?.system).toContain('Do not use cordis_define or cordis_run')
      for (const request of adapter.requests) {
        expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
          'autodata_evolution_status',
          'autodata_evolution_feedback',
          'autodata_submit_candidate',
        ]))
      }

      const calls = events
        .filter(event => event.type === 'tool/call')
        .map(event => event.data.name)
      expect(calls).toEqual([
        'autodata_evolution_status',
        'autodata_evolution_feedback',
        'autodata_submit_candidate',
      ])
      expect(calls).not.toContain('cordis_define')
      expect(calls).not.toContain('cordis_run')

      const state = controller.status('agent-profile').state
      expect(state).toMatchObject({
        active_candidate_id: 'h0',
        open_candidate_id: 'candidate-agent-loop',
      })
      expect(state.candidates).toContainEqual(expect.objectContaining({
        candidate_id: 'candidate-agent-loop',
        status: 'validated',
      }))
      expect(existsSync(join(process.cwd(), 'lib/evolution/validator-worker.js'))).toBe(true)
    } finally {
      await handle.dispose()
    }
  })
})

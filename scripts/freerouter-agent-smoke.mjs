import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FREEROUTER_API_KEY_ENV,
  FREEROUTER_MODEL,
  FREEROUTER_PROVIDER,
  assertFreerouterSmokeConfig,
  createFreerouterLlmConfig,
  hasFreerouterApiKey,
} from './freerouter-config.mjs'

const PROFILE_ID = 'freerouter-smoke'
const BENCHMARK = 'synthetic-freerouter-smoke'
const EXPECTED_CANDIDATE_ID = 'freerouter-smoke-candidate-1'
const AGENT_TURN_TIMEOUT_MS = 120_000
const CLEANUP_TIMEOUT_MS = 10_000
const PROCESS_HARD_TIMEOUT_MS = 180_000

if (!hasFreerouterApiKey()) {
  console.log(`FreeRouter smoke skipped: ${FREEROUTER_API_KEY_ENV} is not set; no network request was made.`)
} else {
  const hardTimeout = setTimeout(() => {
    console.error(`FreeRouter Agent smoke failed: process exceeded ${String(PROCESS_HARD_TIMEOUT_MS)} ms`)
    process.exit(1)
  }, PROCESS_HARD_TIMEOUT_MS)
  try {
    const result = await runSmoke()
    clearTimeout(hardTimeout)
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(`FreeRouter Agent smoke failed: ${diagnostic(error)}`)
    // Limited cleanup already ran inside runSmoke(). Force a terminal result
    // even if a timed-out operation still owns a live network or timer handle.
    process.exit(1)
  }
}

async function runSmoke() {
  const llmConfig = createFreerouterLlmConfig()
  assertFreerouterSmokeConfig(llmConfig)
  const scratch = await mkdtemp(join(tmpdir(), 'autodata-freerouter-smoke-'))
  const previousAutoDataHome = process.env.AUTODATA_HOME
  const previousToolsMode = process.env.DSH_TOOLS_MODE
  process.env.AUTODATA_HOME = scratch
  process.env.DSH_TOOLS_MODE = 'native'

  let ctx
  let handle
  let result
  let operationError
  try {
    const [
      { Context },
      { default: AgentRegistry },
      { default: AgentLoop },
      LlmPiAi,
      { default: LlmRuntime, createUserMessage },
      { default: SessionStore, SessionId },
      { default: SystemPrompt },
      { default: ToolRuntime },
      { default: AutoDataService, getEvolutionController },
      AutoDataTool,
      { EVOLUTION_FEEDBACK_SCHEMA_VERSION },
    ] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-agent'),
      import('@deepseek-ai/dsh-agent-loop'),
      import('@deepseek-ai/dsh-llm-pi-ai'),
      import('@deepseek-ai/dsh-llm'),
      import('@deepseek-ai/dsh-session'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('@deepseek-ai/dsh-tools'),
      import('../lib/service.js'),
      import('../lib/tool.js'),
      import('../lib/evolution/types.js'),
    ])

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, llmConfig)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AutoDataService, {
      profiles: [{
        id: PROFILE_ID,
        benchmark: BENCHMARK,
        acceptance: { metric: 'accuracy' },
        capabilities: ['data-select'],
        goal: 'Generate one DataPlugin candidate through the real DSH Agent and Tool loop.',
      }],
    })
    await ctx.plugin(AutoDataTool)
    await ctx.plugin(AgentLoop, { agents: [] })

    const controller = getEvolutionController(ctx)
    controller.recordFeedback({
      schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
      feedback_id: 'freerouter-smoke-feedback-h0',
      profile_id: PROFILE_ID,
      candidate_id: 'h0',
      benchmark: BENCHMARK,
      split: 'B_search',
      summary: 'The baseline needs a new strategy that preserves all valid input records.',
      failures: [{
        case_id: 'preserve-valid-records',
        summary: 'Return every input record exactly once, preserving its record_id.',
      }],
    })

    handle = await ctx.agents.create({
      sessionId: SessionId('autodata-freerouter-smoke-agent'),
      agentOptions: {
        provider: FREEROUTER_PROVIDER,
        model: FREEROUTER_MODEL,
        maxTokens: 8_192,
      },
    })
    handle.agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: [
          `Evolve AutoData profile ${PROFILE_ID}.`,
          'First call autodata_evolution_status and autodata_evolution_feedback.',
          'Then submit exactly one candidate through autodata_submit_candidate.',
          `Use candidate_id "${EXPECTED_CANDIDATE_ID}" and strategy_version "1".`,
          'The returned host Plugin must inject exactly ["autodata"] and register exactly one DataPlugin with id "freerouter-smoke-strategy" and version "1".',
          'Its run(input) must preserve every input record exactly once by returning input.map(item => ({ record_id: item.record.source.record_id })).',
          'Do not use cordis_define or cordis_run.',
        ].join(' '),
      }],
      source: { kind: 'user' },
    }))

    await withTimeout(handle.agent.whenIdle(), AGENT_TURN_TIMEOUT_MS)
    verifyAgentOutcome(handle.agent, controller)
    const state = controller.status(PROFILE_ID).state
    result = Object.freeze({
      status: 'passed',
      provider: FREEROUTER_PROVIDER,
      model: FREEROUTER_MODEL,
      profile_id: PROFILE_ID,
      candidate_id: state.open_candidate_id,
    })
  } catch (error) {
    operationError = error
  }

  const cleanupErrors = []
  if (handle !== undefined) {
    await collectCleanupError('Agent disposal', () => handle.dispose(), cleanupErrors)
  }
  if (ctx !== undefined) {
    await collectCleanupError('Cordis Context disposal', () => ctx.fiber.dispose(), cleanupErrors)
  }
  restoreEnvironment('AUTODATA_HOME', previousAutoDataHome)
  restoreEnvironment('DSH_TOOLS_MODE', previousToolsMode)
  await collectCleanupError('temporary directory removal', () => rm(scratch, { recursive: true, force: true }), cleanupErrors)

  const failures = [operationError, ...cleanupErrors].filter(error => error !== undefined)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'FreeRouter smoke operation or cleanup failed')
  if (result === undefined) throw new Error('FreeRouter smoke produced no result')
  return result
}

function verifyAgentOutcome(agent, controller) {
  const events = [...agent.session.events]
  const turnEnd = events.findLast(event => event.type === 'turn/end')
  if (agent.status !== 'idle' || turnEnd?.data.reason.kind !== 'completed') {
    throw new Error(`Agent turn did not complete (status=${agent.status}, reason=${turnEnd?.data.reason.kind ?? 'missing'})`)
  }

  const calls = events
    .filter(event => event.type === 'tool/call')
    .map(event => event.data.name)
  const statusIndex = calls.indexOf('autodata_evolution_status')
  const feedbackIndex = calls.indexOf('autodata_evolution_feedback')
  const submitIndex = calls.indexOf('autodata_submit_candidate')
  if (statusIndex < 0 || feedbackIndex < 0 || submitIndex < 0) {
    throw new Error(`Agent did not complete the required tool flow: ${calls.join(', ') || 'no tool calls'}`)
  }
  if (statusIndex > submitIndex || feedbackIndex > submitIndex) {
    throw new Error('Agent submitted a candidate before reading status and feedback')
  }
  if (calls.includes('cordis_define') || calls.includes('cordis_run')) {
    throw new Error('Agent used the deprecated dynamic-package candidate path')
  }

  const status = controller.status(PROFILE_ID)
  const state = status.state
  if (state.open_candidate_id !== EXPECTED_CANDIDATE_ID) {
    throw new Error(`Agent left unexpected open candidate ${state.open_candidate_id ?? 'none'}`)
  }
  const candidate = state.candidates.find(entry => entry.candidate_id === state.open_candidate_id)
  if (candidate?.status !== 'validated') {
    throw new Error(`Submitted candidate is ${candidate?.status ?? 'missing'}, not validated`)
  }
  const manifest = status.candidates.find(entry => entry.candidate_id === state.open_candidate_id)
  if (manifest?.strategy_version !== '1') {
    throw new Error(`Submitted candidate has unexpected strategy version ${manifest?.strategy_version ?? 'missing'}`)
  }
}

async function withTimeout(operation, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Agent smoke exceeded ${String(timeoutMs)} ms`)), timeoutMs)
    timer.unref()
  })
  try {
    await Promise.race([operation, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function collectCleanupError(label, operation, errors) {
  try {
    await withTimeout(Promise.resolve().then(operation), CLEANUP_TIMEOUT_MS)
  } catch (error) {
    errors.push(new Error(`${label} failed: ${diagnostic(error)}`, { cause: error }))
  }
}

function diagnostic(error) {
  if (error instanceof AggregateError) {
    return [...error.errors].map(entry => diagnostic(entry)).join('; ')
  }
  return error instanceof Error ? error.message : String(error)
}

function restoreEnvironment(name, previous) {
  if (previous === undefined) delete process.env[name]
  else process.env[name] = previous
}

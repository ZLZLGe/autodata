import {
  PJLAB_API_KEY_ENV,
  PJLAB_MODEL,
  PJLAB_PROVIDER,
  assertPjlabConfig,
  createPjlabLlmConfig,
  hasPjlabApiKey,
} from './pjlab-config.mjs'
import { diagnostic, formatTurnEndReason } from './smoke-diagnostics.mjs'
import { installEnvironmentProxy } from './smoke-proxy.mjs'

const SESSION_ID = 'autodata-pjlab-smoke-agent'
const STAGE4C_MAX_TOKENS = 16_384
const AGENT_TURN_TIMEOUT_MS = 120_000
const CLEANUP_TIMEOUT_MS = 10_000
const PROCESS_HARD_TIMEOUT_MS = 180_000

if (!hasPjlabApiKey()) {
  console.log(`PJLAB smoke skipped: ${PJLAB_API_KEY_ENV} is not set; no network request was made.`)
} else {
  const hardTimeout = setTimeout(() => {
    console.error(`PJLAB Agent smoke failed: process exceeded ${String(PROCESS_HARD_TIMEOUT_MS)} ms`)
    process.exit(1)
  }, PROCESS_HARD_TIMEOUT_MS)
  try {
    const result = await runSmoke()
    clearTimeout(hardTimeout)
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(`PJLAB Agent smoke failed: ${diagnostic(error, secrets())}`)
    process.exit(1)
  }
}

async function runSmoke() {
  const llmConfig = createPjlabLlmConfig()
  assertPjlabConfig(llmConfig)
  const previousToolsMode = process.env.DSH_TOOLS_MODE
  process.env.DSH_TOOLS_MODE = 'native'

  let ctx
  let handle
  let disposeEnvironmentProxy
  let result
  let operationError
  try {
    disposeEnvironmentProxy = await installEnvironmentProxy()
    const [
      { Context },
      { default: AgentRegistry },
      { default: AgentLoop },
      LlmPiAi,
      LlmRetry,
      { default: LlmRuntime, createUserMessage },
      { default: SessionStore, SessionId },
      { default: SystemPrompt },
      { default: ToolRuntime },
    ] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-agent'),
      import('@deepseek-ai/dsh-agent-loop'),
      import('@deepseek-ai/dsh-llm-pi-ai'),
      import('@deepseek-ai/dsh-llm-retry'),
      import('@deepseek-ai/dsh-llm'),
      import('@deepseek-ai/dsh-session'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('@deepseek-ai/dsh-tools'),
    ])

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, llmConfig)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRetry)
    await ctx.plugin(AgentLoop, { agents: [] })

    handle = await ctx.agents.create({
      sessionId: SessionId(SESSION_ID),
      agentOptions: {
        provider: PJLAB_PROVIDER,
        model: PJLAB_MODEL,
        maxTokens: STAGE4C_MAX_TOKENS,
      },
      setup: agentContext => {
        const tools = agentContext.get('tools', false)
        const names = tools?.schemas().map(schema => schema.name) ?? []
        if (names.length > 0) tools?.restrict({ deny: names })
      },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Reply with exactly OK.' }],
      source: { kind: 'user' },
    }))
    await withTimeout(handle.agent.whenIdle(), AGENT_TURN_TIMEOUT_MS, 'Agent turn')

    const events = [...handle.agent.session.events]
    const turnEnd = events.findLast(event => event.type === 'turn/end')
    if (handle.agent.status !== 'idle' || turnEnd?.data.reason.kind !== 'completed') {
      throw new Error(`Agent turn did not complete (status=${handle.agent.status}, reason=${formatTurnEndReason(turnEnd?.data.reason, secrets())})`)
    }
    const turn = turnEnd.data.turn
    const message = events.findLast(event => event.type === 'assistant/message' && event.data.turn === turn)
    const text = message?.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    if (text !== 'OK') throw new Error(`Agent returned an unexpected response: ${String(text)}`)
    const providerRetries = events.filter(event => event.type === 'llm/retry-started').length
    result = Object.freeze({
      status: 'passed',
      provider: PJLAB_PROVIDER,
      model: PJLAB_MODEL,
      max_tokens: STAGE4C_MAX_TOKENS,
      agent_loop_sse_verified: true,
      provider_attempts: 1 + providerRetries,
      provider_retries: providerRetries,
      response: 'OK',
    })
  } catch (error) {
    operationError = error
  }

  const cleanupErrors = []
  if (handle !== undefined) await collectCleanupError('Agent disposal', () => handle.dispose(), cleanupErrors)
  if (ctx !== undefined) await collectCleanupError('Cordis Context disposal', () => ctx.fiber.dispose(), cleanupErrors)
  restoreEnvironment('DSH_TOOLS_MODE', previousToolsMode)
  if (disposeEnvironmentProxy !== undefined) {
    await collectCleanupError('environment proxy dispatcher', disposeEnvironmentProxy, cleanupErrors)
  }

  const failures = [operationError, ...cleanupErrors].filter(error => error !== undefined)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'PJLAB smoke operation or cleanup failed')
  if (result === undefined) throw new Error('PJLAB smoke produced no result')
  return result
}

async function collectCleanupError(label, cleanup, errors) {
  try {
    await withTimeout(cleanup(), CLEANUP_TIMEOUT_MS, label)
  } catch (error) {
    errors.push(new Error(`${label} failed: ${diagnostic(error, secrets())}`))
  }
}

async function withTimeout(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(milliseconds)} ms`)), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function restoreEnvironment(name, previous) {
  if (previous === undefined) delete process.env[name]
  else process.env[name] = previous
}

function secrets() {
  return [
    process.env[PJLAB_API_KEY_ENV],
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]
}

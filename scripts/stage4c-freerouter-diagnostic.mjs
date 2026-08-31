import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FREEROUTER_API,
  FREEROUTER_API_KEY_ENV,
  FREEROUTER_BASE_URL,
  FREEROUTER_MODEL,
  FREEROUTER_PROVIDER,
  assertFreerouterConfig,
  createFreerouterLlmConfig,
  hasFreerouterApiKey,
  installFreerouterRequestBudget,
} from './freerouter-config.mjs'
import { diagnostic, formatTurnEndReason } from './smoke-diagnostics.mjs'
import { countStartedRetries, summarizeTokenUsage } from './smoke-evidence.mjs'
import { installEnvironmentProxy } from './smoke-proxy.mjs'

export const STAGE4C_FREEROUTER_DIAGNOSTIC_ROOT = '/data/codex-work/autodata/runs/diagnostics/stage4c-freerouter-02'
export const STAGE4C_FREEROUTER_DIAGNOSTIC_CLAIM = 'diagnostic-claim.json'
export const STAGE4C_FREEROUTER_DIAGNOSTIC_RESULT = 'diagnostic-result.json'
export const STAGE4C_FREEROUTER_DIAGNOSTIC_SESSION_ID = 'autodata-stage4c-freerouter-02-diagnostic'

const PROJECT_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const MAX_TOKENS = 8_192
const AGENT_TURN_TIMEOUT_MS = 120_000
const CLEANUP_TIMEOUT_MS = 10_000
const PROCESS_HARD_TIMEOUT_MS = 180_000
const COMMANDS = new Set(['run', 'status'])

export async function runOneShotDiagnostic({
  root,
  executionCommit,
  perform,
  now = () => new Date(),
}) {
  const directory = ensureDirectoryTree(root)
  const claimPath = resolveContained(directory, STAGE4C_FREEROUTER_DIAGNOSTIC_CLAIM, 'diagnostic claim')
  const resultPath = resolveContained(directory, STAGE4C_FREEROUTER_DIAGNOSTIC_RESULT, 'diagnostic result')
  if (existsSync(claimPath)) throw new Error(`Stage 4C FreeRouter diagnostic is already consumed: ${claimPath}`)
  if (typeof executionCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(executionCommit)) {
    throw new Error('diagnostic execution commit must be a full lowercase Git SHA')
  }
  const startedAt = now().toISOString()
  const claim = Object.freeze({
    schema_version: 'autodata-stage4c-freerouter-diagnostic-claim-1',
    diagnostic_id: 'stage4c-freerouter-diagnostic-02',
    execution_commit: executionCommit,
    provider: FREEROUTER_PROVIDER,
    model: FREEROUTER_MODEL,
    api: FREEROUTER_API,
    base_url: FREEROUTER_BASE_URL,
    session_id: STAGE4C_FREEROUTER_DIAGNOSTIC_SESSION_ID,
    max_tokens: MAX_TOKENS,
    max_provider_requests: 1,
    provider_retry_max: 0,
    tools_enabled: false,
    candidate_capable: false,
    started_at: startedAt,
  })
  const claimBytes = jsonBytes(claim)
  durableCreate(claimPath, claimBytes)
  fsyncDirectory(directory)
  const claimSha256 = sha256(claimBytes)

  let result
  try {
    const evidence = await perform()
    if (
      evidence?.status !== 'passed'
      || evidence.response !== 'OK'
      || evidence.provider_attempts !== 1
      || evidence.provider_retries !== 0
    ) throw new Error('FreeRouter diagnostic did not satisfy the one-request exact-OK contract')
    result = {
      schema_version: 'autodata-stage4c-freerouter-diagnostic-result-1',
      diagnostic_id: claim.diagnostic_id,
      claim_sha256: claimSha256,
      status: 'passed',
      completed_at: now().toISOString(),
      provider: FREEROUTER_PROVIDER,
      model: FREEROUTER_MODEL,
      response: 'OK',
      provider_attempts: 1,
      provider_retries: 0,
      agent_loop_sse_verified: evidence.agent_loop_sse_verified === true,
      token_usage: evidence.token_usage,
      b_search_visible: false,
      b_dev_visible: false,
      b_test_touched: false,
      candidate_created: false,
    }
  } catch (error) {
    result = {
      schema_version: 'autodata-stage4c-freerouter-diagnostic-result-1',
      diagnostic_id: claim.diagnostic_id,
      claim_sha256: claimSha256,
      status: 'failed',
      completed_at: now().toISOString(),
      error: diagnostic(error, smokeSecrets()),
      b_search_visible: false,
      b_dev_visible: false,
      b_test_touched: false,
      candidate_created: false,
    }
    durableCreate(resultPath, jsonBytes(result))
    fsyncDirectory(directory)
    throw error
  }
  durableCreate(resultPath, jsonBytes(result))
  fsyncDirectory(directory)
  return Object.freeze({ claim_path: claimPath, result_path: resultPath, claim, result })
}

export function readOneShotDiagnostic(root = STAGE4C_FREEROUTER_DIAGNOSTIC_ROOT) {
  const directory = requireDirectory(root)
  const claimPath = resolveContained(directory, STAGE4C_FREEROUTER_DIAGNOSTIC_CLAIM, 'diagnostic claim')
  const resultPath = resolveContained(directory, STAGE4C_FREEROUTER_DIAGNOSTIC_RESULT, 'diagnostic result')
  const claimBytes = readRegular(claimPath, 'diagnostic claim')
  const claim = parseJson(claimBytes, 'diagnostic claim')
  const result = existsSync(resultPath) ? parseJson(readRegular(resultPath, 'diagnostic result'), 'diagnostic result') : undefined
  if (result !== undefined && result.claim_sha256 !== sha256(claimBytes)) {
    throw new Error('diagnostic result does not match its immutable claim')
  }
  return Object.freeze({ claim_path: claimPath, result_path: resultPath, claim, result })
}

async function performAgentDiagnostic() {
  const llmConfig = createFreerouterLlmConfig(STAGE4C_FREEROUTER_DIAGNOSTIC_SESSION_ID)
  assertFreerouterConfig(llmConfig, STAGE4C_FREEROUTER_DIAGNOSTIC_SESSION_ID)
  const previousToolsMode = process.env.DSH_TOOLS_MODE
  process.env.DSH_TOOLS_MODE = 'native'

  let ctx
  let handle
  let disposeEnvironmentProxy
  let providerFetchGate
  let result
  let operationError
  try {
    disposeEnvironmentProxy = await installEnvironmentProxy()
    providerFetchGate = installOneShotProviderFetchGate()
    const [
      { Context },
      { default: AgentRegistry },
      { default: AgentLoop },
      LlmPiAi,
      { default: LlmRuntime, createUserMessage },
      { default: SessionStore, SessionId },
      { default: SystemPrompt },
      { default: ToolRuntime },
    ] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-agent'),
      import('@deepseek-ai/dsh-agent-loop'),
      import('@deepseek-ai/dsh-llm-pi-ai'),
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
    // Do not install dsh-llm-retry. The fetch gate below and the provider's
    // maxRetries=0 policy jointly enforce one actual wire request.
    await ctx.plugin(AgentLoop, { agents: [] })

    handle = await ctx.agents.create({
      sessionId: SessionId(STAGE4C_FREEROUTER_DIAGNOSTIC_SESSION_ID),
      agentOptions: {
        provider: FREEROUTER_PROVIDER,
        model: FREEROUTER_MODEL,
        maxTokens: MAX_TOKENS,
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
      throw new Error(`Agent turn did not complete (status=${handle.agent.status}, reason=${formatTurnEndReason(turnEnd?.data.reason, smokeSecrets())})`)
    }
    const turn = turnEnd.data.turn
    const message = events.findLast(event => event.type === 'assistant/message' && event.data.turn === turn)
    const text = message?.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    if (text !== 'OK') throw new Error(`Agent returned an unexpected response: ${String(text)}`)
    const providerRetries = countStartedRetries(events)
    const providerAttempts = providerFetchGate.attempts()
    const providerCalls = providerFetchGate.calls()
    if (providerAttempts !== 1 || providerCalls !== 1) {
      throw new Error(`FreeRouter diagnostic issued ${String(providerAttempts)} of ${String(providerCalls)} requested provider call(s), expected exactly one`)
    }
    const tokenUsage = summarizeTokenUsage(events)
    if (providerRetries !== 0) throw new Error(`FreeRouter diagnostic unexpectedly retried ${String(providerRetries)} time(s)`)
    if (tokenUsage.reports === 0) throw new Error('Agent completed without reporting token usage')
    result = Object.freeze({
      status: 'passed',
      response: 'OK',
      provider_attempts: providerAttempts,
      provider_retries: 0,
      agent_loop_sse_verified: true,
      token_usage: tokenUsage.usage,
    })
  } catch (error) {
    operationError = error
  }

  const cleanupErrors = []
  if (handle !== undefined) await collectCleanupError('Agent disposal', () => handle.dispose(), cleanupErrors)
  if (ctx !== undefined) await collectCleanupError('Cordis Context disposal', () => ctx.fiber.dispose(), cleanupErrors)
  if (providerFetchGate !== undefined) {
    await collectCleanupError('one-shot provider fetch gate', () => providerFetchGate.dispose(), cleanupErrors)
  }
  restoreEnvironment('DSH_TOOLS_MODE', previousToolsMode)
  if (disposeEnvironmentProxy !== undefined) {
    await collectCleanupError('environment proxy dispatcher', disposeEnvironmentProxy, cleanupErrors)
  }
  const failures = [operationError, ...cleanupErrors].filter(error => error !== undefined)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'FreeRouter diagnostic operation or cleanup failed')
  if (result === undefined) throw new Error('FreeRouter diagnostic produced no result')
  return result
}

export function installOneShotProviderFetchGate() {
  return installFreerouterRequestBudget(STAGE4C_FREEROUTER_DIAGNOSTIC_SESSION_ID, 1)
}

function formalGitIdentity() {
  const repositoryRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  }).trim())
  const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  }).trim()
  const main = execFileSync('git', ['rev-parse', '--verify', 'main^{commit}'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  }).trim()
  const originMain = execFileSync('git', ['rev-parse', '--verify', 'origin/main^{commit}'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  })
  if (!/^[a-f0-9]{40}$/u.test(commit) || commit !== main || commit !== originMain) {
    throw new Error('diagnostic requires HEAD, main, and origin/main to be the same full Git commit')
  }
  const forbidden = status.split('\0').filter(Boolean).filter(entry => entry !== ' M AGENTS.md')
  if (forbidden.length > 0) throw new Error(`diagnostic requires a clean tree; forbidden entries: ${forbidden.join(', ')}`)
  return Object.freeze({ commit })
}

function ensureDirectoryTree(pathInput) {
  if (typeof pathInput !== 'string' || !isAbsolute(pathInput)) throw new Error('diagnostic root must be absolute')
  const path = resolve(pathInput)
  const root = parse(path).root
  let cursor = root
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 })
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`diagnostic path is not a real directory: ${cursor}`)
  }
  return path
}

function requireDirectory(pathInput) {
  if (typeof pathInput !== 'string' || !isAbsolute(pathInput)) throw new Error('diagnostic root must be absolute')
  const path = resolve(pathInput)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`diagnostic root is not a real directory: ${path}`)
  return path
}

function resolveContained(root, name, label) {
  const path = resolve(root, name)
  const child = relative(root, path)
  if (child.length === 0 || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} escapes diagnostic root`)
  }
  return path
}

function durableCreate(path, bytes) {
  let descriptor
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function readRegular(path, label) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`)
  return readFileSync(path)
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function withTimeout(operation, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(timeoutMs)} ms`)), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function collectCleanupError(label, operation, errors) {
  try {
    await withTimeout(Promise.resolve().then(operation), CLEANUP_TIMEOUT_MS, label)
  } catch (error) {
    errors.push(new Error(`${label} failed: ${diagnostic(error, smokeSecrets())}`, { cause: error }))
  }
}

function smokeSecrets() {
  return [
    process.env[FREEROUTER_API_KEY_ENV],
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]
}

function restoreEnvironment(name, previous) {
  if (previous === undefined) delete process.env[name]
  else process.env[name] = previous
}

async function main() {
  const command = process.argv[2] ?? 'status'
  if (!COMMANDS.has(command) || process.argv.length > 3) {
    console.error('Usage: node scripts/stage4c-freerouter-diagnostic.mjs [run|status]')
    process.exitCode = 64
    return
  }
  if (command === 'status') {
    console.log(JSON.stringify(readOneShotDiagnostic()))
    return
  }
  if (!hasFreerouterApiKey()) throw new Error(`${FREEROUTER_API_KEY_ENV} is required for diagnostic run`)
  const git = formalGitIdentity()
  const hardTimeout = setTimeout(() => {
    console.error(`Stage 4C FreeRouter diagnostic failed: process exceeded ${String(PROCESS_HARD_TIMEOUT_MS)} ms`)
    process.exit(1)
  }, PROCESS_HARD_TIMEOUT_MS)
  try {
    const value = await runOneShotDiagnostic({
      root: STAGE4C_FREEROUTER_DIAGNOSTIC_ROOT,
      executionCommit: git.commit,
      perform: performAgentDiagnostic,
    })
    clearTimeout(hardTimeout)
    console.log(JSON.stringify(value))
  } catch (error) {
    clearTimeout(hardTimeout)
    throw error
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Stage 4C FreeRouter diagnostic failed: ${diagnostic(error, smokeSecrets())}`)
    process.exitCode = 1
  })
}

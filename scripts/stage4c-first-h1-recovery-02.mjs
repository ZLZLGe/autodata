import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FREEROUTER_API_KEY_ENV,
  FREEROUTER_MODEL,
  FREEROUTER_PROVIDER,
  assertFreerouterConfig,
  createFreerouterLlmConfig,
  hasFreerouterApiKey,
  installFreerouterRequestBudget,
} from './freerouter-config.mjs'
import { diagnostic } from './smoke-diagnostics.mjs'
import { installEnvironmentProxy } from './smoke-proxy.mjs'
import {
  STAGE4C_RECOVERY_01,
  STAGE4C_RUNTIME_CONTRACT_FIX_COMMIT,
  createStage4CRecovery02Amendment,
  verifyStage4CRecovery02Amendment,
} from './stage4c-recovery-amendment-02.mjs'
import { summarizeStage4CExecution } from './stage4c-run-summary.mjs'

const PROJECT_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const AUTODATA_HOME = '/data/codex-work/autodata/evolution'
const ORIGINAL_GENERATION_RUN_ROOT = '/data/codex-work/autodata/runs/generations'
const PREDECESSOR_GENERATION_RUN_ROOT = '/data/codex-work/autodata/runs/generation-recoveries/stage4c-pjlab-01'
const GENERATION_RUN_ROOT = '/data/codex-work/autodata/runs/generation-recoveries/stage4c-freerouter-02'
const DIAGNOSTIC_ROOT = '/data/codex-work/autodata/runs/diagnostics/stage4c-freerouter-02'
const EXPERIMENT_RUN_ROOT = '/data/codex-work/autodata/runs/experiments'
const EXPERIMENT_STAGING_ROOT = '/mnt/shared-storage-user/gezhilong/autodata/staging/experiments'
const H0_RUN_ID = 'h0-f058c05bd893-20260830'
const H0_RUN_DIRECTORY = resolve(EXPERIMENT_RUN_ROOT, 'bfcl-v4', H0_RUN_ID)
const B_SEARCH_CASES_JSONL = resolve(PROJECT_ROOT, 'stage4b/bfcl/search.jsonl')
const EXPERIMENT_ASSET_ROOT = resolve(PROJECT_ROOT, 'stage4b')
const COMMON_WORKER_ROOT = resolve(PROJECT_ROOT, 'stage4a/python/autodata_stage4a')
const PROFILE_ID = 'bfcl-v4'
const STRATEGY_VERSION = '1'
const MAX_PROPOSAL_DRAFTS = 1
const MAX_TOKENS = 16_384
const POLL_INTERVAL_MS = 10_000
export const STAGE4C_RECOVERY_02_LOCK_FILE = '/data/codex-work/autodata/runs/.stage4c-freerouter-02.lock'
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'recovery_required'])
const COMMANDS = new Set(['prepare', 'verify', 'start', 'resume', 'status'])

const invokedAsMain = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsMain) {
  const command = process.argv[2]
  if (command === '--help' || command === '-h') {
    console.log('Usage: node scripts/stage4c-first-h1-recovery-02.mjs [prepare|verify|start|resume|status]')
  } else if (!COMMANDS.has(command) || process.argv.length !== 3) {
    console.error('Usage: node scripts/stage4c-first-h1-recovery-02.mjs [prepare|verify|start|resume|status]')
    process.exitCode = 64
  } else {
    try {
      const result = await run(command)
      console.log(JSON.stringify(result.summary))
      if (!['prepare', 'verify', 'status'].includes(command)) {
        if (result.summary.status === 'recovery_required') process.exitCode = 2
        else if (result.summary.status !== 'succeeded') process.exitCode = 1
      }
    } catch (error) {
      console.error(`Stage 4C recovery-02 entry failed: ${diagnostic(error, secrets())}`)
      process.exitCode = 1
    }
  }
}

async function run(requestedCommand) {
  const lock = requestedCommand === 'start' || requestedCommand === 'resume'
    ? acquireStage4CRecovery02Lock()
    : undefined
  try {
    return await runWithLock(requestedCommand)
  } finally {
    lock?.dispose()
  }
}

async function runWithLock(requestedCommand) {
  const git = formalGitIdentity()
  const protocol = requestedCommand === 'prepare'
    ? createStage4CRecovery02Amendment(recoveryOptions(git.commit))
    : verifyStage4CRecovery02Amendment(recoveryOptions(git.commit))
  const execution = recoveryExecution(protocol.amendment, git)
  const contract = assertStage4CRecovery02Contract(protocol.amendment)
  const amendmentSha256 = createHash('sha256').update(readFileSync(protocol.path)).digest('hex')
  if (requestedCommand === 'prepare' || requestedCommand === 'verify') {
    return {
      summary: Object.freeze({
        schema_version: 'autodata-stage4c-recovery-02-preparation-1',
        status: requestedCommand === 'prepare' ? 'prepared' : 'verified',
        amendment_created: protocol.created,
        amendment_path: protocol.path,
        amendment_sha256: amendmentSha256,
        contract_sha256: contract.sha256,
        predecessor_amendment_id: protocol.amendment.predecessor_amendment_id,
        same_logical_h1: true,
        protocol_deviation: true,
        exploratory: true,
        recovery_generation_run_id: execution.generation_run_id,
        recovery_experiment_run_id: execution.experiment_run_id,
        recovery_candidate_id: execution.candidate_id,
        execution_commit: execution.commit,
        provider: FREEROUTER_PROVIDER,
        model: FREEROUTER_MODEL,
        proposal_session_id: execution.session_id,
        max_proposal_drafts: MAX_PROPOSAL_DRAFTS,
        max_provider_requests: 1,
        b_test_touched: false,
      }),
    }
  }

  // Fail before configuring transports or constructing a DSH Agent. This is
  // a strict zero-network gate for start/resume without the named credential.
  assertStage4CRecovery02Credential(requestedCommand)

  process.env.AUTODATA_HOME = AUTODATA_HOME
  process.env.DSH_TOOLS_MODE = 'native'

  let ctx
  let disposeEnvironmentProxy
  let providerRequestBudget
  try {
    const llmConfig = createFreerouterLlmConfig(execution.session_id)
    assertFreerouterConfig(llmConfig, execution.session_id)
    assertProtocolRoute(protocol.amendment, llmConfig, execution)
    disposeEnvironmentProxy = await installEnvironmentProxy()
    providerRequestBudget = installFreerouterRequestBudget(execution.session_id, 1)
    const [
      { Context },
      { default: AgentRegistry },
      { default: AgentLoop },
      LlmPiAi,
      { default: LlmRuntime },
      { default: SessionStore },
      { default: SystemPrompt },
      { default: ToolRuntime },
      { default: LocalJobRegistry },
      { default: LocalSubprocessRuntime },
      { default: AutoDataService, getEvolutionController, getGenerationController },
      { DshGenerationProposer },
    ] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-agent'),
      import('@deepseek-ai/dsh-agent-loop'),
      import('@deepseek-ai/dsh-llm-pi-ai'),
      import('@deepseek-ai/dsh-llm'),
      import('@deepseek-ai/dsh-session'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-jobs-local'),
      import('@deepseek-ai/dsh-subprocess-local'),
      import('../lib/service.js'),
      import('../lib/generation/index.js'),
    ])

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, llmConfig)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    // Deliberately do not install dsh-llm-retry. The provider policy also has
    // maxRetries=0, so one proposal draft can issue at most one wire request.
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(AutoDataService, {
      experiment: {
        run_root: EXPERIMENT_RUN_ROOT,
        staging_root: EXPERIMENT_STAGING_ROOT,
        asset_root: EXPERIMENT_ASSET_ROOT,
        common_worker_root: COMMON_WORKER_ROOT,
      },
      generation: {
        run_root: GENERATION_RUN_ROOT,
        expected_proposal_context_sha256: protocol.amendment.evidence_sha256.proposal_context,
        proposer: new DshGenerationProposer(ctx, {
          provider: FREEROUTER_PROVIDER,
          model: FREEROUTER_MODEL,
          max_tokens: MAX_TOKENS,
        }),
      },
    })
    await ctx.plugin(AgentLoop, { agents: [] })

    const evolution = getEvolutionController(ctx)
    const profile = evolution.status(PROFILE_ID).profile
    if (profile.id !== PROFILE_ID || profile.benchmark !== 'bfcl-v4') {
      throw new Error('the durable bfcl-v4 TaskProfile does not match the formal Stage 4C target')
    }
    const controller = getGenerationController(ctx)
    const existing = generationStatusOrUndefined(controller, execution)
    if (existing !== undefined && existing.state.execution_commit !== execution.commit) {
      throw new Error('existing Stage 4C recovery-02 generation is bound to a different full Git commit')
    }
    if (existing !== undefined && existing.state.max_proposal_drafts !== MAX_PROPOSAL_DRAFTS) {
      throw new Error('existing Stage 4C recovery-02 generation has a different proposal budget')
    }

    let status
    if (requestedCommand === 'start') {
      if (existing !== undefined) throw new Error(`generation ${PROFILE_ID}/${execution.generation_run_id} already exists`)
      status = controller.start(createStage4CRecovery02StartRequest(execution))
    } else if (requestedCommand === 'resume') {
      if (existing === undefined) throw new Error(`generation ${PROFILE_ID}/${execution.generation_run_id} does not exist`)
      status = controller.resume(PROFILE_ID, execution.generation_run_id)
    } else {
      if (existing === undefined) throw new Error(`generation ${PROFILE_ID}/${execution.generation_run_id} does not exist`)
      status = existing
    }

    if (requestedCommand !== 'status' && status.job_id !== undefined) {
      status = await pollUntilSettled(controller, status, execution)
    }
    const base = summarizeStage4CExecution({
      requestedCommand,
      operation: requestedCommand,
      state: status.state,
      execution,
      provider: FREEROUTER_PROVIDER,
      model: FREEROUTER_MODEL,
      profileId: PROFILE_ID,
      protocolAmendment: {
        id: protocol.amendment.amendment_id,
        sha256: amendmentSha256,
        path: protocol.path,
        originalGenerationRunId: STAGE4C_RECOVERY_01.generation_run_id,
      },
    })
    return {
      summary: Object.freeze({
        ...base,
        schema_version: 'autodata-stage4c-recovery-02-summary-1',
        predecessor_amendment_id: protocol.amendment.predecessor_amendment_id,
        protocol_deviation: true,
        exploratory: true,
        proposal_session_id: execution.session_id,
        max_proposal_drafts: MAX_PROPOSAL_DRAFTS,
        proposal_drafts_started: status.state.proposal_drafts_started,
        max_provider_requests: 1,
        provider_requests_started: providerRequestBudget.attempts(),
        provider_fetch_calls: providerRequestBudget.calls(),
        provider_retry_max: 0,
      }),
    }
  } finally {
    if (ctx !== undefined) await ctx.fiber.dispose().catch(() => undefined)
    if (providerRequestBudget !== undefined) providerRequestBudget.dispose()
    if (disposeEnvironmentProxy !== undefined) await disposeEnvironmentProxy().catch(() => undefined)
  }
}

export function acquireStage4CRecovery02Lock(lockPath = STAGE4C_RECOVERY_02_LOCK_FILE) {
  const path = resolve(lockPath)
  if (path !== lockPath) throw new Error('Stage 4C recovery-02 lock path must be absolute and normalized')
  const parent = dirname(path)
  const parentStat = lstatSync(parent)
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || realpathSync(parent) !== parent) {
    throw new Error('Stage 4C recovery-02 lock parent must be one real directory')
  }
  let descriptor
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
    const opened = fstatSync(descriptor)
    if (!opened.isFile()) throw new Error('Stage 4C recovery-02 lock must be a regular file')
    const outcome = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', descriptor],
    })
    if (outcome.error !== undefined) throw outcome.error
    if (outcome.status !== 0) {
      throw new Error('another Stage 4C recovery-02 start/resume process holds the execution lock')
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    throw error
  }
  let disposed = false
  return Object.freeze({
    path,
    dispose: () => {
      if (disposed) return
      disposed = true
      closeSync(descriptor)
    },
  })
}

export function assertStage4CRecovery02Contract(amendment, paths = {}) {
  const expected = amendment?.frozen_h0?.contract_sha256
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error('Stage 4C recovery-02 amendment has no valid frozen H0 contract SHA-256')
  }
  const baselinePath = resolve(paths.baselineContractPath ?? resolve(H0_RUN_DIRECTORY, 'experiment-contract.json'))
  const checkedPath = resolve(paths.checkedContractPath ?? resolve(EXPERIMENT_ASSET_ROOT, 'experiment-contract.json'))
  const baseline = readRealFile(baselinePath, 'frozen H0 experiment contract')
  const checked = readRealFile(checkedPath, 'checked-in experiment contract')
  const sha256 = createHash('sha256').update(baseline).digest('hex')
  if (sha256 !== expected || !baseline.equals(checked)) {
    throw new Error('checked-in experiment contract bytes do not match the frozen H0 contract')
  }
  return Object.freeze({ sha256 })
}

function readRealFile(path, label) {
  const inspected = lstatSync(path)
  if (inspected.isSymbolicLink() || !inspected.isFile() || realpathSync(path) !== path) {
    throw new Error(`${label} must be one real regular file`)
  }
  let descriptor
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== inspected.dev || opened.ino !== inspected.ino) {
      throw new Error(`${label} changed while it was being verified`)
    }
    return readFileSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function createStage4CRecovery02StartRequest(execution) {
  return Object.freeze({
    profile_id: PROFILE_ID,
    run_id: execution.generation_run_id,
    experiment_run_id: execution.experiment_run_id,
    execution_commit: execution.commit,
    baseline_run_directory: H0_RUN_DIRECTORY,
    b_search_cases_jsonl: B_SEARCH_CASES_JSONL,
    candidate_id: execution.candidate_id,
    strategy_version: STRATEGY_VERSION,
    max_proposal_drafts: MAX_PROPOSAL_DRAFTS,
  })
}

export function assertStage4CRecovery02Credential(requestedCommand, environment = process.env) {
  if ((requestedCommand === 'start' || requestedCommand === 'resume') && !hasFreerouterApiKey(environment)) {
    throw new Error(`${FREEROUTER_API_KEY_ENV} is required for ${requestedCommand}; no network request was made`)
  }
}

function generationStatusOrUndefined(controller, execution) {
  try {
    return controller.status(PROFILE_ID, execution.generation_run_id)
  } catch (error) {
    if (isErrorCode(error, 'RUN_NOT_FOUND')) return undefined
    throw error
  }
}

async function pollUntilSettled(controller, initialStatus, execution) {
  let status = initialStatus
  let previous = ''
  for (;;) {
    const state = status.state
    const marker = `${state.status}/${state.phase}/${String(state.proposal_drafts_started)}/${String(state.attempts.length)}`
    if (marker !== previous) {
      console.log(JSON.stringify({
        type: 'stage4c_recovery_02_progress',
        profile_id: PROFILE_ID,
        run_id: execution.generation_run_id,
        status: state.status,
        phase: state.phase,
        proposal_drafts_started: state.proposal_drafts_started,
        draft_attempts_recorded: state.attempts.length,
      }))
      previous = marker
    }
    if (TERMINAL_STATUSES.has(state.status) && status.job_id === undefined) return status
    await delay(POLL_INTERVAL_MS)
    status = controller.status(PROFILE_ID, execution.generation_run_id)
  }
}

function formalGitIdentity() {
  let repositoryRoot
  let commit
  let main
  let originMain
  let status
  try {
    repositoryRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    }).trim())
    commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    }).trim()
    main = execFileSync('git', ['rev-parse', '--verify', 'main^{commit}'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    }).trim()
    originMain = execFileSync('git', ['rev-parse', '--verify', 'origin/main^{commit}'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    }).trim()
    execFileSync('git', ['merge-base', '--is-ancestor', STAGE4C_RUNTIME_CONTRACT_FIX_COMMIT, commit], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
    })
    status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    })
  } catch (error) {
    throw new Error('cannot resolve a clean Stage 4C recovery-02 Git identity containing the runtime-contract fix', { cause: error })
  }
  if (repositoryRoot !== PROJECT_ROOT) throw new Error('Stage 4C recovery-02 entry is not running from the AutoData Git root')
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Stage 4C recovery-02 Git HEAD is not a full commit SHA')
  if (commit !== main || commit !== originMain) {
    throw new Error('Stage 4C recovery-02 requires HEAD, main, and origin/main to be the same full Git commit')
  }
  const changes = status.split('\0').filter(Boolean)
  const forbidden = changes.filter(entry => entry !== ' M AGENTS.md')
  if (forbidden.length > 0) {
    throw new Error(`Stage 4C recovery-02 requires a clean tracked/untracked tree; forbidden entries: ${forbidden.join(', ')}`)
  }
  return Object.freeze({ commit, short_commit: commit.slice(0, 12) })
}

function recoveryOptions(recoveryCommit) {
  return Object.freeze({
    originalGenerationRoot: ORIGINAL_GENERATION_RUN_ROOT,
    predecessorGenerationRoot: PREDECESSOR_GENERATION_RUN_ROOT,
    recoveryGenerationRoot: GENERATION_RUN_ROOT,
    diagnosticRoot: DIAGNOSTIC_ROOT,
    experimentRunRoot: EXPERIMENT_RUN_ROOT,
    experimentStagingRoot: EXPERIMENT_STAGING_ROOT,
    evolutionRoot: AUTODATA_HOME,
    recoveryCommit,
    provider: FREEROUTER_PROVIDER,
    model: FREEROUTER_MODEL,
  })
}

function recoveryExecution(amendment, git) {
  const recovery = amendment?.recovery_execution
  const expectedSessionId = `autodata-generation-${PROFILE_ID}-${String(recovery?.generation_run_id)}`
  if (
    recovery?.execution_commit !== git.commit
    || recovery.provider !== FREEROUTER_PROVIDER
    || recovery.model !== FREEROUTER_MODEL
    || recovery.generation_root !== GENERATION_RUN_ROOT
    || recovery.session_id !== expectedSessionId
    || recovery.proposal_config?.max_tokens !== MAX_TOKENS
    || recovery.proposal_config?.max_proposal_drafts !== MAX_PROPOSAL_DRAFTS
    || recovery.proposal_config?.max_provider_requests !== 1
    || typeof recovery.generation_run_id !== 'string'
    || typeof recovery.experiment_run_id !== 'string'
    || typeof recovery.candidate_id !== 'string'
  ) throw new Error('Stage 4C recovery-02 amendment identity does not match the current execution')
  return Object.freeze({
    commit: git.commit,
    short_commit: git.short_commit,
    generation_run_id: recovery.generation_run_id,
    experiment_run_id: recovery.experiment_run_id,
    candidate_id: recovery.candidate_id,
    session_id: recovery.session_id,
  })
}

function assertProtocolRoute(amendment, config, execution) {
  const protocol = amendment.recovery_execution?.provider_config
  const route = config.providers?.[FREEROUTER_PROVIDER]
  if (
    protocol?.api_key_env !== route?.apiKeyEnv
    || protocol.api !== route.api
    || protocol.base_url !== route.baseURL
    || protocol.reasoning !== route.reasoning
    || protocol.headers?.['x-session-id'] !== execution.session_id
    || route.headers?.['x-session-id'] !== execution.session_id
    || protocol.retry_policy?.mode !== route.retryPolicy?.mode
    || protocol.retry_policy?.max_retries !== route.retryPolicy?.maxRetries
    || protocol.retry_policy?.max_retries !== 0
  ) throw new Error('Stage 4C recovery-02 FreeRouter route drifted from its amendment')
}

function isErrorCode(error, code) {
  return typeof error === 'object' && error !== null && error.code === code
}

function secrets() {
  return [
    process.env[FREEROUTER_API_KEY_ENV],
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]
}

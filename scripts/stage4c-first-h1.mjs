import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  PJLAB_API_KEY_ENV,
  PJLAB_MODEL,
  PJLAB_PROVIDER,
  assertPjlabConfig,
  createPjlabLlmConfig,
  hasPjlabApiKey,
} from './pjlab-config.mjs'
import { diagnostic } from './smoke-diagnostics.mjs'
import { installEnvironmentProxy } from './smoke-proxy.mjs'
import {
  STAGE4C_ORIGINAL_EXECUTION,
  createStage4CRecoveryAmendment,
  verifyStage4CRecoveryAmendment,
} from './stage4c-recovery-amendment.mjs'
import { summarizeStage4CExecution } from './stage4c-run-summary.mjs'

const PROJECT_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const AUTODATA_HOME = '/data/codex-work/autodata/evolution'
const ORIGINAL_GENERATION_RUN_ROOT = '/data/codex-work/autodata/runs/generations'
const GENERATION_RUN_ROOT = '/data/codex-work/autodata/runs/generation-recoveries/stage4c-pjlab-01'
const EXPERIMENT_RUN_ROOT = '/data/codex-work/autodata/runs/experiments'
const EXPERIMENT_STAGING_ROOT = '/mnt/shared-storage-user/gezhilong/autodata/staging/experiments'
const H0_RUN_ID = 'h0-f058c05bd893-20260830'
const H0_RUN_DIRECTORY = resolve(EXPERIMENT_RUN_ROOT, 'bfcl-v4', H0_RUN_ID)
const H0_CONTRACT_ID = 'stage4b-h0-baseline-1'
const H0_CONTRACT_SHA256 = '8d610144f31275f2264e5c959dee1de8dca401d7e50a3425dab0cd2b018c78e0'
const H0_FEEDBACK_ID = 'h0-search-0f39b730fc5af5a756bc'
const H0_EVALUATION_REPORT_ID = 'h0-dev-0f39b730fc5af5a756bc'
const H0_BASELINE_SCORE = 0.8
const B_SEARCH_CASES_JSONL = resolve(PROJECT_ROOT, 'stage4b/bfcl/search.jsonl')
const EXPERIMENT_ASSET_ROOT = resolve(PROJECT_ROOT, 'stage4b')
const COMMON_WORKER_ROOT = resolve(PROJECT_ROOT, 'stage4a/python/autodata_stage4a')
const PROFILE_ID = 'bfcl-v4'
const STRATEGY_VERSION = '1'
const POLL_INTERVAL_MS = 10_000
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'recovery_required'])
const COMMANDS = new Set(['prepare', 'auto', 'start', 'resume', 'status'])

const command = process.argv[2] ?? 'auto'
if (command === '--help' || command === '-h') {
  console.log('Usage: node scripts/stage4c-first-h1.mjs [prepare|auto|start|resume|status]')
} else if (!COMMANDS.has(command) || process.argv.length > 3) {
  console.error('Usage: node scripts/stage4c-first-h1.mjs [prepare|auto|start|resume|status]')
  process.exitCode = 64
} else {
  try {
    const result = await run(command)
    console.log(JSON.stringify(result.summary))
    if (command !== 'status' && command !== 'prepare') {
      if (result.summary.status === 'recovery_required') process.exitCode = 2
      else if (result.summary.status !== 'succeeded') process.exitCode = 1
    }
  } catch (error) {
    console.error(`Stage 4C first-H1 entry failed: ${diagnostic(error, secrets())}`)
    process.exitCode = 1
  }
}

async function run(requestedCommand) {
  const git = formalGitIdentity()
  preflightEvidenceBoundary()
  const protocol = requestedCommand === 'prepare'
    ? createStage4CRecoveryAmendment(recoveryOptions(git.commit))
    : verifyStage4CRecoveryAmendment(recoveryOptions(git.commit))
  const execution = recoveryExecution(protocol.amendment, git)
  const amendmentSha256 = createHash('sha256').update(readFileSync(protocol.path)).digest('hex')
  if (requestedCommand === 'prepare') {
    return {
      summary: Object.freeze({
        schema_version: 'autodata-stage4c-recovery-preparation-1',
        status: 'prepared',
        amendment_created: protocol.created,
        amendment_path: protocol.path,
        amendment_sha256: amendmentSha256,
        same_logical_h1: true,
        original_generation_run_id: STAGE4C_ORIGINAL_EXECUTION.generation_run_id,
        recovery_generation_run_id: execution.generation_run_id,
        recovery_experiment_run_id: execution.experiment_run_id,
        recovery_candidate_id: execution.candidate_id,
        execution_commit: execution.commit,
        provider: PJLAB_PROVIDER,
        model: PJLAB_MODEL,
        b_test_touched: false,
      }),
    }
  }
  process.env.AUTODATA_HOME = AUTODATA_HOME
  process.env.DSH_TOOLS_MODE = 'native'

  let ctx
  let disposeEnvironmentProxy
  try {
    disposeEnvironmentProxy = await installEnvironmentProxy()
    const llmConfig = createPjlabLlmConfig()
    assertPjlabConfig(llmConfig)
    const [
      { Context },
      { default: AgentRegistry },
      { default: AgentLoop },
      LlmPiAi,
      LlmRetry,
      { default: LlmRuntime },
      { default: SessionStore },
      { default: SystemPrompt },
      { default: ToolRuntime },
      { default: LocalJobRegistry },
      { default: LocalSubprocessRuntime },
      { default: AutoDataService, getEvolutionController, getGenerationController },
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
      import('@deepseek-ai/dsh-jobs-local'),
      import('@deepseek-ai/dsh-subprocess-local'),
      import('../lib/service.js'),
    ])

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, llmConfig)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRetry)
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
      throw new Error('existing Stage 4C generation is bound to a different full Git commit')
    }
    const operation = resolveOperation(requestedCommand, existing?.state.status)
    if ((operation === 'start' || operation === 'resume') && !hasPjlabApiKey()) {
      throw new Error(`${PJLAB_API_KEY_ENV} is required for ${operation}`)
    }

    let status
    if (operation === 'start') status = controller.start(startRequest(execution))
    else if (operation === 'resume') status = controller.resume(PROFILE_ID, execution.generation_run_id)
    else {
      if (existing === undefined) {
        throw new Error(`generation ${PROFILE_ID}/${execution.generation_run_id} does not exist`)
      }
      status = existing
    }

    if (operation !== 'status' && status.job_id !== undefined) {
      status = await pollUntilSettled(controller, status, execution)
    }
    return {
      summary: summarizeStage4CExecution({
        requestedCommand,
        operation,
        state: status.state,
        execution,
        provider: PJLAB_PROVIDER,
        model: PJLAB_MODEL,
        profileId: PROFILE_ID,
        protocolAmendment: {
          id: protocol.amendment.amendment_id,
          sha256: amendmentSha256,
          path: protocol.path,
          originalGenerationRunId: STAGE4C_ORIGINAL_EXECUTION.generation_run_id,
        },
      }),
    }
  } finally {
    if (ctx !== undefined) await ctx.fiber.dispose().catch(() => undefined)
    if (disposeEnvironmentProxy !== undefined) await disposeEnvironmentProxy().catch(() => undefined)
  }
}

function startRequest(execution) {
  return Object.freeze({
    profile_id: PROFILE_ID,
    run_id: execution.generation_run_id,
    experiment_run_id: execution.experiment_run_id,
    execution_commit: execution.commit,
    baseline_run_directory: H0_RUN_DIRECTORY,
    b_search_cases_jsonl: B_SEARCH_CASES_JSONL,
    candidate_id: execution.candidate_id,
    strategy_version: STRATEGY_VERSION,
  })
}

function generationStatusOrUndefined(controller, execution) {
  try {
    return controller.status(PROFILE_ID, execution.generation_run_id)
  } catch (error) {
    if (isErrorCode(error, 'RUN_NOT_FOUND')) return undefined
    throw error
  }
}

function resolveOperation(requestedCommand, existingStatus) {
  if (requestedCommand !== 'auto') return requestedCommand
  if (existingStatus === undefined) return 'start'
  if (existingStatus === 'failed' || existingStatus === 'cancelled') return 'status'
  // Replaying a completed ledger is intentional: it verifies that a fresh
  // process can reconcile the durable accepted/rejected decision and runtime.
  return 'resume'
}

async function pollUntilSettled(controller, initialStatus, execution) {
  let status = initialStatus
  let previous = ''
  for (;;) {
    const state = status.state
    const marker = `${state.status}/${state.phase}/${String(state.attempts.length)}`
    if (marker !== previous) {
      console.log(JSON.stringify({
        type: 'stage4c_progress',
        profile_id: PROFILE_ID,
        run_id: execution.generation_run_id,
        status: state.status,
        phase: state.phase,
        draft_attempts: state.attempts.length,
      }))
      previous = marker
    }
    // resume() intentionally starts a reconciliation job even when the
    // durable state is recovery_required or already complete. Wait until that
    // process-local job has actually exited before treating the old durable
    // status as terminal.
    if (TERMINAL_STATUSES.has(state.status) && status.job_id === undefined) return status
    await delay(POLL_INTERVAL_MS)
    status = controller.status(PROFILE_ID, execution.generation_run_id)
  }
}

function formalGitIdentity() {
  let repositoryRoot
  let commit
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
    status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    })
  } catch (error) {
    throw new Error('cannot resolve the formal Stage 4C Git identity', { cause: error })
  }
  if (repositoryRoot !== PROJECT_ROOT) throw new Error('formal Stage 4C entry is not running from the AutoData Git root')
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('formal Stage 4C Git HEAD is not a full commit SHA')
  const changes = status.split('\0').filter(Boolean)
  const forbidden = changes.filter(entry => entry !== ' M AGENTS.md')
  if (forbidden.length > 0) {
    throw new Error(`formal Stage 4C requires a clean tracked/untracked tree; forbidden entries: ${forbidden.join(', ')}`)
  }
  return Object.freeze({ commit, short_commit: commit.slice(0, 12) })
}

function recoveryOptions(recoveryCommit) {
  return Object.freeze({
    originalGenerationRoot: ORIGINAL_GENERATION_RUN_ROOT,
    recoveryGenerationRoot: GENERATION_RUN_ROOT,
    experimentRunRoot: EXPERIMENT_RUN_ROOT,
    experimentStagingRoot: EXPERIMENT_STAGING_ROOT,
    evolutionRoot: AUTODATA_HOME,
    recoveryCommit,
    provider: PJLAB_PROVIDER,
    model: PJLAB_MODEL,
  })
}

function recoveryExecution(amendment, git) {
  const recovery = amendment?.recovery_execution
  if (
    recovery?.execution_commit !== git.commit
    || recovery.provider !== PJLAB_PROVIDER
    || recovery.model !== PJLAB_MODEL
    || recovery.generation_root !== GENERATION_RUN_ROOT
    || typeof recovery.generation_run_id !== 'string'
    || typeof recovery.experiment_run_id !== 'string'
    || typeof recovery.candidate_id !== 'string'
  ) throw new Error('Stage 4C recovery amendment identity does not match the current execution')
  return Object.freeze({
    commit: git.commit,
    short_commit: git.short_commit,
    generation_run_id: recovery.generation_run_id,
    experiment_run_id: recovery.experiment_run_id,
    candidate_id: recovery.candidate_id,
  })
}

function preflightEvidenceBoundary() {
  const profileDirectory = resolve(AUTODATA_HOME, 'profiles', PROFILE_ID)
  const requiredDirectories = [AUTODATA_HOME, H0_RUN_DIRECTORY, EXPERIMENT_ASSET_ROOT, COMMON_WORKER_ROOT]
  for (const path of requiredDirectories) requireRealPath(path, 'directory')
  const requiredFiles = [
    resolve(AUTODATA_HOME, 'profiles', PROFILE_ID, 'profile.json'),
    resolve(AUTODATA_HOME, 'profiles', PROFILE_ID, 'state.json'),
    resolve(H0_RUN_DIRECTORY, 'canonical.jsonl'),
    resolve(H0_RUN_DIRECTORY, 'run-summary.json'),
    resolve(H0_RUN_DIRECTORY, 'b-search-results.json'),
    resolve(H0_RUN_DIRECTORY, 'feedback.json'),
    resolve(H0_RUN_DIRECTORY, 'state.json'),
    resolve(H0_RUN_DIRECTORY, 'evaluation-report.json'),
    resolve(H0_RUN_DIRECTORY, 'experiment-contract.json'),
    B_SEARCH_CASES_JSONL,
    resolve(EXPERIMENT_ASSET_ROOT, 'experiment-contract.json'),
  ]
  for (const path of requiredFiles) {
    rejectBTestPath(path)
    requireRealPath(path, 'file')
  }
  for (const relativePath of listRelativeFiles(H0_RUN_DIRECTORY)) rejectBTestPath(relativePath)

  const baselineState = readJson(resolve(H0_RUN_DIRECTORY, 'state.json'), 'H0 state')
  if (typeof baselineState.eval_result_path !== 'string') throw new Error('formal H0 state has no eval_result_path')
  const predictionPath = resolve(dirname(baselineState.eval_result_path), 'predictions.jsonl')
  assertContained(H0_RUN_DIRECTORY, predictionPath, 'H0 predictions')
  rejectBTestPath(predictionPath)
  requireRealPath(predictionPath, 'file')

  assertFormalH0Evidence(baselineState)

  const jsonEvidence = [
    [resolve(H0_RUN_DIRECTORY, 'state.json'), 'H0 state'],
    [resolve(H0_RUN_DIRECTORY, 'b-search-results.json'), 'H0 B_search results'],
    [resolve(H0_RUN_DIRECTORY, 'evaluation-report.json'), 'H0 evaluation report'],
    [resolve(H0_RUN_DIRECTORY, 'experiment-contract.json'), 'H0 experiment contract'],
    [resolve(EXPERIMENT_ASSET_ROOT, 'experiment-contract.json'), 'checked-in experiment contract'],
  ]
  for (const [path, label] of jsonEvidence) rejectBTestEvidence(readJson(path, label), label)
  rejectBTestEvidence(readJsonLines(predictionPath, 'H0 predictions'), 'H0 predictions')
  const searchCases = readJsonLines(B_SEARCH_CASES_JSONL, 'checked-in B_search cases')
  rejectBTestEvidence(searchCases, 'checked-in B_search cases')
  if (searchCases.length === 0 || searchCases.some(value => value?.split !== 'search')) {
    throw new Error('the proposal case bundle must contain B_search cases only')
  }
  for (const relativePath of listRelativeFiles(profileDirectory)) {
    rejectBTestPath(relativePath)
    const path = resolve(profileDirectory, relativePath)
    if (relativePath.endsWith('.json')) rejectBTestEvidence(readJson(path, `Evolution record ${relativePath}`), 'Evolution record')
    if (relativePath.endsWith('.jsonl')) rejectBTestEvidence(readJsonLines(path, `Evolution record ${relativePath}`), 'Evolution record')
  }
}

function assertFormalH0Evidence(baselineState) {
  const contractPath = resolve(H0_RUN_DIRECTORY, 'experiment-contract.json')
  const checkedContractPath = resolve(EXPERIMENT_ASSET_ROOT, 'experiment-contract.json')
  const contractText = readFileSync(contractPath, 'utf8')
  const checkedContractText = readFileSync(checkedContractPath, 'utf8')
  const contractSha256 = createHash('sha256').update(contractText).digest('hex')
  if (contractText !== checkedContractText || contractSha256 !== H0_CONTRACT_SHA256) {
    throw new Error('formal H0 contract bytes do not match the checked-in frozen contract')
  }
  const contract = readJson(contractPath, 'H0 experiment contract')
  if (
    contract.contract_id !== H0_CONTRACT_ID
    || contract.profile?.id !== PROFILE_ID
    || contract.profile?.benchmark !== 'bfcl-v4'
    || contract.profile?.metric !== 'equal_category_accuracy'
  ) throw new Error('formal H0 contract identity is invalid')
  if (
    baselineState.contract_id !== H0_CONTRACT_ID
    || baselineState.contract_sha256 !== contractSha256
    || baselineState.profile_id !== PROFILE_ID
    || baselineState.run_id !== H0_RUN_ID
    || baselineState.status !== 'succeeded'
    || baselineState.phase !== 'complete'
    || baselineState.feedback_id !== H0_FEEDBACK_ID
    || baselineState.evaluation_report_id !== H0_EVALUATION_REPORT_ID
  ) throw new Error('formal H0 state is not bound to the frozen completed baseline')

  const report = readJson(resolve(H0_RUN_DIRECTORY, 'evaluation-report.json'), 'H0 evaluation report')
  if (
    report.report_id !== H0_EVALUATION_REPORT_ID
    || report.profile_id !== PROFILE_ID
    || report.candidate_id !== 'h0'
    || report.benchmark !== 'bfcl-v4'
    || report.split !== 'B_dev'
    || report.metric !== 'equal_category_accuracy'
    || report.score !== H0_BASELINE_SCORE
    || report.complete !== true
    || report.cases_evaluated !== 25
    || report.cases_expected !== 25
    || report.run_id !== H0_RUN_ID
    || report.metadata?.contract_id !== H0_CONTRACT_ID
    || report.metadata?.contract_sha256 !== contractSha256
    || report.metadata?.evaluation_result_path !== baselineState.eval_result_path
  ) throw new Error('formal H0 B_dev report is not the frozen 0.8 baseline')

  const searchPath = resolve(H0_RUN_DIRECTORY, 'b-search-results.json')
  const search = readJson(searchPath, 'H0 B_search results')
  if (
    search.schema_version !== 'autodata-b-search-results-1'
    || search.contract_id !== H0_CONTRACT_ID
    || search.contract_sha256 !== contractSha256
    || search.profile_id !== PROFILE_ID
    || search.run_id !== H0_RUN_ID
    || !Array.isArray(search.cases)
    || search.cases.length !== 25
  ) throw new Error('formal H0 B_search results are not bound to the frozen run')

  const feedback = readJson(resolve(H0_RUN_DIRECTORY, 'feedback.json'), 'H0 feedback')
  if (
    feedback.feedback_id !== H0_FEEDBACK_ID
    || feedback.profile_id !== PROFILE_ID
    || feedback.candidate_id !== 'h0'
    || feedback.benchmark !== 'bfcl-v4'
    || feedback.split !== 'B_search'
    || feedback.artifact_path !== searchPath
    || feedback.metadata?.contract_id !== H0_CONTRACT_ID
    || feedback.metadata?.contract_sha256 !== contractSha256
    || feedback.metadata?.run_id !== H0_RUN_ID
  ) throw new Error('formal H0 feedback is not bound to the frozen B_search artifact')

  const evolutionStatePath = resolve(AUTODATA_HOME, 'profiles', PROFILE_ID, 'state.json')
  const evolutionFeedbackPath = resolve(AUTODATA_HOME, 'profiles', PROFILE_ID, 'feedback', `${H0_FEEDBACK_ID}.json`)
  const evolutionReportPath = resolve(AUTODATA_HOME, 'profiles', PROFILE_ID, 'runs', H0_RUN_ID, 'summary.json')
  for (const path of [evolutionStatePath, evolutionFeedbackPath, evolutionReportPath]) requireRealPath(path, 'file')
  const evolutionState = readJson(evolutionStatePath, 'Evolution state')
  const h0 = Array.isArray(evolutionState.candidates)
    ? evolutionState.candidates.find(candidate => candidate?.candidate_id === 'h0')
    : undefined
  if (
    !Array.isArray(evolutionState.feedback_ids)
    || !evolutionState.feedback_ids.includes(H0_FEEDBACK_ID)
    || h0?.evaluation?.report_id !== H0_EVALUATION_REPORT_ID
    || h0.evaluation.candidate_id !== 'h0'
    || h0.evaluation.benchmark !== 'bfcl-v4'
    || h0.evaluation.split !== 'B_dev'
    || h0.evaluation.metric !== 'equal_category_accuracy'
    || h0.evaluation.score !== H0_BASELINE_SCORE
  ) throw new Error('Evolution state does not retain the frozen H0 baseline and feedback')
  if (!isDeepStrictEqual(readJson(evolutionFeedbackPath, 'durable H0 feedback'), feedback)) {
    throw new Error('Evolution Store H0 feedback differs from the formal experiment artifact')
  }
  if (!isDeepStrictEqual(readJson(evolutionReportPath, 'durable H0 evaluation'), report)) {
    throw new Error('Evolution Store H0 evaluation differs from the formal experiment artifact')
  }
}

function requireRealPath(path, kind) {
  const stat = statSync(path)
  if ((kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && !stat.isFile())) {
    throw new Error(`required ${kind} is unavailable: ${path}`)
  }
  if (realpathSync(path) !== resolve(path)) throw new Error(`required ${kind} uses a symlink alias: ${path}`)
}

function listRelativeFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`formal H0 artifacts contain a symbolic link: ${path}`)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(relative(root, path))
    }
  }
  visit(root)
  return files
}

function rejectBTestPath(path) {
  if (hasBTestPathComponent(path)) {
    throw new Error(`B_test path is forbidden by the Stage 4C entry: ${path}`)
  }
}

function hasBTestPathComponent(path) {
  return path.replaceAll('\\', '/').split('/').filter(Boolean)
    .some(part => /^(?:b[_-]?test(?:[._-].*)?|test(?:\.jsonl?)?)$/iu.test(part))
}

function rejectBTestEvidence(value, label, key = '') {
  if (typeof value === 'string') {
    const normalized = value.trim()
    const semanticKey = /(?:^|_)(?:split|partition|dataset|case_ids?|artifact|path|file|directory|uri|url)(?:_|$)/iu.test(key)
    if (
      /^(?:b[_-]?test|test)$/iu.test(normalized)
      || (semanticKey && (/b[_-]?test/iu.test(value) || hasBTestPathComponent(value)))
    ) {
      throw new Error(`${label} contains forbidden B_test evidence`)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) rejectBTestEvidence(entry, label, key)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      if (/b[_-]?test/iu.test(childKey)) throw new Error(`${label} contains a forbidden B_test key`)
      rejectBTestEvidence(child, label, childKey)
    }
  }
}

function readJson(path, label) {
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot parse ${label}`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function readJsonLines(path, label) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/gu).filter(line => line.trim().length > 0).map(line => JSON.parse(line))
  } catch (error) {
    throw new Error(`cannot parse ${label}`, { cause: error })
  }
}

function assertContained(root, path, label) {
  const child = relative(resolve(root), resolve(path))
  if (child === '..' || child.startsWith(`..${sep}`) || child.startsWith('/') || child.startsWith('\\')) {
    throw new Error(`${label} escapes the formal H0 run directory`)
  }
}

function isErrorCode(error, code) {
  return typeof error === 'object' && error !== null && error.code === code
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

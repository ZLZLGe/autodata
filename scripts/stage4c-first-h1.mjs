import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  GETELUCID_API,
  GETELUCID_API_KEY_ENV,
  GETELUCID_BASE_URL,
  GETELUCID_MODEL,
  GETELUCID_PROVIDER,
  assertGetElucidConfig,
  createGetElucidLlmConfig,
  hasGetElucidApiKey,
} from './getelucid-config.mjs'
import { diagnostic } from './provider-diagnostics.mjs'
import { installEnvironmentProxy } from './provider-proxy.mjs'
import { resolveStage4CExecutionIdentity } from './stage4c-run-identity.mjs'
import { summarizeStage4CExecution } from './stage4c-run-summary.mjs'

const PROJECT_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const AUTODATA_HOME = '/data/codex-work/autodata/evolution'
export const STAGE4C_GETELUCID_GENERATION_ROOT = '/data/codex-work/autodata/runs/generations/stage4c-getelucid-01'
export const STAGE4C_GETELUCID_MANIFEST_FILE = resolve(STAGE4C_GETELUCID_GENERATION_ROOT, 'run-manifest.json')
export const STAGE4C_GETELUCID_LOCK_FILE = '/data/codex-work/autodata/runs/.stage4c-getelucid-01.lock'
const EXPERIMENT_RUN_ROOT = '/data/codex-work/autodata/runs/experiments'
const EXPERIMENT_STAGING_ROOT = '/mnt/shared-storage-user/gezhilong/autodata/staging/experiments'
const H0_RUN_ID = 'h0-f058c05bd893-20260830'
const H0_RUN_DIRECTORY = resolve(EXPERIMENT_RUN_ROOT, 'bfcl-v4', H0_RUN_ID)
const H0_CONTRACT_ID = 'stage4b-h0-baseline-1'
const H0_CONTRACT_SHA256 = '8d610144f31275f2264e5c959dee1de8dca401d7e50a3425dab0cd2b018c78e0'
const H0_FEEDBACK_ID = 'h0-search-0f39b730fc5af5a756bc'
const H0_EVALUATION_REPORT_ID = 'h0-dev-0f39b730fc5af5a756bc'
const H0_BASELINE_SCORE = 0.8
const H0_SOURCE_POOL_SHA256 = 'c5c57f65bb58ddecf4d83d576a0fc7341153933bab2ce9b9596b20f9496a9db4'
const B_SEARCH_CASES_JSONL = resolve(PROJECT_ROOT, 'stage4b/bfcl/search.jsonl')
const EXPERIMENT_ASSET_ROOT = resolve(PROJECT_ROOT, 'stage4b')
const COMMON_WORKER_ROOT = resolve(PROJECT_ROOT, 'stage4a/python/autodata_stage4a')
const PROFILE_ID = 'bfcl-v4'
const STRATEGY_VERSION = '1'
const MAX_PROPOSAL_DRAFTS = 1
const MAX_PROVIDER_REQUESTS = 1
const PROVIDER_RETRY_MAX = 0
const MAX_TOKENS = 16_384
const POLL_INTERVAL_MS = 10_000
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'recovery_required'])
const COMMANDS = new Set(['start', 'resume', 'status'])
let manifestTemporarySequence = 0

const invokedAsMain = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsMain) {
  const command = process.argv[2]
  if (command === '--help' || command === '-h') {
    console.log('Usage: node scripts/stage4c-first-h1.mjs [start|resume|status]')
  } else if (!COMMANDS.has(command) || process.argv.length !== 3) {
    console.error('Usage: node scripts/stage4c-first-h1.mjs [start|resume|status]')
    process.exitCode = 64
  } else {
    try {
      const result = await run(command)
      console.log(JSON.stringify(result.summary))
      if (command !== 'status') {
        if (result.summary.status === 'recovery_required') process.exitCode = 2
        else if (result.summary.status !== 'succeeded') process.exitCode = 1
      }
    } catch (error) {
      console.error(`Stage 4C first-H1 entry failed: ${diagnostic(error, secrets())}`)
      process.exitCode = 1
    }
  }
}

async function run(requestedCommand) {
  const lock = requestedCommand === 'start' || requestedCommand === 'resume'
    ? acquireStage4CExecutionLock()
    : undefined
  try {
    return await runWithLock(requestedCommand)
  } finally {
    lock?.dispose()
  }
}

async function runWithLock(requestedCommand) {
  const execution = formalExecutionIdentity()
  preflightEvidenceBoundary()
  const existingManifest = readStage4CRunManifest(execution)
  assertStage4CCredential(requestedCommand)
  process.env.AUTODATA_HOME = AUTODATA_HOME
  process.env.DSH_TOOLS_MODE = 'native'

  let ctx
  let disposeEnvironmentProxy
  try {
    disposeEnvironmentProxy = await installEnvironmentProxy()
    const llmConfig = createGetElucidLlmConfig()
    assertGetElucidConfig(llmConfig)
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
    // Deliberately omit dsh-llm-retry. The provider profile also declares
    // maxRetries=0, so the one proposal slot maps to one Responses request.
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalJobRegistry)
    const proposer = createManifestingProposer(
      new DshGenerationProposer(ctx, {
        provider: GETELUCID_PROVIDER,
        model: GETELUCID_MODEL,
        max_tokens: MAX_TOKENS,
      }),
      execution,
    )
    await ctx.plugin(AutoDataService, {
      experiment: {
        run_root: EXPERIMENT_RUN_ROOT,
        staging_root: EXPERIMENT_STAGING_ROOT,
        asset_root: EXPERIMENT_ASSET_ROOT,
        common_worker_root: COMMON_WORKER_ROOT,
      },
      generation: {
        run_root: STAGE4C_GETELUCID_GENERATION_ROOT,
        proposer,
        ...(existingManifest === undefined
          ? {}
          : { expected_proposal_context_sha256: existingManifest.manifest.proposal.context_sha256 }),
      },
    })
    await ctx.plugin(AgentLoop, { agents: [] })

    const evolution = getEvolutionController(ctx)
    const profile = evolution.status(PROFILE_ID).profile
    if (
      profile.id !== PROFILE_ID
      || profile.benchmark !== 'bfcl-v4'
      || profile.acceptance_policy?.rule !== 'strict_improvement'
      || profile.acceptance_policy.split !== 'B_dev'
      || profile.acceptance_policy.metric !== 'equal_category_accuracy'
      || profile.acceptance_policy.direction !== 'maximize'
    ) {
      throw new Error('the durable bfcl-v4 TaskProfile does not match the formal Stage 4C target')
    }
    const controller = getGenerationController(ctx)
    const existing = generationStatusOrUndefined(controller, execution)
    if (existing !== undefined && existing.state.execution_commit !== execution.commit) {
      throw new Error('existing Stage 4C generation is bound to a different full Git commit')
    }
    if (existing !== undefined && existing.state.max_proposal_drafts !== MAX_PROPOSAL_DRAFTS) {
      throw new Error('existing Stage 4C generation has a different proposal budget')
    }

    let status
    if (requestedCommand === 'start') {
      if (existing !== undefined) throw new Error(`generation ${PROFILE_ID}/${execution.generation_run_id} already exists`)
      status = controller.start(createStage4CStartRequest(execution))
    } else if (requestedCommand === 'resume') {
      if (existing === undefined) throw new Error(`generation ${PROFILE_ID}/${execution.generation_run_id} does not exist`)
      status = controller.resume(PROFILE_ID, execution.generation_run_id)
    }
    else {
      if (existing === undefined) {
        throw new Error(`generation ${PROFILE_ID}/${execution.generation_run_id} does not exist`)
      }
      status = existing
    }

    if (requestedCommand !== 'status' && status.job_id !== undefined) {
      status = await pollUntilSettled(controller, status, execution)
    }
    const manifest = readStage4CRunManifest(execution)
    return {
      summary: summarizeStage4CExecution({
        requestedCommand,
        operation: requestedCommand,
        state: status.state,
        execution,
        provider: GETELUCID_PROVIDER,
        model: GETELUCID_MODEL,
        profileId: PROFILE_ID,
        runManifest: manifest,
      }),
    }
  } finally {
    if (ctx !== undefined) await ctx.fiber.dispose().catch(() => undefined)
    if (disposeEnvironmentProxy !== undefined) await disposeEnvironmentProxy().catch(() => undefined)
  }
}

export function createStage4CStartRequest(execution) {
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

function formalExecutionIdentity() {
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
  return resolveStage4CExecutionIdentity({
    generationRunRoot: STAGE4C_GETELUCID_GENERATION_ROOT,
    profileId: PROFILE_ID,
    commit,
    maxProposalDrafts: MAX_PROPOSAL_DRAFTS,
  })
}

export function assertStage4CCredential(command, environment = process.env) {
  if ((command === 'start' || command === 'resume') && !hasGetElucidApiKey(environment)) {
    throw new Error(`${GETELUCID_API_KEY_ENV} is required for ${command}; no network request was made`)
  }
}

export function acquireStage4CExecutionLock(lockPath = STAGE4C_GETELUCID_LOCK_FILE) {
  const path = resolve(lockPath)
  if (path !== lockPath) throw new Error('Stage 4C lock path must be absolute and normalized')
  const parent = dirname(path)
  const parentStat = lstatSync(parent)
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || realpathSync(parent) !== parent) {
    throw new Error('Stage 4C lock parent must be one real directory')
  }
  let descriptor
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
    const opened = fstatSync(descriptor)
    if (!opened.isFile()) throw new Error('Stage 4C lock must be a regular file')
    const outcome = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', descriptor],
    })
    if (outcome.error !== undefined) throw outcome.error
    if (outcome.status !== 0) throw new Error('another Stage 4C start/resume process holds the execution lock')
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

export function createStage4CRunManifest(execution, proposalContext) {
  if (proposalContext?.profile_id !== PROFILE_ID) {
    throw new Error('Stage 4C proposal context belongs to a different profile')
  }
  if (
    proposalContext?.source_pool?.canonical_jsonl_sha256 !== H0_SOURCE_POOL_SHA256
    || !/^[a-f0-9]{64}$/u.test(proposalContext.source_pool.canonical_jsonl_sha256)
  ) throw new Error('Stage 4C proposal context source pool differs from frozen H0')
  const proposalContextSha256 = sha256(`${canonicalJson(proposalContext)}\n`)
  const manifest = {
    schema_version: 'autodata-stage4c-getelucid-run-manifest-1',
    exploratory: true,
    profile_id: PROFILE_ID,
    generation_run_id: execution.generation_run_id,
    experiment_run_id: execution.experiment_run_id,
    candidate_id: execution.candidate_id,
    execution_commit: execution.commit,
    provider: {
      id: GETELUCID_PROVIDER,
      api: GETELUCID_API,
      base_url: GETELUCID_BASE_URL,
      endpoint: `${GETELUCID_BASE_URL}/responses`,
      model: GETELUCID_MODEL,
      api_key_env: GETELUCID_API_KEY_ENV,
    },
    h0: {
      run_id: H0_RUN_ID,
      contract_id: H0_CONTRACT_ID,
      contract_sha256: H0_CONTRACT_SHA256,
      source_pool_sha256: H0_SOURCE_POOL_SHA256,
    },
    proposal: {
      context_sha256: proposalContextSha256,
      max_proposal_drafts: MAX_PROPOSAL_DRAFTS,
      max_provider_requests: MAX_PROVIDER_REQUESTS,
      provider_retry_max: PROVIDER_RETRY_MAX,
    },
    acceptance: {
      rule: 'strict_improvement',
      split: 'B_dev',
      metric: 'equal_category_accuracy',
      direction: 'maximize',
      baseline_score: H0_BASELINE_SCORE,
    },
  }
  assertStage4CRunManifest(manifest, execution)
  return deepFreeze(manifest)
}

export function assertStage4CRunManifest(value, execution) {
  const manifest = requireExactRecord(value, [
    'schema_version',
    'exploratory',
    'profile_id',
    'generation_run_id',
    'experiment_run_id',
    'candidate_id',
    'execution_commit',
    'provider',
    'h0',
    'proposal',
    'acceptance',
  ], 'Stage 4C run manifest')
  assertManifestEqual(manifest.schema_version, 'autodata-stage4c-getelucid-run-manifest-1', 'schema_version')
  assertManifestEqual(manifest.exploratory, true, 'exploratory')
  assertManifestEqual(manifest.profile_id, PROFILE_ID, 'profile_id')
  assertManifestEqual(manifest.generation_run_id, execution.generation_run_id, 'generation_run_id')
  assertManifestEqual(manifest.experiment_run_id, execution.experiment_run_id, 'experiment_run_id')
  assertManifestEqual(manifest.candidate_id, execution.candidate_id, 'candidate_id')
  assertManifestEqual(manifest.execution_commit, execution.commit, 'execution_commit')

  const provider = requireExactRecord(manifest.provider, [
    'id', 'api', 'base_url', 'endpoint', 'model', 'api_key_env',
  ], 'Stage 4C run manifest provider')
  assertManifestEqual(provider.id, GETELUCID_PROVIDER, 'provider.id')
  assertManifestEqual(provider.api, GETELUCID_API, 'provider.api')
  assertManifestEqual(provider.base_url, GETELUCID_BASE_URL, 'provider.base_url')
  assertManifestEqual(provider.endpoint, `${GETELUCID_BASE_URL}/responses`, 'provider.endpoint')
  assertManifestEqual(provider.model, GETELUCID_MODEL, 'provider.model')
  assertManifestEqual(provider.api_key_env, GETELUCID_API_KEY_ENV, 'provider.api_key_env')

  const h0 = requireExactRecord(manifest.h0, [
    'run_id', 'contract_id', 'contract_sha256', 'source_pool_sha256',
  ], 'Stage 4C run manifest H0')
  assertManifestEqual(h0.run_id, H0_RUN_ID, 'h0.run_id')
  assertManifestEqual(h0.contract_id, H0_CONTRACT_ID, 'h0.contract_id')
  assertManifestEqual(h0.contract_sha256, H0_CONTRACT_SHA256, 'h0.contract_sha256')
  assertManifestEqual(h0.source_pool_sha256, H0_SOURCE_POOL_SHA256, 'h0.source_pool_sha256')

  const proposal = requireExactRecord(manifest.proposal, [
    'context_sha256', 'max_proposal_drafts', 'max_provider_requests', 'provider_retry_max',
  ], 'Stage 4C run manifest proposal')
  if (typeof proposal.context_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(proposal.context_sha256)) {
    throw new Error('Stage 4C run manifest proposal.context_sha256 must be lowercase SHA-256')
  }
  assertManifestEqual(proposal.max_proposal_drafts, MAX_PROPOSAL_DRAFTS, 'proposal.max_proposal_drafts')
  assertManifestEqual(proposal.max_provider_requests, MAX_PROVIDER_REQUESTS, 'proposal.max_provider_requests')
  assertManifestEqual(proposal.provider_retry_max, PROVIDER_RETRY_MAX, 'proposal.provider_retry_max')

  const acceptance = requireExactRecord(manifest.acceptance, [
    'rule', 'split', 'metric', 'direction', 'baseline_score',
  ], 'Stage 4C run manifest acceptance')
  assertManifestEqual(acceptance.rule, 'strict_improvement', 'acceptance.rule')
  assertManifestEqual(acceptance.split, 'B_dev', 'acceptance.split')
  assertManifestEqual(acceptance.metric, 'equal_category_accuracy', 'acceptance.metric')
  assertManifestEqual(acceptance.direction, 'maximize', 'acceptance.direction')
  assertManifestEqual(acceptance.baseline_score, H0_BASELINE_SCORE, 'acceptance.baseline_score')
  return manifest
}

export function persistStage4CRunManifest(manifest, path = STAGE4C_GETELUCID_MANIFEST_FILE) {
  const normalizedPath = resolve(path)
  if (normalizedPath !== path) throw new Error('Stage 4C run manifest path must be absolute and normalized')
  const parent = dirname(normalizedPath)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  requireRealDirectory(parent, 'Stage 4C run manifest parent')
  const content = `${canonicalJson(manifest)}\n`
  if (existsSync(normalizedPath)) {
    assertRegularFile(normalizedPath, 'Stage 4C run manifest')
    if (readFileSync(normalizedPath, 'utf8') !== content) {
      throw new Error('existing Stage 4C run manifest conflicts with the frozen plan')
    }
    return Object.freeze({ manifest: deepFreeze(manifest), path: normalizedPath, sha256: sha256(content) })
  }

  manifestTemporarySequence += 1
  const temporary = resolve(parent, `.run-manifest.${String(process.pid)}.${String(manifestTemporarySequence)}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    try {
      linkSync(temporary, normalizedPath)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      assertRegularFile(normalizedPath, 'Stage 4C run manifest')
      if (readFileSync(normalizedPath, 'utf8') !== content) {
        throw new Error('existing Stage 4C run manifest conflicts with the frozen plan')
      }
    }
    const parentDescriptor = openSync(parent, constants.O_RDONLY)
    try { fsyncSync(parentDescriptor) } finally { closeSync(parentDescriptor) }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return Object.freeze({ manifest: deepFreeze(manifest), path: normalizedPath, sha256: sha256(content) })
}

export function readStage4CRunManifest(execution, path = STAGE4C_GETELUCID_MANIFEST_FILE) {
  const normalizedPath = resolve(path)
  if (normalizedPath !== path) throw new Error('Stage 4C run manifest path must be absolute and normalized')
  if (!existsSync(normalizedPath)) return undefined
  assertRegularFile(normalizedPath, 'Stage 4C run manifest')
  const content = readFileSync(normalizedPath, 'utf8')
  let manifest
  try {
    manifest = JSON.parse(content)
  } catch (error) {
    throw new Error('cannot parse Stage 4C run manifest', { cause: error })
  }
  assertStage4CRunManifest(manifest, execution)
  const canonical = `${canonicalJson(manifest)}\n`
  if (content !== canonical) throw new Error('Stage 4C run manifest is not in canonical form')
  return Object.freeze({ manifest: deepFreeze(manifest), path: normalizedPath, sha256: sha256(content) })
}

export function createManifestingProposer(delegate, execution, manifestPath = STAGE4C_GETELUCID_MANIFEST_FILE) {
  if (delegate === null || typeof delegate !== 'object' || typeof delegate.create !== 'function') {
    throw new Error('Stage 4C manifesting proposer requires a proposal delegate')
  }
  return Object.freeze({
    create: async (profileId, runId, signal) => {
      const session = await delegate.create(profileId, runId, signal)
      return Object.freeze({
        agent: session.agent,
        propose: async (request, proposalSignal) => {
          if (request.max_attempts !== MAX_PROPOSAL_DRAFTS || request.attempt !== 1) {
            throw new Error('Stage 4C proposal request exceeds the frozen one-request budget')
          }
          const manifest = createStage4CRunManifest(execution, request.context)
          persistStage4CRunManifest(manifest, manifestPath)
          return session.propose(request, proposalSignal)
        },
        cancel: reason => session.cancel(reason),
        dispose: () => session.dispose(),
      })
    },
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Stage 4C manifest input contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Stage 4C manifest input must contain only plain JSON values')
  }
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  if (entries.some(([, entry]) => entry === undefined)) {
    throw new Error('Stage 4C manifest input contains undefined')
  }
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function requireExactRecord(value, fields, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`)
  }
  return value
}

function assertManifestEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`Stage 4C run manifest ${label} must be ${String(expected)}`)
}

function requireRealDirectory(path, label) {
  const inspected = lstatSync(path)
  if (inspected.isSymbolicLink() || !inspected.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`${label} must be one real directory`)
  }
}

function assertRegularFile(path, label) {
  const inspected = lstatSync(path)
  if (inspected.isSymbolicLink() || !inspected.isFile() || realpathSync(path) !== path) {
    throw new Error(`${label} must be one real regular file`)
  }
}

function isErrorCode(error, code) {
  return typeof error === 'object' && error !== null && error.code === code
}

function secrets() {
  return [
    process.env[GETELUCID_API_KEY_ENV],
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]
}

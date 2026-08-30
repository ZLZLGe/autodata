/** Append-only protocol amendment for the one approved Stage 4C recovery. */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'

export const STAGE4C_RECOVERY_AMENDMENT_SCHEMA_VERSION = 'autodata-stage4c-recovery-amendment-1'
export const STAGE4C_RECOVERY_AMENDMENT_FILE = 'protocol-amendment-01.json'

export const STAGE4C_ORIGINAL_EXECUTION = deepFreeze({
  profile_id: 'bfcl-v4',
  generation_run_id: 'first-h1-aa168525e92f-20260831',
  experiment_run_id: 'h1-aa168525e92f-20260831',
  candidate_id: 'candidate-h1-aa168525e92f-20260831',
  execution_commit: 'aa168525e92fdcca297ad13dc4531393130a67d1',
  provider: 'free-router',
  model: 'gpt-5.6-sol',
})

export const STAGE4C_FROZEN_H0 = deepFreeze({
  profile_id: 'bfcl-v4',
  run_id: 'h0-f058c05bd893-20260830',
  contract_id: 'stage4b-h0-baseline-1',
  contract_sha256: '8d610144f31275f2264e5c959dee1de8dca401d7e50a3425dab0cd2b018c78e0',
  feedback_id: 'h0-search-0f39b730fc5af5a756bc',
  evaluation_report_id: 'h0-dev-0f39b730fc5af5a756bc',
  baseline_score: 0.8,
})

const AMENDMENT_ID = 'stage4c-recovery-amendment-01'
const RECOVERY_OWNER_SCHEMA_VERSION = 'autodata-stage4c-recovery-owner-1'
const RECOVERY_OWNER_FILE = 'stage4c-recovery-owner.json'
const RECOVERY_PROVIDER = 'pjlab'
const RECOVERY_MODEL = 'glm-5.3-flash'
const RECOVERY_MAX_TOKENS = 16_384
const RECOVERY_API = 'openai-completions'
const RECOVERY_BASE_URL = 'https://token.pjlab.org.cn/v1'
const RECOVERY_CONTEXT_WINDOW = 1_048_576
const ORIGINAL_STRATEGY_VERSION = '1'
const ORIGINAL_FAILURE = 'proposal Agent turn did not complete'
const AUTODATA_PROJECT_ROOT = '/root/autodata'
const ORIGINAL_B_SEARCH_CASES = '/root/autodata/stage4b/bfcl/search.jsonl'
const ORIGINAL_SOURCE_POOL_SHA256 = 'c5c57f65bb58ddecf4d83d576a0fc7341153933bab2ce9b9596b20f9496a9db4'
const COMMIT = /^[a-f0-9]{40}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const OPTION_FIELDS = Object.freeze([
  'originalGenerationRoot',
  'recoveryGenerationRoot',
  'experimentRunRoot',
  'experimentStagingRoot',
  'evolutionRoot',
  'recoveryCommit',
  'provider',
  'model',
])

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value
}

function exactFields(value, fields, label) {
  const object = record(value, label)
  const actual = Object.keys(object).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`)
  }
  return object
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match the frozen Stage 4C protocol`)
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`)
  }
  return value
}

function missing(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

/** Inspect every existing component without following symbolic links. */
function inspectPath(pathInput, { allowMissing = false } = {}) {
  const path = resolve(pathInput)
  const root = parse(path).root
  let cursor = root
  let stat
  try {
    stat = lstatSync(cursor)
  } catch (error) {
    throw new Error(`cannot inspect filesystem root for ${path}`, { cause: error })
  }
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are forbidden in Stage 4C recovery paths: ${cursor}`)
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    try {
      stat = lstatSync(cursor)
    } catch (error) {
      if (allowMissing && missing(error)) return { exists: false, path }
      throw new Error(`cannot inspect Stage 4C recovery path: ${cursor}`, { cause: error })
    }
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are forbidden in Stage 4C recovery paths: ${cursor}`)
  }
  return { exists: true, path, stat }
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  return resolve(value)
}

function directory(value, label) {
  const path = absolutePath(value, label)
  const inspected = inspectPath(path)
  if (!inspected.stat.isDirectory()) throw new Error(`${label} must be a directory: ${path}`)
  if (realpathSync(path) !== path) throw new Error(`${label} must not use a filesystem alias: ${path}`)
  return path
}

function createDirectoryWithoutSymlinks(pathInput, label) {
  const path = absolutePath(pathInput, label)
  const root = parse(path).root
  let cursor = root
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    const inspected = inspectPath(cursor, { allowMissing: true })
    if (!inspected.exists) {
      try { mkdirSync(cursor, { mode: 0o700 }) } catch (error) {
        if (error?.code !== 'EEXIST') throw new Error(`cannot create ${label}: ${cursor}`, { cause: error })
      }
    }
    const created = inspectPath(cursor)
    if (!created.stat.isDirectory()) throw new Error(`${label} must be a directory: ${cursor}`)
  }
  return directory(path, label)
}

function contained(root, pathInput, label) {
  const path = resolve(pathInput)
  const child = relative(root, path)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} must be a child of its configured root`)
  }
  return path
}

function overlaps(left, right) {
  const child = relative(left, right)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function assertIndependentRecoveryRoot(recoveryRoot, sourceRoots) {
  for (const [label, sourceRoot] of sourceRoots) {
    if (overlaps(sourceRoot, recoveryRoot) || overlaps(recoveryRoot, sourceRoot)) {
      throw new Error(`recovery generation root must be independent from ${label}`)
    }
  }
}

function readRegularBytes(root, pathInput, label) {
  const path = contained(root, pathInput, label)
  const inspected = inspectPath(path)
  if (!inspected.stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`)
  let descriptor
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== inspected.stat.dev || opened.ino !== inspected.stat.ino) {
      throw new Error(`${label} changed while it was being verified`)
    }
    return readFileSync(descriptor)
  } catch (error) {
    if (error instanceof Error && error.message.includes(label)) throw error
    throw new Error(`cannot read ${label}: ${path}`, { cause: error })
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function parseJsonObject(bytes, label) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not valid UTF-8`)
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
  return record(value, label)
}

function evidence(root, path, label) {
  const bytes = readRegularBytes(root, path, label)
  return {
    value: parseJsonObject(bytes, label),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function fileEvidence(root, path, label) {
  const bytes = readRegularBytes(root, path, label)
  return { sha256: createHash('sha256').update(bytes).digest('hex') }
}

function assertAbsent(root, pathInput, label) {
  const path = contained(root, pathInput, label)
  if (inspectPath(path, { allowMissing: true }).exists) throw new Error(`${label} already exists: ${path}`)
}

function normalizedOptions(optionsInput, createRecoveryRoot = false) {
  const options = exactFields(optionsInput, OPTION_FIELDS, 'Stage 4C recovery options')
  const recoveryGenerationRoot = absolutePath(options.recoveryGenerationRoot, 'recovery generation root')
  const roots = {
    originalGenerationRoot: directory(options.originalGenerationRoot, 'original generation root'),
    recoveryGenerationRoot,
    experimentRunRoot: directory(options.experimentRunRoot, 'experiment run root'),
    experimentStagingRoot: directory(options.experimentStagingRoot, 'experiment staging root'),
    evolutionRoot: directory(options.evolutionRoot, 'Evolution root'),
  }
  assertIndependentRecoveryRoot(roots.recoveryGenerationRoot, [
    ['original generation root', roots.originalGenerationRoot],
    ['experiment run root', roots.experimentRunRoot],
    ['experiment staging root', roots.experimentStagingRoot],
    ['Evolution root', roots.evolutionRoot],
  ])
  if (createRecoveryRoot) createDirectoryWithoutSymlinks(recoveryGenerationRoot, 'recovery generation root')
  else directory(recoveryGenerationRoot, 'recovery generation root')
  if (typeof options.recoveryCommit !== 'string' || !COMMIT.test(options.recoveryCommit)) {
    throw new Error('recovery commit must be a full lowercase Git commit SHA')
  }
  if (options.recoveryCommit === STAGE4C_ORIGINAL_EXECUTION.execution_commit) {
    throw new Error('recovery commit must differ from the failed original execution commit')
  }
  equal(options.provider, RECOVERY_PROVIDER, 'recovery provider')
  equal(options.model, RECOVERY_MODEL, 'recovery model')
  return { ...roots, recoveryCommit: options.recoveryCommit, provider: options.provider, model: options.model }
}

function verifyClaim(value) {
  const claim = exactFields(value, [
    'schema_version', 'profile_id', 'run_id', 'experiment_run_id', 'candidate_id', 'execution_commit',
  ], 'original first-H1 claim')
  equal(claim.schema_version, 'autodata-first-h1-claim-1', 'claim schema_version')
  equal(claim.profile_id, STAGE4C_ORIGINAL_EXECUTION.profile_id, 'claim profile_id')
  equal(claim.run_id, STAGE4C_ORIGINAL_EXECUTION.generation_run_id, 'claim run_id')
  equal(claim.experiment_run_id, STAGE4C_ORIGINAL_EXECUTION.experiment_run_id, 'claim experiment_run_id')
  equal(claim.candidate_id, STAGE4C_ORIGINAL_EXECUTION.candidate_id, 'claim candidate_id')
  equal(claim.execution_commit, STAGE4C_ORIGINAL_EXECUTION.execution_commit, 'claim execution_commit')
}

function verifyRequest(value, runDirectory, h0Directory) {
  const request = exactFields(value, [
    'profile_id', 'run_id', 'experiment_run_id', 'execution_commit', 'baseline_run_directory',
    'b_search_cases_jsonl', 'candidate_id', 'strategy_version',
  ], 'original generation request')
  equal(request.profile_id, STAGE4C_ORIGINAL_EXECUTION.profile_id, 'request profile_id')
  equal(request.run_id, STAGE4C_ORIGINAL_EXECUTION.generation_run_id, 'request run_id')
  equal(request.experiment_run_id, STAGE4C_ORIGINAL_EXECUTION.experiment_run_id, 'request experiment_run_id')
  equal(request.candidate_id, STAGE4C_ORIGINAL_EXECUTION.candidate_id, 'request candidate_id')
  equal(request.execution_commit, STAGE4C_ORIGINAL_EXECUTION.execution_commit, 'request execution_commit')
  equal(request.baseline_run_directory, h0Directory, 'request baseline_run_directory')
  equal(request.b_search_cases_jsonl, ORIGINAL_B_SEARCH_CASES, 'request b_search_cases_jsonl')
  equal(request.strategy_version, ORIGINAL_STRATEGY_VERSION, 'request strategy_version')
  void runDirectory
}

function verifyState(value, runDirectory, h0Directory) {
  const state = exactFields(value, [
    'schema_version', 'profile_id', 'run_id', 'experiment_run_id', 'candidate_id', 'strategy_version',
    'execution_commit', 'status', 'phase', 'run_directory', 'baseline_run_directory',
    'b_search_cases_jsonl', 'created_at', 'updated_at', 'attempts', 'formal_candidate_persisted', 'failure',
  ], 'original generation state')
  equal(state.schema_version, 'autodata-generation-state-1', 'state schema_version')
  equal(state.profile_id, STAGE4C_ORIGINAL_EXECUTION.profile_id, 'state profile_id')
  equal(state.run_id, STAGE4C_ORIGINAL_EXECUTION.generation_run_id, 'state run_id')
  equal(state.experiment_run_id, STAGE4C_ORIGINAL_EXECUTION.experiment_run_id, 'state experiment_run_id')
  equal(state.candidate_id, STAGE4C_ORIGINAL_EXECUTION.candidate_id, 'state candidate_id')
  equal(state.strategy_version, ORIGINAL_STRATEGY_VERSION, 'state strategy_version')
  equal(state.execution_commit, STAGE4C_ORIGINAL_EXECUTION.execution_commit, 'state execution_commit')
  equal(state.status, 'failed', 'state status')
  equal(state.phase, 'proposing', 'state phase')
  equal(state.run_directory, runDirectory, 'state run_directory')
  equal(state.baseline_run_directory, h0Directory, 'state baseline_run_directory')
  equal(state.b_search_cases_jsonl, ORIGINAL_B_SEARCH_CASES, 'state b_search_cases_jsonl')
  equal(state.formal_candidate_persisted, false, 'state formal_candidate_persisted')
  const created = isoTimestamp(state.created_at, 'state.created_at')
  const updated = isoTimestamp(state.updated_at, 'state.updated_at')
  if (Date.parse(updated) < Date.parse(created)) throw new Error('state.updated_at precedes state.created_at')
  if (!Array.isArray(state.attempts) || state.attempts.length !== 3) {
    throw new Error('original generation state must contain exactly three failed attempts')
  }
  const responsePaths = state.attempts.map((attemptInput, index) => {
    const number = index + 1
    const attempt = exactFields(attemptInput, ['attempt', 'status', 'response_path', 'created_at', 'failure'], `attempt ${String(number)}`)
    equal(attempt.attempt, number, `attempt ${String(number)} number`)
    equal(attempt.status, 'failed', `attempt ${String(number)} status`)
    equal(attempt.failure, ORIGINAL_FAILURE, `attempt ${String(number)} failure`)
    isoTimestamp(attempt.created_at, `attempt ${String(number)} created_at`)
    const expected = resolve(runDirectory, 'attempts', `draft-${String(number).padStart(2, '0')}`, 'response.json')
    equal(attempt.response_path, expected, `attempt ${String(number)} response_path`)
    return expected
  })
  const failure = exactFields(state.failure, ['code', 'message'], 'original generation failure')
  equal(failure.code, 'PROPOSAL_FAILED', 'state failure code')
  equal(failure.message, 'all 3 ephemeral drafts failed', 'state failure message')
  return responsePaths
}

function verifyLineage(value, h0Directory) {
  const lineage = exactFields(value, [
    'schema_version', 'profile_id', 'parent_candidate_id', 'candidate_id', 'execution_commit',
    'baseline_run_directory', 'baseline_feedback_id', 'source_pool_sha256',
  ], 'original source lineage')
  equal(lineage.schema_version, 'autodata-generation-lineage-1', 'lineage schema_version')
  equal(lineage.profile_id, STAGE4C_ORIGINAL_EXECUTION.profile_id, 'lineage profile_id')
  equal(lineage.parent_candidate_id, 'h0', 'lineage parent_candidate_id')
  equal(lineage.candidate_id, STAGE4C_ORIGINAL_EXECUTION.candidate_id, 'lineage candidate_id')
  equal(lineage.execution_commit, STAGE4C_ORIGINAL_EXECUTION.execution_commit, 'lineage execution_commit')
  equal(lineage.baseline_run_directory, h0Directory, 'lineage baseline_run_directory')
  equal(lineage.baseline_feedback_id, STAGE4C_FROZEN_H0.feedback_id, 'lineage baseline_feedback_id')
  equal(lineage.source_pool_sha256, ORIGINAL_SOURCE_POOL_SHA256, 'lineage source_pool_sha256')
}

function containsForbiddenEvaluationBoundary(value) {
  if (typeof value === 'string') {
    const normalized = value.replace(/([a-z])([A-Z])/gu, '$1_$2')
    return /(?:^|[^a-z0-9])b[-_\s]*(?:dev|test)(?=$|[^a-z0-9])/iu.test(normalized)
  }
  if (Array.isArray(value)) return value.some(containsForbiddenEvaluationBoundary)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, child]) => (
    containsForbiddenEvaluationBoundary(key) || containsForbiddenEvaluationBoundary(child)
  ))
}

function verifyProposalContext(value) {
  const context = exactFields(value, [
    'profile_id', 'benchmark', 'strategy_plugin_id', 'strategy_version', 'generation', 'seed',
    'allowed_capabilities', 'b_search', 'source_pool',
  ], 'original proposal context')
  equal(context.profile_id, STAGE4C_ORIGINAL_EXECUTION.profile_id, 'proposal context profile_id')
  equal(context.benchmark, 'bfcl-v4', 'proposal context benchmark')
  equal(context.strategy_plugin_id, 'bfcl-v4-strategy', 'proposal context strategy_plugin_id')
  equal(context.strategy_version, ORIGINAL_STRATEGY_VERSION, 'proposal context strategy_version')
  equal(context.generation, 1, 'proposal context generation')
  equal(context.seed, 42, 'proposal context seed')
  if (
    !Array.isArray(context.allowed_capabilities)
    || JSON.stringify(context.allowed_capabilities) !== JSON.stringify(['data-select', 'data-filter', 'data-order'])
  ) throw new Error('proposal context allowed_capabilities drifted')
  const search = exactFields(context.b_search, ['summary', 'metrics', 'failures'], 'proposal context B_search')
  if (typeof search.summary !== 'string' || !search.summary.includes('B_search')) {
    throw new Error('proposal context must contain the frozen B_search summary')
  }
  const metrics = record(search.metrics, 'proposal context B_search metrics')
  equal(metrics.macro_score, STAGE4C_FROZEN_H0.baseline_score, 'proposal context B_search macro_score')
  if (!Array.isArray(search.failures)) throw new Error('proposal context B_search failures must be an array')
  const pool = exactFields(context.source_pool, ['canonical_records', 'canonical_jsonl_sha256', 'records'], 'proposal context source_pool')
  equal(pool.canonical_records, 100, 'proposal context canonical_records')
  equal(pool.canonical_jsonl_sha256, ORIGINAL_SOURCE_POOL_SHA256, 'proposal context source_pool hash')
  if (!Array.isArray(pool.records) || pool.records.length !== 100) {
    throw new Error('proposal context source_pool must contain 100 record summaries')
  }
  if (containsForbiddenEvaluationBoundary(context)) {
    throw new Error('proposal context must not contain B_dev or B_test evidence')
  }
}

function verifyEvolutionState(value) {
  const state = record(value, 'Evolution state')
  equal(state.schema_version, 'autodata-evolution-state-2', 'Evolution state schema_version')
  equal(state.profile_id, STAGE4C_ORIGINAL_EXECUTION.profile_id, 'Evolution state profile_id')
  equal(state.generation, 0, 'Evolution state generation')
  equal(state.active_candidate_id, 'h0', 'Evolution state active_candidate_id')
  equal(state.open_candidate_id, null, 'Evolution state open_candidate_id')
  if (!Array.isArray(state.candidates) || state.candidates.length !== 1) {
    throw new Error('Evolution state must contain only H0')
  }
  const candidate = record(state.candidates[0], 'Evolution H0 candidate')
  equal(candidate.candidate_id, 'h0', 'Evolution H0 candidate_id')
  equal(candidate.generation, 0, 'Evolution H0 generation')
  equal(candidate.status, 'accepted', 'Evolution H0 status')
  equal(candidate.parent_candidate_id, null, 'Evolution H0 parent_candidate_id')
}

function listRegularFiles(root) {
  const files = []
  const visit = directoryPath => {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const path = resolve(directoryPath, entry.name)
      const inspected = inspectPath(path)
      if (inspected.stat.isDirectory()) visit(path)
      else if (inspected.stat.isFile()) files.push(relative(root, path))
      else throw new Error(`unsupported artifact type in original generation run: ${path}`)
    }
  }
  visit(root)
  return files.sort()
}

function verifyOriginalRunInventory(runDirectory) {
  const expected = [
    'attempts/draft-01/response.json',
    'attempts/draft-02/response.json',
    'attempts/draft-03/response.json',
    'proposal-context.json',
    'request.json',
    'source-lineage.json',
    'state.json',
  ].sort()
  const actual = listRegularFiles(runDirectory)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('original generation run contains an unexpected candidate, materialization, experiment, or other artifact')
  }
}

function verifyOriginalProfileInventory(profileDirectory) {
  const allowed = new Set([
    'first-h1-claim.json',
    STAGE4C_ORIGINAL_EXECUTION.generation_run_id,
    RECOVERY_OWNER_FILE,
  ])
  const ownerTemporary = /^stage4c-recovery-owner\.json\.\d+\.[a-f0-9-]+\.tmp$/u
  const unexpected = readdirSync(profileDirectory)
    .filter(name => !allowed.has(name) && !ownerTemporary.test(name))
  if (unexpected.length > 0) {
    throw new Error(`original generation profile contains unsupported history: ${unexpected.sort().join(', ')}`)
  }
}

function verifyResponse(value, number) {
  const response = exactFields(value, ['error'], `draft ${String(number)} response`)
  equal(response.error, ORIGINAL_FAILURE, `draft ${String(number)} response error`)
}

function verifyH0State(value, h0Directory, h0StagingDirectory) {
  const state = record(value, 'frozen H0 state')
  equal(state.schema_version, 'autodata-experiment-state-1', 'H0 state schema_version')
  equal(state.profile_id, STAGE4C_FROZEN_H0.profile_id, 'H0 state profile_id')
  equal(state.run_id, STAGE4C_FROZEN_H0.run_id, 'H0 state run_id')
  equal(state.contract_id, STAGE4C_FROZEN_H0.contract_id, 'H0 state contract_id')
  equal(state.contract_sha256, STAGE4C_FROZEN_H0.contract_sha256, 'H0 state contract_sha256')
  equal(state.feedback_id, STAGE4C_FROZEN_H0.feedback_id, 'H0 state feedback_id')
  equal(state.evaluation_report_id, STAGE4C_FROZEN_H0.evaluation_report_id, 'H0 state evaluation_report_id')
  equal(state.status, 'succeeded', 'H0 state status')
  equal(state.phase, 'complete', 'H0 state phase')
  equal(state.run_directory, h0Directory, 'H0 state run_directory')
  equal(state.staging_directory, h0StagingDirectory, 'H0 state staging_directory')
}

function recoveryIdentity(options) {
  const shortCommit = options.recoveryCommit.slice(0, 12)
  return {
    generation_root: options.recoveryGenerationRoot,
    generation_run_id: `first-h1-recovery-01-${shortCommit}-20260831`,
    experiment_run_id: `h1-recovery-01-${shortCommit}-20260831`,
    candidate_id: `candidate-h1-recovery-01-${shortCommit}-20260831`,
  }
}

function amendmentFor(options, replayEvolutionStateSha256) {
  const recoveryExecutionIdentity = recoveryIdentity(options)
  const profileDirectory = contained(
    options.originalGenerationRoot,
    resolve(options.originalGenerationRoot, STAGE4C_ORIGINAL_EXECUTION.profile_id),
    'original generation profile directory',
  )
  const runDirectory = contained(
    options.originalGenerationRoot,
    resolve(profileDirectory, STAGE4C_ORIGINAL_EXECUTION.generation_run_id),
    'original generation run directory',
  )
  const runInspection = inspectPath(runDirectory)
  if (!runInspection.stat.isDirectory()) throw new Error(`original generation run must be a directory: ${runDirectory}`)
  const h0Directory = contained(
    options.experimentRunRoot,
    resolve(options.experimentRunRoot, STAGE4C_FROZEN_H0.profile_id, STAGE4C_FROZEN_H0.run_id),
    'frozen H0 run directory',
  )
  const h0Inspection = inspectPath(h0Directory)
  if (!h0Inspection.stat.isDirectory()) throw new Error(`frozen H0 run must be a directory: ${h0Directory}`)
  const h0StagingDirectory = contained(
    options.experimentStagingRoot,
    resolve(options.experimentStagingRoot, STAGE4C_FROZEN_H0.run_id),
    'frozen H0 staging directory',
  )

  const claim = evidence(options.originalGenerationRoot, resolve(profileDirectory, 'first-h1-claim.json'), 'original first-H1 claim')
  const request = evidence(runDirectory, resolve(runDirectory, 'request.json'), 'original generation request')
  const state = evidence(runDirectory, resolve(runDirectory, 'state.json'), 'original generation state')
  const lineage = evidence(runDirectory, resolve(runDirectory, 'source-lineage.json'), 'original source lineage')
  const proposalContext = evidence(runDirectory, resolve(runDirectory, 'proposal-context.json'), 'original proposal context')
  verifyClaim(claim.value)
  verifyRequest(request.value, runDirectory, h0Directory)
  const responsePaths = verifyState(state.value, runDirectory, h0Directory)
  verifyLineage(lineage.value, h0Directory)
  verifyProposalContext(proposalContext.value)
  const responses = responsePaths.map((path, index) => {
    const result = evidence(runDirectory, path, `draft ${String(index + 1)} response`)
    verifyResponse(result.value, index + 1)
    return result
  })

  const h0State = evidence(h0Directory, resolve(h0Directory, 'state.json'), 'frozen H0 state')
  const h0Contract = evidence(h0Directory, resolve(h0Directory, 'experiment-contract.json'), 'frozen H0 contract')
  verifyH0State(h0State.value, h0Directory, h0StagingDirectory)
  equal(h0Contract.sha256, STAGE4C_FROZEN_H0.contract_sha256, 'H0 contract bytes SHA-256')
  const contract = record(h0Contract.value, 'frozen H0 contract')
  equal(contract.schema_version, 'autodata-experiment-contract-1', 'H0 contract schema_version')

  const h0Canonical = fileEvidence(h0Directory, resolve(h0Directory, 'canonical.jsonl'), 'frozen H0 canonical data')
  const h0RunSummary = fileEvidence(h0Directory, resolve(h0Directory, 'run-summary.json'), 'frozen H0 run summary')
  const h0SearchResults = fileEvidence(h0Directory, resolve(h0Directory, 'b-search-results.json'), 'frozen H0 B_search results')
  const h0Feedback = fileEvidence(h0Directory, resolve(h0Directory, 'feedback.json'), 'frozen H0 feedback')
  const h0EvaluationReport = fileEvidence(h0Directory, resolve(h0Directory, 'evaluation-report.json'), 'frozen H0 evaluation report')
  const h0EvalPredictions = fileEvidence(
    h0Directory,
    resolve(h0Directory, 'attempts', 'eval', '0001', 'predictions.jsonl'),
    'frozen H0 evaluation predictions',
  )
  const checkedInBSearchCases = fileEvidence(
    AUTODATA_PROJECT_ROOT,
    ORIGINAL_B_SEARCH_CASES,
    'checked-in B_search cases',
  )
  const evolutionProfileDirectory = resolve(
    options.evolutionRoot,
    'profiles',
    STAGE4C_ORIGINAL_EXECUTION.profile_id,
  )
  const evolutionProfile = fileEvidence(
    options.evolutionRoot,
    resolve(evolutionProfileDirectory, 'profile.json'),
    'Evolution profile',
  )
  const evolutionH0Feedback = fileEvidence(
    options.evolutionRoot,
    resolve(evolutionProfileDirectory, 'feedback', `${STAGE4C_FROZEN_H0.feedback_id}.json`),
    'durable Evolution H0 feedback',
  )
  const evolutionH0Evaluation = fileEvidence(
    options.evolutionRoot,
    resolve(evolutionProfileDirectory, 'runs', STAGE4C_FROZEN_H0.run_id, 'summary.json'),
    'durable Evolution H0 evaluation',
  )

  let evolutionStateSha256 = replayEvolutionStateSha256
  if (evolutionStateSha256 === undefined) {
    const evolutionStatePath = resolve(
      options.evolutionRoot,
      'profiles',
      STAGE4C_ORIGINAL_EXECUTION.profile_id,
      'state.json',
    )
    const evolutionState = evidence(options.evolutionRoot, evolutionStatePath, 'Evolution state')
    verifyEvolutionState(evolutionState.value)
    evolutionStateSha256 = evolutionState.sha256
  } else if (typeof evolutionStateSha256 !== 'string' || !SHA256.test(evolutionStateSha256)) {
    throw new Error('recorded pre-recovery Evolution state SHA-256 is invalid')
  }
  verifyOriginalRunInventory(runDirectory)
  verifyOriginalProfileInventory(profileDirectory)

  assertAbsent(
    options.experimentRunRoot,
    resolve(options.experimentRunRoot, STAGE4C_ORIGINAL_EXECUTION.profile_id, STAGE4C_ORIGINAL_EXECUTION.experiment_run_id),
    'original H1 experiment directory',
  )
  assertAbsent(
    options.experimentStagingRoot,
    resolve(options.experimentStagingRoot, STAGE4C_ORIGINAL_EXECUTION.experiment_run_id),
    'original H1 experiment staging directory',
  )
  assertAbsent(
    options.evolutionRoot,
    resolve(options.evolutionRoot, 'profiles', STAGE4C_ORIGINAL_EXECUTION.profile_id, 'candidates', STAGE4C_ORIGINAL_EXECUTION.candidate_id),
    'original H1 Evolution candidate directory',
  )
  assertAbsent(
    options.experimentRunRoot,
    resolve(
      options.experimentRunRoot,
      '.candidate-owners',
      STAGE4C_ORIGINAL_EXECUTION.profile_id,
      `${STAGE4C_ORIGINAL_EXECUTION.candidate_id}.json`,
    ),
    'original H1 experiment owner claim',
  )
  if (replayEvolutionStateSha256 === undefined) {
    assertAbsent(
      options.recoveryGenerationRoot,
      resolve(options.recoveryGenerationRoot, STAGE4C_ORIGINAL_EXECUTION.profile_id),
      'recovery generation profile directory',
    )
    assertAbsent(
      options.experimentRunRoot,
      resolve(options.experimentRunRoot, STAGE4C_ORIGINAL_EXECUTION.profile_id, recoveryExecutionIdentity.experiment_run_id),
      'recovery H1 experiment directory',
    )
    assertAbsent(
      options.experimentStagingRoot,
      resolve(options.experimentStagingRoot, recoveryExecutionIdentity.experiment_run_id),
      'recovery H1 experiment staging directory',
    )
    assertAbsent(
      options.evolutionRoot,
      resolve(
        options.evolutionRoot,
        'profiles',
        STAGE4C_ORIGINAL_EXECUTION.profile_id,
        'candidates',
        recoveryExecutionIdentity.candidate_id,
      ),
      'recovery H1 Evolution candidate directory',
    )
    assertAbsent(
      options.experimentRunRoot,
      resolve(
        options.experimentRunRoot,
        '.candidate-owners',
        STAGE4C_ORIGINAL_EXECUTION.profile_id,
        `${recoveryExecutionIdentity.candidate_id}.json`,
      ),
      'recovery H1 experiment owner claim',
    )
  }

  return deepFreeze({
    schema_version: STAGE4C_RECOVERY_AMENDMENT_SCHEMA_VERSION,
    amendment_id: AMENDMENT_ID,
    same_logical_h1: true,
    recovery_reason: 'operator_adjudicated_provider_infrastructure_failure',
    original_execution: {
      ...STAGE4C_ORIGINAL_EXECUTION,
      status: 'failed',
      phase: 'proposing',
      draft_attempts: 3,
      draft_failure: ORIGINAL_FAILURE,
      persisted_observation: {
        usable_model_draft_observed: false,
        candidate_source_observed: false,
      },
      diagnostic_reproducer: {
        scope: 'separate_no_candidate_free_router_request',
        http_status: 456,
        code: 'session_id_required',
        relation_to_original_attempts: 'operator_adjudication_not_per_attempt_persisted_evidence',
      },
      formal_candidate_persisted: false,
      experiment_started: false,
      evolution_candidate_persisted: false,
    },
    recovery_execution: {
      execution_commit: options.recoveryCommit,
      provider: options.provider,
      model: options.model,
      ...recoveryExecutionIdentity,
      proposal_config: {
        max_tokens: RECOVERY_MAX_TOKENS,
        tool_access: 'disabled',
      },
      provider_config: {
        api_key_env: 'PJLAB_API_KEY',
        api: RECOVERY_API,
        base_url: RECOVERY_BASE_URL,
        default_context_window: RECOVERY_CONTEXT_WINDOW,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsUsageInStreaming: false,
          maxTokensField: 'max_tokens',
          supportsStrictMode: false,
        },
      },
    },
    frozen_h0: STAGE4C_FROZEN_H0,
    protocol_guards: {
      original_artifacts_immutable: true,
      frozen_h0_reused: true,
      infrastructure_recovery_only: true,
      max_recovery_amendments: 1,
      max_model_drafts: 3,
      manual_candidate: false,
      b_dev_model_visible: false,
      b_test_touched: false,
    },
    evidence_sha256: {
      first_h1_claim: claim.sha256,
      generation_request: request.sha256,
      generation_state: state.sha256,
      source_lineage: lineage.sha256,
      proposal_context: proposalContext.sha256,
      draft_responses: responses.map((response, index) => ({ attempt: index + 1, sha256: response.sha256 })),
      h0_state: h0State.sha256,
      h0_contract: h0Contract.sha256,
      h0_canonical_jsonl: h0Canonical.sha256,
      h0_run_summary: h0RunSummary.sha256,
      h0_b_search_results: h0SearchResults.sha256,
      h0_feedback: h0Feedback.sha256,
      h0_evaluation_report: h0EvaluationReport.sha256,
      h0_eval_predictions: h0EvalPredictions.sha256,
      checked_in_b_search_cases: checkedInBSearchCases.sha256,
      evolution_profile: evolutionProfile.sha256,
      evolution_h0_feedback: evolutionH0Feedback.sha256,
      evolution_h0_evaluation: evolutionH0Evaluation.sha256,
      evolution_state: evolutionStateSha256,
    },
  })
}

/** Verify the immutable failed run and return the deterministic amendment body without writing. */
export function verifyStage4CRecoverySource(optionsInput) {
  return amendmentFor(normalizedOptions(optionsInput))
}

function amendmentPath(options) {
  return contained(
    options.recoveryGenerationRoot,
    resolve(options.recoveryGenerationRoot, STAGE4C_RECOVERY_AMENDMENT_FILE),
    'recovery protocol amendment',
  )
}

function ownerPath(options) {
  return contained(
    options.originalGenerationRoot,
    resolve(options.originalGenerationRoot, STAGE4C_ORIGINAL_EXECUTION.profile_id, RECOVERY_OWNER_FILE),
    'Stage 4C recovery owner',
  )
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function ownerFor(options, amendmentSha256) {
  const identity = recoveryIdentity(options)
  return deepFreeze({
    schema_version: RECOVERY_OWNER_SCHEMA_VERSION,
    profile_id: STAGE4C_ORIGINAL_EXECUTION.profile_id,
    amendment_id: AMENDMENT_ID,
    amendment_file: STAGE4C_RECOVERY_AMENDMENT_FILE,
    amendment_sha256: amendmentSha256,
    recovery_generation_root: options.recoveryGenerationRoot,
    recovery_commit: options.recoveryCommit,
    generation_run_id: identity.generation_run_id,
    experiment_run_id: identity.experiment_run_id,
    candidate_id: identity.candidate_id,
  })
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

/** Publish complete bytes atomically without ever exposing a partial target. */
function durableLinkNewOrSame(root, pathInput, content, label) {
  const path = contained(root, pathInput, label)
  const inspected = inspectPath(path, { allowMissing: true })
  if (inspected.exists) {
    const actual = readRegularBytes(root, path, label)
    if (!actual.equals(content)) throw new Error(`existing ${label} conflicts: ${path}`)
    return false
  }
  const directoryPath = resolve(path, '..')
  const temporary = contained(root, `${path}.${String(process.pid)}.${randomUUID()}.tmp`, `${label} temporary file`)
  let descriptor
  let temporaryCreated = false
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    temporaryCreated = true
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    try {
      linkSync(temporary, path)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const actual = readRegularBytes(root, path, label)
      if (!actual.equals(content)) throw new Error(`existing ${label} conflicts: ${path}`)
      return false
    }
    fsyncDirectory(directoryPath)
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes('conflicts')) throw error
    throw new Error(`cannot durably publish ${label}: ${path}`, { cause: error })
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best-effort descriptor cleanup */ }
    }
    if (temporaryCreated) {
      try {
        unlinkSync(temporary)
        fsyncDirectory(directoryPath)
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
  }
}

function verifyExistingAmendment(options) {
  const path = amendmentPath(options)
  const actual = readRegularBytes(options.recoveryGenerationRoot, path, 'recovery protocol amendment')
  const parsed = parseJsonObject(actual, 'recovery protocol amendment')
  const hashes = record(parsed.evidence_sha256, 'recovery protocol amendment evidence_sha256')
  const evolutionStateSha256 = hashes.evolution_state
  if (typeof evolutionStateSha256 !== 'string' || !SHA256.test(evolutionStateSha256)) {
    throw new Error('recovery protocol amendment has an invalid pre-recovery Evolution state SHA-256')
  }
  const amendment = amendmentFor(options, evolutionStateSha256)
  const expected = jsonBytes(amendment)
  if (!actual.equals(expected)) throw new Error(`existing recovery protocol amendment conflicts: ${path}`)
  const expectedOwner = jsonBytes(ownerFor(options, sha256Bytes(actual)))
  const owner = readRegularBytes(options.originalGenerationRoot, ownerPath(options), 'Stage 4C recovery owner')
  if (!owner.equals(expectedOwner)) throw new Error(`existing Stage 4C recovery owner conflicts: ${ownerPath(options)}`)
  return deepFreeze({ path, created: false, amendment })
}

/** Validate the durable amendment for recovery resume/status after mutable state has advanced. */
export function verifyStage4CRecoveryAmendment(optionsInput) {
  return verifyExistingAmendment(normalizedOptions(optionsInput))
}

/** Create exactly one immutable amendment, or accept a byte-identical replay. */
export function createStage4CRecoveryAmendment(optionsInput) {
  const options = normalizedOptions(optionsInput, true)
  const path = amendmentPath(options)
  const inspected = inspectPath(path, { allowMissing: true })
  if (inspected.exists) return verifyExistingAmendment(options)
  let amendment
  try {
    amendment = amendmentFor(options)
  } catch (error) {
    if (inspectPath(path, { allowMissing: true }).exists) return verifyExistingAmendment(options)
    throw error
  }
  const content = jsonBytes(amendment)
  const owner = jsonBytes(ownerFor(options, sha256Bytes(content)))
  durableLinkNewOrSame(options.originalGenerationRoot, ownerPath(options), owner, 'Stage 4C recovery owner')
  const created = durableLinkNewOrSame(options.recoveryGenerationRoot, path, content, 'recovery protocol amendment')
  if (!created) return verifyExistingAmendment(options)
  return deepFreeze({ path, created: true, amendment })
}

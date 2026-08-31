/** Append-only protocol deviation for the final, one-proposal Stage 4C recovery. */

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

export const STAGE4C_RECOVERY_AMENDMENT_02_SCHEMA_VERSION = 'autodata-stage4c-recovery-amendment-2'
export const STAGE4C_RECOVERY_AMENDMENT_02_FILE = 'protocol-amendment-02.json'
export const STAGE4C_RECOVERY_02_OWNER_FILE = 'stage4c-recovery-02-owner.json'
export const STAGE4C_RUNTIME_CONTRACT_FIX_COMMIT = 'd666c608c20b4e59210d553a613e975ba6364dd3'

export const STAGE4C_RECOVERY_01 = deepFreeze({
  profile_id: 'bfcl-v4',
  generation_run_id: 'first-h1-recovery-01-c7eb58fe1623-20260831',
  experiment_run_id: 'h1-recovery-01-c7eb58fe1623-20260831',
  candidate_id: 'candidate-h1-recovery-01-c7eb58fe1623-20260831',
  execution_commit: 'c7eb58fe16239add34d4dd5bf42ccfc584282d29',
  provider: 'pjlab',
  model: 'glm-5.3-flash',
})

const ORIGINAL_EXECUTION = deepFreeze({
  generation_run_id: 'first-h1-aa168525e92f-20260831',
  experiment_run_id: 'h1-aa168525e92f-20260831',
  candidate_id: 'candidate-h1-aa168525e92f-20260831',
  execution_commit: 'aa168525e92fdcca297ad13dc4531393130a67d1',
})
const FROZEN_H0 = deepFreeze({
  profile_id: 'bfcl-v4',
  run_id: 'h0-f058c05bd893-20260830',
  contract_id: 'stage4b-h0-baseline-1',
  contract_sha256: '8d610144f31275f2264e5c959dee1de8dca401d7e50a3425dab0cd2b018c78e0',
  feedback_id: 'h0-search-0f39b730fc5af5a756bc',
  evaluation_report_id: 'h0-dev-0f39b730fc5af5a756bc',
  baseline_score: 0.8,
})
const AMENDMENT_ID = 'stage4c-recovery-amendment-02'
const PREDECESSOR_AMENDMENT_ID = 'stage4c-recovery-amendment-01'
const PREDECESSOR_AMENDMENT_FILE = 'protocol-amendment-01.json'
const PREDECESSOR_OWNER_FILE = 'stage4c-recovery-owner.json'
const OWNER_SCHEMA_VERSION = 'autodata-stage4c-recovery-owner-2'
const RECOVERY_PROVIDER = 'free-router'
const RECOVERY_MODEL = 'gpt-5.6-sol'
const RECOVERY_MAX_TOKENS = 16_384
const RECOVERY_API = 'openai-responses'
const RECOVERY_BASE_URL = 'https://free-router.opendatalab.com/v1'
const DIAGNOSTIC_ID = 'stage4c-freerouter-diagnostic-02'
const DIAGNOSTIC_SESSION_ID = 'autodata-stage4c-freerouter-02-diagnostic'
const DIAGNOSTIC_CLAIM_FILE = 'diagnostic-claim.json'
const DIAGNOSTIC_RESULT_FILE = 'diagnostic-result.json'
const DIAGNOSTIC_MAX_TOKENS = 8_192
const ORIGINAL_B_SEARCH_CASES = '/root/autodata/stage4b/bfcl/search.jsonl'
const COMMIT = /^[a-f0-9]{40}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const OPTION_FIELDS = Object.freeze([
  'originalGenerationRoot',
  'predecessorGenerationRoot',
  'recoveryGenerationRoot',
  'diagnosticRoot',
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
  if (actual !== expected) throw new Error(`${label} does not match the frozen Stage 4C recovery-02 protocol`)
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`)
  return value
}

function missing(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

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
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are forbidden in Stage 4C recovery-02 paths: ${cursor}`)
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    try {
      stat = lstatSync(cursor)
    } catch (error) {
      if (allowMissing && missing(error)) return { exists: false, path }
      throw new Error(`cannot inspect Stage 4C recovery-02 path: ${cursor}`, { cause: error })
    }
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are forbidden in Stage 4C recovery-02 paths: ${cursor}`)
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

function contained(rootInput, pathInput, label) {
  const root = resolve(rootInput)
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
  try { value = JSON.parse(text) } catch (error) { throw new Error(`${label} is not valid JSON`, { cause: error }) }
  return record(value, label)
}

function evidence(root, path, label) {
  const bytes = readRegularBytes(root, path, label)
  return { value: parseJsonObject(bytes, label), sha256: createHash('sha256').update(bytes).digest('hex') }
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
  const options = exactFields(optionsInput, OPTION_FIELDS, 'Stage 4C recovery-02 options')
  const recoveryGenerationRoot = absolutePath(options.recoveryGenerationRoot, 'recovery-02 generation root')
  let diagnosticRoot
  try {
    diagnosticRoot = directory(options.diagnosticRoot, 'FreeRouter diagnostic root')
  } catch (error) {
    throw new Error('FreeRouter diagnostic root is unavailable or invalid', { cause: error })
  }
  const roots = {
    originalGenerationRoot: directory(options.originalGenerationRoot, 'original generation root'),
    predecessorGenerationRoot: directory(options.predecessorGenerationRoot, 'recovery-01 generation root'),
    recoveryGenerationRoot,
    diagnosticRoot,
    experimentRunRoot: directory(options.experimentRunRoot, 'experiment run root'),
    experimentStagingRoot: directory(options.experimentStagingRoot, 'experiment staging root'),
    evolutionRoot: directory(options.evolutionRoot, 'Evolution root'),
  }
  for (const [label, root] of Object.entries(roots)) {
    if (label === 'recoveryGenerationRoot') continue
    if (overlaps(root, recoveryGenerationRoot) || overlaps(recoveryGenerationRoot, root)) {
      throw new Error(`recovery-02 generation root must be independent from ${label}`)
    }
  }
  if (createRecoveryRoot) createDirectoryWithoutSymlinks(recoveryGenerationRoot, 'recovery-02 generation root')
  else directory(recoveryGenerationRoot, 'recovery-02 generation root')
  if (typeof options.recoveryCommit !== 'string' || !COMMIT.test(options.recoveryCommit)) {
    throw new Error('recovery-02 commit must be a full lowercase Git commit SHA')
  }
  if ([ORIGINAL_EXECUTION.execution_commit, STAGE4C_RECOVERY_01.execution_commit].includes(options.recoveryCommit)) {
    throw new Error('recovery-02 commit must differ from both exhausted executions')
  }
  equal(options.provider, RECOVERY_PROVIDER, 'recovery-02 provider')
  equal(options.model, RECOVERY_MODEL, 'recovery-02 model')
  return { ...roots, recoveryCommit: options.recoveryCommit, provider: options.provider, model: options.model }
}

function verifyPredecessorAmendment(value, options) {
  const amendment = record(value, 'recovery-01 amendment')
  equal(amendment.schema_version, 'autodata-stage4c-recovery-amendment-1', 'recovery-01 amendment schema_version')
  equal(amendment.amendment_id, PREDECESSOR_AMENDMENT_ID, 'recovery-01 amendment_id')
  equal(amendment.same_logical_h1, true, 'recovery-01 same_logical_h1')
  const execution = record(amendment.recovery_execution, 'recovery-01 execution')
  for (const [field, expected] of Object.entries(STAGE4C_RECOVERY_01)) {
    if (field === 'profile_id') continue
    const amendmentField = field === 'generation_run_id' || field === 'experiment_run_id' || field === 'candidate_id'
      || field === 'execution_commit' || field === 'provider' || field === 'model'
    if (amendmentField) equal(execution[field], expected, `recovery-01 ${field}`)
  }
  equal(execution.generation_root, options.predecessorGenerationRoot, 'recovery-01 generation_root')
  const h0 = record(amendment.frozen_h0, 'recovery-01 frozen_h0')
  for (const [field, expected] of Object.entries(FROZEN_H0)) equal(h0[field], expected, `recovery-01 frozen_h0.${field}`)
  const guards = record(amendment.protocol_guards, 'recovery-01 protocol_guards')
  equal(guards.max_recovery_amendments, 1, 'recovery-01 max_recovery_amendments')
  equal(guards.max_model_drafts, 3, 'recovery-01 max_model_drafts')
  equal(guards.manual_candidate, false, 'recovery-01 manual_candidate')
  equal(guards.b_dev_model_visible, false, 'recovery-01 b_dev_model_visible')
  equal(guards.b_test_touched, false, 'recovery-01 b_test_touched')
  return amendment
}

function verifyPredecessorOwner(value, amendmentSha256, options) {
  const owner = exactFields(value, [
    'schema_version', 'profile_id', 'amendment_id', 'amendment_file', 'amendment_sha256',
    'recovery_generation_root', 'recovery_commit', 'generation_run_id', 'experiment_run_id', 'candidate_id',
  ], 'recovery-01 owner')
  equal(owner.schema_version, 'autodata-stage4c-recovery-owner-1', 'recovery-01 owner schema_version')
  equal(owner.profile_id, STAGE4C_RECOVERY_01.profile_id, 'recovery-01 owner profile_id')
  equal(owner.amendment_id, PREDECESSOR_AMENDMENT_ID, 'recovery-01 owner amendment_id')
  equal(owner.amendment_file, PREDECESSOR_AMENDMENT_FILE, 'recovery-01 owner amendment_file')
  equal(owner.amendment_sha256, amendmentSha256, 'recovery-01 owner amendment_sha256')
  equal(owner.recovery_generation_root, options.predecessorGenerationRoot, 'recovery-01 owner root')
  equal(owner.recovery_commit, STAGE4C_RECOVERY_01.execution_commit, 'recovery-01 owner commit')
  equal(owner.generation_run_id, STAGE4C_RECOVERY_01.generation_run_id, 'recovery-01 owner generation_run_id')
  equal(owner.experiment_run_id, STAGE4C_RECOVERY_01.experiment_run_id, 'recovery-01 owner experiment_run_id')
  equal(owner.candidate_id, STAGE4C_RECOVERY_01.candidate_id, 'recovery-01 owner candidate_id')
}

function verifyOriginalEvidenceChain(amendment01, options, evolutionStateSha256) {
  const hashes = exactFields(record(amendment01.evidence_sha256, 'recovery-01 evidence_sha256'), [
    'first_h1_claim', 'generation_request', 'generation_state', 'source_lineage', 'proposal_context',
    'draft_responses', 'h0_state', 'h0_contract', 'h0_canonical_jsonl', 'h0_run_summary',
    'h0_b_search_results', 'h0_feedback', 'h0_evaluation_report', 'h0_eval_predictions',
    'checked_in_b_search_cases', 'evolution_profile', 'evolution_h0_feedback',
    'evolution_h0_evaluation', 'evolution_state',
  ], 'recovery-01 evidence_sha256')
  const profileDirectory = directory(
    resolve(options.originalGenerationRoot, STAGE4C_RECOVERY_01.profile_id),
    'original generation profile directory',
  )
  const runDirectory = directory(
    resolve(profileDirectory, ORIGINAL_EXECUTION.generation_run_id),
    'original generation run directory',
  )
  const h0Directory = directory(
    resolve(options.experimentRunRoot, FROZEN_H0.profile_id, FROZEN_H0.run_id),
    'frozen H0 run directory',
  )
  const evolutionProfileDirectory = directory(
    resolve(options.evolutionRoot, 'profiles', FROZEN_H0.profile_id),
    'Evolution profile directory',
  )
  const files = [
    ['first_h1_claim', options.originalGenerationRoot, resolve(profileDirectory, 'first-h1-claim.json')],
    ['generation_request', runDirectory, resolve(runDirectory, 'request.json')],
    ['generation_state', runDirectory, resolve(runDirectory, 'state.json')],
    ['source_lineage', runDirectory, resolve(runDirectory, 'source-lineage.json')],
    ['proposal_context', runDirectory, resolve(runDirectory, 'proposal-context.json')],
    ['h0_state', h0Directory, resolve(h0Directory, 'state.json')],
    ['h0_contract', h0Directory, resolve(h0Directory, 'experiment-contract.json')],
    ['h0_canonical_jsonl', h0Directory, resolve(h0Directory, 'canonical.jsonl')],
    ['h0_run_summary', h0Directory, resolve(h0Directory, 'run-summary.json')],
    ['h0_b_search_results', h0Directory, resolve(h0Directory, 'b-search-results.json')],
    ['h0_feedback', h0Directory, resolve(h0Directory, 'feedback.json')],
    ['h0_evaluation_report', h0Directory, resolve(h0Directory, 'evaluation-report.json')],
    ['h0_eval_predictions', h0Directory, resolve(h0Directory, 'attempts', 'eval', '0001', 'predictions.jsonl')],
    ['checked_in_b_search_cases', '/root/autodata', ORIGINAL_B_SEARCH_CASES],
    ['evolution_profile', options.evolutionRoot, resolve(evolutionProfileDirectory, 'profile.json')],
    ['evolution_h0_feedback', options.evolutionRoot, resolve(evolutionProfileDirectory, 'feedback', `${FROZEN_H0.feedback_id}.json`)],
    ['evolution_h0_evaluation', options.evolutionRoot, resolve(evolutionProfileDirectory, 'runs', FROZEN_H0.run_id, 'summary.json')],
  ]
  for (const [field, root, path] of files) {
    const expected = hashes[field]
    if (typeof expected !== 'string' || !SHA256.test(expected)) {
      throw new Error(`recovery-01 ${field} SHA-256 is invalid`)
    }
    equal(fileEvidence(root, path, `recovery-01 chained ${field}`).sha256, expected, `recovery-01 ${field} SHA-256`)
  }
  if (typeof hashes.evolution_state !== 'string' || !SHA256.test(hashes.evolution_state)) {
    throw new Error('recovery-01 evolution_state SHA-256 is invalid')
  }
  equal(evolutionStateSha256, hashes.evolution_state, 'recovery-01 Evolution state SHA-256')
  if (!Array.isArray(hashes.draft_responses) || hashes.draft_responses.length !== 3) {
    throw new Error('recovery-01 original draft response hashes must contain exactly three entries')
  }
  for (let index = 0; index < hashes.draft_responses.length; index += 1) {
    const attempt = index + 1
    const item = exactFields(hashes.draft_responses[index], ['attempt', 'sha256'], `recovery-01 original draft ${String(attempt)} hash`)
    equal(item.attempt, attempt, `recovery-01 original draft ${String(attempt)} number`)
    if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      throw new Error(`recovery-01 original draft ${String(attempt)} SHA-256 is invalid`)
    }
    const path = resolve(runDirectory, 'attempts', `draft-${String(attempt).padStart(2, '0')}`, 'response.json')
    equal(fileEvidence(runDirectory, path, `recovery-01 chained original draft ${String(attempt)}`).sha256, item.sha256, `recovery-01 original draft ${String(attempt)} SHA-256`)
  }
  const expectedRun = [
    'attempts/draft-01/response.json', 'attempts/draft-02/response.json', 'attempts/draft-03/response.json',
    'proposal-context.json', 'request.json', 'source-lineage.json', 'state.json',
  ].sort()
  if (JSON.stringify(listRegularFiles(runDirectory)) !== JSON.stringify(expectedRun)) {
    throw new Error('original generation run contains an unexpected candidate, materialization, experiment, or other artifact')
  }
  const expectedProfile = ['first-h1-claim.json', ORIGINAL_EXECUTION.generation_run_id, PREDECESSOR_OWNER_FILE].sort()
  if (JSON.stringify(readdirSync(profileDirectory).sort()) !== JSON.stringify(expectedProfile)) {
    throw new Error('original generation profile contains unsupported history')
  }
}

function verifyClaim(value) {
  const claim = exactFields(value, [
    'schema_version', 'profile_id', 'run_id', 'experiment_run_id', 'candidate_id', 'execution_commit',
  ], 'recovery-01 first-H1 claim')
  equal(claim.schema_version, 'autodata-first-h1-claim-1', 'recovery-01 claim schema_version')
  equal(claim.profile_id, STAGE4C_RECOVERY_01.profile_id, 'recovery-01 claim profile_id')
  equal(claim.run_id, STAGE4C_RECOVERY_01.generation_run_id, 'recovery-01 claim run_id')
  equal(claim.experiment_run_id, STAGE4C_RECOVERY_01.experiment_run_id, 'recovery-01 claim experiment_run_id')
  equal(claim.candidate_id, STAGE4C_RECOVERY_01.candidate_id, 'recovery-01 claim candidate_id')
  equal(claim.execution_commit, STAGE4C_RECOVERY_01.execution_commit, 'recovery-01 claim execution_commit')
}

function verifyRequest(value, h0Directory) {
  const request = exactFields(value, [
    'profile_id', 'run_id', 'experiment_run_id', 'execution_commit', 'baseline_run_directory',
    'b_search_cases_jsonl', 'candidate_id', 'strategy_version',
  ], 'recovery-01 generation request')
  equal(request.profile_id, STAGE4C_RECOVERY_01.profile_id, 'recovery-01 request profile_id')
  equal(request.run_id, STAGE4C_RECOVERY_01.generation_run_id, 'recovery-01 request run_id')
  equal(request.experiment_run_id, STAGE4C_RECOVERY_01.experiment_run_id, 'recovery-01 request experiment_run_id')
  equal(request.candidate_id, STAGE4C_RECOVERY_01.candidate_id, 'recovery-01 request candidate_id')
  equal(request.execution_commit, STAGE4C_RECOVERY_01.execution_commit, 'recovery-01 request execution_commit')
  equal(request.baseline_run_directory, h0Directory, 'recovery-01 request baseline_run_directory')
  equal(request.b_search_cases_jsonl, ORIGINAL_B_SEARCH_CASES, 'recovery-01 request b_search_cases_jsonl')
  equal(request.strategy_version, '1', 'recovery-01 request strategy_version')
}

function verifyLineage(value, h0Directory, sourcePoolSha256) {
  const lineage = exactFields(value, [
    'schema_version', 'profile_id', 'parent_candidate_id', 'candidate_id', 'execution_commit',
    'baseline_run_directory', 'baseline_feedback_id', 'source_pool_sha256',
  ], 'recovery-01 source lineage')
  equal(lineage.schema_version, 'autodata-generation-lineage-1', 'recovery-01 lineage schema_version')
  equal(lineage.profile_id, STAGE4C_RECOVERY_01.profile_id, 'recovery-01 lineage profile_id')
  equal(lineage.parent_candidate_id, 'h0', 'recovery-01 lineage parent_candidate_id')
  equal(lineage.candidate_id, STAGE4C_RECOVERY_01.candidate_id, 'recovery-01 lineage candidate_id')
  equal(lineage.execution_commit, STAGE4C_RECOVERY_01.execution_commit, 'recovery-01 lineage execution_commit')
  equal(lineage.baseline_run_directory, h0Directory, 'recovery-01 lineage baseline_run_directory')
  equal(lineage.baseline_feedback_id, FROZEN_H0.feedback_id, 'recovery-01 lineage baseline_feedback_id')
  equal(lineage.source_pool_sha256, sourcePoolSha256, 'recovery-01 lineage source_pool_sha256')
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
  ], 'recovery-01 proposal context')
  equal(context.profile_id, STAGE4C_RECOVERY_01.profile_id, 'proposal context profile_id')
  equal(context.benchmark, 'bfcl-v4', 'proposal context benchmark')
  equal(context.strategy_plugin_id, 'bfcl-v4-strategy', 'proposal context strategy_plugin_id')
  equal(context.strategy_version, '1', 'proposal context strategy_version')
  equal(context.generation, 1, 'proposal context generation')
  equal(context.seed, 42, 'proposal context seed')
  if (JSON.stringify(context.allowed_capabilities) !== JSON.stringify(['data-select', 'data-filter', 'data-order'])) {
    throw new Error('recovery-01 proposal context capabilities drifted')
  }
  const pool = exactFields(context.source_pool, ['canonical_records', 'canonical_jsonl_sha256', 'records'], 'proposal context source_pool')
  equal(pool.canonical_records, 100, 'proposal context canonical_records')
  if (typeof pool.canonical_jsonl_sha256 !== 'string' || !SHA256.test(pool.canonical_jsonl_sha256)) {
    throw new Error('proposal context source_pool_sha256 is invalid')
  }
  if (!Array.isArray(pool.records) || pool.records.length !== 100) {
    throw new Error('proposal context must retain exactly 100 source-pool summaries')
  }
  if (containsForbiddenEvaluationBoundary(context)) {
    throw new Error('proposal context must not contain B_dev or B_test evidence')
  }
  return pool.canonical_jsonl_sha256
}

function verifyRecoveryState(value, runDirectory, h0Directory) {
  const state = exactFields(value, [
    'schema_version', 'profile_id', 'run_id', 'experiment_run_id', 'candidate_id', 'strategy_version',
    'execution_commit', 'status', 'phase', 'run_directory', 'baseline_run_directory',
    'b_search_cases_jsonl', 'created_at', 'updated_at', 'attempts', 'formal_candidate_persisted', 'failure',
  ], 'recovery-01 generation state')
  equal(state.schema_version, 'autodata-generation-state-1', 'recovery-01 state schema_version')
  equal(state.profile_id, STAGE4C_RECOVERY_01.profile_id, 'recovery-01 state profile_id')
  equal(state.run_id, STAGE4C_RECOVERY_01.generation_run_id, 'recovery-01 state run_id')
  equal(state.experiment_run_id, STAGE4C_RECOVERY_01.experiment_run_id, 'recovery-01 state experiment_run_id')
  equal(state.candidate_id, STAGE4C_RECOVERY_01.candidate_id, 'recovery-01 state candidate_id')
  equal(state.execution_commit, STAGE4C_RECOVERY_01.execution_commit, 'recovery-01 state execution_commit')
  equal(state.strategy_version, '1', 'recovery-01 state strategy_version')
  equal(state.status, 'failed', 'recovery-01 state status')
  equal(state.phase, 'proposing', 'recovery-01 state phase')
  equal(state.run_directory, runDirectory, 'recovery-01 state run_directory')
  equal(state.baseline_run_directory, h0Directory, 'recovery-01 state baseline_run_directory')
  equal(state.b_search_cases_jsonl, ORIGINAL_B_SEARCH_CASES, 'recovery-01 state b_search_cases_jsonl')
  equal(state.formal_candidate_persisted, false, 'recovery-01 formal_candidate_persisted')
  const created = isoTimestamp(state.created_at, 'recovery-01 state created_at')
  if (Date.parse(isoTimestamp(state.updated_at, 'recovery-01 state updated_at')) < Date.parse(created)) {
    throw new Error('recovery-01 state updated_at precedes created_at')
  }
  if (!Array.isArray(state.attempts) || state.attempts.length !== 3) {
    throw new Error('recovery-01 state must contain exactly three exhausted draft attempts')
  }
  const completeDraftSourceHashes = []
  const responsePaths = state.attempts.map((attemptInput, index) => {
    const number = index + 1
    const attempt = exactFields(
      attemptInput,
      number <= 2
        ? ['attempt', 'status', 'response_path', 'created_at', 'host_source_sha256', 'validation', 'failure']
        : ['attempt', 'status', 'response_path', 'created_at', 'failure'],
      `recovery-01 attempt ${String(number)}`,
    )
    equal(attempt.attempt, number, `recovery-01 attempt ${String(number)} number`)
    equal(attempt.status, 'failed', `recovery-01 attempt ${String(number)} status`)
    const expectedPath = resolve(runDirectory, 'attempts', `draft-${String(number).padStart(2, '0')}`, 'response.json')
    equal(attempt.response_path, expectedPath, `recovery-01 attempt ${String(number)} response_path`)
    isoTimestamp(attempt.created_at, `recovery-01 attempt ${String(number)} created_at`)
    if (number <= 2) {
      if (typeof attempt.host_source_sha256 !== 'string' || !SHA256.test(attempt.host_source_sha256)) {
        throw new Error(`recovery-01 attempt ${String(number)} source hash is invalid`)
      }
      completeDraftSourceHashes.push(attempt.host_source_sha256)
      const validation = exactFields(
        attempt.validation,
        ['schema_version', 'candidate_id', 'ok', 'reason'],
        `recovery-01 attempt ${String(number)} validation`,
      )
      if (
        validation.schema_version !== 'autodata-candidate-validation-1'
        || validation.candidate_id !== STAGE4C_RECOVERY_01.candidate_id
        || validation.ok !== false
        || !String(validation.reason).includes('plugin pipeline produced no selected records')
        || !String(attempt.failure).includes('plugin pipeline produced no selected records')
      ) {
        throw new Error(`recovery-01 attempt ${String(number)} must retain its failed structural validation`)
      }
    } else if (!String(attempt.failure).includes('kind=max-tokens')) {
      throw new Error('recovery-01 attempt 3 must retain its max-tokens failure')
    }
    return expectedPath
  })
  const failure = exactFields(state.failure, ['code', 'message'], 'recovery-01 terminal failure')
  equal(failure.code, 'PROPOSAL_FAILED', 'recovery-01 failure code')
  equal(failure.message, 'all 3 ephemeral drafts failed', 'recovery-01 failure message')
  if (completeDraftSourceHashes[0] === completeDraftSourceHashes[1]) {
    throw new Error('recovery-01 complete drafts must retain their distinct source hashes')
  }
  return { responsePaths, completeDraftSourceHashes }
}

function verifyResponses(runDirectory, paths, sourceHashes) {
  return paths.map((path, index) => {
    const result = evidence(runDirectory, path, `recovery-01 draft ${String(index + 1)} response`)
    if (index < 2) {
      const response = exactFields(result.value, ['description', 'host_source'], `recovery-01 draft ${String(index + 1)} response`)
      if (typeof response.description !== 'string' || response.description.length === 0 || typeof response.host_source !== 'string') {
        throw new Error(`recovery-01 draft ${String(index + 1)} must retain one complete model payload`)
      }
      equal(
        createHash('sha256').update(response.host_source).digest('hex'),
        sourceHashes[index],
        `recovery-01 draft ${String(index + 1)} host source`,
      )
    } else {
      const response = exactFields(result.value, ['error'], 'recovery-01 draft 3 response')
      if (typeof response.error !== 'string' || !response.error.includes('kind=max-tokens')) {
        throw new Error('recovery-01 draft 3 response must retain its max-tokens failure')
      }
    }
    return result
  })
}

function listRegularFiles(root) {
  const files = []
  const visit = directoryPath => {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const path = resolve(directoryPath, entry.name)
      const inspected = inspectPath(path)
      if (inspected.stat.isDirectory()) visit(path)
      else if (inspected.stat.isFile()) files.push(relative(root, path))
      else throw new Error(`unsupported recovery-01 artifact type: ${path}`)
    }
  }
  visit(root)
  return files.sort()
}

function verifyRecovery01Inventory(options, profileDirectory, runDirectory) {
  const expectedRun = [
    'attempts/draft-01/response.json',
    'attempts/draft-02/response.json',
    'attempts/draft-03/response.json',
    'proposal-context.json',
    'request.json',
    'source-lineage.json',
    'state.json',
  ].sort()
  if (JSON.stringify(listRegularFiles(runDirectory)) !== JSON.stringify(expectedRun)) {
    throw new Error('recovery-01 run contains an unexpected candidate, materialization, experiment, or other artifact')
  }
  const profileEntries = readdirSync(profileDirectory).sort()
  if (JSON.stringify(profileEntries) !== JSON.stringify(['first-h1-claim.json', STAGE4C_RECOVERY_01.generation_run_id].sort())) {
    throw new Error('recovery-01 profile contains unsupported generation history')
  }
  const allowedRoot = new Set([PREDECESSOR_AMENDMENT_FILE, STAGE4C_RECOVERY_01.profile_id, STAGE4C_RECOVERY_02_OWNER_FILE])
  const ownerTemporary = /^stage4c-recovery-02-owner\.json\.\d+\.[a-f0-9-]+\.tmp$/u
  const unexpected = readdirSync(options.predecessorGenerationRoot)
    .filter(name => !allowedRoot.has(name) && !ownerTemporary.test(name))
  if (unexpected.length > 0) throw new Error(`recovery-01 root contains unsupported history: ${unexpected.sort().join(', ')}`)
}

function verifyRecovery02RootInventory(options) {
  const allowed = new Set([STAGE4C_RECOVERY_AMENDMENT_02_FILE, STAGE4C_RECOVERY_01.profile_id])
  const amendmentTemporary = /^protocol-amendment-02\.json\.\d+\.[a-f0-9-]+\.tmp$/u
  const unexpected = readdirSync(options.recoveryGenerationRoot)
    .filter(name => !allowed.has(name) && !amendmentTemporary.test(name))
  if (unexpected.length > 0) {
    throw new Error(`recovery-02 root contains unsupported history: ${unexpected.sort().join(', ')}`)
  }
}

function verifyDiagnostic(options) {
  const entries = readdirSync(options.diagnosticRoot).sort()
  if (JSON.stringify(entries) !== JSON.stringify([DIAGNOSTIC_CLAIM_FILE, DIAGNOSTIC_RESULT_FILE].sort())) {
    throw new Error('FreeRouter diagnostic root must contain exactly its immutable claim and result')
  }
  const claim = evidence(
    options.diagnosticRoot,
    resolve(options.diagnosticRoot, DIAGNOSTIC_CLAIM_FILE),
    'FreeRouter diagnostic claim',
  )
  const claimValue = exactFields(claim.value, [
    'schema_version', 'diagnostic_id', 'execution_commit', 'provider', 'model', 'api', 'base_url',
    'session_id', 'max_tokens', 'max_provider_requests', 'provider_retry_max', 'tools_enabled',
    'candidate_capable', 'started_at',
  ], 'FreeRouter diagnostic claim')
  equal(claimValue.schema_version, 'autodata-stage4c-freerouter-diagnostic-claim-1', 'diagnostic claim schema_version')
  equal(claimValue.diagnostic_id, DIAGNOSTIC_ID, 'diagnostic claim id')
  equal(claimValue.execution_commit, options.recoveryCommit, 'diagnostic execution/recovery commit')
  equal(claimValue.provider, RECOVERY_PROVIDER, 'diagnostic provider')
  equal(claimValue.model, RECOVERY_MODEL, 'diagnostic model')
  equal(claimValue.api, RECOVERY_API, 'diagnostic API')
  equal(claimValue.base_url, RECOVERY_BASE_URL, 'diagnostic base URL')
  equal(claimValue.session_id, DIAGNOSTIC_SESSION_ID, 'diagnostic session id')
  equal(claimValue.max_tokens, DIAGNOSTIC_MAX_TOKENS, 'diagnostic max_tokens')
  equal(claimValue.max_provider_requests, 1, 'diagnostic provider request cap')
  equal(claimValue.provider_retry_max, 0, 'diagnostic provider retry cap')
  equal(claimValue.tools_enabled, false, 'diagnostic tools_enabled')
  equal(claimValue.candidate_capable, false, 'diagnostic candidate_capable')
  const startedAt = isoTimestamp(claimValue.started_at, 'diagnostic started_at')

  const result = evidence(
    options.diagnosticRoot,
    resolve(options.diagnosticRoot, DIAGNOSTIC_RESULT_FILE),
    'FreeRouter diagnostic result',
  )
  const resultValue = exactFields(result.value, [
    'schema_version', 'diagnostic_id', 'claim_sha256', 'status', 'completed_at', 'provider', 'model',
    'response', 'provider_attempts', 'provider_retries', 'agent_loop_sse_verified', 'token_usage',
    'b_search_visible', 'b_dev_visible', 'b_test_touched', 'candidate_created',
  ], 'FreeRouter diagnostic result')
  equal(resultValue.schema_version, 'autodata-stage4c-freerouter-diagnostic-result-1', 'diagnostic result schema_version')
  equal(resultValue.diagnostic_id, DIAGNOSTIC_ID, 'diagnostic result id')
  equal(resultValue.claim_sha256, claim.sha256, 'diagnostic result claim SHA-256')
  equal(resultValue.status, 'passed', 'diagnostic result status')
  equal(resultValue.provider, RECOVERY_PROVIDER, 'diagnostic result provider')
  equal(resultValue.model, RECOVERY_MODEL, 'diagnostic result model')
  equal(resultValue.response, 'OK', 'diagnostic result response')
  equal(resultValue.provider_attempts, 1, 'diagnostic result provider_attempts')
  equal(resultValue.provider_retries, 0, 'diagnostic result provider_retries')
  equal(resultValue.agent_loop_sse_verified, true, 'diagnostic result Agent loop/SSE evidence')
  equal(resultValue.b_search_visible, false, 'diagnostic result b_search_visible')
  equal(resultValue.b_dev_visible, false, 'diagnostic result b_dev_visible')
  equal(resultValue.b_test_touched, false, 'diagnostic result b_test_touched')
  equal(resultValue.candidate_created, false, 'diagnostic result candidate_created')
  record(resultValue.token_usage, 'diagnostic result token_usage')
  if (Date.parse(isoTimestamp(resultValue.completed_at, 'diagnostic completed_at')) < Date.parse(startedAt)) {
    throw new Error('diagnostic completed_at precedes started_at')
  }
  return { claim, result }
}

function verifyH0AndEvolution(options, replayEvolutionStateSha256) {
  const h0Directory = contained(
    options.experimentRunRoot,
    resolve(options.experimentRunRoot, FROZEN_H0.profile_id, FROZEN_H0.run_id),
    'frozen H0 run directory',
  )
  const h0State = evidence(h0Directory, resolve(h0Directory, 'state.json'), 'frozen H0 state')
  const state = record(h0State.value, 'frozen H0 state')
  equal(state.profile_id, FROZEN_H0.profile_id, 'H0 state profile_id')
  equal(state.run_id, FROZEN_H0.run_id, 'H0 state run_id')
  equal(state.contract_id, FROZEN_H0.contract_id, 'H0 state contract_id')
  equal(state.contract_sha256, FROZEN_H0.contract_sha256, 'H0 state contract_sha256')
  equal(state.feedback_id, FROZEN_H0.feedback_id, 'H0 state feedback_id')
  equal(state.evaluation_report_id, FROZEN_H0.evaluation_report_id, 'H0 state evaluation_report_id')
  equal(state.status, 'succeeded', 'H0 state status')
  equal(state.phase, 'complete', 'H0 state phase')
  const contract = fileEvidence(h0Directory, resolve(h0Directory, 'experiment-contract.json'), 'frozen H0 contract')
  equal(contract.sha256, FROZEN_H0.contract_sha256, 'H0 contract SHA-256')
  const canonical = fileEvidence(h0Directory, resolve(h0Directory, 'canonical.jsonl'), 'frozen H0 canonical data')

  let evolutionStateSha256 = replayEvolutionStateSha256
  if (evolutionStateSha256 === undefined) {
    const evolution = evidence(
      options.evolutionRoot,
      resolve(options.evolutionRoot, 'profiles', FROZEN_H0.profile_id, 'state.json'),
      'pre-recovery-02 Evolution state',
    )
    const value = record(evolution.value, 'pre-recovery-02 Evolution state')
    equal(value.profile_id, FROZEN_H0.profile_id, 'Evolution state profile_id')
    equal(value.generation, 0, 'Evolution state generation')
    equal(value.active_candidate_id, 'h0', 'Evolution active_candidate_id')
    equal(value.open_candidate_id, null, 'Evolution open_candidate_id')
    if (!Array.isArray(value.candidates) || value.candidates.length !== 1 || value.candidates[0]?.candidate_id !== 'h0') {
      throw new Error('Evolution state must contain H0 only before recovery-02')
    }
    evolutionStateSha256 = evolution.sha256
  } else if (typeof evolutionStateSha256 !== 'string' || !SHA256.test(evolutionStateSha256)) {
    throw new Error('recorded pre-recovery-02 Evolution state SHA-256 is invalid')
  }
  return { h0Directory, h0State, contract, canonical, evolutionStateSha256 }
}

function recoveryIdentity(options) {
  const shortCommit = options.recoveryCommit.slice(0, 12)
  const generationRunId = `first-h1-recovery-02-${shortCommit}-20260831`
  return {
    generation_root: options.recoveryGenerationRoot,
    generation_run_id: generationRunId,
    experiment_run_id: `h1-recovery-02-${shortCommit}-20260831`,
    candidate_id: `candidate-h1-recovery-02-${shortCommit}-20260831`,
    session_id: `autodata-generation-${STAGE4C_RECOVERY_01.profile_id}-${generationRunId}`,
  }
}

function amendmentFor(options, replayEvolutionStateSha256) {
  const identity = recoveryIdentity(options)
  const diagnostic = verifyDiagnostic(options)
  const amendment01 = evidence(
    options.predecessorGenerationRoot,
    resolve(options.predecessorGenerationRoot, PREDECESSOR_AMENDMENT_FILE),
    'recovery-01 amendment',
  )
  const amendment01Value = verifyPredecessorAmendment(amendment01.value, options)
  const owner01 = evidence(
    options.originalGenerationRoot,
    resolve(options.originalGenerationRoot, STAGE4C_RECOVERY_01.profile_id, PREDECESSOR_OWNER_FILE),
    'recovery-01 owner',
  )
  verifyPredecessorOwner(owner01.value, amendment01.sha256, options)

  const profileDirectory = contained(
    options.predecessorGenerationRoot,
    resolve(options.predecessorGenerationRoot, STAGE4C_RECOVERY_01.profile_id),
    'recovery-01 profile directory',
  )
  const runDirectory = contained(
    options.predecessorGenerationRoot,
    resolve(profileDirectory, STAGE4C_RECOVERY_01.generation_run_id),
    'recovery-01 run directory',
  )
  const h0 = verifyH0AndEvolution(options, replayEvolutionStateSha256)
  verifyOriginalEvidenceChain(amendment01Value, options, h0.evolutionStateSha256)
  const claim = evidence(options.predecessorGenerationRoot, resolve(profileDirectory, 'first-h1-claim.json'), 'recovery-01 first-H1 claim')
  const request = evidence(runDirectory, resolve(runDirectory, 'request.json'), 'recovery-01 request')
  const state = evidence(runDirectory, resolve(runDirectory, 'state.json'), 'recovery-01 state')
  const lineage = evidence(runDirectory, resolve(runDirectory, 'source-lineage.json'), 'recovery-01 lineage')
  const context = evidence(runDirectory, resolve(runDirectory, 'proposal-context.json'), 'recovery-01 proposal context')
  verifyClaim(claim.value)
  verifyRequest(request.value, h0.h0Directory)
  const recoveryState = verifyRecoveryState(state.value, runDirectory, h0.h0Directory)
  const sourcePoolSha256 = verifyProposalContext(context.value)
  equal(sourcePoolSha256, h0.canonical.sha256, 'proposal context/H0 source-pool SHA-256')
  verifyLineage(lineage.value, h0.h0Directory, sourcePoolSha256)
  const responses = verifyResponses(runDirectory, recoveryState.responsePaths, recoveryState.completeDraftSourceHashes)
  const predecessorHashes = record(amendment01Value.evidence_sha256, 'recovery-01 amendment evidence_sha256')
  equal(predecessorHashes.proposal_context, context.sha256, 'recovery-01 chained proposal context SHA-256')
  verifyRecovery01Inventory(options, profileDirectory, runDirectory)
  verifyRecovery02RootInventory(options)

  for (const exhausted of [ORIGINAL_EXECUTION, STAGE4C_RECOVERY_01]) {
    assertAbsent(
      options.experimentRunRoot,
      resolve(options.experimentRunRoot, STAGE4C_RECOVERY_01.profile_id, exhausted.experiment_run_id),
      `exhausted ${exhausted.experiment_run_id} experiment directory`,
    )
    assertAbsent(
      options.experimentStagingRoot,
      resolve(options.experimentStagingRoot, exhausted.experiment_run_id),
      `exhausted ${exhausted.experiment_run_id} staging directory`,
    )
    assertAbsent(
      options.evolutionRoot,
      resolve(options.evolutionRoot, 'profiles', STAGE4C_RECOVERY_01.profile_id, 'candidates', exhausted.candidate_id),
      `exhausted ${exhausted.candidate_id} candidate directory`,
    )
    assertAbsent(
      options.experimentRunRoot,
      resolve(options.experimentRunRoot, '.candidate-owners', STAGE4C_RECOVERY_01.profile_id, `${exhausted.candidate_id}.json`),
      `exhausted ${exhausted.candidate_id} experiment owner`,
    )
  }
  if (replayEvolutionStateSha256 === undefined) {
    assertAbsent(
      options.recoveryGenerationRoot,
      resolve(options.recoveryGenerationRoot, STAGE4C_RECOVERY_01.profile_id),
      'recovery-02 generation profile directory',
    )
    assertAbsent(
      options.experimentRunRoot,
      resolve(options.experimentRunRoot, STAGE4C_RECOVERY_01.profile_id, identity.experiment_run_id),
      'recovery-02 experiment directory',
    )
    assertAbsent(
      options.experimentStagingRoot,
      resolve(options.experimentStagingRoot, identity.experiment_run_id),
      'recovery-02 staging directory',
    )
    assertAbsent(
      options.evolutionRoot,
      resolve(options.evolutionRoot, 'profiles', STAGE4C_RECOVERY_01.profile_id, 'candidates', identity.candidate_id),
      'recovery-02 Evolution candidate directory',
    )
    assertAbsent(
      options.experimentRunRoot,
      resolve(options.experimentRunRoot, '.candidate-owners', STAGE4C_RECOVERY_01.profile_id, `${identity.candidate_id}.json`),
      'recovery-02 experiment owner',
    )
  }

  return deepFreeze({
    schema_version: STAGE4C_RECOVERY_AMENDMENT_02_SCHEMA_VERSION,
    amendment_id: AMENDMENT_ID,
    predecessor_amendment_id: PREDECESSOR_AMENDMENT_ID,
    same_logical_h1: true,
    classification: 'exploratory_protocol_deviation',
    recovery_reason: 'operator_authorized_single_proposal_after_runtime_contract_repair',
    runtime_contract_repair: {
      commit: STAGE4C_RUNTIME_CONTRACT_FIX_COMMIT,
      defect: 'proposal_prompt_misdescribed_data_plugin_runtime_input',
      corrected_runtime_input: 'DataSelection[]',
      record_id_path: 'item.record.source.record_id',
    },
    prerequisite_diagnostic: {
      diagnostic_id: DIAGNOSTIC_ID,
      root: options.diagnosticRoot,
      session_id: DIAGNOSTIC_SESSION_ID,
      execution_commit: options.recoveryCommit,
      status: 'passed',
      response: 'OK',
      provider_attempts: 1,
      provider_retries: 0,
      candidate_created: false,
      b_test_touched: false,
    },
    exhausted_executions: {
      original: {
        ...ORIGINAL_EXECUTION,
        provider: 'free-router',
        model: 'gpt-5.6-sol',
        proposal_attempts: 3,
        complete_draft_payloads: 0,
      },
      recovery_01: {
        ...STAGE4C_RECOVERY_01,
        status: 'failed',
        phase: 'proposing',
        proposal_attempts: 3,
        complete_draft_payloads: 2,
        formal_candidate_persisted: false,
        experiment_started: false,
      },
    },
    recovery_execution: {
      execution_commit: options.recoveryCommit,
      provider: options.provider,
      model: options.model,
      ...identity,
      proposal_config: {
        max_tokens: RECOVERY_MAX_TOKENS,
        max_proposal_drafts: 1,
        max_provider_requests: 1,
        tool_access: 'disabled',
      },
      provider_config: {
        api_key_env: 'FREEROUTER_API_KEY',
        api: RECOVERY_API,
        base_url: RECOVERY_BASE_URL,
        reasoning: 'high',
        headers: { 'x-session-id': identity.session_id },
        retry_policy: { mode: 'normal', max_retries: 0 },
      },
    },
    frozen_h0: FROZEN_H0,
    protocol_guards: {
      protocol_deviation: true,
      provider_switch: true,
      exploratory: true,
      infrastructure_recovery_only: false,
      original_and_recovery_01_artifacts_immutable: true,
      frozen_h0_reused: true,
      prior_draft_source_model_visible: false,
      max_total_proposal_attempts: 7,
      max_complete_draft_payloads: 3,
      max_recovery_02_proposals: 1,
      max_provider_requests: 1,
      max_formal_candidates: 1,
      manual_candidate: false,
      provider_fallback: false,
      draft_selection: false,
      amendment_03_allowed: false,
      ambiguous_request_outcome_consumes_budget: true,
      b_dev_model_visible: false,
      b_test_touched: false,
    },
    evidence_sha256: {
      predecessor_amendment: amendment01.sha256,
      predecessor_owner: owner01.sha256,
      diagnostic_claim: diagnostic.claim.sha256,
      diagnostic_result: diagnostic.result.sha256,
      recovery_01_first_h1_claim: claim.sha256,
      recovery_01_generation_request: request.sha256,
      recovery_01_generation_state: state.sha256,
      recovery_01_source_lineage: lineage.sha256,
      proposal_context: context.sha256,
      recovery_01_draft_responses: responses.map((response, index) => ({ attempt: index + 1, sha256: response.sha256 })),
      recovery_01_complete_draft_host_sources: recoveryState.completeDraftSourceHashes
        .map((sha256, index) => ({ attempt: index + 1, sha256 })),
      h0_state: h0.h0State.sha256,
      h0_contract: h0.contract.sha256,
      h0_canonical_jsonl: h0.canonical.sha256,
      evolution_state: h0.evolutionStateSha256,
    },
  })
}

export function verifyStage4CRecovery02Source(optionsInput) {
  return amendmentFor(normalizedOptions(optionsInput))
}

function amendmentPath(options) {
  return contained(
    options.recoveryGenerationRoot,
    resolve(options.recoveryGenerationRoot, STAGE4C_RECOVERY_AMENDMENT_02_FILE),
    'recovery-02 protocol amendment',
  )
}

function ownerPath(options) {
  return contained(
    options.predecessorGenerationRoot,
    resolve(options.predecessorGenerationRoot, STAGE4C_RECOVERY_02_OWNER_FILE),
    'recovery-02 successor owner',
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
    schema_version: OWNER_SCHEMA_VERSION,
    profile_id: STAGE4C_RECOVERY_01.profile_id,
    predecessor_amendment_id: PREDECESSOR_AMENDMENT_ID,
    amendment_id: AMENDMENT_ID,
    amendment_file: STAGE4C_RECOVERY_AMENDMENT_02_FILE,
    amendment_sha256: amendmentSha256,
    recovery_generation_root: options.recoveryGenerationRoot,
    recovery_commit: options.recoveryCommit,
    generation_run_id: identity.generation_run_id,
    experiment_run_id: identity.experiment_run_id,
    candidate_id: identity.candidate_id,
    amendment_03_allowed: false,
  })
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

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
  const actual = readRegularBytes(options.recoveryGenerationRoot, path, 'recovery-02 protocol amendment')
  const parsed = parseJsonObject(actual, 'recovery-02 protocol amendment')
  const hashes = record(parsed.evidence_sha256, 'recovery-02 amendment evidence_sha256')
  const evolutionStateSha256 = hashes.evolution_state
  if (typeof evolutionStateSha256 !== 'string' || !SHA256.test(evolutionStateSha256)) {
    throw new Error('recovery-02 amendment has an invalid pre-execution Evolution state SHA-256')
  }
  const amendment = amendmentFor(options, evolutionStateSha256)
  const expected = jsonBytes(amendment)
  if (!actual.equals(expected)) throw new Error(`existing recovery-02 protocol amendment conflicts: ${path}`)
  const expectedOwner = jsonBytes(ownerFor(options, sha256Bytes(actual)))
  const owner = readRegularBytes(options.predecessorGenerationRoot, ownerPath(options), 'recovery-02 successor owner')
  if (!owner.equals(expectedOwner)) throw new Error(`existing recovery-02 successor owner conflicts: ${ownerPath(options)}`)
  return deepFreeze({ path, created: false, amendment })
}

export function verifyStage4CRecovery02Amendment(optionsInput) {
  return verifyExistingAmendment(normalizedOptions(optionsInput))
}

export function createStage4CRecovery02Amendment(optionsInput) {
  const options = normalizedOptions(optionsInput, true)
  const path = amendmentPath(options)
  if (inspectPath(path, { allowMissing: true }).exists) return verifyExistingAmendment(options)
  let amendment
  try {
    amendment = amendmentFor(options)
  } catch (error) {
    if (inspectPath(path, { allowMissing: true }).exists) return verifyExistingAmendment(options)
    throw error
  }
  const content = jsonBytes(amendment)
  const owner = jsonBytes(ownerFor(options, sha256Bytes(content)))
  durableLinkNewOrSame(options.predecessorGenerationRoot, ownerPath(options), owner, 'recovery-02 successor owner')
  const created = durableLinkNewOrSame(options.recoveryGenerationRoot, path, content, 'recovery-02 protocol amendment')
  if (!created) return verifyExistingAmendment(options)
  return deepFreeze({ path, created: true, amendment })
}

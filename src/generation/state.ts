import { isAbsolute, resolve } from 'node:path'
import { immutableJson, isJsonObject } from '../core/json.js'
import { validateExperimentId } from '../experiment/contracts.js'
import type { CandidateValidationResult } from '../evolution/validator.js'
import {
  GENERATION_MAX_DRAFTS,
  GENERATION_STATE_VERSION,
  LEGACY_GENERATION_STATE_VERSION,
  GenerationError,
  type GenerationDraftAttempt,
  type GenerationErrorCode,
  type NormalizedGenerationStartRequest,
  type GenerationState,
} from './types.js'

const SHA256 = /^[a-f0-9]{64}$/u
const GIT_COMMIT = /^[a-f0-9]{40}$/u
const ERROR_CODES = new Set<GenerationErrorCode>([
  'INVALID_REQUEST', 'RUN_EXISTS', 'RUN_NOT_FOUND', 'STATE_CORRUPT', 'ARTIFACT_EXISTS',
  'ARTIFACT_INVALID', 'PATH_ESCAPE', 'DEPENDENCY_UNAVAILABLE', 'PROPOSAL_FAILED',
  'VALIDATION_FAILED', 'NONDETERMINISTIC_CANDIDATE', 'EXPERIMENT_FAILED',
  'DECISION_FAILED', 'RECOVERY_REQUIRED', 'CANCEL_FAILED', 'STORE_IO',
])
const STATUSES = new Set(['queued', 'running', 'recovery_required', 'succeeded', 'failed', 'cancelled'])
const PHASES = new Set(['initialized', 'proposing', 'candidate_ready', 'experiment', 'deciding', 'feedback', 'complete'])

function corrupt(message: string): never {
  throw new GenerationError(message, 'STATE_CORRUPT')
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupt(`${label} must be a non-empty string`)
  return value
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label)
  if (!Number.isFinite(Date.parse(result))) corrupt(`${label} must be an ISO timestamp`)
  return result
}

function absolute(value: unknown, label: string): string {
  const path = text(value, label)
  if (!isAbsolute(path)) corrupt(`${label} must be an absolute path`)
  return resolve(path)
}

export function normalizeGenerationStartRequest(value: unknown): NormalizedGenerationStartRequest {
  if (!isJsonObject(value)) throw new GenerationError('generation start request must be an object', 'INVALID_REQUEST')
  const requiredFields = [
    'profile_id', 'run_id', 'experiment_run_id', 'execution_commit', 'baseline_run_directory',
    'b_search_cases_jsonl', 'candidate_id', 'strategy_version',
  ] as const
  const fields = [...requiredFields, 'max_proposal_drafts'] as const
  const missing = requiredFields.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) throw new GenerationError(`generation start request is missing ${missing}`, 'INVALID_REQUEST')
  const extra = Object.keys(value).find(field => !fields.includes(field as typeof fields[number]))
  if (extra !== undefined) throw new GenerationError(`generation start request has unsupported field ${extra}`, 'INVALID_REQUEST')
  const strategyVersion = value.strategy_version
  if (typeof strategyVersion !== 'string' || strategyVersion.length === 0 || strategyVersion.length > 64) {
    throw new GenerationError('strategy_version must contain 1-64 characters', 'INVALID_REQUEST')
  }
  const baseline = value.baseline_run_directory
  const cases = value.b_search_cases_jsonl
  const executionCommit = value.execution_commit
  if (typeof executionCommit !== 'string' || !GIT_COMMIT.test(executionCommit)) {
    throw new GenerationError('execution_commit must be a full lowercase Git commit', 'INVALID_REQUEST')
  }
  if (typeof baseline !== 'string' || !isAbsolute(baseline)) {
    throw new GenerationError('baseline_run_directory must be absolute', 'INVALID_REQUEST')
  }
  if (typeof cases !== 'string' || !isAbsolute(cases)) {
    throw new GenerationError('b_search_cases_jsonl must be absolute', 'INVALID_REQUEST')
  }
  const maxProposalDrafts = value.max_proposal_drafts ?? GENERATION_MAX_DRAFTS
  if (
    typeof maxProposalDrafts !== 'number'
    || !Number.isSafeInteger(maxProposalDrafts)
    || maxProposalDrafts < 1
    || maxProposalDrafts > GENERATION_MAX_DRAFTS
  ) {
    throw new GenerationError(
      `max_proposal_drafts must be a safe integer between 1 and ${String(GENERATION_MAX_DRAFTS)}`,
      'INVALID_REQUEST',
    )
  }
  return Object.freeze({
    profile_id: validateExperimentId(value.profile_id, 'profile_id'),
    run_id: validateExperimentId(value.run_id, 'run_id'),
    experiment_run_id: validateExperimentId(value.experiment_run_id, 'experiment_run_id'),
    execution_commit: executionCommit,
    baseline_run_directory: resolve(baseline),
    b_search_cases_jsonl: resolve(cases),
    candidate_id: validateExperimentId(value.candidate_id, 'candidate_id'),
    strategy_version: strategyVersion,
    max_proposal_drafts: maxProposalDrafts,
  })
}

export function createInitialGenerationState(input: {
  readonly request: NormalizedGenerationStartRequest
  readonly run_directory: string
  readonly now: string
}): GenerationState {
  return normalizeGenerationState({
    schema_version: GENERATION_STATE_VERSION,
    profile_id: input.request.profile_id,
    run_id: input.request.run_id,
    experiment_run_id: input.request.experiment_run_id,
    candidate_id: input.request.candidate_id,
    strategy_version: input.request.strategy_version,
    execution_commit: input.request.execution_commit,
    status: 'queued',
    phase: 'initialized',
    run_directory: input.run_directory,
    baseline_run_directory: input.request.baseline_run_directory,
    b_search_cases_jsonl: input.request.b_search_cases_jsonl,
    created_at: input.now,
    updated_at: input.now,
    max_proposal_drafts: input.request.max_proposal_drafts,
    proposal_drafts_started: 0,
    attempts: [],
    formal_candidate_persisted: false,
  })
}

export function normalizeGenerationState(value: unknown): GenerationState {
  if (!isJsonObject(value)) corrupt('generation state must be an object')
  const commonRequired = [
    'schema_version', 'profile_id', 'run_id', 'experiment_run_id', 'candidate_id',
    'strategy_version', 'execution_commit', 'status', 'phase', 'run_directory', 'baseline_run_directory',
    'b_search_cases_jsonl', 'created_at', 'updated_at', 'attempts',
    'formal_candidate_persisted',
  ] as const
  const legacy = value.schema_version === LEGACY_GENERATION_STATE_VERSION
  if (!legacy && value.schema_version !== GENERATION_STATE_VERSION) {
    corrupt('generation state schema_version is unsupported')
  }
  const required = legacy
    ? commonRequired
    : [...commonRequired, 'max_proposal_drafts', 'proposal_drafts_started'] as const
  const optional = new Set([
    'candidate_source_path', 'candidate_source_sha256', 'materialized_data_path',
    'materialization_sha256', 'experiment_started', 'decision', 'feedback_id', 'failure',
  ])
  const missing = required.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) corrupt(`generation state is missing ${missing}`)
  const requiredSet = new Set<string>(required)
  const extra = Object.keys(value).find(field => !requiredSet.has(field) && !optional.has(field))
  if (extra !== undefined) corrupt(`generation state has unsupported field ${extra}`)
  const profileId = validateExperimentId(value.profile_id, 'profile_id')
  const runId = validateExperimentId(value.run_id, 'run_id')
  if (!STATUSES.has(value.status as string)) corrupt('generation state.status is invalid')
  if (!PHASES.has(value.phase as string)) corrupt('generation state.phase is invalid')
  const maxProposalDrafts = legacy ? GENERATION_MAX_DRAFTS : value.max_proposal_drafts
  if (
    typeof maxProposalDrafts !== 'number'
    || !Number.isSafeInteger(maxProposalDrafts)
    || maxProposalDrafts < 1
    || maxProposalDrafts > GENERATION_MAX_DRAFTS
  ) {
    corrupt(`generation state max_proposal_drafts must be between 1 and ${String(GENERATION_MAX_DRAFTS)}`)
  }
  if (!Array.isArray(value.attempts) || value.attempts.length > maxProposalDrafts) {
    corrupt(`generation state attempts must contain at most ${String(maxProposalDrafts)} entries`)
  }
  const attempts = value.attempts.map((attempt, index) => normalizeAttempt(attempt, index + 1))
  const proposalDraftsStarted = legacy ? attempts.length : value.proposal_drafts_started
  if (
    typeof proposalDraftsStarted !== 'number'
    || !Number.isSafeInteger(proposalDraftsStarted)
    || proposalDraftsStarted < attempts.length
    || proposalDraftsStarted > maxProposalDrafts
    || proposalDraftsStarted - attempts.length > 1
  ) corrupt('generation state proposal_drafts_started is inconsistent with its draft budget')
  if (typeof value.formal_candidate_persisted !== 'boolean') corrupt('formal_candidate_persisted must be boolean')
  if (
    proposalDraftsStarted !== attempts.length
    && (value.phase !== 'proposing' || value.formal_candidate_persisted)
  ) corrupt('only an unpersisted proposing state may contain a pending proposal draft')
  const candidateSourceSha = optionalSha(value.candidate_source_sha256, 'candidate_source_sha256')
  const materializationSha = optionalSha(value.materialization_sha256, 'materialization_sha256')
  const decision = value.decision === undefined ? undefined : (() => {
    if (!isJsonObject(value.decision)) corrupt('generation decision must be an object')
    const fields = ['candidate_id', 'accepted', 'reason', 'candidate_score', 'baseline_score'] as const
    if (Object.keys(value.decision).length !== fields.length || fields.some(field => !Object.hasOwn(value.decision as object, field))) {
      corrupt('generation decision has an invalid shape')
    }
    if (value.decision.candidate_id !== value.candidate_id || typeof value.decision.accepted !== 'boolean') {
      corrupt('generation decision identity is invalid')
    }
    const candidateScore = value.decision.candidate_score
    const baselineScore = value.decision.baseline_score
    if (
      typeof candidateScore !== 'number' || !Number.isFinite(candidateScore)
      || typeof baselineScore !== 'number' || !Number.isFinite(baselineScore)
    ) corrupt('generation decision scores must be finite')
    return {
      candidate_id: value.decision.candidate_id as string,
      accepted: value.decision.accepted,
      reason: text(value.decision.reason, 'generation decision.reason'),
      candidate_score: candidateScore,
      baseline_score: baselineScore,
    }
  })()
  const failure = value.failure === undefined ? undefined : (() => {
    if (!isJsonObject(value.failure) || typeof value.failure.code !== 'string' || !ERROR_CODES.has(value.failure.code as GenerationErrorCode)) {
      corrupt('generation failure is invalid')
    }
    return {
      code: value.failure.code as GenerationErrorCode,
      message: text(value.failure.message, 'generation failure.message'),
    }
  })()
  const state: GenerationState = {
    schema_version: legacy ? LEGACY_GENERATION_STATE_VERSION : GENERATION_STATE_VERSION,
    profile_id: profileId,
    run_id: runId,
    experiment_run_id: validateExperimentId(value.experiment_run_id, 'experiment_run_id'),
    candidate_id: validateExperimentId(value.candidate_id, 'candidate_id'),
    strategy_version: text(value.strategy_version, 'strategy_version'),
    execution_commit: (() => {
      const commit = text(value.execution_commit, 'execution_commit')
      if (!GIT_COMMIT.test(commit)) corrupt('execution_commit must be a full lowercase Git commit')
      return commit
    })(),
    status: value.status as GenerationState['status'],
    phase: value.phase as GenerationState['phase'],
    run_directory: absolute(value.run_directory, 'run_directory'),
    baseline_run_directory: absolute(value.baseline_run_directory, 'baseline_run_directory'),
    b_search_cases_jsonl: absolute(value.b_search_cases_jsonl, 'b_search_cases_jsonl'),
    created_at: timestamp(value.created_at, 'created_at'),
    updated_at: timestamp(value.updated_at, 'updated_at'),
    max_proposal_drafts: maxProposalDrafts,
    proposal_drafts_started: proposalDraftsStarted,
    attempts,
    formal_candidate_persisted: value.formal_candidate_persisted,
    ...(value.candidate_source_path === undefined ? {} : { candidate_source_path: absolute(value.candidate_source_path, 'candidate_source_path') }),
    ...(candidateSourceSha === undefined ? {} : { candidate_source_sha256: candidateSourceSha }),
    ...(value.materialized_data_path === undefined ? {} : { materialized_data_path: absolute(value.materialized_data_path, 'materialized_data_path') }),
    ...(materializationSha === undefined ? {} : { materialization_sha256: materializationSha }),
    ...(value.experiment_started === undefined ? {} : { experiment_started: value.experiment_started === true }),
    ...(decision === undefined ? {} : { decision }),
    ...(value.feedback_id === undefined ? {} : { feedback_id: validateExperimentId(value.feedback_id, 'feedback_id') }),
    ...(failure === undefined ? {} : { failure }),
  }
  if (state.formal_candidate_persisted && (
    state.candidate_source_path === undefined
    || state.candidate_source_sha256 === undefined
    || state.materialized_data_path === undefined
    || state.materialization_sha256 === undefined
  )) corrupt('persisted formal candidate is missing frozen source/materialization evidence')
  if (state.experiment_started === true && !state.formal_candidate_persisted) {
    corrupt('experiment cannot start before the formal candidate is persisted')
  }
  if (state.decision !== undefined && state.experiment_started !== true) corrupt('decision requires a started experiment')
  if (state.status === 'succeeded' && (state.phase !== 'complete' || state.decision === undefined)) {
    corrupt('succeeded generation must be complete with a decision')
  }
  return immutableJson(state) as unknown as GenerationState
}

function optionalSha(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SHA256.test(value)) corrupt(`${label} must be lowercase SHA-256`)
  return value
}

function normalizeAttempt(value: unknown, expectedAttempt: number): GenerationDraftAttempt {
  if (!isJsonObject(value)) corrupt('generation draft attempt must be an object')
  const required = ['attempt', 'status', 'response_path', 'created_at'] as const
  const optional = new Set(['host_source_sha256', 'validation', 'materialization_sha256', 'failure'])
  const missing = required.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) corrupt(`generation draft attempt is missing ${missing}`)
  const extra = Object.keys(value).find(field => !required.includes(field as typeof required[number]) && !optional.has(field))
  if (extra !== undefined) corrupt(`generation draft attempt has unsupported field ${extra}`)
  if (value.attempt !== expectedAttempt) corrupt('generation draft attempt numbers are not contiguous')
  if (value.status !== 'failed' && value.status !== 'passed') corrupt('generation draft attempt status is invalid')
  const validation = value.validation
  if (validation !== undefined && !isJsonObject(validation)) corrupt('generation draft validation result is invalid')
  return {
    attempt: expectedAttempt,
    status: value.status,
    response_path: absolute(value.response_path, 'generation draft response_path'),
    created_at: timestamp(value.created_at, 'generation draft created_at'),
    ...(value.host_source_sha256 === undefined ? {} : { host_source_sha256: optionalSha(value.host_source_sha256, 'generation draft host_source_sha256') as string }),
    ...(validation === undefined ? {} : { validation: validation as unknown as CandidateValidationResult }),
    ...(value.materialization_sha256 === undefined ? {} : { materialization_sha256: optionalSha(value.materialization_sha256, 'generation draft materialization_sha256') as string }),
    ...(value.failure === undefined ? {} : { failure: text(value.failure, 'generation draft failure') }),
  }
}

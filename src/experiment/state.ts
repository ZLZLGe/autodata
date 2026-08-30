/** Strict durable state for one Host-owned experiment run. */

import { createHash } from 'node:crypto'
import { immutableJson, isJsonObject } from '../core/json.js'
import { validateExperimentId } from './contracts.js'
import type { AcceptanceDecision, AcceptanceDecisionReason } from '../evolution/types.js'
import {
  EXPERIMENT_STAGES,
  EXPERIMENT_STATE_VERSION,
  ExperimentError,
  type ExperimentAttempt,
  type ExperimentAttemptStatus,
  type ExperimentErrorCode,
  type ExperimentStage,
  type ExperimentState,
} from './types.js'

const RUN_STATUSES = new Set(['queued', 'running', 'recovery_required', 'succeeded', 'failed', 'cancelled'])
const ATTEMPT_STATUSES = new Set<ExperimentAttemptStatus>([
  'prepared', 'dry_running', 'dry_passed', 'predict_running', 'predict_passed',
  'submitting', 'submitted', 'monitoring', 'succeeded', 'failed', 'cancelled', 'recovery_required',
])
const ERROR_CODES = new Set<ExperimentErrorCode>([
  'INVALID_REQUEST', 'RUN_EXISTS', 'RUN_NOT_FOUND', 'STATE_CORRUPT', 'ARTIFACT_EXISTS',
  'ARTIFACT_INVALID', 'PATH_ESCAPE', 'DEPENDENCY_UNAVAILABLE', 'DRY_RUN_FAILED',
    'UNSCHEDULABLE', 'SUBMIT_FAILED', 'REMOTE_FAILED', 'WORKER_FAILED', 'RECOVERY_REQUIRED',
  'CANCEL_FAILED', 'STORE_IO', 'BASELINE_REGISTRATION_FAILED', 'EVALUATION_REGISTRATION_FAILED',
])
const DECISION_REASONS = new Set<AcceptanceDecisionReason>([
  'accepted_strict_improvement', 'candidate_not_found', 'candidate_not_validated',
  'profile_mismatch', 'report_incomplete', 'wrong_split', 'wrong_metric', 'wrong_benchmark',
  'baseline_missing', 'baseline_fields_incomplete', 'baseline_candidate_mismatch',
  'baseline_score_mismatch', 'not_strictly_better', 'runtime_activation_failed',
])

function corrupt(message: string): never {
  throw new ExperimentError(message, 'STATE_CORRUPT')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) corrupt(`${label} must be an object`)
  return value
}

function exact(value: Record<string, unknown>, fields: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...fields, ...optional])
  const missing = fields.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) corrupt(`${label} is missing field ${missing}`)
  const extra = Object.keys(value).find(field => !allowed.has(field))
  if (extra !== undefined) corrupt(`${label} has unsupported field ${extra}`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupt(`${label} must be a non-empty string`)
  return value
}

function absolute(value: unknown, label: string): string {
  const path = text(value, label)
  if (!path.startsWith('/')) corrupt(`${label} must be absolute`)
  return path
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    corrupt(`${label} must be an integer >= ${String(minimum)}`)
  }
  return value
}

function score(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    corrupt(`${label} must be a finite score between 0 and 1`)
  }
  return value
}

function normalizeDecision(value: unknown, candidateId: string): AcceptanceDecision {
  const item = record(value, 'experiment decision')
  exact(item, ['candidate_id', 'accepted', 'reason'], [
    'split', 'metric', 'candidate_score', 'baseline_score',
  ], 'experiment decision')
  const decisionCandidateId = validateExperimentId(item.candidate_id, 'experiment decision.candidate_id')
  if (decisionCandidateId !== candidateId) corrupt('experiment decision candidate_id does not match the run candidate')
  if (typeof item.accepted !== 'boolean') corrupt('experiment decision.accepted must be a boolean')
  if (typeof item.reason !== 'string' || !DECISION_REASONS.has(item.reason as AcceptanceDecisionReason)) {
    corrupt('experiment decision.reason is invalid')
  }
  if (item.split !== undefined && !['B_search', 'B_dev', 'B_test'].includes(item.split as string)) {
    corrupt('experiment decision.split is invalid')
  }
  return Object.freeze({
    candidate_id: decisionCandidateId,
    accepted: item.accepted,
    reason: item.reason as AcceptanceDecisionReason,
    ...(item.split === undefined ? {} : { split: item.split as 'B_search' | 'B_dev' | 'B_test' }),
    ...(item.metric === undefined ? {} : { metric: text(item.metric, 'experiment decision.metric') }),
    ...(item.candidate_score === undefined ? {} : { candidate_score: score(item.candidate_score, 'experiment decision.candidate_score') }),
    ...(item.baseline_score === undefined ? {} : { baseline_score: score(item.baseline_score, 'experiment decision.baseline_score') }),
  })
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label)
  if (!Number.isFinite(Date.parse(result))) corrupt(`${label} must be an ISO timestamp`)
  return result
}

function stage(value: unknown, label: string): ExperimentStage {
  if (typeof value !== 'string' || !(EXPERIMENT_STAGES as readonly string[]).includes(value)) {
    corrupt(`${label} is invalid`)
  }
  return value as ExperimentStage
}

function normalizeAttempt(value: unknown): ExperimentAttempt {
  const item = record(value, 'experiment attempt')
  exact(item, [
    'stage', 'attempt', 'status', 'rjob_name', 'request_path', 'result_path', 'created_at', 'updated_at',
  ], [
    'retry_classification', 'dry_run_path', 'prediction_path', 'submission_path', 'logs_path',
    'output_cleanup_path', 'failure_code', 'failure_message',
  ], 'experiment attempt')
  const attemptStage = stage(item.stage, 'experiment attempt.stage')
  const attemptNumber = integer(item.attempt, 'experiment attempt.attempt', 1)
  if (attemptNumber > 2) corrupt('experiment attempt exceeds the single infrastructure retry allowance')
  if (typeof item.status !== 'string' || !ATTEMPT_STATUSES.has(item.status as ExperimentAttemptStatus)) {
    corrupt('experiment attempt.status is invalid')
  }
  if (attemptNumber === 1 && item.retry_classification !== undefined) {
    corrupt('the first experiment attempt cannot have a retry classification')
  }
  if (attemptNumber === 2 && item.retry_classification !== 'infrastructure') {
    corrupt('the only allowed second attempt must be classified as infrastructure')
  }
  if ((item.failure_code === undefined) !== (item.failure_message === undefined)) {
    corrupt('experiment attempt failure_code and failure_message must be recorded together')
  }
  if (item.failure_code !== undefined) {
    if (item.status !== 'failed') corrupt('only a failed experiment attempt may record a failure')
    if (typeof item.failure_code !== 'string' || !ERROR_CODES.has(item.failure_code as ExperimentErrorCode)) {
      corrupt('experiment attempt.failure_code is invalid')
    }
  }
  return Object.freeze({
    stage: attemptStage,
    attempt: attemptNumber,
    status: item.status as ExperimentAttemptStatus,
    rjob_name: text(item.rjob_name, 'experiment attempt.rjob_name'),
    request_path: absolute(item.request_path, 'experiment attempt.request_path'),
    result_path: absolute(item.result_path, 'experiment attempt.result_path'),
    created_at: timestamp(item.created_at, 'experiment attempt.created_at'),
    updated_at: timestamp(item.updated_at, 'experiment attempt.updated_at'),
    ...(item.retry_classification === undefined ? {} : { retry_classification: 'infrastructure' as const }),
    ...(item.dry_run_path === undefined ? {} : { dry_run_path: absolute(item.dry_run_path, 'experiment attempt.dry_run_path') }),
    ...(item.prediction_path === undefined ? {} : { prediction_path: absolute(item.prediction_path, 'experiment attempt.prediction_path') }),
    ...(item.submission_path === undefined ? {} : { submission_path: absolute(item.submission_path, 'experiment attempt.submission_path') }),
    ...(item.logs_path === undefined ? {} : { logs_path: absolute(item.logs_path, 'experiment attempt.logs_path') }),
    ...(item.output_cleanup_path === undefined ? {} : {
      output_cleanup_path: absolute(item.output_cleanup_path, 'experiment attempt.output_cleanup_path'),
    }),
    ...(item.failure_code === undefined ? {} : {
      failure_code: item.failure_code as ExperimentErrorCode,
      failure_message: text(item.failure_message, 'experiment attempt.failure_message'),
    }),
  })
}

export function experimentRJobName(runIdInput: string, stageInput: ExperimentStage, attempt: number): string {
  const runId = validateExperimentId(runIdInput, 'run_id')
  const suffix = attempt === 1 ? '' : `-retry-${String(attempt)}`
  const prefix = 'autodata-stage4b-'
  const tail = `-${stageInput}${suffix}`
  const unabridged = `${prefix}${runId}${tail}`
  // RJob appends `-${task_name}` to form a Kubernetes label identifier. Keep
  // the job name at 57 chars so the longer `-train` suffix still fits in 63.
  const maxRJobNameLength = 57
  if (unabridged.length <= maxRJobNameLength) return unabridged
  const digest = createHash('sha256').update(runId).digest('hex').slice(0, 10)
  const retained = maxRJobNameLength - prefix.length - tail.length - digest.length - 1
  return `${prefix}${runId.slice(0, retained)}-${digest}${tail}`
}

export function createInitialExperimentState(input: {
  readonly contract_id: string
  readonly contract_sha256: string
  readonly profile_id: string
  readonly run_id: string
  readonly run_directory: string
  readonly staging_directory: string
  readonly now: string
  readonly candidate_id?: string
  readonly candidate_generation?: number
}): ExperimentState {
  return normalizeExperimentState({
    schema_version: EXPERIMENT_STATE_VERSION,
    contract_id: input.contract_id,
    contract_sha256: input.contract_sha256,
    profile_id: input.profile_id,
    run_id: input.run_id,
    status: 'queued',
    phase: 'initializing',
    run_directory: input.run_directory,
    staging_directory: input.staging_directory,
    created_at: input.now,
    updated_at: input.now,
    attempts: [],
    ...(input.candidate_id === undefined ? {} : {
      candidate_id: input.candidate_id,
      candidate_generation: input.candidate_generation,
    }),
  })
}

export function normalizeExperimentState(input: unknown): ExperimentState {
  const value = record(input, 'experiment state')
  exact(value, [
    'schema_version', 'contract_id', 'contract_sha256', 'profile_id', 'run_id', 'status', 'phase',
    'run_directory', 'staging_directory', 'created_at', 'updated_at', 'attempts',
  ], [
    'candidate_id', 'candidate_generation', 'train_result_path', 'eval_result_path', 'feedback_id',
    'evaluation_report_id', 'decision_path', 'decision', 'failure',
  ], 'experiment state')
  if (value.schema_version !== EXPERIMENT_STATE_VERSION) corrupt('unsupported experiment state schema')
  const profileId = validateExperimentId(value.profile_id, 'profile_id')
  const runId = validateExperimentId(value.run_id, 'run_id')
  if (typeof value.status !== 'string' || !RUN_STATUSES.has(value.status)) corrupt('experiment state.status is invalid')
  if (typeof value.phase !== 'string' || ![
    'initializing', 'materialized', 'train', 'eval', 'registering', 'complete',
  ].includes(value.phase)) corrupt('experiment state.phase is invalid')
  if (!Array.isArray(value.attempts)) corrupt('experiment state.attempts must be an array')
  const attempts = value.attempts.map(normalizeAttempt)
  if ((value.candidate_id === undefined) !== (value.candidate_generation === undefined)) {
    corrupt('candidate_id and candidate_generation must be recorded together')
  }
  const candidateId = value.candidate_id === undefined
    ? undefined
    : validateExperimentId(value.candidate_id, 'candidate_id')
  const candidateGeneration = value.candidate_generation === undefined
    ? undefined
    : integer(value.candidate_generation, 'candidate_generation', 1)
  if (candidateGeneration !== undefined && candidateGeneration !== 1) {
    corrupt('the Stage 4C experiment supports only the first evolved generation')
  }
  if ((value.decision === undefined) !== (value.decision_path === undefined)) {
    corrupt('decision and decision_path must be recorded together')
  }
  if (value.decision !== undefined && candidateId === undefined) {
    corrupt('an H0 experiment cannot contain an acceptance decision')
  }
  const decision = value.decision === undefined
    ? undefined
    : normalizeDecision(value.decision, candidateId as string)
  for (const attemptStage of EXPERIMENT_STAGES) {
    const stageAttempts = attempts.filter(attempt => attempt.stage === attemptStage)
    if (stageAttempts.some((attempt, index) => attempt.attempt !== index + 1)) {
      corrupt(`${attemptStage} attempt numbers are not contiguous`)
    }
  }
  const order = attempts.map(attempt => attempt.stage)
  if (order.some((attemptStage, index) => attemptStage === 'train' && order.slice(0, index).includes('eval'))) {
    corrupt('training attempts cannot follow evaluation attempts')
  }
  const failure = value.failure === undefined ? undefined : (() => {
    const item = record(value.failure, 'experiment failure')
    exact(item, ['code', 'message'], ['stage', 'attempt'], 'experiment failure')
    if (typeof item.code !== 'string' || !ERROR_CODES.has(item.code as ExperimentErrorCode)) corrupt('experiment failure.code is invalid')
    return {
      code: item.code as ExperimentErrorCode,
      message: text(item.message, 'experiment failure.message'),
      ...(item.stage === undefined ? {} : { stage: stage(item.stage, 'experiment failure.stage') }),
      ...(item.attempt === undefined ? {} : { attempt: integer(item.attempt, 'experiment failure.attempt', 1) }),
    }
  })()
  const state: ExperimentState = {
    schema_version: EXPERIMENT_STATE_VERSION,
    contract_id: text(value.contract_id, 'experiment state.contract_id'),
    contract_sha256: text(value.contract_sha256, 'experiment state.contract_sha256'),
    profile_id: profileId,
    run_id: runId,
    status: value.status as ExperimentState['status'],
    phase: value.phase as ExperimentState['phase'],
    run_directory: absolute(value.run_directory, 'experiment state.run_directory'),
    staging_directory: absolute(value.staging_directory, 'experiment state.staging_directory'),
    created_at: timestamp(value.created_at, 'experiment state.created_at'),
    updated_at: timestamp(value.updated_at, 'experiment state.updated_at'),
    attempts,
    ...(candidateId === undefined ? {} : { candidate_id: candidateId, candidate_generation: candidateGeneration as number }),
    ...(value.train_result_path === undefined ? {} : { train_result_path: absolute(value.train_result_path, 'experiment state.train_result_path') }),
    ...(value.eval_result_path === undefined ? {} : { eval_result_path: absolute(value.eval_result_path, 'experiment state.eval_result_path') }),
    ...(value.feedback_id === undefined ? {} : { feedback_id: validateExperimentId(value.feedback_id, 'feedback_id') }),
    ...(value.evaluation_report_id === undefined ? {} : { evaluation_report_id: validateExperimentId(value.evaluation_report_id, 'evaluation_report_id') }),
    ...(value.decision_path === undefined ? {} : {
      decision_path: absolute(value.decision_path, 'experiment state.decision_path'),
      decision: decision as AcceptanceDecision,
    }),
    ...(failure === undefined ? {} : { failure }),
  }
  if (state.phase === 'initializing' && (
    !['queued', 'failed', 'cancelled', 'recovery_required'].includes(state.status)
    || state.attempts.length !== 0
  )) {
    corrupt('an initializing experiment must not be running or contain attempts')
  }
  if (['eval', 'registering', 'complete'].includes(state.phase) && state.train_result_path === undefined) {
    corrupt(`${state.phase} experiment state is missing its training result`)
  }
  if (['registering', 'complete'].includes(state.phase) && state.eval_result_path === undefined) {
    corrupt(`${state.phase} experiment state is missing its evaluation result`)
  }
  if (state.status === 'succeeded' && state.phase !== 'complete') {
    corrupt('a succeeded experiment must be complete')
  }
  if (state.status === 'succeeded' && state.candidate_id === undefined && (
    state.feedback_id === undefined || state.evaluation_report_id === undefined
  )) corrupt('a succeeded H0 experiment must contain both durable baseline record identifiers')
  if (state.status === 'succeeded' && state.candidate_id !== undefined && (
    state.feedback_id !== undefined
    || state.evaluation_report_id === undefined
    || state.decision === undefined
    || state.decision_path === undefined
  )) corrupt('a succeeded H1 experiment must contain its durable evaluation decision and no current feedback id')
  return immutableJson(state) as unknown as ExperimentState
}

export function replaceExperimentAttempt(
  state: ExperimentState,
  attemptIndex: number,
  patch: Partial<ExperimentAttempt>,
  now: string,
): ExperimentState {
  const current = state.attempts[attemptIndex]
  if (current === undefined) corrupt('cannot update a missing experiment attempt')
  const attempts = state.attempts.map((attempt, index) => index === attemptIndex
    ? { ...attempt, ...patch, updated_at: now }
    : attempt)
  return normalizeExperimentState({ ...state, attempts, updated_at: now })
}

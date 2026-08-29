/** Pure Stage 4A state construction and strict durable-state validation. */

import { isAbsolute } from 'node:path'
import { immutableJson, isJsonObject } from '../core/json.js'
import { validateStage4AId } from './contracts.js'
import {
  STAGE4A_STATE_VERSION,
  Stage4AError,
  type Stage4AAttempt,
  type Stage4AAttemptStatus,
  type Stage4AFailure,
  type Stage4AStage,
  type Stage4AState,
} from './types.js'

const RUN_STATUSES = new Set(['queued', 'running', 'recovery_required', 'succeeded', 'failed', 'cancelled'])
const ATTEMPT_STATUSES = new Set([
  'prepared', 'dry_running', 'dry_passed', 'predict_running', 'predict_passed',
  'submitting', 'submitted', 'monitoring', 'succeeded', 'failed', 'cancelled',
  'recovery_required',
])
const PHASES = new Set(['initializing', 'materialized', 'train', 'eval', 'complete'])
const ERROR_CODES = new Set([
  'INVALID_REQUEST', 'RUN_EXISTS', 'RUN_NOT_FOUND', 'STATE_CORRUPT', 'ARTIFACT_EXISTS',
  'ARTIFACT_INVALID', 'PATH_ESCAPE', 'DEPENDENCY_UNAVAILABLE', 'DRY_RUN_FAILED',
  'UNSCHEDULABLE', 'SUBMIT_FAILED', 'REMOTE_FAILED', 'RECOVERY_REQUIRED',
  'CANCEL_FAILED', 'STORE_IO',
])

function corrupt(message: string): never {
  throw new Stage4AError(message, 'STATE_CORRUPT')
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) corrupt(`${label} must be an object`)
  return value
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const fields = new Set([...required, ...optional])
  const missing = required.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) corrupt(`${label} is missing field ${missing}`)
  const extra = Object.keys(value).find(field => !fields.has(field))
  if (extra !== undefined) corrupt(`${label} has unsupported field ${extra}`)
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupt(`${label} must be a non-empty string`)
  return value
}

function absolute(value: unknown, label: string): string {
  const path = string(value, label)
  if (!isAbsolute(path)) corrupt(`${label} must be absolute`)
  return path
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label)
  if (!Number.isFinite(Date.parse(result))) corrupt(`${label} must be an ISO timestamp`)
  return result
}

/** Stable Kubernetes-compatible remote identity; unlike JobId it survives process restart. */
export function stage4ARJobName(runId: string, stage: Stage4AStage): string {
  return `autodata-${validateStage4AId(runId, 'run_id')}-${stage}`
}

export function createInitialStage4AState(input: {
  readonly profile_id: string
  readonly run_id: string
  readonly run_directory: string
  readonly staging_directory: string
  readonly now: string
}): Stage4AState {
  return immutableJson({
    schema_version: STAGE4A_STATE_VERSION,
    profile_id: validateStage4AId(input.profile_id, 'profile_id'),
    run_id: validateStage4AId(input.run_id, 'run_id'),
    status: 'queued',
    phase: 'initializing',
    run_directory: input.run_directory,
    staging_directory: input.staging_directory,
    created_at: input.now,
    updated_at: input.now,
    attempts: [],
  }) as unknown as Stage4AState
}

/** Reject unknown fields and impossible durable combinations after restart. */
export function normalizeStage4AState(input: unknown): Stage4AState {
  const value = object(input, 'Stage 4A state')
  exact(value, [
    'schema_version', 'profile_id', 'run_id', 'status', 'phase', 'run_directory',
    'staging_directory', 'created_at', 'updated_at', 'attempts',
  ], ['train_result_path', 'eval_result_path', 'failure'], 'Stage 4A state')
  if (value.schema_version !== STAGE4A_STATE_VERSION) corrupt('unsupported Stage 4A state schema_version')
  const profileId = validateStage4AId(value.profile_id, 'profile_id')
  const runId = validateStage4AId(value.run_id, 'run_id')
  if (typeof value.status !== 'string' || !RUN_STATUSES.has(value.status)) corrupt('invalid Stage 4A run status')
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase)) corrupt('invalid Stage 4A phase')
  if (!Array.isArray(value.attempts)) corrupt('Stage 4A attempts must be an array')
  const stageCounts = new Map<Stage4AStage, number>([['train', 0], ['eval', 0]])
  const attempts = value.attempts.map((entry, index): Stage4AAttempt => {
    const attempt = object(entry, `Stage 4A attempts[${String(index)}]`)
    exact(attempt, [
      'stage', 'attempt', 'status', 'rjob_name', 'request_path', 'result_path',
      'created_at', 'updated_at',
    ], ['dry_run_path', 'prediction_path', 'submission_path', 'logs_path'], `Stage 4A attempts[${String(index)}]`)
    if (attempt.stage !== 'train' && attempt.stage !== 'eval') corrupt('invalid Stage 4A attempt stage')
    if (typeof attempt.attempt !== 'number' || !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) {
      corrupt('invalid Stage 4A attempt number')
    }
    const expectedNumber = (stageCounts.get(attempt.stage) ?? 0) + 1
    if (attempt.attempt !== expectedNumber) corrupt('Stage 4A attempt numbers must be contiguous per stage')
    stageCounts.set(attempt.stage, expectedNumber)
    if (typeof attempt.status !== 'string' || !ATTEMPT_STATUSES.has(attempt.status)) corrupt('invalid Stage 4A attempt status')
    if (attempt.rjob_name !== stage4ARJobName(runId, attempt.stage)) corrupt('Stage 4A attempt has a mismatched RJob name')
    const optionalPath = (key: 'dry_run_path' | 'prediction_path' | 'submission_path' | 'logs_path'): string | undefined => {
      const path = attempt[key]
      return path === undefined ? undefined : absolute(path, `Stage 4A attempt.${key}`)
    }
    const dryRunPath = optionalPath('dry_run_path')
    const predictionPath = optionalPath('prediction_path')
    const submissionPath = optionalPath('submission_path')
    const logsPath = optionalPath('logs_path')
    return {
      stage: attempt.stage,
      attempt: attempt.attempt,
      status: attempt.status as Stage4AAttemptStatus,
      rjob_name: attempt.rjob_name,
      request_path: absolute(attempt.request_path, 'Stage 4A attempt.request_path'),
      result_path: absolute(attempt.result_path, 'Stage 4A attempt.result_path'),
      created_at: timestamp(attempt.created_at, 'Stage 4A attempt.created_at'),
      updated_at: timestamp(attempt.updated_at, 'Stage 4A attempt.updated_at'),
      ...(dryRunPath === undefined ? {} : { dry_run_path: dryRunPath }),
      ...(predictionPath === undefined ? {} : { prediction_path: predictionPath }),
      ...(submissionPath === undefined ? {} : { submission_path: submissionPath }),
      ...(logsPath === undefined ? {} : { logs_path: logsPath }),
    }
  })
  let failure: Stage4AFailure | undefined
  if (value.failure !== undefined) {
    const item = object(value.failure, 'Stage 4A failure')
    exact(item, ['code', 'message'], ['stage', 'attempt'], 'Stage 4A failure')
    if (typeof item.code !== 'string' || !ERROR_CODES.has(item.code)) corrupt('invalid Stage 4A failure code')
    if (item.stage !== undefined && item.stage !== 'train' && item.stage !== 'eval') corrupt('invalid Stage 4A failure stage')
    if (item.attempt !== undefined && (typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1)) {
      corrupt('invalid Stage 4A failure attempt')
    }
    failure = {
      code: item.code as Stage4AFailure['code'],
      message: string(item.message, 'Stage 4A failure.message'),
      ...(item.stage === undefined ? {} : { stage: item.stage }),
      ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
    }
  }
  const state: Stage4AState = {
    schema_version: STAGE4A_STATE_VERSION,
    profile_id: profileId,
    run_id: runId,
    status: value.status as Stage4AState['status'],
    phase: value.phase as Stage4AState['phase'],
    run_directory: absolute(value.run_directory, 'Stage 4A state.run_directory'),
    staging_directory: absolute(value.staging_directory, 'Stage 4A state.staging_directory'),
    created_at: timestamp(value.created_at, 'Stage 4A state.created_at'),
    updated_at: timestamp(value.updated_at, 'Stage 4A state.updated_at'),
    attempts,
    ...(value.train_result_path === undefined ? {} : { train_result_path: absolute(value.train_result_path, 'Stage 4A state.train_result_path') }),
    ...(value.eval_result_path === undefined ? {} : { eval_result_path: absolute(value.eval_result_path, 'Stage 4A state.eval_result_path') }),
    ...(failure === undefined ? {} : { failure }),
  }
  if (state.phase === 'initializing' && (state.status !== 'queued' || state.attempts.length !== 0)) {
    corrupt('an initializing Stage 4A run must be queued without attempts')
  }
  if (state.status === 'succeeded' && (state.phase !== 'complete' || state.train_result_path === undefined || state.eval_result_path === undefined)) {
    corrupt('a succeeded Stage 4A run must contain both results')
  }
  return immutableJson(state) as unknown as Stage4AState
}

export function replaceStage4AAttempt(
  state: Stage4AState,
  attemptIndex: number,
  patch: Partial<Stage4AAttempt>,
  now: string,
): Stage4AState {
  const current = state.attempts[attemptIndex]
  if (current === undefined) corrupt('cannot update a missing Stage 4A attempt')
  const attempts = state.attempts.map((attempt, index) => index === attemptIndex
    ? { ...attempt, ...patch, updated_at: now }
    : attempt)
  return normalizeStage4AState({ ...state, attempts, updated_at: now })
}

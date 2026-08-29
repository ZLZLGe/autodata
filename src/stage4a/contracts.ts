/** Strict construction and validation for the four Stage 4A wire contracts. */

import { canonicalJson, immutableJson, isJsonObject } from '../core/json.js'
import type { DataRunResult } from '../core/types.js'
import {
  STAGE4A_BFCL_CASES,
  STAGE4A_EVAL_REQUEST_VERSION,
  STAGE4A_EVAL_RESULT_VERSION,
  STAGE4A_EXPECTED_PARAMETERS,
  STAGE4A_MODEL_ID,
  STAGE4A_MODEL_PATH,
  STAGE4A_MODEL_REVISION,
  STAGE4A_TOOL_CALL_PARSER,
  STAGE4A_TRAIN_REQUEST_VERSION,
  STAGE4A_TRAIN_RESULT_VERSION,
  STAGE4A_VLLM_VERSION,
  Stage4AError,
  type Stage4AEvalCaseResult,
  type Stage4AEvalRequest,
  type Stage4AEvalResult,
  type Stage4AMaterializedData,
  type Stage4AStartRequest,
  type Stage4ATrainRequest,
  type Stage4ATrainResult,
} from './types.js'

const ID_PATTERN = /^[a-z][a-z0-9-]*$/u
const MAX_ID_LENGTH = 48

function invalid(message: string): never {
  throw new Stage4AError(message, 'ARTIFACT_INVALID')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) invalid(`${label} must be an object`)
  return value
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const expected = new Set(fields)
  const missing = fields.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) invalid(`${label} is missing field ${missing}`)
  const extra = Object.keys(value).find(field => !expected.has(field))
  if (extra !== undefined) invalid(`${label} has unsupported field ${extra}`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a non-empty string`)
  return value
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${label} must be a safe integer >= ${String(minimum)}`)
  }
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`)
  return value
}

function literal<T extends string | number>(value: unknown, expected: T, label: string): T {
  if (value !== expected) invalid(`${label} must equal ${JSON.stringify(expected)}`)
  return expected
}

/** Validate an identifier before it can become a path or RJob name component. */
export function validateStage4AId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    throw new Stage4AError(
      `${label} must match ${String(ID_PATTERN)} and contain at most ${String(MAX_ID_LENGTH)} characters`,
      'INVALID_REQUEST',
    )
  }
  return value
}

/** Validate the Host start boundary without retaining caller-owned containers. */
export function normalizeStage4AStartRequest(input: unknown): Stage4AStartRequest {
  if (!isJsonObject(input)) throw new Stage4AError('Stage 4A start request must be an object', 'INVALID_REQUEST')
  const allowed = new Set(['profile_id', 'run_id', 'data_run'])
  const missing = [...allowed].find(field => !Object.hasOwn(input, field))
  if (missing !== undefined) throw new Stage4AError(`Stage 4A start request is missing field ${missing}`, 'INVALID_REQUEST')
  const extra = Object.keys(input).find(field => !allowed.has(field))
  if (extra !== undefined) throw new Stage4AError(`Stage 4A start request has unsupported field ${extra}`, 'INVALID_REQUEST')
  return Object.freeze({
    profile_id: validateStage4AId(input.profile_id, 'profile_id'),
    run_id: validateStage4AId(input.run_id, 'run_id'),
    data_run: input.data_run as unknown as DataRunResult,
  })
}

function validateAbsolutePath(value: unknown, label: string): string {
  const path = text(value, label)
  if (!path.startsWith('/')) invalid(`${label} must be an absolute path`)
  return path
}

/** Construct the only supported two-step full-parameter training request. */
export function createStage4ATrainRequest(input: {
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly materialized: Stage4AMaterializedData
  readonly output_root: string
}): Stage4ATrainRequest {
  const request: Stage4ATrainRequest = {
    schema_version: STAGE4A_TRAIN_REQUEST_VERSION,
    profile_id: validateStage4AId(input.profile_id, 'profile_id'),
    run_id: validateStage4AId(input.run_id, 'run_id'),
    attempt: integer(input.attempt, 'attempt', 1),
    input: validateStage4AMaterializedData(input.materialized),
    output: {
      root: validateAbsolutePath(input.output_root, 'training output root'),
      result_json: `${validateAbsolutePath(input.output_root, 'training output root')}/result.json`,
      checkpoint_dir: `${validateAbsolutePath(input.output_root, 'training output root')}/train/checkpoint-2`,
    },
    model: { id: STAGE4A_MODEL_ID, revision: STAGE4A_MODEL_REVISION, path: STAGE4A_MODEL_PATH },
    recipe: {
      gpus: 4,
      gpu_family: 'H200',
      max_steps: 2,
      tuner_type: 'full',
      precision: 'bf16',
      optimizer: 'adafactor',
      deepspeed: 'zero3',
      expected_parameters: STAGE4A_EXPECTED_PARAMETERS,
    },
  }
  return immutableJson(request) as unknown as Stage4ATrainRequest
}

/** Strictly validate a persisted training request. */
export function normalizeStage4ATrainRequest(input: unknown): Stage4ATrainRequest {
  const value = record(input, 'training request')
  exact(value, ['schema_version', 'profile_id', 'run_id', 'attempt', 'input', 'output', 'model', 'recipe'], 'training request')
  literal(value.schema_version, STAGE4A_TRAIN_REQUEST_VERSION, 'training request.schema_version')
  const materialized = validateStage4AMaterializedData(value.input)
  const output = record(value.output, 'training request.output')
  exact(output, ['root', 'result_json', 'checkpoint_dir'], 'training request.output')
  const root = validateAbsolutePath(output.root, 'training request.output.root')
  const expected = createStage4ATrainRequest({
    profile_id: validateStage4AId(value.profile_id, 'profile_id'),
    run_id: validateStage4AId(value.run_id, 'run_id'),
    attempt: integer(value.attempt, 'attempt', 1),
    materialized,
    output_root: root,
  })
  if (canonicalJson(value) !== canonicalJson(expected)) invalid('training request differs from the frozen Stage 4A contract')
  return expected
}

/** Construct the only supported one-H200 five-case evaluation request. */
export function createStage4AEvalRequest(input: {
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly checkpoint_path: string
  readonly output_root: string
}): Stage4AEvalRequest {
  const request: Stage4AEvalRequest = {
    schema_version: STAGE4A_EVAL_REQUEST_VERSION,
    profile_id: validateStage4AId(input.profile_id, 'profile_id'),
    run_id: validateStage4AId(input.run_id, 'run_id'),
    attempt: integer(input.attempt, 'attempt', 1),
    checkpoint_path: validateAbsolutePath(input.checkpoint_path, 'evaluation checkpoint path'),
    output: {
      root: validateAbsolutePath(input.output_root, 'evaluation output root'),
      result_json: `${validateAbsolutePath(input.output_root, 'evaluation output root')}/result.json`,
    },
    runtime: {
      gpus: 1,
      gpu_family: 'H200',
      model_id: STAGE4A_MODEL_ID,
      model_revision: STAGE4A_MODEL_REVISION,
      vllm_version: STAGE4A_VLLM_VERSION,
      tool_call_parser: STAGE4A_TOOL_CALL_PARSER,
    },
    case_ids: STAGE4A_BFCL_CASES,
  }
  return immutableJson(request) as unknown as Stage4AEvalRequest
}

/** Strictly validate a persisted evaluation request. */
export function normalizeStage4AEvalRequest(input: unknown): Stage4AEvalRequest {
  const value = record(input, 'evaluation request')
  exact(value, ['schema_version', 'profile_id', 'run_id', 'attempt', 'checkpoint_path', 'output', 'runtime', 'case_ids'], 'evaluation request')
  literal(value.schema_version, STAGE4A_EVAL_REQUEST_VERSION, 'evaluation request.schema_version')
  const output = record(value.output, 'evaluation request.output')
  exact(output, ['root', 'result_json'], 'evaluation request.output')
  const expected = createStage4AEvalRequest({
    profile_id: validateStage4AId(value.profile_id, 'profile_id'),
    run_id: validateStage4AId(value.run_id, 'run_id'),
    attempt: integer(value.attempt, 'attempt', 1),
    checkpoint_path: validateAbsolutePath(value.checkpoint_path, 'evaluation request.checkpoint_path'),
    output_root: validateAbsolutePath(output.root, 'evaluation request.output.root'),
  })
  if (canonicalJson(value) !== canonicalJson(expected)) invalid('evaluation request differs from the frozen Stage 4A contract')
  return expected
}

/** Parse a worker training result and enforce every compatibility assertion. */
export function normalizeStage4ATrainResult(
  input: unknown,
  expected: Pick<Stage4ATrainRequest, 'profile_id' | 'run_id' | 'attempt'> & {
    readonly checkpoint_path: string
  },
): Stage4ATrainResult {
  const value = record(input, 'training result')
  exact(value, ['schema_version', 'profile_id', 'run_id', 'attempt', 'status', 'checkpoint_path', 'checks', 'failure'], 'training result')
  literal(value.schema_version, STAGE4A_TRAIN_RESULT_VERSION, 'training result.schema_version')
  literal(value.profile_id, expected.profile_id, 'training result.profile_id')
  literal(value.run_id, expected.run_id, 'training result.run_id')
  literal(value.attempt, expected.attempt, 'training result.attempt')
  const status = text(value.status, 'training result.status')
  if (status !== 'passed' && status !== 'failed') invalid('training result.status must be passed or failed')
  literal(value.checkpoint_path, expected.checkpoint_path, 'training result.checkpoint_path')
  const checks = record(value.checks, 'training result.checks')
  exact(checks, [
    'gpu_count', 'gpu_family', 'model_revision', 'trainable_parameters', 'total_parameters',
    'global_step', 'finite_metrics', 'huggingface_weight_shards', 'zero_optimizer_shards',
    'zero_model_state_shards', 'fresh_process_reload', 'weights_changed',
  ], 'training result.checks')
  const result: Stage4ATrainResult = {
    schema_version: STAGE4A_TRAIN_RESULT_VERSION,
    profile_id: expected.profile_id,
    run_id: expected.run_id,
    attempt: expected.attempt,
    status,
    checkpoint_path: expected.checkpoint_path,
    checks: {
      gpu_count: integer(checks.gpu_count, 'training result.checks.gpu_count'),
      gpu_family: text(checks.gpu_family, 'training result.checks.gpu_family'),
      model_revision: text(checks.model_revision, 'training result.checks.model_revision'),
      trainable_parameters: integer(checks.trainable_parameters, 'training result.checks.trainable_parameters'),
      total_parameters: integer(checks.total_parameters, 'training result.checks.total_parameters'),
      global_step: integer(checks.global_step, 'training result.checks.global_step'),
      finite_metrics: boolean(checks.finite_metrics, 'training result.checks.finite_metrics'),
      huggingface_weight_shards: integer(checks.huggingface_weight_shards, 'training result.checks.huggingface_weight_shards'),
      zero_optimizer_shards: integer(checks.zero_optimizer_shards, 'training result.checks.zero_optimizer_shards'),
      zero_model_state_shards: integer(checks.zero_model_state_shards, 'training result.checks.zero_model_state_shards'),
      fresh_process_reload: boolean(checks.fresh_process_reload, 'training result.checks.fresh_process_reload'),
      weights_changed: boolean(checks.weights_changed, 'training result.checks.weights_changed'),
    },
    failure: value.failure === null ? null : text(value.failure, 'training result.failure'),
  }
  if (result.status !== 'passed') invalid(`training worker reported failure: ${result.failure ?? 'unspecified failure'}`)
  const required = result.checks
  if (
    required.gpu_count !== 4
    || required.gpu_family !== 'NVIDIA H200'
    || required.model_revision !== STAGE4A_MODEL_REVISION
    || required.trainable_parameters !== STAGE4A_EXPECTED_PARAMETERS
    || required.total_parameters !== STAGE4A_EXPECTED_PARAMETERS
    || required.global_step !== 2
    || !required.finite_metrics
    || required.huggingface_weight_shards !== 4
    || required.zero_optimizer_shards !== 4
    || required.zero_model_state_shards !== 4
    || !required.fresh_process_reload
    || !required.weights_changed
    || result.failure !== null
  ) invalid('training result did not satisfy the frozen Stage 4A gate')
  return immutableJson(result) as unknown as Stage4ATrainResult
}

/** Parse a worker evaluation result and enforce the frozen five-case gate. */
export function normalizeStage4AEvalResult(
  input: unknown,
  expected: Pick<Stage4AEvalRequest, 'profile_id' | 'run_id' | 'attempt'>,
): Stage4AEvalResult {
  const value = record(input, 'evaluation result')
  exact(value, ['schema_version', 'profile_id', 'run_id', 'attempt', 'status', 'checks', 'cases', 'failure'], 'evaluation result')
  literal(value.schema_version, STAGE4A_EVAL_RESULT_VERSION, 'evaluation result.schema_version')
  literal(value.profile_id, expected.profile_id, 'evaluation result.profile_id')
  literal(value.run_id, expected.run_id, 'evaluation result.run_id')
  literal(value.attempt, expected.attempt, 'evaluation result.attempt')
  const status = text(value.status, 'evaluation result.status')
  if (status !== 'passed' && status !== 'failed') invalid('evaluation result.status must be passed or failed')
  const checks = record(value.checks, 'evaluation result.checks')
  exact(checks, [
    'gpu_count', 'gpu_family', 'model_revision', 'vllm_version', 'tool_call_parser',
    'loaded_weight_shards',
  ], 'evaluation result.checks')
  if (!Array.isArray(value.cases)) invalid('evaluation result.cases must be an array')
  const cases = value.cases.map((entry, index): Stage4AEvalCaseResult => {
    const item = record(entry, `evaluation result.cases[${String(index)}]`)
    exact(item, ['case_id', 'passed'], `evaluation result.cases[${String(index)}]`)
    const caseId = text(item.case_id, `evaluation result.cases[${String(index)}].case_id`)
    if (!(STAGE4A_BFCL_CASES as readonly string[]).includes(caseId)) invalid(`unsupported BFCL case ${caseId}`)
    return { case_id: caseId as Stage4AEvalCaseResult['case_id'], passed: boolean(item.passed, `evaluation result.cases[${String(index)}].passed`) }
  })
  const result: Stage4AEvalResult = {
    schema_version: STAGE4A_EVAL_RESULT_VERSION,
    profile_id: expected.profile_id,
    run_id: expected.run_id,
    attempt: expected.attempt,
    status,
    checks: {
      gpu_count: integer(checks.gpu_count, 'evaluation result.checks.gpu_count'),
      gpu_family: text(checks.gpu_family, 'evaluation result.checks.gpu_family'),
      model_revision: text(checks.model_revision, 'evaluation result.checks.model_revision'),
      vllm_version: text(checks.vllm_version, 'evaluation result.checks.vllm_version'),
      tool_call_parser: text(checks.tool_call_parser, 'evaluation result.checks.tool_call_parser'),
      loaded_weight_shards: integer(checks.loaded_weight_shards, 'evaluation result.checks.loaded_weight_shards'),
    },
    cases,
    failure: value.failure === null ? null : text(value.failure, 'evaluation result.failure'),
  }
  const ids = cases.map(item => item.case_id)
  if (
    result.status !== 'passed'
    || result.checks.gpu_count !== 1
    || result.checks.gpu_family !== 'NVIDIA H200'
    || result.checks.model_revision !== STAGE4A_MODEL_REVISION
    || result.checks.vllm_version !== STAGE4A_VLLM_VERSION
    || result.checks.tool_call_parser !== STAGE4A_TOOL_CALL_PARSER
    || result.checks.loaded_weight_shards !== 4
    || ids.length !== STAGE4A_BFCL_CASES.length
    || ids.some((id, index) => id !== STAGE4A_BFCL_CASES[index])
    || cases.some(item => !item.passed)
    || result.failure !== null
  ) invalid('evaluation result did not satisfy the frozen Stage 4A gate')
  return immutableJson(result) as unknown as Stage4AEvalResult
}

/** Shared strict path validation for request readers and tests. */
export function validateStage4AMaterializedData(value: unknown): Stage4AMaterializedData {
  const input = record(value, 'materialized input')
  exact(input, ['canonical_jsonl', 'logical_view_jsonl', 'run_summary_json'], 'materialized input')
  return Object.freeze({
    canonical_jsonl: validateAbsolutePath(input.canonical_jsonl, 'materialized input.canonical_jsonl'),
    logical_view_jsonl: validateAbsolutePath(input.logical_view_jsonl, 'materialized input.logical_view_jsonl'),
    run_summary_json: validateAbsolutePath(input.run_summary_json, 'materialized input.run_summary_json'),
  })
}

/** Host-only contracts for the Stage 4A GPU compatibility gate. */

import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { DataRunResult, JsonObject } from '../core/types.js'

export const STAGE4A_TRAIN_REQUEST_VERSION = 'autodata-stage4a-train-request-1'
export const STAGE4A_TRAIN_RESULT_VERSION = 'autodata-stage4a-train-result-1'
export const STAGE4A_EVAL_REQUEST_VERSION = 'autodata-stage4a-eval-request-1'
export const STAGE4A_EVAL_RESULT_VERSION = 'autodata-stage4a-eval-result-1'
export const STAGE4A_STATE_VERSION = 'autodata-stage4a-state-1'

export const STAGE4A_MODEL_ID = 'Qwen/Qwen3.5-9B'
export const STAGE4A_MODEL_REVISION = 'c202236235762e1c871ad0ccb60c8ee5ba337b9a'
export const STAGE4A_MODEL_PATH = `/mnt/shared-storage-gpfs2/gpfs2-shared-public/huggingface/hub/models--Qwen--Qwen3.5-9B/snapshots/${STAGE4A_MODEL_REVISION}`
export const STAGE4A_CONTAINER_IMAGE = 'registry.h.pjlab.org.cn/ailab/pytorch2.7.0-cuda12.8-cudnn9:v5'
export const STAGE4A_EXPECTED_PARAMETERS = 9_409_813_744
export const STAGE4A_VLLM_VERSION = '0.19.1'
export const STAGE4A_TOOL_CALL_PARSER = 'qwen3_coder'
export const STAGE4A_BFCL_CASES = Object.freeze([
  'simple_python_116',
  'multiple_132',
  'parallel_115',
  'parallel_multiple_177',
  'irrelevance_194',
] as const)

export type Stage4AStage = 'train' | 'eval'
export type Stage4ARunStatus =
  | 'queued'
  | 'running'
  | 'recovery_required'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export type Stage4AAttemptStatus =
  | 'prepared'
  | 'dry_running'
  | 'dry_passed'
  | 'predict_running'
  | 'predict_passed'
  | 'submitting'
  | 'submitted'
  | 'monitoring'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'recovery_required'

export interface Stage4AStartRequest {
  readonly profile_id: string
  readonly run_id: string
  readonly data_run: DataRunResult
}

export interface Stage4AMaterializedData {
  readonly canonical_jsonl: string
  readonly logical_view_jsonl: string
  readonly run_summary_json: string
}

export interface Stage4ATrainRequest {
  readonly schema_version: typeof STAGE4A_TRAIN_REQUEST_VERSION
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly input: Stage4AMaterializedData
  readonly output: {
    readonly root: string
    readonly result_json: string
    readonly checkpoint_dir: string
  }
  readonly model: {
    readonly id: typeof STAGE4A_MODEL_ID
    readonly revision: typeof STAGE4A_MODEL_REVISION
    readonly path: typeof STAGE4A_MODEL_PATH
  }
  readonly recipe: {
    readonly gpus: 4
    readonly gpu_family: 'H200'
    readonly max_steps: 2
    readonly tuner_type: 'full'
    readonly precision: 'bf16'
    readonly optimizer: 'adafactor'
    readonly deepspeed: 'zero3'
    readonly expected_parameters: typeof STAGE4A_EXPECTED_PARAMETERS
  }
}

export interface Stage4ATrainResult {
  readonly schema_version: typeof STAGE4A_TRAIN_RESULT_VERSION
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly status: 'passed' | 'failed'
  readonly checkpoint_path: string
  readonly checks: {
    readonly gpu_count: number
    readonly gpu_family: string
    readonly model_revision: string
    readonly trainable_parameters: number
    readonly total_parameters: number
    readonly global_step: number
    readonly finite_metrics: boolean
    readonly huggingface_weight_shards: number
    readonly zero_optimizer_shards: number
    readonly zero_model_state_shards: number
    readonly fresh_process_reload: boolean
    readonly weights_changed: boolean
  }
  readonly failure: string | null
}

export interface Stage4AEvalRequest {
  readonly schema_version: typeof STAGE4A_EVAL_REQUEST_VERSION
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly checkpoint_path: string
  readonly output: {
    readonly root: string
    readonly result_json: string
  }
  readonly runtime: {
    readonly gpus: 1
    readonly gpu_family: 'H200'
    readonly model_id: typeof STAGE4A_MODEL_ID
    readonly model_revision: typeof STAGE4A_MODEL_REVISION
    readonly vllm_version: typeof STAGE4A_VLLM_VERSION
    readonly tool_call_parser: typeof STAGE4A_TOOL_CALL_PARSER
  }
  readonly case_ids: typeof STAGE4A_BFCL_CASES
}

export interface Stage4AEvalCaseResult {
  readonly case_id: typeof STAGE4A_BFCL_CASES[number]
  readonly passed: boolean
}

export interface Stage4AEvalResult {
  readonly schema_version: typeof STAGE4A_EVAL_RESULT_VERSION
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly status: 'passed' | 'failed'
  readonly checks: {
    readonly gpu_count: number
    readonly gpu_family: string
    readonly model_revision: string
    readonly vllm_version: string
    readonly tool_call_parser: string
    readonly loaded_weight_shards: number
  }
  readonly cases: readonly Stage4AEvalCaseResult[]
  readonly failure: string | null
}

export interface Stage4AAttempt {
  readonly stage: Stage4AStage
  readonly attempt: number
  readonly status: Stage4AAttemptStatus
  readonly rjob_name: string
  readonly request_path: string
  readonly result_path: string
  readonly created_at: string
  readonly updated_at: string
  readonly dry_run_path?: string
  readonly prediction_path?: string
  readonly submission_path?: string
  readonly logs_path?: string
}

export interface Stage4AFailure {
  readonly code: Stage4AErrorCode
  readonly message: string
  readonly stage?: Stage4AStage
  readonly attempt?: number
}

export interface Stage4AState {
  readonly schema_version: typeof STAGE4A_STATE_VERSION
  readonly profile_id: string
  readonly run_id: string
  readonly status: Stage4ARunStatus
  readonly phase: 'initializing' | 'materialized' | Stage4AStage | 'complete'
  readonly run_directory: string
  readonly staging_directory: string
  readonly created_at: string
  readonly updated_at: string
  readonly attempts: readonly Stage4AAttempt[]
  readonly train_result_path?: string
  readonly eval_result_path?: string
  readonly failure?: Stage4AFailure
}

export interface Stage4AStatus {
  readonly state: Stage4AState
  /** Process-local convenience only. It is deliberately never written to state.json. */
  readonly job_id?: JobId
}

export interface Stage4ACommandResult {
  readonly argv: readonly string[]
  readonly exit_code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export interface Stage4ARJobSpec {
  readonly stage: Stage4AStage
  readonly rjob_name: string
  readonly staging_directory: string
  readonly script_path: string
  readonly request_path: string
  /** Optional generic experiment overrides; Stage 4A always uses the defaults. */
  readonly request_environment?: string
  readonly resources?: {
    readonly gpu: number
    readonly cpu: number
    readonly memory_mib: number
  }
  readonly container_image?: string
  /** Kubernetes-level task retries. The H-cluster requires a positive value. */
  readonly backoff_limit?: number
}

export type Stage4ARemoteStatus = 'missing' | 'pending' | 'running' | 'succeeded' | 'failed' | 'stopped'

export interface Stage4ARJobObservation {
  readonly status: Stage4ARemoteStatus
  readonly command: Stage4ACommandResult
}

export interface Stage4ARJobBackend {
  dryRun(spec: Stage4ARJobSpec, signal: AbortSignal): Promise<Stage4ACommandResult>
  predict(spec: Stage4ARJobSpec, signal: AbortSignal): Promise<Stage4ACommandResult>
  submit(spec: Stage4ARJobSpec, signal: AbortSignal): Promise<Stage4ACommandResult>
  inspect(rjobName: string, signal: AbortSignal): Promise<Stage4ARJobObservation>
  logs(rjobName: string, signal: AbortSignal): Promise<Stage4ACommandResult>
  stop(rjobName: string): Promise<Stage4ACommandResult>
}

export interface Stage4AJobHooks {
  readonly done: Promise<JobOutcome>
  cancel(reason?: string): void
  readOutput?(): string
}

export interface Stage4AJobRegistry {
  start(spec: {
    readonly kind: 'autodata-stage4a'
    readonly label: string
    readonly outputLimitBytes?: number
    readonly run: () => Stage4AJobHooks
  }): JobId
  get(id: JobId): { readonly status: string }
  kill(id: JobId, caller?: undefined, reason?: string): 'requested' | 'already-finished'
  attachController(name: string): () => void
}

export interface Stage4AControllerOptions {
  readonly run_root?: string
  readonly staging_root?: string
  readonly asset_root?: string
  readonly poll_interval_ms?: number
  readonly backend?: Stage4ARJobBackend
  readonly jobs?: Stage4AJobRegistry
  readonly now?: () => Date
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly profile_exists?: (profileId: string) => boolean
}

export type Stage4AErrorCode =
  | 'INVALID_REQUEST'
  | 'RUN_EXISTS'
  | 'RUN_NOT_FOUND'
  | 'STATE_CORRUPT'
  | 'ARTIFACT_EXISTS'
  | 'ARTIFACT_INVALID'
  | 'PATH_ESCAPE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'DRY_RUN_FAILED'
  | 'UNSCHEDULABLE'
  | 'SUBMIT_FAILED'
  | 'REMOTE_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'CANCEL_FAILED'
  | 'STORE_IO'

export class Stage4AError extends Error {
  readonly code: Stage4AErrorCode
  readonly profile_id?: string
  readonly run_id?: string
  readonly stage?: Stage4AStage
  readonly details?: JsonObject

  constructor(
    message: string,
    code: Stage4AErrorCode,
    options: {
      readonly profile_id?: string
      readonly run_id?: string
      readonly stage?: Stage4AStage
      readonly details?: JsonObject
      readonly cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'Stage4AError'
    this.code = code
    if (options.profile_id !== undefined) this.profile_id = options.profile_id
    if (options.run_id !== undefined) this.run_id = options.run_id
    if (options.stage !== undefined) this.stage = options.stage
    if (options.details !== undefined) this.details = options.details
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'autodata-stage4a': 'autodata-stage4a'
  }
}

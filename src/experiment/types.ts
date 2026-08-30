/** Host-only contracts for reproducible train/evaluate experiments. */

import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { DataRunResult, JsonObject } from '../core/types.js'
import type { EvolutionController } from '../evolution/controller.js'
import type { EvolutionRuntimeAgent } from '../evolution/runtime.js'
import type { AcceptanceDecision } from '../evolution/types.js'
import type {
  Stage4ACommandResult,
  Stage4ARJobBackend,
} from '../stage4a/types.js'

export const EXPERIMENT_CONTRACT_VERSION = 'autodata-experiment-contract-1'
export const EXPERIMENT_STATE_VERSION = 'autodata-experiment-state-1'
export const EXPERIMENT_TRAIN_REQUEST_VERSION = 'autodata-experiment-train-request-1'
export const EXPERIMENT_TRAIN_RESULT_VERSION = 'autodata-experiment-train-result-1'
export const EXPERIMENT_EVAL_REQUEST_VERSION = 'autodata-experiment-eval-request-1'
export const EXPERIMENT_EVAL_RESULT_VERSION = 'autodata-experiment-eval-result-1'

export const EXPERIMENT_SPLITS = Object.freeze(['B_search', 'B_dev'] as const)
export type ExperimentSplit = typeof EXPERIMENT_SPLITS[number]
export const EXPERIMENT_STAGES = Object.freeze(['train', 'eval'] as const)
export type ExperimentStage = typeof EXPERIMENT_STAGES[number]

export interface ExperimentContract {
  readonly schema_version: typeof EXPERIMENT_CONTRACT_VERSION
  readonly contract_id: string
  /** Absent only for the byte-compatible Stage 4B H0 baseline contract. */
  readonly subject?: ExperimentCandidateSubject
  readonly profile: {
    readonly id: string
    readonly benchmark: string
    readonly metric: string
  }
  readonly data: {
    readonly dataset_id: string
    readonly dataset_subset: string
    readonly dataset_revision: string
    readonly harness_id: string
    readonly seed: number
    readonly canonical_records: number
    readonly logical_training_units: number
    readonly historical_training_tokens: number
    readonly canonical_jsonl_sha256: string
    readonly logical_view_jsonl_sha256: string
    readonly run_summary_json_sha256: string
  }
  readonly model: {
    readonly id: string
    readonly revision: string
    readonly path: string
    readonly thinking: false
    readonly expected_parameters: number
  }
  readonly execution: {
    readonly container_image: string
    readonly rjob_backoff_limit: 1
    readonly training_wheelhouse: ExperimentWheelhouse
    readonly vllm_wheelhouse: ExperimentWheelhouse
    readonly bfcl_wheelhouse: ExperimentWheelhouse
  }
  readonly training: {
    readonly gpus: 4
    readonly gpu_family: 'H200'
    readonly max_steps: number
    readonly max_length: number
    readonly per_device_train_batch_size: number
    readonly gradient_accumulation_steps: number
    readonly tuner_type: 'full'
    readonly precision: 'bf16'
    readonly optimizer: 'adafactor'
    readonly deepspeed: 'zero3'
    readonly packing: true
    readonly padding_free: true
    readonly gradient_checkpointing: true
    readonly use_hf: true
    readonly check_model: false
    readonly template: 'qwen3_5'
    readonly template_backend: 'swift'
    readonly enable_thinking: false
    readonly add_non_thinking_prefix: true
    readonly loss_scale: 'default'
    readonly is_binary_loss_scale: true
    readonly truncation_strategy: 'delete'
    readonly split_dataset_ratio: 0
    readonly dataset_num_proc: 4
    readonly load_from_cache_file: false
    readonly strict: true
    readonly freeze_llm: false
    readonly freeze_vit: false
    readonly freeze_aligner: false
    readonly torch_dtype: 'bfloat16'
    readonly bf16: true
    readonly attention_implementation: 'flash_attn'
    readonly packing_length: 8192
    readonly packing_num_proc: 1
    readonly packing_strategy: 'sequential'
    readonly learning_rate: 0.00001
    readonly lr_scheduler_type: 'cosine'
    readonly warmup_ratio: 0.05
    readonly weight_decay: 0.1
    readonly vit_gradient_checkpointing: true
    readonly save_strategy: 'steps'
    readonly save_steps: 16
    readonly save_total_limit: 1
    readonly save_only_model: false
    readonly logging_strategy: 'steps'
    readonly logging_steps: 1
    readonly logging_first_step: true
    readonly report_to: readonly ['none']
    readonly dataloader_num_workers: 0
    readonly seed: 42
    readonly data_seed: 42
    readonly add_version: false
  }
  readonly evaluation: {
    readonly gpus: 1
    readonly gpu_family: 'H200'
    readonly vllm_version: string
    readonly tool_call_parser: string
    readonly bfcl_version: '2026.3.23'
    readonly server: {
      readonly dtype: 'bfloat16'
      readonly tensor_parallel_size: 1
      readonly max_model_len: 8192
      readonly gpu_memory_utilization: 0.9
      readonly generation_config: 'vllm'
      readonly enable_auto_tool_choice: true
    }
    readonly generation: {
      readonly tool_choice: 'auto'
      readonly parallel_tool_calls: true
      readonly temperature: 0
      readonly top_p: 1
      readonly max_tokens: 2048
      readonly seed: 42
      readonly n: 1
      readonly stream: false
      readonly include_reasoning: false
      readonly enable_thinking: false
    }
    readonly checker: {
      readonly language: 'python'
      readonly model_config: 'qwen3-8b-FC'
      readonly underscore_to_dot: true
    }
    readonly categories: readonly string[]
    readonly cases_per_category_per_split: number
    readonly case_ids: Readonly<Record<ExperimentSplit, readonly string[]>>
    readonly macro: 'equal_category_accuracy'
  }
  readonly retry: {
    readonly scientific_retries: 0
    readonly infrastructure_retries_per_stage: 1
  }
}

/** Frozen identity of the validated strategy whose materialized view is trained. */
export interface ExperimentCandidateSubject {
  readonly candidate_id: string
  readonly generation: number
  readonly plugin_id: string
  readonly strategy_version: string
  readonly host_source_sha256: string
  readonly runtime_plan_sha256: string
  readonly materialization_sha256: string
}

export interface ExperimentWheelhouse {
  readonly path: string
  readonly manifest_sha256: string
}

export interface ExperimentStartRequest {
  readonly profile_id: string
  readonly run_id: string
  readonly data_run: DataRunResult
  /** Omit for H0. H1 is cross-checked against the durable Evolution Store. */
  readonly subject?: ExperimentCandidateSubject
}

export interface ExperimentMaterializedData {
  readonly canonical_jsonl: string
  readonly logical_view_jsonl: string
  readonly run_summary_json: string
}

export interface ExperimentTrainRequest {
  readonly schema_version: typeof EXPERIMENT_TRAIN_REQUEST_VERSION
  readonly contract_id: string
  readonly contract_sha256: string
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly input: ExperimentMaterializedData
  readonly output: {
    readonly root: string
    readonly result_json: string
    readonly checkpoint_dir: string
  }
  readonly model: ExperimentContract['model']
  readonly recipe: ExperimentContract['training']
}

export interface ExperimentTrainResult {
  readonly schema_version: typeof EXPERIMENT_TRAIN_RESULT_VERSION
  readonly contract_id: string
  readonly contract_sha256: string
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

export interface ExperimentEvalRequest {
  readonly schema_version: typeof EXPERIMENT_EVAL_REQUEST_VERSION
  readonly contract_id: string
  readonly contract_sha256: string
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly checkpoint_path: string
  readonly output: {
    readonly root: string
    readonly result_json: string
    readonly predictions_jsonl: string
  }
  readonly model: ExperimentContract['model']
  readonly runtime: {
    readonly gpus: 1
    readonly gpu_family: 'H200'
    readonly vllm_version: string
    readonly tool_call_parser: string
  }
  readonly benchmark: {
    readonly id: string
    readonly metric: string
    readonly categories: readonly string[]
    readonly case_ids: Readonly<Record<ExperimentSplit, readonly string[]>>
    readonly macro: 'equal_category_accuracy'
  }
}

export interface ExperimentEvalCaseResult {
  readonly case_id: string
  readonly split: ExperimentSplit
  readonly category: string
  readonly passed: boolean
  readonly failure_summary: string | null
}

export interface ExperimentEvalResult {
  readonly schema_version: typeof EXPERIMENT_EVAL_RESULT_VERSION
  readonly contract_id: string
  readonly contract_sha256: string
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly status: 'completed' | 'failed'
  readonly checks: {
    readonly gpu_count: number
    readonly gpu_family: string
    readonly model_revision: string
    readonly vllm_version: string
    readonly tool_call_parser: string
    readonly loaded_weight_shards: number
  }
  readonly cases: readonly ExperimentEvalCaseResult[]
  readonly category_scores: Readonly<Record<ExperimentSplit, Readonly<Record<string, number>>>>
  readonly macro_scores: Readonly<Record<ExperimentSplit, number>>
  readonly predictions_path: string
  readonly failure: string | null
}

export type ExperimentRunStatus =
  | 'queued'
  | 'running'
  | 'recovery_required'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type ExperimentAttemptStatus =
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

export interface ExperimentAttempt {
  readonly stage: ExperimentStage
  readonly attempt: number
  readonly status: ExperimentAttemptStatus
  readonly rjob_name: string
  readonly request_path: string
  readonly result_path: string
  readonly created_at: string
  readonly updated_at: string
  readonly retry_classification?: 'infrastructure'
  readonly dry_run_path?: string
  readonly prediction_path?: string
  readonly submission_path?: string
  readonly logs_path?: string
  readonly output_cleanup_path?: string
  readonly failure_code?: ExperimentErrorCode
  readonly failure_message?: string
}

export interface ExperimentFailure {
  readonly code: ExperimentErrorCode
  readonly message: string
  readonly stage?: ExperimentStage
  readonly attempt?: number
}

export interface ExperimentState {
  readonly schema_version: typeof EXPERIMENT_STATE_VERSION
  readonly contract_id: string
  readonly contract_sha256: string
  readonly profile_id: string
  readonly run_id: string
  readonly status: ExperimentRunStatus
  readonly phase: 'initializing' | 'materialized' | ExperimentStage | 'registering' | 'complete'
  readonly run_directory: string
  readonly staging_directory: string
  readonly created_at: string
  readonly updated_at: string
  readonly attempts: readonly ExperimentAttempt[]
  readonly candidate_id?: string
  readonly candidate_generation?: number
  readonly train_result_path?: string
  readonly eval_result_path?: string
  readonly feedback_id?: string
  readonly evaluation_report_id?: string
  readonly decision_path?: string
  readonly decision?: AcceptanceDecision
  readonly failure?: ExperimentFailure
}

export interface ExperimentStatus {
  readonly state: ExperimentState
  /** Process-local convenience only; never persisted. */
  readonly job_id?: JobId
}

export interface ExperimentJobHooks {
  readonly done: Promise<JobOutcome>
  cancel(reason?: string): void
  readOutput?(): string
}

export interface ExperimentJobRegistry {
  start(spec: {
    readonly kind: 'autodata-experiment'
    readonly label: string
    readonly outputLimitBytes?: number
    readonly run: () => ExperimentJobHooks
  }): JobId
  get(id: JobId): { readonly status: string }
  kill(id: JobId, caller?: undefined, reason?: string): 'requested' | 'already-finished'
  attachController(name: string): () => void
}

export interface ExperimentControllerOptions {
  readonly evolution: EvolutionController
  readonly run_root?: string
  readonly staging_root?: string
  readonly asset_root?: string
  readonly common_worker_root?: string
  readonly poll_interval_ms?: number
  readonly backend?: Stage4ARJobBackend
  readonly jobs?: ExperimentJobRegistry
  readonly now?: () => Date
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

/** Process-local runtime authority required only when an H1 might be accepted. */
export type ExperimentRuntimeAgent = EvolutionRuntimeAgent

export type ExperimentErrorCode =
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
  | 'WORKER_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'CANCEL_FAILED'
  | 'STORE_IO'
  | 'BASELINE_REGISTRATION_FAILED'
  | 'EVALUATION_REGISTRATION_FAILED'

export class ExperimentError extends Error {
  readonly code: ExperimentErrorCode
  readonly profile_id?: string
  readonly run_id?: string
  readonly stage?: ExperimentStage
  readonly details?: JsonObject

  constructor(
    message: string,
    code: ExperimentErrorCode,
    options: {
      readonly profile_id?: string
      readonly run_id?: string
      readonly stage?: ExperimentStage
      readonly details?: JsonObject
      readonly cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ExperimentError'
    this.code = code
    if (options.profile_id !== undefined) this.profile_id = options.profile_id
    if (options.run_id !== undefined) this.run_id = options.run_id
    if (options.stage !== undefined) this.stage = options.stage
    if (options.details !== undefined) this.details = options.details
  }
}

/** The experiment reuses the hardened Stage 4A RJob transport. */
export type ExperimentRJobBackend = Stage4ARJobBackend
export type ExperimentCommandResult = Stage4ACommandResult

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'autodata-experiment': 'autodata-experiment'
  }
}

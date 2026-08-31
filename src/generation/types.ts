/** Host-only contracts for the first real H1 generation workflow. */

import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { DataRunResult, JsonObject } from '../core/types.js'
import type { CandidateValidationResult } from '../evolution/validator.js'
import type { EvolutionRuntimeAgent } from '../evolution/runtime.js'
import type { ExperimentController } from '../experiment/controller.js'
import type { EvolutionController } from '../evolution/controller.js'
import type { CandidateValidator } from '../evolution/validator.js'

export const LEGACY_GENERATION_STATE_VERSION = 'autodata-generation-state-1'
export const GENERATION_STATE_VERSION = 'autodata-generation-state-2'
export const GENERATION_MATERIALIZATION_VERSION = 'autodata-generation-materialization-1'
export const GENERATION_MAX_DRAFTS = 3

export type GenerationRunStatus =
  | 'queued'
  | 'running'
  | 'recovery_required'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type GenerationPhase =
  | 'initialized'
  | 'proposing'
  | 'candidate_ready'
  | 'experiment'
  | 'deciding'
  | 'feedback'
  | 'complete'

export interface GenerationStartRequest {
  readonly profile_id: string
  readonly run_id: string
  readonly experiment_run_id: string
  /** Full Git commit containing the exact Host implementation used for this run. */
  readonly execution_commit: string
  /** Completed H0 experiment directory containing canonical and B_search artifacts. */
  readonly baseline_run_directory: string
  /** Checked-in B_search case bundle. B_dev/B_test paths are deliberately unsupported. */
  readonly b_search_cases_jsonl: string
  readonly candidate_id: string
  readonly strategy_version: string
  /** Per-run proposal budget. Omission preserves the historical three-draft behavior. */
  readonly max_proposal_drafts?: number
}

export type NormalizedGenerationStartRequest = Omit<GenerationStartRequest, 'max_proposal_drafts'> & {
  readonly max_proposal_drafts: number
}

export interface GenerationFailureContext {
  readonly case_id: string
  readonly category: string
  readonly prompt: unknown
  readonly functions: unknown
  readonly expected: unknown
  readonly observed: unknown
  readonly failure_summary: string
}

export interface GenerationDatasetRecordSummary {
  readonly record_id: string
  readonly user_excerpt: string
  readonly assistant_tool_names: readonly string[]
  readonly available_tool_names: readonly string[]
  readonly assistant_messages: number
  readonly no_tool_assistant_messages: number
}

/** The complete model-visible proposal context. It intentionally has no B_dev field. */
export interface GenerationProposalContext {
  readonly profile_id: string
  readonly benchmark: string
  readonly strategy_plugin_id: string
  readonly strategy_version: string
  readonly generation: number
  readonly seed: number
  readonly allowed_capabilities: readonly string[]
  readonly b_search: {
    readonly summary: string
    readonly metrics: Readonly<Record<string, number>>
    readonly failures: readonly GenerationFailureContext[]
  }
  readonly source_pool: {
    readonly canonical_records: number
    readonly canonical_jsonl_sha256: string
    readonly records: readonly GenerationDatasetRecordSummary[]
  }
}

export interface GenerationDraft {
  readonly host_source: string
  readonly description: string
}

export interface GenerationDraftRequest {
  readonly attempt: number
  readonly max_attempts: number
  readonly context: GenerationProposalContext
  readonly previous_failure?: string
}

/** Process-local proposal session. The same live Agent is used for activation. */
export interface GenerationProposalSession {
  readonly agent: EvolutionRuntimeAgent
  propose(request: GenerationDraftRequest, signal: AbortSignal): Promise<GenerationDraft>
  cancel(reason?: string): void
  dispose(): Promise<void>
}

export interface GenerationProposer {
  create(profileId: string, runId: string, signal: AbortSignal): Promise<GenerationProposalSession>
}

export interface GenerationMaterializationRequest {
  readonly profile_id: string
  readonly candidate_id: string
  readonly generation: number
  readonly strategy_plugin_id: string
  readonly strategy_version: string
  readonly host_source: string
  readonly harness_id: string
  readonly seed: number
  readonly canonical_records: readonly unknown[]
  readonly baseline_summary: unknown
}

export interface GenerationMaterialization {
  readonly schema_version: typeof GENERATION_MATERIALIZATION_VERSION
  readonly candidate_id: string
  readonly host_source_sha256: string
  readonly source_pool_sha256: string
  readonly canonical_jsonl_sha256: string
  readonly logical_view_jsonl_sha256: string
  readonly run_summary_json_sha256: string
  readonly selected_record_ids: readonly string[]
  readonly data_run: DataRunResult
}

export interface GenerationMaterializer {
  materialize(request: GenerationMaterializationRequest, signal?: AbortSignal): Promise<GenerationMaterialization>
}

export interface GenerationDraftAttempt {
  readonly attempt: number
  readonly status: 'failed' | 'passed'
  readonly response_path: string
  readonly created_at: string
  readonly host_source_sha256?: string
  readonly validation?: CandidateValidationResult
  readonly materialization_sha256?: string
  readonly failure?: string
}

export interface GenerationDecision {
  readonly candidate_id: string
  readonly accepted: boolean
  readonly reason: string
  readonly candidate_score: number
  readonly baseline_score: number
}

export interface GenerationState {
  readonly schema_version: typeof LEGACY_GENERATION_STATE_VERSION | typeof GENERATION_STATE_VERSION
  readonly profile_id: string
  readonly run_id: string
  readonly experiment_run_id: string
  readonly candidate_id: string
  readonly strategy_version: string
  readonly execution_commit: string
  readonly status: GenerationRunStatus
  readonly phase: GenerationPhase
  readonly run_directory: string
  readonly baseline_run_directory: string
  readonly b_search_cases_jsonl: string
  readonly created_at: string
  readonly updated_at: string
  /** Immutable per-run proposal budget. Legacy v1 states are projected as three. */
  readonly max_proposal_drafts: number
  /** Number of proposal slots durably reserved before entering the model boundary. */
  readonly proposal_drafts_started: number
  readonly attempts: readonly GenerationDraftAttempt[]
  readonly formal_candidate_persisted: boolean
  readonly candidate_source_path?: string
  readonly candidate_source_sha256?: string
  readonly materialized_data_path?: string
  readonly materialization_sha256?: string
  readonly experiment_started?: boolean
  readonly decision?: GenerationDecision
  readonly feedback_id?: string
  readonly failure?: {
    readonly code: GenerationErrorCode
    readonly message: string
  }
}

export interface GenerationStatus {
  readonly state: GenerationState
  /** Process-local convenience only; never persisted. */
  readonly job_id?: JobId
}

export interface GenerationJobHooks {
  readonly done: Promise<JobOutcome>
  cancel(reason?: string): void
  readOutput?(): string
}

export interface GenerationJobRegistry {
  start(spec: {
    readonly kind: 'autodata-generation'
    readonly label: string
    readonly outputLimitBytes?: number
    readonly run: () => GenerationJobHooks
  }): JobId
  get(id: JobId): { readonly status: string }
  kill(id: JobId, caller?: undefined, reason?: string): 'requested' | 'already-finished'
  attachController(name: string): () => void
}

export interface GenerationControllerOptions {
  readonly evolution: EvolutionController
  readonly experiment: ExperimentController
  readonly proposer?: GenerationProposer
  readonly materializer?: GenerationMaterializer
  readonly validator?: CandidateValidator
  readonly run_root?: string
  /** Optional byte hash of canonical proposal-context JSON plus its trailing newline. */
  readonly expected_proposal_context_sha256?: string
  readonly poll_interval_ms?: number
  readonly jobs?: GenerationJobRegistry
  readonly now?: () => Date
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export type GenerationErrorCode =
  | 'INVALID_REQUEST'
  | 'RUN_EXISTS'
  | 'RUN_NOT_FOUND'
  | 'STATE_CORRUPT'
  | 'ARTIFACT_EXISTS'
  | 'ARTIFACT_INVALID'
  | 'PATH_ESCAPE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'PROPOSAL_FAILED'
  | 'VALIDATION_FAILED'
  | 'NONDETERMINISTIC_CANDIDATE'
  | 'EXPERIMENT_FAILED'
  | 'DECISION_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'CANCEL_FAILED'
  | 'STORE_IO'

export class GenerationError extends Error {
  readonly code: GenerationErrorCode
  readonly profile_id?: string
  readonly run_id?: string
  readonly details?: JsonObject

  constructor(
    message: string,
    code: GenerationErrorCode,
    options: {
      readonly profile_id?: string
      readonly run_id?: string
      readonly details?: JsonObject
      readonly cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GenerationError'
    this.code = code
    if (options.profile_id !== undefined) this.profile_id = options.profile_id
    if (options.run_id !== undefined) this.run_id = options.run_id
    if (options.details !== undefined) this.details = options.details
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'autodata-generation': 'autodata-generation'
  }
}

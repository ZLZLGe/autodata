/** Public, serializable contracts for the AutoData Stage 3 evolution core. */

import type { DataSourceIdentity, JsonObject } from '../core/types.js'

/** Schema versions are ordinary format identifiers, not integrity tokens. */
export const TASK_PROFILE_SCHEMA_VERSION = 'autodata-task-profile-1'
export const ACCEPTANCE_POLICY_SCHEMA_VERSION = 'autodata-acceptance-policy-1'
export const CANDIDATE_MANIFEST_SCHEMA_VERSION = 'autodata-candidate-manifest-2'
export const EVALUATION_REPORT_SCHEMA_VERSION = 'autodata-evaluation-report-1'
export const EVOLUTION_FEEDBACK_SCHEMA_VERSION = 'autodata-evolution-feedback-1'
export const EVOLUTION_STATE_SCHEMA_VERSION = 'autodata-evolution-state-2'

export const MAX_HOST_SOURCE_BYTES = 256 * 1024
export const MAX_FEEDBACK_FAILURES = 50

/** The baseline candidate installed for every new profile. */
export const H0_CANDIDATE_ID = 'h0'
export const H0_PLUGIN_ID = 'toolcall-h0'
export const H0_PLUGIN_VERSION = '3'

/** Capabilities that a Stage 3 strategy candidate may request. */
export const STAGE3_CAPABILITIES = Object.freeze([
  'data-select',
  'data-filter',
  'data-order',
  'task-strategy',
] as const)
export type Stage3Capability = typeof STAGE3_CAPABILITIES[number]

export type CandidateStatus = 'proposed' | 'validated' | 'accepted' | 'rejected' | 'retired'
export type EvaluationSplit = 'B_search' | 'B_dev' | 'B_test'
export type AcceptanceRule = 'strict_improvement'
export type MetricDirection = 'maximize'

/** Acceptance policy is fixed by the profile and cannot be supplied by a candidate. */
export interface AcceptancePolicy {
  readonly schema_version: string
  readonly rule: AcceptanceRule
  readonly split: 'B_dev'
  readonly metric: string
  readonly direction: MetricDirection
}

/** A task-level evolution profile. All fields are JSON-compatible and detached on entry. */
export interface TaskProfile {
  readonly schema_version: string
  readonly id: string
  readonly strategy_plugin_id: string
  readonly acceptance_policy: AcceptancePolicy
  readonly goal?: string
  readonly name?: string
  readonly description?: string
  readonly source?: DataSourceIdentity
  readonly benchmark: string
  readonly capabilities: readonly Stage3Capability[]
  readonly metadata?: JsonObject
}

/** Convenient input form accepted by profile normalization. */
export interface TaskProfileInput {
  readonly schema_version?: string
  readonly id: string
  readonly strategy_plugin_id?: string
  readonly acceptance_policy?: Partial<AcceptancePolicy>
  /** Short alias accepted at the boundary; normalized output uses acceptance_policy. */
  readonly acceptance?: Partial<AcceptancePolicy>
  readonly goal?: string
  readonly name?: string
  readonly description?: string
  readonly source?: DataSourceIdentity
  readonly benchmark: string
  readonly capabilities?: readonly Stage3Capability[]
  readonly metadata?: JsonObject
}

/** Immutable metadata for one proposed DSH Strategy Package. */
export interface CandidateManifest {
  readonly schema_version: string
  readonly candidate_id: string
  readonly profile_id: string
  readonly generation: number
  readonly parent_candidate_id: string | null
  readonly strategy_version: string
  readonly capabilities: readonly Stage3Capability[]
  readonly description?: string
  readonly metadata?: JsonObject
}

/** Input form for a candidate manifest before defaults are normalized. */
export interface CandidateManifestInput {
  readonly schema_version?: string
  readonly candidate_id: string
  readonly profile_id: string
  readonly generation: number
  readonly parent_candidate_id?: string | null
  readonly strategy_version: string
  readonly capabilities?: readonly Stage3Capability[]
  readonly description?: string
  readonly metadata?: JsonObject
}

/** Candidate source held by the Store alongside its manifest. */
export interface CandidatePackage {
  readonly manifest: CandidateManifest
  readonly host_source: string
}

/** Compact score retained in state so acceptance and rollback remain inspectable. */
export interface EvaluationSummary {
  readonly report_id: string
  readonly candidate_id: string
  readonly benchmark: string
  readonly split: EvaluationSplit
  readonly metric: string
  readonly score: number
}

/** External evaluator output consumed by the controller/state machine. */
export interface EvaluationReport {
  readonly schema_version: string
  readonly report_id: string
  readonly profile_id: string
  readonly candidate_id: string
  readonly benchmark: string
  readonly split: EvaluationSplit
  readonly metric: string
  readonly score: number
  readonly complete: boolean
  readonly cases_evaluated?: number
  readonly cases_expected?: number
  readonly run_id?: string
  readonly baseline_candidate_id?: string
  readonly baseline_score?: number
  readonly category_scores?: Readonly<Record<string, number>>
  readonly metadata?: JsonObject
}

export interface EvolutionFailureCase {
  readonly case_id: string
  readonly summary: string
  readonly category?: string
}

/** B_search evidence supplied by the Host for the current active candidate. */
export interface EvolutionFeedback {
  readonly schema_version: string
  readonly feedback_id: string
  readonly profile_id: string
  readonly candidate_id: string
  readonly benchmark: string
  readonly split: 'B_search'
  readonly summary: string
  readonly failures: readonly EvolutionFailureCase[]
  readonly metrics?: Readonly<Record<string, number>>
  readonly artifact_path?: string
  readonly metadata?: JsonObject
}

export interface EvolutionFeedbackInput {
  readonly schema_version?: string
  readonly feedback_id: string
  readonly profile_id: string
  readonly candidate_id: string
  readonly benchmark: string
  readonly split?: 'B_search'
  readonly summary: string
  readonly failures?: readonly EvolutionFailureCase[]
  readonly metrics?: Readonly<Record<string, number>>
  readonly artifact_path?: string
  readonly metadata?: JsonObject
}

/** Reasons are stable diagnostics, not an additional policy language. */
export type AcceptanceDecisionReason =
  | 'accepted_strict_improvement'
  | 'candidate_not_found'
  | 'candidate_not_validated'
  | 'profile_mismatch'
  | 'report_incomplete'
  | 'wrong_split'
  | 'wrong_metric'
  | 'wrong_benchmark'
  | 'baseline_missing'
  | 'baseline_fields_incomplete'
  | 'baseline_candidate_mismatch'
  | 'baseline_score_mismatch'
  | 'not_strictly_better'
  | 'runtime_activation_failed'

export interface AcceptanceDecision {
  readonly candidate_id: string
  readonly accepted: boolean
  readonly reason: AcceptanceDecisionReason
  readonly split?: EvaluationSplit
  readonly metric?: string
  readonly candidate_score?: number
  readonly baseline_score?: number
}

/** One candidate's state summary; executable source is intentionally absent. */
export interface CandidateState {
  readonly candidate_id: string
  readonly generation: number
  readonly status: CandidateStatus
  readonly parent_candidate_id: string | null
  readonly evaluation?: EvaluationSummary
}

/** Durable per-profile state. Exactly one candidate is accepted/active. */
export interface EvolutionState {
  readonly schema_version: string
  readonly profile_id: string
  readonly generation: number
  readonly active_candidate_id: string
  readonly open_candidate_id: string | null
  readonly candidates: readonly CandidateState[]
  readonly feedback_ids: readonly string[]
  readonly current_feedback_id: string | null
  readonly active_evaluation?: EvaluationSummary
}

export interface EvaluationRecord {
  readonly report: EvaluationReport
  readonly decision?: AcceptanceDecision
}

/** A cross-checked durable snapshot. H0 has no CandidatePackage entry. */
export interface EvolutionSnapshot {
  readonly profile: TaskProfile
  readonly state: EvolutionState
  readonly candidate_packages: readonly CandidatePackage[]
  readonly feedback_records: readonly EvolutionFeedback[]
}

/** Synchronous Store contract used by the Stage 3 controller. */
export interface EvolutionStore {
  readonly root?: string
  createProfile(profile: TaskProfile): EvolutionState
  saveProfile(profile: TaskProfile): void
  getProfile(profileId: string): TaskProfile | undefined
  listProfiles(): readonly TaskProfile[]
  saveState(state: EvolutionState): void
  getState(profileId: string): EvolutionState | undefined
  saveCandidate(candidate: CandidatePackage): void
  getCandidate(profileId: string, candidateId: string): CandidatePackage | undefined
  listCandidates(profileId: string): readonly CandidatePackage[]
  saveFeedback(feedback: EvolutionFeedback): void
  getFeedback(profileId: string, feedbackId: string): EvolutionFeedback | undefined
  listFeedback(profileId: string): readonly EvolutionFeedback[]
  saveEvaluation(profileId: string, record: EvaluationRecord): void
  getEvaluation(profileId: string, reportId: string): EvaluationRecord | undefined
  loadConsistentSnapshot(profileId: string): EvolutionSnapshot
}

export type EvolutionErrorCode =
  | 'INVALID_PROFILE'
  | 'PROFILE_EXISTS'
  | 'PROFILE_NOT_FOUND'
  | 'INVALID_POLICY'
  | 'INVALID_CANDIDATE'
  | 'CANDIDATE_EXISTS'
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_STATE'
  | 'OPEN_CANDIDATE_EXISTS'
  | 'INVALID_FEEDBACK'
  | 'FEEDBACK_EXISTS'
  | 'FEEDBACK_NOT_FOUND'
  | 'INVALID_EVALUATION'
  | 'EVALUATION_NOT_FOUND'
  | 'STATE_CORRUPT'
  | 'STORE_IO'
  | 'VALIDATION_UNAVAILABLE'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_FAILED'
  | 'RUNTIME_STATE'
  | 'RUNTIME_DEGRADED'

/** Stable error boundary for profile, state-machine, and Store failures. */
export class EvolutionError extends Error {
  readonly code: EvolutionErrorCode
  readonly profile_id?: string
  readonly candidate_id?: string

  constructor(
    message: string,
    code: EvolutionErrorCode,
    options: { readonly profile_id?: string; readonly candidate_id?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EvolutionError'
    this.code = code
    if (options.profile_id !== undefined) this.profile_id = options.profile_id
    if (options.candidate_id !== undefined) this.candidate_id = options.candidate_id
  }
}

import {
  EvolutionError,
  H0_CANDIDATE_ID,
  MAX_HOST_SOURCE_BYTES,
  type AcceptanceDecision,
  type CandidateManifest,
  type CandidatePackage,
  type CandidateState,
  type EvaluationReport,
  type EvolutionFeedback,
  type EvolutionState,
  type EvolutionStore,
  type Stage3Capability,
  type TaskProfile,
  type TaskProfileInput,
} from './types.js'
import {
  normalizeEvolutionFeedback,
  normalizeTaskProfile,
} from './profile.js'
import {
  proposeCandidate,
  recordEvaluation as transitionEvaluation,
  recordEvolutionFeedback,
  rejectCandidate,
  rejectRuntimeActivation,
  rollbackCandidate,
  validateCandidate as transitionValidated,
} from './state.js'
import type { CandidateValidationResult, CandidateValidator } from './validator.js'
import type { EvolutionRuntime, EvolutionRuntimeAgent, RuntimeActivation } from './runtime.js'

export interface CandidateSubmissionInput {
  readonly candidate_id: string
  readonly strategy_version: string
  readonly host_source: string
  readonly capabilities?: readonly Stage3Capability[]
  readonly description?: string
  readonly metadata?: CandidateManifest['metadata']
}

export interface EvolutionStatus {
  readonly profile: TaskProfile
  readonly state: EvolutionState
  readonly candidates: readonly CandidateManifest[]
}

export interface CandidateValidationOutcome {
  readonly validation: CandidateValidationResult
  readonly status: EvolutionStatus
}

export interface EvaluationOutcome {
  readonly decision: AcceptanceDecision
  readonly status: EvolutionStatus
}

export interface EvolutionControllerOptions {
  readonly store: EvolutionStore
  readonly validator: CandidateValidator
  readonly runtime?: EvolutionRuntime
}

/** Single-writer Stage 3 coordinator for durable decisions and DSH activation. */
export class EvolutionController {
  readonly store: EvolutionStore
  private readonly validator: CandidateValidator
  private readonly runtime: EvolutionRuntime | undefined
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(options: EvolutionControllerOptions) {
    this.store = options.store
    this.validator = options.validator
    this.runtime = options.runtime
  }

  createProfile(input: TaskProfileInput | TaskProfile): EvolutionStatus {
    this.assertUsable()
    const profile = normalizeTaskProfile(input)
    const collision = this.store.listProfiles().find(value =>
      value.strategy_plugin_id === profile.strategy_plugin_id && value.id !== profile.id)
    if (collision !== undefined) {
      throw new EvolutionError(
        `strategy_plugin_id ${profile.strategy_plugin_id} is already owned by profile ${collision.id}`,
        'INVALID_PROFILE',
        { profile_id: profile.id },
      )
    }
    this.store.createProfile(profile)
    return this.status(profile.id)
  }

  /** Persist a new direct host-source proposal. Validation is a separate step. */
  submitCandidate(profileId: string, input: CandidateSubmissionInput): EvolutionStatus {
    this.assertUsable()
    if (typeof input.host_source !== 'string' || input.host_source.trim().length === 0) {
      throw new EvolutionError('candidate host_source must be a non-empty string', 'INVALID_CANDIDATE', {
        profile_id: profileId,
        candidate_id: input.candidate_id,
      })
    }
    if (Buffer.byteLength(input.host_source, 'utf8') > MAX_HOST_SOURCE_BYTES) {
      throw new EvolutionError('candidate host source exceeds 256 KiB', 'INVALID_CANDIDATE', {
        profile_id: profileId,
        candidate_id: input.candidate_id,
      })
    }
    const snapshot = this.store.loadConsistentSnapshot(profileId)
    const manifest: CandidateManifest = {
      schema_version: 'autodata-candidate-manifest-2',
      candidate_id: input.candidate_id,
      profile_id: snapshot.profile.id,
      generation: snapshot.state.generation + 1,
      parent_candidate_id: snapshot.state.active_candidate_id,
      strategy_version: input.strategy_version,
      capabilities: input.capabilities ?? snapshot.profile.capabilities,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    }
    const candidate: CandidatePackage = { manifest, host_source: input.host_source }
    const next = proposeCandidate(snapshot.profile, snapshot.state, manifest)

    // Candidate files are append-only. A crash between these writes leaves an
    // unreferenced artifact which the Store intentionally ignores.
    this.store.saveCandidate(candidate)
    this.store.saveState(next)
    return this.status(profileId)
  }

  /** Submit source and immediately perform the ordinary child-process validation. */
  async submitAndValidateCandidate(
    profileId: string,
    input: CandidateSubmissionInput,
  ): Promise<CandidateValidationOutcome> {
    this.submitCandidate(profileId, input)
    return this.validateCandidate(profileId, input.candidate_id)
  }

  async validateCandidate(profileId: string, candidateId: string): Promise<CandidateValidationOutcome> {
    this.assertUsable()
    const snapshot = this.store.loadConsistentSnapshot(profileId)
    const stateCandidate = this.requireStateCandidate(snapshot.state, candidateId)
    if (snapshot.state.open_candidate_id !== candidateId || stateCandidate.status !== 'proposed') {
      throw new EvolutionError(`candidate ${candidateId} is not proposed`, 'CANDIDATE_STATE', {
        profile_id: profileId,
        candidate_id: candidateId,
      })
    }
    const candidate = this.requireCandidate(snapshot.candidate_packages, profileId, candidateId)
    let validation: CandidateValidationResult
    try {
      validation = await this.validator.validate(snapshot.profile, candidate)
    } catch (error) {
      // An unavailable worker is infrastructure failure: keep proposed/open so
      // the same candidate can be retried after the host is repaired.
      if (error instanceof EvolutionError && error.code === 'VALIDATION_UNAVAILABLE') throw error
      throw error
    }
    if (validation.candidate_id !== candidateId && validation.candidate_id !== 'unknown') {
      throw new EvolutionError('validator returned a different candidate_id', 'RUNTIME_FAILED', {
        profile_id: profileId,
        candidate_id: candidateId,
      })
    }
    const next = validation.ok
      ? transitionValidated(snapshot.state, candidateId)
      : rejectCandidate(snapshot.state, candidateId)
    this.store.saveState(next)
    return Object.freeze({ validation, status: this.status(profileId) })
  }

  /** Append Host-authored B_search feedback for the currently active version. */
  recordFeedback(feedbackInput: EvolutionFeedback): EvolutionFeedback {
    this.assertUsable()
    const feedback = normalizeEvolutionFeedback(feedbackInput)
    const snapshot = this.store.loadConsistentSnapshot(feedback.profile_id)
    const next = recordEvolutionFeedback(snapshot.state, feedback)
    // Write the immutable record first. If state persistence fails it is an
    // orphan and will be ignored; IDs remain occupied and cannot be reused.
    this.store.saveFeedback(feedback)
    this.store.saveState(next)
    return feedback
  }

  /** Return one feedback record, or undefined when a profile has none/current is absent. */
  feedback(profileId: string, feedbackId?: string): EvolutionFeedback | undefined {
    this.assertUsable()
    const snapshot = this.store.loadConsistentSnapshot(profileId)
    const selected = feedbackId ?? snapshot.state.current_feedback_id
    if (selected === null || selected === undefined) return undefined
    const feedback = snapshot.feedback_records.find(value => value.feedback_id === selected)
    if (feedback === undefined) {
      throw new EvolutionError(`feedback ${selected} is missing`, 'FEEDBACK_NOT_FOUND', {
        profile_id: profileId,
      })
    }
    return feedback
  }

  async recordEvaluation(
    report: EvaluationReport,
    agent?: EvolutionRuntimeAgent,
  ): Promise<EvaluationOutcome> {
    this.assertUsable()
    const snapshot = this.store.loadConsistentSnapshot(report.profile_id)
    const transition = transitionEvaluation(snapshot.profile, snapshot.state, report)
    let activation: RuntimeActivation | undefined

    if (transition.decision.accepted) {
      if (agent === undefined) {
        throw new EvolutionError('accepting a candidate requires a live DSH Agent', 'RUNTIME_UNAVAILABLE', {
          profile_id: report.profile_id,
          candidate_id: report.candidate_id,
        })
      }
      const current = this.activePackage(snapshot.state, snapshot.candidate_packages)
      const candidate = this.requireCandidate(snapshot.candidate_packages, report.profile_id, report.candidate_id)
      try {
        activation = await this.requireRuntime().activate(snapshot.profile, current, candidate, agent)
      } catch (error) {
        // RUNTIME_FAILED means the candidate itself failed after the old active
        // was restored. Turn that into a durable rejection. Unavailable or
        // degraded infrastructure remains open for a later retry.
        if (error instanceof EvolutionError && error.code === 'RUNTIME_FAILED') {
          const rejected = rejectRuntimeActivation(snapshot.state, report, transition.decision)
          this.persistEvaluationTransition(snapshot, rejected.state, report, rejected.decision)
          return Object.freeze({ decision: rejected.decision, status: this.status(report.profile_id) })
        }
        throw error
      }
    }

    try {
      this.persistEvaluationTransition(snapshot, transition.state, report, transition.decision)
    } catch (error) {
      this.restoreState(snapshot.state)
      if (activation !== undefined) {
        try {
          await activation.rollback()
        } catch (rollbackError) {
          throw new EvolutionError('failed to restore runtime after persistence failure', 'RUNTIME_DEGRADED', {
            profile_id: report.profile_id,
            candidate_id: report.candidate_id,
            cause: rollbackError,
          })
        }
      }
      throw error
    }
    return Object.freeze({ decision: transition.decision, status: this.status(report.profile_id) })
  }

  async rollback(
    profileId: string,
    targetCandidateId: string,
    agent: EvolutionRuntimeAgent,
  ): Promise<EvolutionStatus> {
    this.assertUsable()
    const snapshot = this.store.loadConsistentSnapshot(profileId)
    const next = rollbackCandidate(snapshot.state, targetCandidateId)
    if (next === snapshot.state) return this.status(profileId)
    const current = this.activePackage(snapshot.state, snapshot.candidate_packages)
    const target = targetCandidateId === H0_CANDIDATE_ID
      ? null
      : this.requireCandidate(snapshot.candidate_packages, profileId, targetCandidateId)
    const runtime = this.requireRuntime()
    let activation: RuntimeActivation | undefined
    if (target === null) {
      await runtime.ensureActive(snapshot.profile, null, agent)
    } else {
      activation = await runtime.activate(snapshot.profile, current, target, agent)
    }
    try {
      this.store.saveState(next)
    } catch (error) {
      this.restoreState(snapshot.state)
      if (activation !== undefined) await activation.rollback()
      else if (current !== null) await runtime.ensureActive(snapshot.profile, current, agent)
      throw error
    }
    return this.status(profileId)
  }

  async resume(profileId: string, agent: EvolutionRuntimeAgent): Promise<EvolutionStatus> {
    this.assertUsable()
    const snapshot = this.store.loadConsistentSnapshot(profileId)
    const active = this.activePackage(snapshot.state, snapshot.candidate_packages)
    await this.requireRuntime().ensureActive(snapshot.profile, active, agent)
    return this.status(profileId)
  }

  status(profileId: string): EvolutionStatus {
    this.assertUsable()
    const snapshot = this.store.loadConsistentSnapshot(profileId)
    return Object.freeze({
      profile: snapshot.profile,
      state: snapshot.state,
      candidates: Object.freeze(snapshot.candidate_packages.map(value => value.manifest)),
    })
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = this.runtime?.dispose() ?? Promise.resolve()
    return this.disposal
  }

  private persistEvaluationTransition(
    snapshot: { readonly state: EvolutionState },
    state: EvolutionState,
    report: EvaluationReport,
    decision: AcceptanceDecision,
  ): void {
    this.store.saveState(state)
    try {
      this.store.saveEvaluation(report.profile_id, { report, decision })
    } catch (error) {
      this.restoreState(snapshot.state)
      throw error
    }
  }

  private restoreState(state: EvolutionState): void {
    try {
      this.store.saveState(state)
    } catch (error) {
      throw new EvolutionError('failed to restore a consistent evolution snapshot', 'STATE_CORRUPT', {
        profile_id: state.profile_id,
        cause: error,
      })
    }
  }

  private activePackage(state: EvolutionState, candidates: readonly CandidatePackage[]): CandidatePackage | null {
    if (state.active_candidate_id === H0_CANDIDATE_ID) return null
    return this.requireCandidate(candidates, state.profile_id, state.active_candidate_id)
  }

  private requireCandidate(
    candidates: readonly CandidatePackage[],
    profileId: string,
    candidateId: string,
  ): CandidatePackage {
    const candidate = candidates.find(value => value.manifest.candidate_id === candidateId)
    if (candidate === undefined) {
      throw new EvolutionError(`candidate ${candidateId} is missing`, 'CANDIDATE_NOT_FOUND', {
        profile_id: profileId,
        candidate_id: candidateId,
      })
    }
    return candidate
  }

  private requireStateCandidate(state: EvolutionState, candidateId: string): CandidateState {
    const candidate = state.candidates.find(value => value.candidate_id === candidateId)
    if (candidate === undefined) {
      throw new EvolutionError(`candidate ${candidateId} does not exist`, 'CANDIDATE_NOT_FOUND', {
        profile_id: state.profile_id,
        candidate_id: candidateId,
      })
    }
    return candidate
  }

  private requireRuntime(): EvolutionRuntime {
    if (this.runtime === undefined) {
      throw new EvolutionError('DSH evolution runtime is unavailable', 'RUNTIME_UNAVAILABLE')
    }
    return this.runtime
  }

  private assertUsable(): void {
    if (this.disposed) throw new EvolutionError('AutoData evolution controller is disposed', 'RUNTIME_UNAVAILABLE')
  }
}

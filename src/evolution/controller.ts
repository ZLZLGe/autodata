import {
  EvolutionError,
  H0_CANDIDATE_ID,
  MAX_HOST_SOURCE_BYTES,
  type AcceptanceDecision,
  type CandidateManifest,
  type CandidatePackage,
  type CandidateState,
  type EvaluationReport,
  type EvaluationRecord,
  type EvolutionFeedback,
  type EvolutionState,
  type EvolutionStore,
  type Stage3Capability,
  type TaskProfile,
  type TaskProfileInput,
} from './types.js'
import { canonicalJson } from '../core/json.js'
import {
  normalizeEvolutionFeedback,
  normalizeEvaluationReport,
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
import {
  normalizeCandidateValidationResult,
  type CandidateValidationResult,
  type CandidateValidator,
} from './validator.js'
import {
  CandidateActivationError,
  type EvolutionRuntime,
  type EvolutionRuntimeAgent,
  type RuntimeActivation,
} from './runtime.js'

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
  private readonly profileMutations = new Map<string, Promise<void>>()
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

  /**
   * Ensure immutable Host-configured profiles exist without changing the
   * createProfile() collision contract used by explicit callers.
   */
  ensureProfiles(inputs: readonly (TaskProfileInput | TaskProfile)[]): readonly EvolutionStatus[] {
    this.assertUsable()
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new EvolutionError('at least one TaskProfile must be configured', 'INVALID_PROFILE')
    }

    // Normalize and cross-check the complete requested set before creating
    // anything. A later config error must not leave an earlier profile behind.
    const profiles = inputs.map(input => normalizeTaskProfile(input))
    const requestedIds = new Set<string>()
    const requestedStrategies = new Map<string, string>()
    for (const profile of profiles) {
      if (requestedIds.has(profile.id)) {
        throw new EvolutionError(`profile ${profile.id} is configured more than once`, 'INVALID_PROFILE', {
          profile_id: profile.id,
        })
      }
      requestedIds.add(profile.id)
      const owner = requestedStrategies.get(profile.strategy_plugin_id)
      if (owner !== undefined) {
        throw new EvolutionError(
          `strategy_plugin_id ${profile.strategy_plugin_id} is configured for both ${owner} and ${profile.id}`,
          'INVALID_PROFILE',
          { profile_id: profile.id },
        )
      }
      requestedStrategies.set(profile.strategy_plugin_id, profile.id)
    }

    const existing = this.store.listProfiles()
    const existingById = new Map(existing.map(profile => [profile.id, profile]))
    const existingByStrategy = new Map(existing.map(profile => [profile.strategy_plugin_id, profile]))

    // Existing profiles are part of the model-visible runtime surface. Check
    // their complete state before accepting new configuration.
    for (const profile of existing) this.store.loadConsistentSnapshot(profile.id)

    for (const profile of profiles) {
      const current = existingById.get(profile.id)
      if (current !== undefined && !sameProfile(current, profile)) {
        throw new EvolutionError(
          `profile ${profile.id} already exists with different immutable configuration`,
          'PROFILE_EXISTS',
          { profile_id: profile.id },
        )
      }
      const strategyOwner = existingByStrategy.get(profile.strategy_plugin_id)
      if (strategyOwner !== undefined && strategyOwner.id !== profile.id) {
        throw new EvolutionError(
          `strategy_plugin_id ${profile.strategy_plugin_id} is already owned by profile ${strategyOwner.id}`,
          'INVALID_PROFILE',
          { profile_id: profile.id },
        )
      }
    }

    for (const profile of profiles) {
      if (!existingById.has(profile.id)) this.store.createProfile(profile)
    }
    return Object.freeze(profiles.map(profile => this.status(profile.id)))
  }

  /** Return immutable TaskProfiles in their stable Store order. */
  profiles(): readonly TaskProfile[] {
    this.assertUsable()
    return this.store.listProfiles()
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
    return this.withProfileMutation(profileId, async () => {
      const snapshot = this.store.loadConsistentSnapshot(profileId)
      const stateCandidate = this.requireStateCandidate(snapshot.state, candidateId)
      if (snapshot.state.open_candidate_id !== candidateId || stateCandidate.status !== 'proposed') {
        throw new EvolutionError(`candidate ${candidateId} is not proposed`, 'CANDIDATE_STATE', {
          profile_id: profileId,
          candidate_id: candidateId,
        })
      }
      const candidate = this.requireCandidate(snapshot.candidate_packages, profileId, candidateId)
      const rawValidation = await this.validator.validate(snapshot.profile, candidate)
      let validation: CandidateValidationResult
      try {
        validation = normalizeCandidateValidationResult(
          rawValidation,
          candidateId,
          snapshot.profile.strategy_plugin_id,
          candidate.manifest.strategy_version,
        )
      } catch (error) {
        throw new EvolutionError('validator returned a malformed or mismatched result', 'VALIDATION_UNAVAILABLE', {
          profile_id: profileId,
          candidate_id: candidateId,
          cause: error,
        })
      }

      // Synchronous Host feedback may have committed while validation ran.
      const refreshed = this.store.loadConsistentSnapshot(profileId)
      const refreshedCandidate = this.requireStateCandidate(refreshed.state, candidateId)
      if (refreshed.state.open_candidate_id !== candidateId || refreshedCandidate.status !== 'proposed') {
        throw new EvolutionError(`candidate ${candidateId} changed while validation was running`, 'CANDIDATE_STATE', {
          profile_id: profileId,
          candidate_id: candidateId,
        })
      }
      const next = validation.ok
        ? transitionValidated(refreshed.state, candidateId)
        : rejectCandidate(refreshed.state, candidateId)
      this.store.saveState(next)
      return Object.freeze({ validation, status: this.status(profileId) })
    })
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
    reportInput: EvaluationReport,
    agent?: EvolutionRuntimeAgent,
  ): Promise<EvaluationOutcome> {
    const report = normalizeEvaluationReport(reportInput)
    return this.withProfileMutation(report.profile_id, async () => {
      let snapshot = this.store.loadConsistentSnapshot(report.profile_id)
      const existing = this.store.getEvaluation(report.profile_id, report.report_id)
      const committed = this.committedEvaluationDecision(snapshot.state, report, existing)
      if (committed !== undefined) {
        return Object.freeze({ decision: committed, status: this.status(report.profile_id) })
      }
      this.assertMatchingEvaluationRecord(report, existing)

      let transition = transitionEvaluation(snapshot.profile, snapshot.state, report)
      if (existing?.decision?.reason === 'runtime_activation_failed') {
        const rejected = rejectRuntimeActivation(snapshot.state, report, transition.decision)
        this.assertSameDecision(existing.decision, rejected.decision, report)
        try {
          this.persistEvaluationTransition(rejected.state, report, rejected.decision)
        } catch (error) {
          this.restoreState(snapshot.state)
          throw error
        }
        return Object.freeze({ decision: rejected.decision, status: this.status(report.profile_id) })
      }
      if (existing?.decision !== undefined) {
        this.assertSameDecision(existing.decision, transition.decision, report)
      }

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
          if (!(error instanceof CandidateActivationError)) throw error
          if (existing !== undefined) {
            throw new EvolutionError('a previously activated candidate could not be reactivated', 'RUNTIME_DEGRADED', {
              profile_id: report.profile_id,
              candidate_id: report.candidate_id,
              cause: error,
            })
          }
          // CandidateActivationError guarantees that the previous active
          // runtime has already been restored. Re-read state to retain any
          // synchronous feedback committed while activation was attempted.
          snapshot = this.store.loadConsistentSnapshot(report.profile_id)
          transition = transitionEvaluation(snapshot.profile, snapshot.state, report)
          const rejected = rejectRuntimeActivation(snapshot.state, report, transition.decision)
          try {
            this.persistEvaluationTransition(rejected.state, report, rejected.decision)
          } catch (persistError) {
            this.restoreState(snapshot.state)
            throw persistError
          }
          return Object.freeze({ decision: rejected.decision, status: this.status(report.profile_id) })
        }

        try {
          const refreshed = this.store.loadConsistentSnapshot(report.profile_id)
          const refreshedTransition = transitionEvaluation(refreshed.profile, refreshed.state, report)
          this.assertSameDecision(transition.decision, refreshedTransition.decision, report)
          snapshot = refreshed
          transition = refreshedTransition
        } catch (error) {
          try {
            await activation.rollback()
          } catch (rollbackError) {
            throw new EvolutionError('state changed and the activated candidate could not be rolled back', 'RUNTIME_DEGRADED', {
              profile_id: report.profile_id,
              candidate_id: report.candidate_id,
              cause: new AggregateError([error, rollbackError]),
            })
          }
          throw error
        }
      }

      try {
        this.persistEvaluationTransition(transition.state, report, transition.decision)
      } catch (error) {
        this.restoreState(snapshot.state)
        if (activation !== undefined) {
          try {
            await activation.rollback()
          } catch (rollbackError) {
            throw new EvolutionError('failed to restore runtime after persistence failure', 'RUNTIME_DEGRADED', {
              profile_id: report.profile_id,
              candidate_id: report.candidate_id,
              cause: new AggregateError([error, rollbackError]),
            })
          }
        }
        throw error
      }
      return Object.freeze({ decision: transition.decision, status: this.status(report.profile_id) })
    })
  }

  async rollback(
    profileId: string,
    targetCandidateId: string,
    agent: EvolutionRuntimeAgent,
  ): Promise<EvolutionStatus> {
    return this.withProfileMutation(profileId, async () => {
      const snapshot = this.store.loadConsistentSnapshot(profileId)
      let next = rollbackCandidate(snapshot.state, targetCandidateId)
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
        try {
          activation = await runtime.activate(snapshot.profile, current, target, agent)
        } catch (error) {
          if (!(error instanceof CandidateActivationError)) throw error
          throw new EvolutionError('failed to activate an accepted rollback target', 'RUNTIME_DEGRADED', {
            profile_id: profileId,
            candidate_id: targetCandidateId,
            cause: error,
          })
        }
      }

      let refreshed
      try {
        refreshed = this.store.loadConsistentSnapshot(profileId)
        if (refreshed.state.active_candidate_id !== snapshot.state.active_candidate_id) {
          throw new EvolutionError('active candidate changed while rollback was running', 'RUNTIME_STATE', {
            profile_id: profileId,
            candidate_id: targetCandidateId,
          })
        }
        next = rollbackCandidate(refreshed.state, targetCandidateId)
      } catch (error) {
        return this.restoreRuntimeAndRethrow(
          runtime, snapshot.profile, current, activation, agent, targetCandidateId, error,
        )
      }

      try {
        this.store.saveState(next)
      } catch (error) {
        this.restoreState(refreshed.state)
        return this.restoreRuntimeAndRethrow(
          runtime, snapshot.profile, current, activation, agent, targetCandidateId, error,
        )
      }
      return this.status(profileId)
    })
  }

  async resume(profileId: string, agent: EvolutionRuntimeAgent): Promise<EvolutionStatus> {
    return this.withProfileMutation(profileId, async () => {
      const snapshot = this.store.loadConsistentSnapshot(profileId)
      const active = this.activePackage(snapshot.state, snapshot.candidate_packages)
      await this.requireRuntime().ensureActive(snapshot.profile, active, agent)
      const refreshed = this.store.loadConsistentSnapshot(profileId)
      if (refreshed.state.active_candidate_id !== snapshot.state.active_candidate_id) {
        throw new EvolutionError('active candidate changed while runtime resume was running', 'RUNTIME_STATE', {
          profile_id: profileId,
        })
      }
      return this.status(profileId)
    })
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
    state: EvolutionState,
    report: EvaluationReport,
    decision: AcceptanceDecision,
  ): void {
    // The immutable record is the prepare step. state.json is the sole commit
    // pointer, so a crash in between is safe to replay.
    this.store.saveEvaluation(report.profile_id, { report, decision })
    this.store.saveState(state)
  }

  private committedEvaluationDecision(
    state: EvolutionState,
    report: EvaluationReport,
    record: EvaluationRecord | undefined,
  ): AcceptanceDecision | undefined {
    const committed = state.candidates.filter(candidate => candidate.evaluation?.report_id === report.report_id)
    if (committed.length === 0) return undefined
    if (committed.length !== 1 || record?.decision === undefined) {
      throw new EvolutionError(`committed evaluation ${report.report_id} has no unique durable record`, 'STATE_CORRUPT', {
        profile_id: report.profile_id,
        candidate_id: report.candidate_id,
      })
    }
    this.assertMatchingEvaluationRecord(report, record)
    const candidate = committed[0]!
    if (
      candidate.candidate_id !== report.candidate_id
      || (record.decision.accepted
        ? candidate.status !== 'accepted' && candidate.status !== 'retired'
        : candidate.status !== 'rejected')
    ) {
      throw new EvolutionError(`committed evaluation ${report.report_id} contradicts state`, 'STATE_CORRUPT', {
        profile_id: report.profile_id,
        candidate_id: report.candidate_id,
      })
    }
    return record.decision
  }

  private assertMatchingEvaluationRecord(
    report: EvaluationReport,
    record: EvaluationRecord | undefined,
  ): void {
    if (record === undefined) return
    if (canonicalJson(record.report) !== canonicalJson(report)) {
      throw new EvolutionError(`evaluation ${report.report_id} conflicts with its durable record`, 'INVALID_EVALUATION', {
        profile_id: report.profile_id,
        candidate_id: report.candidate_id,
      })
    }
    if (record.decision === undefined) {
      throw new EvolutionError(`evaluation ${report.report_id} has no durable decision`, 'STATE_CORRUPT', {
        profile_id: report.profile_id,
        candidate_id: report.candidate_id,
      })
    }
  }

  private assertSameDecision(
    expected: AcceptanceDecision,
    actual: AcceptanceDecision,
    report: EvaluationReport,
  ): void {
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      throw new EvolutionError(`evaluation ${report.report_id} no longer has its durable decision`, 'STATE_CORRUPT', {
        profile_id: report.profile_id,
        candidate_id: report.candidate_id,
      })
    }
  }

  private async restoreRuntimeAndRethrow(
    runtime: EvolutionRuntime,
    profile: TaskProfile,
    current: CandidatePackage | null,
    activation: RuntimeActivation | undefined,
    agent: EvolutionRuntimeAgent,
    targetCandidateId: string,
    primaryError: unknown,
  ): Promise<never> {
    try {
      if (activation !== undefined) await activation.rollback()
      else if (current !== null) await runtime.ensureActive(profile, current, agent)
    } catch (restoreError) {
      throw new EvolutionError('failed to restore runtime after rollback was not committed', 'RUNTIME_DEGRADED', {
        profile_id: profile.id,
        candidate_id: targetCandidateId,
        cause: new AggregateError([primaryError, restoreError]),
      })
    }
    throw primaryError
  }

  private async withProfileMutation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    this.assertUsable()
    const previous = this.profileMutations.get(profileId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    this.profileMutations.set(profileId, tail)
    await previous
    try {
      this.assertUsable()
      return await operation()
    } finally {
      release()
      if (this.profileMutations.get(profileId) === tail) this.profileMutations.delete(profileId)
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

function sameProfile(left: TaskProfile, right: TaskProfile): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

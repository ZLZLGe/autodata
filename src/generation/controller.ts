/** Host-only, resumable orchestration for the first real H1 experiment. */

import type { Context } from '@deepseek-ai/cordis'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalJson, isJsonObject, parseJsonLines, parseStrictJsonObject } from '../core/index.js'
import type { CanonicalMessage, CanonicalTrajectory, JsonObject } from '../core/types.js'
import {
  EVALUATION_REPORT_SCHEMA_VERSION,
  EVOLUTION_FEEDBACK_SCHEMA_VERSION,
  H0_CANDIDATE_ID,
  candidateRuntimeHostSource,
  createFrozenSelectionRuntimeBinding,
  normalizeEvaluationReport,
  normalizeEvolutionFeedback,
  normalizeCandidateValidationResult,
  ProcessCandidateValidator,
  type CandidatePackage,
  type CandidateValidator,
  type EvolutionFeedback,
  type EvolutionRuntimeAgent,
  type EvaluationReport,
} from '../evolution/index.js'
import {
  normalizeExperimentContract,
  normalizeExperimentEvalRequest,
  normalizeExperimentEvalResult,
} from '../experiment/contracts.js'
import { normalizeExperimentPredictionsJsonl } from '../experiment/predictions.js'
import type { ExperimentContract, ExperimentState } from '../experiment/types.js'
import { ExperimentError } from '../experiment/types.js'
import { sleepWithAbort } from '../experiment/sleep.js'
import { GenerationLedger } from './ledger.js'
import { materializationDigest, normalizeMaterialization, ProcessCandidateMaterializer } from './materializer.js'
import { DshGenerationProposer } from './proposer.js'
import { normalizeGenerationBSearchResults, type GenerationBSearchResults } from './protocol.js'
import { createInitialGenerationState, normalizeGenerationStartRequest } from './state.js'
import {
  GENERATION_MAX_DRAFTS,
  GenerationError,
  type GenerationControllerOptions,
  type GenerationDecision,
  type GenerationDraft,
  type GenerationDraftAttempt,
  type GenerationFailureContext,
  type GenerationMaterialization,
  type GenerationMaterializationRequest,
  type GenerationProposalContext,
  type GenerationProposalSession,
  type GenerationStartRequest,
  type GenerationState,
  type GenerationStatus,
} from './types.js'

const OUTPUT_LIMIT_BYTES = 64 * 1024
const DEFAULT_POLL_INTERVAL_MS = 30_000
const CANONICAL_FILE = 'canonical.jsonl'
const SUMMARY_FILE = 'run-summary.json'
const SEARCH_RESULTS_FILE = 'b-search-results.json'
const BASELINE_STATE_FILE = 'state.json'
const EVALUATION_REPORT_FILE = 'evaluation-report.json'
const EXPERIMENT_CONTRACT_FILE = 'experiment-contract.json'
const FEEDBACK_FILE = 'feedback.json'
const MAX_DRAFT_FAILURE_CHARACTERS = 8192

interface LiveGeneration {
  readonly abort: AbortController
  readonly done: Promise<import('@deepseek-ai/dsh-jobs').JobOutcome>
  readonly output: string[]
  jobId?: JobId
  session?: GenerationProposalSession
}

interface FrozenInputs {
  readonly canonicalRecords: readonly unknown[]
  readonly baselineSummary: Record<string, unknown>
  readonly proposalContext: GenerationProposalContext
  readonly sourcePoolSha256: string
  readonly baselineFeedbackId: string
}

function runKey(profileId: string, runId: string): string {
  return `${profileId}\0${runId}`
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function nowIso(now: () => Date): string {
  const value = now()
  if (!Number.isFinite(value.getTime())) throw new GenerationError('generation clock returned an invalid Date', 'STORE_IO')
  return value.toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asGenerationError(error: unknown, fallback: ConstructorParameters<typeof GenerationError>[1]): GenerationError {
  if (error instanceof GenerationError) return error
  return new GenerationError(errorMessage(error), fallback, { cause: error })
}

/** One workflow owns proposal, materialization, formal H1 persistence, experiment, and runtime reconciliation. */
export class GenerationController {
  private readonly ledger: GenerationLedger
  private readonly proposer: NonNullable<GenerationControllerOptions['proposer']>
  private readonly materializer: NonNullable<GenerationControllerOptions['materializer']>
  private readonly validator: CandidateValidator
  private readonly pollIntervalMs: number
  private readonly now: () => Date
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly live = new Map<string, LiveGeneration>()
  private readonly processJobs = new Map<string, JobId>()
  private readonly retainedSessions = new Map<string, GenerationProposalSession>()
  private detachJobController: (() => void) | undefined
  private disposed = false

  constructor(private readonly ctx: Context, private readonly options: GenerationControllerOptions) {
    this.ledger = new GenerationLedger(options.run_root)
    this.proposer = options.proposer ?? new DshGenerationProposer(ctx)
    this.materializer = options.materializer ?? new ProcessCandidateMaterializer()
    this.validator = options.validator ?? new ProcessCandidateValidator()
    this.pollIntervalMs = options.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? sleepWithAbort
    if (
      options.expected_proposal_context_sha256 !== undefined
      && !/^[a-f0-9]{64}$/u.test(options.expected_proposal_context_sha256)
    ) {
      throw new GenerationError('expected_proposal_context_sha256 must be a lowercase SHA-256', 'INVALID_REQUEST')
    }
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 0) {
      throw new GenerationError('poll_interval_ms must be a finite non-negative number', 'INVALID_REQUEST')
    }
  }

  start(requestInput: GenerationStartRequest): GenerationStatus {
    this.assertUsable()
    const request = normalizeGenerationStartRequest(requestInput)
    const key = runKey(request.profile_id, request.run_id)
    if (this.live.has(key)) throw new GenerationError(`generation ${request.profile_id}/${request.run_id} is already live`, 'RUN_EXISTS')
    if ([...this.live.keys()].some(value => value.startsWith(`${request.profile_id}\0`))) {
      throw new GenerationError(`TaskProfile ${request.profile_id} already has a live generation`, 'RUN_EXISTS')
    }
    this.assertEvolutionReady(request)
    const state = createInitialGenerationState({
      request,
      run_directory: this.ledger.runDirectory(request.profile_id, request.run_id),
      now: nowIso(this.now),
    })
    // Validate all immutable H0 inputs before consuming the one formal run ID.
    const frozen = this.loadFrozenInputs(state)
    this.assertExpectedProposalContext(frozen.proposalContext)
    this.ledger.claimFirstH1(state)
    this.ledger.initialize(state, { 'request.json': `${canonicalJson(request)}\n` })
    return this.launch(state, false)
  }

  status(profileId: string, runId: string): GenerationStatus {
    this.assertUsable()
    const state = this.ledger.loadState(profileId, runId)
    if (state.status === 'succeeded' && state.phase === 'complete') this.assertCompletedEvidence(state)
    const jobId = this.processJobs.get(runKey(state.profile_id, state.run_id))
    return Object.freeze({ state, ...(jobId === undefined ? {} : { job_id: jobId }) })
  }

  resume(profileId: string, runId: string): GenerationStatus {
    this.assertUsable()
    const key = runKey(profileId, runId)
    if (this.live.has(key)) throw new GenerationError(`generation ${profileId}/${runId} is already live`, 'RUN_EXISTS')
    if ([...this.live.keys()].some(value => value.startsWith(`${profileId}\0`))) {
      throw new GenerationError(`TaskProfile ${profileId} already has a live generation`, 'RUN_EXISTS')
    }
    const state = this.ledger.loadState(profileId, runId)
    if (state.status === 'failed' || state.status === 'cancelled') return Object.freeze({ state })
    if (state.status === 'succeeded' && state.phase === 'complete') this.assertCompletedEvidence(state)
    return this.launch(state, true)
  }

  async cancel(profileId: string, runId: string): Promise<GenerationStatus> {
    this.assertUsable()
    const key = runKey(profileId, runId)
    const live = this.live.get(key)
    if (live?.jobId !== undefined) {
      this.jobs().kill(live.jobId, undefined, 'generation cancelled by Host')
      await live.done
      return this.status(profileId, runId)
    }
    let state = this.ledger.loadState(profileId, runId)
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') return { state }
    if (state.formal_candidate_persisted || state.experiment_started === true) {
      if (state.experiment_started === true) {
        try { await this.options.experiment.cancel(state.profile_id, state.experiment_run_id) } catch { /* reconcile on resume */ }
      }
      state = this.save(state, {
        status: 'recovery_required',
        failure: { code: 'RECOVERY_REQUIRED', message: 'cancellation followed formal H1 persistence; resume to reconcile' },
      })
    } else {
      state = this.save(state, {
        status: 'cancelled',
        failure: { code: 'CANCEL_FAILED', message: 'generation cancelled by Host' },
      })
    }
    return { state }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const live of this.live.values()) {
      live.abort.abort(new GenerationError('generation controller disposed', 'CANCEL_FAILED'))
      live.session?.cancel('generation controller disposed')
    }
    await Promise.all([...this.live.values()].map(live => live.done.catch(() => undefined)))
    await Promise.all([...this.retainedSessions.values()].map(session => session.dispose().catch(() => undefined)))
    this.retainedSessions.clear()
    this.detachJobController?.()
    this.detachJobController = undefined
  }

  private launch(state: GenerationState, recovering: boolean): GenerationStatus {
    const jobs = this.jobs()
    this.ensureJobController(jobs)
    const key = runKey(state.profile_id, state.run_id)
    let live: LiveGeneration | undefined
    const jobId = jobs.start({
      kind: 'autodata-generation',
      label: `Generation ${state.profile_id}/${state.run_id}`,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run: () => {
        const abort = new AbortController()
        const output: string[] = []
        const holder: LiveGeneration = { abort, output, done: Promise.resolve({ status: 'failed' }) }
        const done = this.execute(state.profile_id, state.run_id, recovering, holder)
          .catch(error => ({ status: 'failed' as const, detail: errorMessage(error), output: errorMessage(error) }))
          .finally(() => {
            this.live.delete(key)
            this.processJobs.delete(key)
          })
        Object.defineProperty(holder, 'done', { value: done, enumerable: true })
        live = holder
        this.live.set(key, holder)
        return {
          cancel: (reason?: string) => {
            abort.abort(new GenerationError(reason ?? 'generation cancelled', 'CANCEL_FAILED'))
            holder.session?.cancel(reason)
          },
          done,
          readOutput: () => output.splice(0).join('\n'),
        }
      },
    })
    if (live === undefined) throw new GenerationError('DSH jobs provider did not start generation', 'DEPENDENCY_UNAVAILABLE')
    live.jobId = jobId
    this.processJobs.set(key, jobId)
    return this.status(state.profile_id, state.run_id)
  }

  private async execute(
    profileId: string,
    runId: string,
    recovering: boolean,
    live: LiveGeneration,
  ): Promise<import('@deepseek-ai/dsh-jobs').JobOutcome> {
    let state = this.ledger.loadState(profileId, runId)
    let session: GenerationProposalSession | undefined
    const completedReplay = state.status === 'succeeded' && state.phase === 'complete'
    try {
      if (completedReplay) this.assertCompletedEvidence(state)
      session = await this.proposer.create(profileId, runId, live.abort.signal)
      live.session = session
      if (state.status === 'succeeded' && state.phase === 'complete') {
        const resumed = await this.options.evolution.resume(profileId, session.agent)
        const expectedActive = state.decision?.accepted === true ? state.candidate_id : H0_CANDIDATE_ID
        const candidate = resumed.state.candidates.find(value => value.candidate_id === state.candidate_id)
        const expectedCandidateStatus = state.decision?.accepted === true ? 'accepted' : 'rejected'
        if (
          resumed.state.active_candidate_id !== expectedActive
          || resumed.state.active_evaluation?.candidate_id !== expectedActive
          || resumed.state.open_candidate_id !== null
          || candidate?.status !== expectedCandidateStatus
        ) {
          throw new GenerationError('completed generation conflicts with durable Evolution state', 'DECISION_FAILED')
        }
        if (state.decision?.accepted === true) this.retainSession(profileId, session)
        else await session.dispose()
        this.note(live, 'restored runtime from completed Stage 4C state')
        return { status: 'completed', detail: 'Stage 4C runtime restored', output: live.output.join('\n') }
      }
      state = this.save(state, { status: 'running', failure: undefined })
      if (!state.formal_candidate_persisted) {
        if (state.phase === 'initialized' || state.phase === 'proposing') {
          const frozen = this.loadFrozenInputs(state)
          this.assertExpectedProposalContext(frozen.proposalContext)
          this.ledger.writeNewOrSameJson(resolve(state.run_directory, 'proposal-context.json'), frozen.proposalContext, state.run_directory)
          this.ledger.writeNewOrSameJson(resolve(state.run_directory, 'source-lineage.json'), {
            schema_version: 'autodata-generation-lineage-1',
            profile_id: state.profile_id,
            parent_candidate_id: H0_CANDIDATE_ID,
            candidate_id: state.candidate_id,
            execution_commit: state.execution_commit,
            baseline_run_directory: state.baseline_run_directory,
            baseline_feedback_id: frozen.baselineFeedbackId,
            source_pool_sha256: frozen.sourcePoolSha256,
          }, state.run_directory)
          state = await this.proposeCandidate(state, frozen, session, live)
        }
        // A crash may occur after Evolution commits the candidate package but
        // before this ledger records formal_candidate_persisted. A
        // candidate_ready replay therefore reconciles the frozen package
        // directly and must not demand the earlier no-open-candidate H0 state.
        state = await this.persistFormalCandidate(state, live)
      }

      state = await this.runExperiment(state, session.agent, recovering, live)
      state = await this.reconcileDecision(state, session.agent, live)
      state = await this.commitFeedbackAndResume(state, session.agent, live)
      this.retainSessionIfNeeded(state, session)
      this.note(live, `Stage 4C complete: H1 ${state.decision?.accepted === true ? 'accepted' : 'rejected'}`)
      return { status: 'completed', detail: `H1 ${state.decision?.accepted === true ? 'accepted' : 'rejected'}`, output: live.output.join('\n') }
    } catch (error) {
      const failure = asGenerationError(error, 'RECOVERY_REQUIRED')
      try {
        if (completedReplay) throw failure
        state = this.ledger.loadState(profileId, runId)
        const cancellation = live.abort.signal.aborted
        const unsafeToCancel = state.formal_candidate_persisted || state.experiment_started === true
        const safelyClosedExperiment = failure.code === 'EXPERIMENT_FAILED'
          && failure.details?.candidate_closed === true
        const recoveryRequired = !safelyClosedExperiment
          && (unsafeToCancel || failure.code === 'RECOVERY_REQUIRED')
        state = this.save(state, {
          status: cancellation && !unsafeToCancel
            ? 'cancelled'
            : recoveryRequired
              ? 'recovery_required'
              : 'failed',
          failure: {
            code: recoveryRequired ? 'RECOVERY_REQUIRED' : failure.code,
            message: cancellation && unsafeToCancel
              ? 'cancellation occurred after formal H1 persistence; resume to reconcile'
              : failure.message,
          },
        })
      } catch { /* preserve the primary failure and completed ledger */ }
      this.note(live, `Stage 4C stopped: ${failure.message}`)
      return {
        status: live.abort.signal.aborted ? 'killed' : 'failed',
        detail: failure.code,
        output: live.output.join('\n'),
      }
    } finally {
      if (session !== undefined && !this.isRetained(session)) await session.dispose().catch(() => undefined)
    }
  }

  private async proposeCandidate(
    initial: GenerationState,
    frozen: FrozenInputs,
    session: GenerationProposalSession,
    live: LiveGeneration,
  ): Promise<GenerationState> {
    let state = this.save(initial, { phase: 'proposing', status: 'running' })
    state = await this.reconcileOrphanDrafts(state, frozen, live)
    if (state.phase === 'candidate_ready') return state
    let previousFailure = state.attempts.at(-1)?.failure
    for (let attempt = state.attempts.length + 1; attempt <= GENERATION_MAX_DRAFTS; attempt += 1) {
      if (live.abort.signal.aborted) throw new GenerationError('candidate proposal was cancelled', 'CANCEL_FAILED')
      const directory = resolve(state.run_directory, 'attempts', `draft-${String(attempt).padStart(2, '0')}`)
      const responsePath = resolve(directory, 'response.json')
      const createdAt = nowIso(this.now)
      let draft: GenerationDraft | undefined
      let validation: Awaited<ReturnType<CandidateValidator['validate']>> | undefined
      try {
        draft = await session.propose({
          attempt,
          max_attempts: GENERATION_MAX_DRAFTS,
          context: frozen.proposalContext,
          ...(previousFailure === undefined ? {} : { previous_failure: previousFailure }),
        }, live.abort.signal)
        this.ledger.writeNewJson(responsePath, draft, state.run_directory)
        const candidate = this.candidatePackage(state, draft)
        validation = normalizeCandidateValidationResult(
          await this.validator.validate(this.options.evolution.status(state.profile_id).profile, candidate),
          state.candidate_id,
          frozen.proposalContext.strategy_plugin_id,
          state.strategy_version,
        )
        if (!validation.ok) throw new GenerationError(validation.reason ?? 'candidate structural validation failed', 'VALIDATION_FAILED')
        const materializationRequest = this.materializationRequest(state, frozen, draft)
        const first = await this.materializer.materialize(materializationRequest, live.abort.signal)
        const second = await this.materializer.materialize(materializationRequest, live.abort.signal)
        if (materializationDigest(first) !== materializationDigest(second)) {
          throw new GenerationError('two fresh-process candidate materializations differ', 'NONDETERMINISTIC_CANDIDATE')
        }
        const digest = sha256(materializationDigest(first))
        const sourceSha = sha256(draft.host_source)
        if (first.host_source_sha256 !== sourceSha) {
          throw new GenerationError('candidate materialization source hash is invalid', 'ARTIFACT_INVALID')
        }
        const runtimeBinding = this.runtimeBindingForMaterialization(state, first, sourceSha, digest)
        this.assertRuntimePlanCompiles(state, draft, runtimeBinding, digest)
        this.ledger.writeNewJson(resolve(directory, 'validation.json'), validation, state.run_directory)
        this.ledger.writeNewJson(resolve(directory, 'materialization-1.json'), materializationEvidence(first), state.run_directory)
        this.ledger.writeNewJson(resolve(directory, 'materialization-2.json'), materializationEvidence(second), state.run_directory)
        const sourcePath = resolve(directory, 'package-host.js')
        const materializedPath = resolve(directory, 'materialized-data.json')
        this.ledger.writeNew(sourcePath, draft.host_source, state.run_directory)
        this.ledger.writeNewJson(materializedPath, first.data_run, state.run_directory)
        const record: GenerationDraftAttempt = {
          attempt,
          status: 'passed',
          response_path: responsePath,
          created_at: createdAt,
          host_source_sha256: sourceSha,
          validation,
          materialization_sha256: digest,
        }
        state = this.save(state, {
          phase: 'candidate_ready',
          attempts: [...state.attempts, record],
          candidate_source_path: sourcePath,
          candidate_source_sha256: sourceSha,
          materialized_data_path: materializedPath,
          materialization_sha256: digest,
        })
        this.note(live, `ephemeral draft ${String(attempt)} passed validation and two-process materialization`)
        return state
      } catch (error) {
        if (live.abort.signal.aborted) throw error
        const failure = errorMessage(error).slice(0, MAX_DRAFT_FAILURE_CHARACTERS)
        if (!existsSync(responsePath)) {
          this.ledger.writeNewJson(responsePath, { error: failure }, state.run_directory)
        }
        const record: GenerationDraftAttempt = {
          attempt,
          status: 'failed',
          response_path: responsePath,
          created_at: createdAt,
          ...(draft === undefined ? {} : { host_source_sha256: sha256(draft.host_source) }),
          ...(validation === undefined ? {} : { validation }),
          failure,
        }
        state = this.save(state, { phase: 'proposing', attempts: [...state.attempts, record] })
        previousFailure = failure
        this.note(live, `ephemeral draft ${String(attempt)} failed: ${failure}`)
      }
    }
    throw new GenerationError(`all ${String(GENERATION_MAX_DRAFTS)} ephemeral drafts failed`, 'PROPOSAL_FAILED')
  }

  private async reconcileOrphanDrafts(
    initial: GenerationState,
    frozen: FrozenInputs,
    live: LiveGeneration,
  ): Promise<GenerationState> {
    let state = initial
    while (state.attempts.length < GENERATION_MAX_DRAFTS) {
      const attempt = state.attempts.length + 1
      const directory = resolve(state.run_directory, 'attempts', `draft-${String(attempt).padStart(2, '0')}`)
      const responsePath = resolve(directory, 'response.json')
      if (!existsSync(responsePath)) return state
      const createdAt = nowIso(this.now)
      const response = this.ledger.readJson(
        this.requireContainedFile(state.run_directory, responsePath, 'orphan draft response'),
        'orphan draft response',
      )
      if (Object.hasOwn(response, 'error')) {
        const failure = this.strictOrphanProposalError(response, directory)
        state = this.save(state, {
          phase: 'proposing',
          attempts: [...state.attempts, {
            attempt,
            status: 'failed',
            response_path: responsePath,
            created_at: createdAt,
            failure,
          }],
        })
        this.note(live, `recovered failed orphan ephemeral draft ${String(attempt)}: ${failure}`)
        continue
      }
      if (
        Object.keys(response).length !== 2
        || typeof response.host_source !== 'string'
        || response.host_source.trim().length === 0
        || typeof response.description !== 'string'
        || response.description.trim().length === 0
      ) throw new GenerationError('orphan draft response is malformed', 'ARTIFACT_INVALID')
      const draft: GenerationDraft = { host_source: response.host_source, description: response.description }
      let validation: Awaited<ReturnType<CandidateValidator['validate']>> | undefined
      let first: GenerationMaterialization | undefined
      let second: GenerationMaterialization | undefined
      try {
        validation = normalizeCandidateValidationResult(
          await this.validator.validate(
            this.options.evolution.status(state.profile_id).profile,
            this.candidatePackage(state, draft),
          ),
          state.candidate_id,
          frozen.proposalContext.strategy_plugin_id,
          state.strategy_version,
        )
        if (!validation.ok) throw new GenerationError('orphan draft validation was not successful', 'VALIDATION_FAILED')
        const materializationRequest = this.materializationRequest(state, frozen, draft)
        first = await this.materializer.materialize(materializationRequest, live.abort.signal)
        second = await this.materializer.materialize(materializationRequest, live.abort.signal)
        if (materializationDigest(first) !== materializationDigest(second)) {
          throw new GenerationError('orphan draft materializations differ', 'NONDETERMINISTIC_CANDIDATE')
        }
      } catch (error) {
        if (live.abort.signal.aborted) throw error
        const failure = `interrupted draft artifacts could not be reconciled: ${errorMessage(error)}`.slice(0, 8192)
        const record: GenerationDraftAttempt = {
          attempt,
          status: 'failed',
          response_path: responsePath,
          created_at: createdAt,
          host_source_sha256: sha256(draft.host_source),
          ...(validation === undefined ? {} : { validation }),
          failure,
        }
        state = this.save(state, { phase: 'proposing', attempts: [...state.attempts, record] })
        this.note(live, `consumed incomplete orphan ephemeral draft ${String(attempt)}: ${failure}`)
        continue
      }
      if (validation === undefined || first === undefined || second === undefined) {
        throw new GenerationError('orphan draft reconciliation lost validated materialization', 'STATE_CORRUPT')
      }
      const sourcePath = resolve(directory, 'package-host.js')
      const materializedPath = resolve(directory, 'materialized-data.json')
      this.ledger.writeNewOrSameJson(resolve(directory, 'validation.json'), validation, state.run_directory)
      this.ledger.writeNewOrSameJson(resolve(directory, 'materialization-1.json'), materializationEvidence(first), state.run_directory)
      this.ledger.writeNewOrSameJson(resolve(directory, 'materialization-2.json'), materializationEvidence(second), state.run_directory)
      this.ledger.writeNewOrSame(sourcePath, draft.host_source, state.run_directory)
      this.ledger.writeNewOrSameJson(materializedPath, first.data_run, state.run_directory)
      const sourceSha = sha256(draft.host_source)
      if (first.host_source_sha256 !== sourceSha) {
        throw new GenerationError('orphan materialization source hash is invalid', 'ARTIFACT_INVALID')
      }
      const digest = sha256(materializationDigest(first))
      const runtimeBinding = this.runtimeBindingForMaterialization(state, first, sourceSha, digest)
      this.assertRuntimePlanCompiles(state, draft, runtimeBinding, digest)
      const record: GenerationDraftAttempt = {
        attempt,
        status: 'passed',
        response_path: responsePath,
        created_at: createdAt,
        host_source_sha256: sourceSha,
        validation,
        materialization_sha256: digest,
      }
      this.note(live, `revalidated and recovered orphan ephemeral draft ${String(attempt)}`)
      return this.save(state, {
        phase: 'candidate_ready',
        attempts: [...state.attempts, record],
        candidate_source_path: sourcePath,
        candidate_source_sha256: sourceSha,
        materialized_data_path: materializedPath,
        materialization_sha256: digest,
      })
    }
    return state
  }

  private async persistFormalCandidate(state: GenerationState, live: LiveGeneration): Promise<GenerationState> {
    if (
      state.candidate_source_path === undefined
      || state.candidate_source_sha256 === undefined
      || state.materialized_data_path === undefined
      || state.materialization_sha256 === undefined
    ) throw new GenerationError('candidate-ready state is missing frozen artifacts', 'STATE_CORRUPT')
    const source = this.readRegularText(state.candidate_source_path, state.run_directory, 'candidate source')
    if (sha256(source) !== state.candidate_source_sha256) {
      throw new GenerationError('candidate source no longer matches its frozen hash', 'ARTIFACT_INVALID')
    }
    // Re-read and hash the materialized payload before allowing the durable
    // candidate transition. This closes the write-then-crash window between
    // the two-process gate and experiment submission.
    const materialization = this.readFrozenMaterialization(state)
    let status = this.options.evolution.status(state.profile_id)
    const expectedPackage = this.formalCandidatePackage(state, source, materialization)
    const existing = status.state.candidates.find(candidate => candidate.candidate_id === state.candidate_id)
    if (existing === undefined) {
      const outcome = await this.options.evolution.submitAndValidateCandidate(state.profile_id, {
        candidate_id: state.candidate_id,
        strategy_version: state.strategy_version,
        host_source: source,
        capabilities: status.profile.capabilities,
        ...(expectedPackage.manifest.description === undefined ? {} : { description: expectedPackage.manifest.description }),
        metadata: expectedPackage.manifest.metadata,
      })
      if (!outcome.validation.ok) {
        throw new GenerationError(`formal candidate validation failed: ${outcome.validation.reason ?? 'unknown reason'}`, 'VALIDATION_FAILED')
      }
      status = outcome.status
    } else {
      const candidate = this.options.evolution.store.getCandidate(state.profile_id, state.candidate_id)
      if (candidate === undefined || canonicalJson(candidate) !== canonicalJson(expectedPackage)) {
        throw new GenerationError('durable candidate does not match the complete frozen generation package', 'STATE_CORRUPT')
      }
      if (existing.status === 'proposed') status = (await this.options.evolution.validateCandidate(state.profile_id, state.candidate_id)).status
    }
    const formal = status.state.candidates.find(candidate => candidate.candidate_id === state.candidate_id)
    if (formal?.status !== 'validated' && formal?.status !== 'accepted' && formal?.status !== 'rejected') {
      throw new GenerationError(`formal candidate has unexpected status ${formal?.status ?? 'missing'}`, 'STATE_CORRUPT')
    }
    this.note(live, 'persisted the only formal H1 candidate')
    return this.save(state, { formal_candidate_persisted: true, phase: 'experiment' })
  }

  private async runExperiment(
    initial: GenerationState,
    agent: EvolutionRuntimeAgent,
    recovering: boolean,
    live: LiveGeneration,
  ): Promise<GenerationState> {
    let state = initial
    if (state.decision !== undefined) return state
    if (
      state.materialized_data_path === undefined
      || state.candidate_source_sha256 === undefined
      || state.materialization_sha256 === undefined
    ) {
      throw new GenerationError('formal H1 experiment is missing materialized data', 'STATE_CORRUPT')
    }
    const materialization = this.readFrozenMaterialization(state)
    const runtimeBinding = this.runtimeBindingForMaterialization(
      state,
      materialization,
      state.candidate_source_sha256,
      state.materialization_sha256,
    )
    const dataRun = materialization.data_run
    const request = {
      profile_id: state.profile_id,
      run_id: state.experiment_run_id,
      data_run: dataRun,
      subject: {
        candidate_id: state.candidate_id,
        generation: 1,
        plugin_id: this.options.evolution.status(state.profile_id).profile.strategy_plugin_id,
        strategy_version: state.strategy_version,
        host_source_sha256: state.candidate_source_sha256,
        runtime_plan_sha256: runtimeBinding.runtime_plan_sha256,
        materialization_sha256: runtimeBinding.materialization_sha256,
      },
    }
    let experimentStatus
    if (state.experiment_started !== true) {
      // Persist intent first. A crash before start is distinguished from a
      // crash after start by probing the experiment ledger on resume.
      state = this.save(state, { phase: 'experiment', experiment_started: true })
      try {
        experimentStatus = this.startExperiment(request, agent)
      } catch (error) {
        if (!(error instanceof ExperimentError) || (error.code !== 'RUN_EXISTS' && error.code !== 'RUN_NOT_FOUND')) throw error
        experimentStatus = this.resumeExperiment(state.profile_id, state.experiment_run_id, agent)
      }
    } else {
      try {
        experimentStatus = this.options.experiment.status(state.profile_id, state.experiment_run_id)
        if (!['succeeded', 'failed', 'cancelled'].includes(experimentStatus.state.status)) {
          experimentStatus = this.resumeExperiment(state.profile_id, state.experiment_run_id, agent)
        }
      } catch (error) {
        if (!(error instanceof ExperimentError) || error.code !== 'RUN_NOT_FOUND') throw error
        experimentStatus = this.startExperiment(request, agent)
      }
    }
    this.note(live, recovering ? 'resumed the H1 experiment' : 'started the H1 experiment')
    for (;;) {
      if (live.abort.signal.aborted) throw new GenerationError('generation cancelled while H1 experiment was running', 'CANCEL_FAILED')
      experimentStatus = this.options.experiment.status(state.profile_id, state.experiment_run_id)
      if (experimentStatus.state.status === 'succeeded') break
      if (experimentStatus.state.status === 'failed' || experimentStatus.state.status === 'cancelled') {
        const closed = this.options.evolution.abandonCandidate(state.profile_id, state.candidate_id)
        const resumed = await this.options.evolution.resume(state.profile_id, agent)
        const candidate = resumed.state.candidates.find(value => value.candidate_id === state.candidate_id)
        if (
          closed.state.active_candidate_id !== H0_CANDIDATE_ID
          || resumed.state.active_candidate_id !== H0_CANDIDATE_ID
          || resumed.state.open_candidate_id !== null
          || candidate?.status !== 'rejected'
        ) throw new GenerationError('terminal H1 experiment could not be closed against H0', 'RECOVERY_REQUIRED')
        throw new GenerationError(
          `H1 experiment ended as ${experimentStatus.state.status}: ${experimentStatus.state.failure?.message ?? 'no detail'}`,
          'EXPERIMENT_FAILED',
          { details: { candidate_closed: true, experiment_status: experimentStatus.state.status } },
        )
      }
      if (experimentStatus.state.status === 'recovery_required' && experimentStatus.job_id === undefined) {
        throw new GenerationError(
          `H1 experiment requires recovery: ${experimentStatus.state.failure?.message ?? 'no detail'}`,
          'RECOVERY_REQUIRED',
        )
      }
      await this.sleep(this.pollIntervalMs, live.abort.signal)
    }
    return this.save(state, { phase: 'deciding' })
  }

  private async reconcileDecision(
    state: GenerationState,
    agent: EvolutionRuntimeAgent,
    live: LiveGeneration,
  ): Promise<GenerationState> {
    if (state.decision !== undefined) return this.save(state, { phase: 'feedback' })
    let snapshot = this.options.evolution.store.loadConsistentSnapshot(state.profile_id)
    let candidate = snapshot.state.candidates.find(value => value.candidate_id === state.candidate_id)
    if (candidate?.evaluation === undefined) {
      const experiment = this.options.experiment.status(state.profile_id, state.experiment_run_id).state
      const reportPath = resolve(experiment.run_directory, 'evaluation-report.json')
      const report = normalizeEvaluationReport(
        this.ledger.readJson(reportPath, 'H1 evaluation report') as unknown as EvaluationReport,
      )
      await this.options.evolution.recordEvaluation(report, agent)
      snapshot = this.options.evolution.store.loadConsistentSnapshot(state.profile_id)
      candidate = snapshot.state.candidates.find(value => value.candidate_id === state.candidate_id)
    }
    if (candidate?.evaluation === undefined) throw new GenerationError('H1 evaluation decision is not durable', 'DECISION_FAILED')
    const record = snapshot.evaluation_records.find(value => value.report.report_id === candidate?.evaluation?.report_id)
    if (record?.decision === undefined || record.report.baseline_score === undefined) {
      throw new GenerationError('H1 evaluation record is missing its decision or baseline', 'DECISION_FAILED')
    }
    const decision: GenerationDecision = {
      candidate_id: state.candidate_id,
      accepted: record.decision.accepted,
      reason: record.decision.reason,
      candidate_score: record.report.score,
      baseline_score: record.report.baseline_score,
    }
    this.ledger.writeNewOrSameJson(resolve(state.run_directory, 'decision.json'), {
      ...decision,
      report_id: record.report.report_id,
      split: record.report.split,
      metric: record.report.metric,
    }, state.run_directory)
    this.note(live, `durable strict decision: ${decision.accepted ? 'accept' : 'reject'} (${String(decision.candidate_score)} vs ${String(decision.baseline_score)})`)
    return this.save(state, { decision, phase: 'feedback' })
  }

  private async commitFeedbackAndResume(
    state: GenerationState,
    agent: EvolutionRuntimeAgent,
    live: LiveGeneration,
  ): Promise<GenerationState> {
    if (state.decision === undefined) throw new GenerationError('feedback phase is missing a decision', 'STATE_CORRUPT')
    const experiment = this.options.experiment.status(state.profile_id, state.experiment_run_id).state
    const contract = this.loadBoundExperimentContract(
      state,
      experiment.run_directory,
      experiment.contract_id,
      experiment.contract_sha256,
    )
    const searchPath = resolve(experiment.run_directory, SEARCH_RESULTS_FILE)
    const search = normalizeGenerationBSearchResults(
      this.readJsonContained(searchPath, experiment.run_directory, 'H1 B_search results'),
      {
        profile_id: state.profile_id,
        run_id: state.experiment_run_id,
        candidate_id: state.candidate_id,
        contract_id: experiment.contract_id,
        contract_sha256: experiment.contract_sha256,
        case_ids: contract.evaluation.case_ids.B_search,
        categories: contract.evaluation.categories,
        cases_per_category: contract.evaluation.cases_per_category_per_split,
      },
    )
    this.ledger.writeNewOrSameJson(resolve(state.run_directory, 'h1-b-search-results.json'), search, state.run_directory)
    let feedbackId = state.feedback_id
    if (state.decision.accepted) {
      const feedback = this.feedbackFromSearch(state, search, searchPath)
      // recordFeedback is append-only and replay-safe. Always call it so a
      // crash after the immutable file write but before state.json can attach
      // the orphan record during recovery.
      this.options.evolution.recordFeedback(feedback)
      feedbackId = feedback.feedback_id
      this.ledger.writeNewOrSameJson(resolve(state.run_directory, 'evolution-feedback.json'), feedback, state.run_directory)
    }
    const resumed = await this.options.evolution.resume(state.profile_id, agent)
    const expectedActive = state.decision.accepted ? state.candidate_id : H0_CANDIDATE_ID
    if (resumed.state.active_candidate_id !== expectedActive || resumed.state.open_candidate_id !== null) {
      throw new GenerationError('runtime state does not match the durable H1 decision', 'DECISION_FAILED')
    }
    this.note(live, `runtime reconciled to ${expectedActive}`)
    return this.save(state, {
      status: 'succeeded',
      phase: 'complete',
      ...(feedbackId === undefined ? {} : { feedback_id: feedbackId }),
      failure: undefined,
    })
  }

  /** Rebuild and cross-check every durable input to a completed Generation before runtime use. */
  private assertCompletedEvidence(state: GenerationState): void {
    try {
      if (
        !state.formal_candidate_persisted
        || state.experiment_started !== true
        || state.decision === undefined
        || state.failure !== undefined
        || (state.decision.accepted !== (state.feedback_id !== undefined))
      ) throw new GenerationError('completed generation state is missing terminal evidence', 'STATE_CORRUPT')

      const request = normalizeGenerationStartRequest(this.readJsonContained(
        resolve(state.run_directory, 'request.json'),
        state.run_directory,
        'generation request',
      ))
      if (canonicalJson(request) !== canonicalJson({
        profile_id: state.profile_id,
        run_id: state.run_id,
        experiment_run_id: state.experiment_run_id,
        execution_commit: state.execution_commit,
        baseline_run_directory: state.baseline_run_directory,
        b_search_cases_jsonl: state.b_search_cases_jsonl,
        candidate_id: state.candidate_id,
        strategy_version: state.strategy_version,
      })) throw new GenerationError('completed generation request no longer matches its state', 'ARTIFACT_INVALID')

      const frozen = this.loadFrozenInputs(state, true)
      this.assertExpectedProposalContext(frozen.proposalContext)
      const proposalContext = this.readJsonContained(
        resolve(state.run_directory, 'proposal-context.json'),
        state.run_directory,
        'generation proposal context',
      )
      const sourceLineage = this.readJsonContained(
        resolve(state.run_directory, 'source-lineage.json'),
        state.run_directory,
        'generation source lineage',
      )
      if (canonicalJson(proposalContext) !== canonicalJson(frozen.proposalContext)) {
        throw new GenerationError('completed proposal context differs from the frozen H0 inputs', 'ARTIFACT_INVALID')
      }
      if (canonicalJson(sourceLineage) !== canonicalJson({
        schema_version: 'autodata-generation-lineage-1',
        profile_id: state.profile_id,
        parent_candidate_id: H0_CANDIDATE_ID,
        candidate_id: state.candidate_id,
        execution_commit: state.execution_commit,
        baseline_run_directory: state.baseline_run_directory,
        baseline_feedback_id: frozen.baselineFeedbackId,
        source_pool_sha256: frozen.sourcePoolSha256,
      })) throw new GenerationError('completed source lineage differs from the frozen H0 inputs', 'ARTIFACT_INVALID')

      const passed = state.attempts.filter(attempt => attempt.status === 'passed')
      const attempt = passed[0]
      if (passed.length !== 1 || attempt === undefined || state.attempts.at(-1) !== attempt) {
        throw new GenerationError('completed generation must have one terminal passed draft', 'STATE_CORRUPT')
      }
      const draftDirectory = resolve(state.run_directory, 'attempts', `draft-${String(attempt.attempt).padStart(2, '0')}`)
      const responsePath = resolve(draftDirectory, 'response.json')
      const sourcePath = resolve(draftDirectory, 'package-host.js')
      const materializedPath = resolve(draftDirectory, 'materialized-data.json')
      if (
        attempt.response_path !== responsePath
        || state.candidate_source_path !== sourcePath
        || state.materialized_data_path !== materializedPath
        || attempt.host_source_sha256 !== state.candidate_source_sha256
        || attempt.materialization_sha256 !== state.materialization_sha256
        || attempt.validation?.ok !== true
      ) throw new GenerationError('completed generation draft binding is inconsistent', 'STATE_CORRUPT')

      const profile = this.options.evolution.status(state.profile_id).profile
      const validation = normalizeCandidateValidationResult(
        this.readJsonContained(resolve(draftDirectory, 'validation.json'), state.run_directory, 'candidate validation'),
        state.candidate_id,
        profile.strategy_plugin_id,
        state.strategy_version,
      )
      if (!validation.ok || canonicalJson(validation) !== canonicalJson(attempt.validation)) {
        throw new GenerationError('completed candidate validation evidence changed', 'ARTIFACT_INVALID')
      }
      const source = this.readRegularText(sourcePath, state.run_directory, 'candidate source')
      if (sha256(source) !== state.candidate_source_sha256) {
        throw new GenerationError('completed candidate source changed', 'ARTIFACT_INVALID')
      }
      const materialization = this.readFrozenMaterialization(state)
      const expectedPackage = this.formalCandidatePackage(state, source, materialization)

      const experimentStatus = this.options.experiment.status(state.profile_id, state.experiment_run_id)
      const experiment = experimentStatus.state
      if (
        experimentStatus.job_id !== undefined
        || experiment.status !== 'succeeded'
        || experiment.phase !== 'complete'
        || experiment.profile_id !== state.profile_id
        || experiment.run_id !== state.experiment_run_id
        || experiment.candidate_id !== state.candidate_id
        || experiment.candidate_generation !== 1
        || experiment.failure !== undefined
      ) throw new GenerationError('completed generation is not bound to a completed H1 experiment', 'ARTIFACT_INVALID')
      const contract = this.loadBoundExperimentContract(
        state,
        experiment.run_directory,
        experiment.contract_id,
        experiment.contract_sha256,
      )
      this.assertMaterializationContract(state, materialization, contract, profile.strategy_plugin_id)
      const result = this.readCompletedEvaluation(experiment, contract)

      const searchPath = resolve(experiment.run_directory, SEARCH_RESULTS_FILE)
      const search = normalizeGenerationBSearchResults(
        this.readJsonContained(searchPath, experiment.run_directory, 'H1 B_search results'),
        {
          profile_id: state.profile_id,
          run_id: state.experiment_run_id,
          candidate_id: state.candidate_id,
          contract_id: experiment.contract_id,
          contract_sha256: experiment.contract_sha256,
          case_ids: contract.evaluation.case_ids.B_search,
          categories: contract.evaluation.categories,
          cases_per_category: contract.evaluation.cases_per_category_per_split,
        },
      )
      if (
        canonicalJson(search.cases) !== canonicalJson(result.cases.filter(value => value.split === 'B_search'))
        || canonicalJson(search.category_scores) !== canonicalJson(result.category_scores.B_search)
        || search.macro_score !== result.macro_scores.B_search
      ) throw new GenerationError('H1 B_search sidecar differs from the evaluation result', 'ARTIFACT_INVALID')
      const localSearch = normalizeGenerationBSearchResults(
        this.readJsonContained(resolve(state.run_directory, 'h1-b-search-results.json'), state.run_directory, 'Generation H1 B_search results'),
        {
          profile_id: state.profile_id,
          run_id: state.experiment_run_id,
          candidate_id: state.candidate_id,
          contract_id: experiment.contract_id,
          contract_sha256: experiment.contract_sha256,
          case_ids: contract.evaluation.case_ids.B_search,
          categories: contract.evaluation.categories,
          cases_per_category: contract.evaluation.cases_per_category_per_split,
        },
      )
      if (canonicalJson(localSearch) !== canonicalJson(search)) {
        throw new GenerationError('Generation B_search copy differs from its experiment evidence', 'ARTIFACT_INVALID')
      }

      const report = normalizeEvaluationReport(
        this.readJsonContained(resolve(experiment.run_directory, EVALUATION_REPORT_FILE), experiment.run_directory, 'H1 evaluation report') as unknown as EvaluationReport,
      )
      if (
        experiment.evaluation_report_id !== report.report_id
        || report.profile_id !== state.profile_id
        || report.run_id !== state.experiment_run_id
        || report.candidate_id !== state.candidate_id
        || report.benchmark !== profile.benchmark
        || report.split !== 'B_dev'
        || report.metric !== profile.acceptance_policy.metric
        || !report.complete
        || report.cases_expected === undefined
        || report.cases_evaluated !== report.cases_expected
        || report.score !== result.macro_scores.B_dev
        || report.baseline_candidate_id !== H0_CANDIDATE_ID
        || report.baseline_score === undefined
        || canonicalJson(report.category_scores) !== canonicalJson(result.category_scores.B_dev)
        || report.metadata?.contract_id !== experiment.contract_id
        || report.metadata.contract_sha256 !== experiment.contract_sha256
        || report.metadata.evaluation_result_path !== experiment.eval_result_path
        || report.metadata.b_search_artifact_path !== searchPath
      ) throw new GenerationError('H1 evaluation report differs from its completed experiment', 'ARTIFACT_INVALID')

      if (experiment.decision === undefined || experiment.decision_path === undefined) {
        throw new GenerationError('completed H1 experiment is missing its decision', 'ARTIFACT_INVALID')
      }
      const experimentDecision = this.readJsonContained(
        experiment.decision_path,
        experiment.run_directory,
        'H1 experiment decision',
      )
      if (canonicalJson(experimentDecision) !== canonicalJson(experiment.decision)) {
        throw new GenerationError('H1 experiment decision file differs from its state', 'ARTIFACT_INVALID')
      }
      const expectedDecision: GenerationDecision = {
        candidate_id: state.candidate_id,
        accepted: experiment.decision.accepted,
        reason: experiment.decision.reason,
        candidate_score: report.score,
        baseline_score: report.baseline_score,
      }
      if (
        experiment.decision.split !== 'B_dev'
        || experiment.decision.metric !== profile.acceptance_policy.metric
        || experiment.decision.candidate_score !== report.score
        || experiment.decision.baseline_score !== report.baseline_score
        || canonicalJson(state.decision) !== canonicalJson(expectedDecision)
      ) throw new GenerationError('Generation decision differs from the H1 experiment decision', 'DECISION_FAILED')
      const localDecision = this.readJsonContained(
        resolve(state.run_directory, 'decision.json'),
        state.run_directory,
        'Generation decision',
      )
      if (canonicalJson(localDecision) !== canonicalJson({
        ...expectedDecision,
        report_id: report.report_id,
        split: report.split,
        metric: report.metric,
      })) throw new GenerationError('Generation decision artifact changed', 'ARTIFACT_INVALID')

      const snapshot = this.options.evolution.store.loadConsistentSnapshot(state.profile_id)
      const packages = snapshot.candidate_packages.filter(value => value.manifest.candidate_id !== H0_CANDIDATE_ID)
      const storedPackage = packages.find(value => value.manifest.candidate_id === state.candidate_id)
      const candidate = snapshot.state.candidates.find(value => value.candidate_id === state.candidate_id)
      const evaluation = snapshot.evaluation_records.find(value => value.report.report_id === report.report_id)
      const expectedActive = state.decision.accepted ? state.candidate_id : H0_CANDIDATE_ID
      const expectedStatus = state.decision.accepted ? 'accepted' : 'rejected'
      if (
        packages.length !== 1
        || storedPackage === undefined
        || canonicalJson(storedPackage) !== canonicalJson(expectedPackage)
        || candidate?.status !== expectedStatus
        || candidate.evaluation?.report_id !== report.report_id
        || evaluation?.decision === undefined
        || canonicalJson(evaluation.report) !== canonicalJson(report)
        || canonicalJson(evaluation.decision) !== canonicalJson(experiment.decision)
        || snapshot.state.active_candidate_id !== expectedActive
        || snapshot.state.open_candidate_id !== null
        || snapshot.state.generation !== (state.decision.accepted ? 1 : 0)
        || snapshot.state.active_evaluation?.candidate_id !== expectedActive
      ) throw new GenerationError('Evolution terminal state differs from the completed generation', 'DECISION_FAILED')

      const feedbackPath = resolve(state.run_directory, 'evolution-feedback.json')
      if (state.decision.accepted) {
        const expectedFeedback = this.feedbackFromSearch(state, search, searchPath)
        const localFeedback = normalizeEvolutionFeedback(
          this.readJsonContained(feedbackPath, state.run_directory, 'accepted H1 feedback') as unknown as EvolutionFeedback,
        )
        const storedFeedback = snapshot.feedback_records.find(value => value.feedback_id === expectedFeedback.feedback_id)
        if (
          state.feedback_id !== expectedFeedback.feedback_id
          || snapshot.state.current_feedback_id !== expectedFeedback.feedback_id
          || canonicalJson(localFeedback) !== canonicalJson(expectedFeedback)
          || canonicalJson(storedFeedback ?? null) !== canonicalJson(expectedFeedback)
        ) throw new GenerationError('accepted H1 feedback evidence changed', 'ARTIFACT_INVALID')
      } else if (
        state.feedback_id !== undefined
        || existsSync(feedbackPath)
        || snapshot.feedback_records.some(value => value.candidate_id === state.candidate_id)
        || snapshot.feedback_records.find(value => value.feedback_id === snapshot.state.current_feedback_id)?.candidate_id !== H0_CANDIDATE_ID
      ) throw new GenerationError('rejected H1 unexpectedly has accepted feedback', 'ARTIFACT_INVALID')
    } catch (error) {
      if (error instanceof GenerationError) throw error
      throw new GenerationError(`completed generation evidence is invalid: ${errorMessage(error)}`, 'ARTIFACT_INVALID', {
        profile_id: state.profile_id,
        run_id: state.run_id,
        cause: error,
      })
    }
  }

  private readCompletedEvaluation(state: ExperimentState, contract: ExperimentContract) {
    const attempt = [...state.attempts].reverse().find(value => value.stage === 'eval' && value.status === 'succeeded')
    if (attempt === undefined || state.eval_result_path === undefined || attempt.result_path !== state.eval_result_path) {
      throw new GenerationError('completed H1 experiment is missing its successful evaluation attempt', 'ARTIFACT_INVALID')
    }
    const request = normalizeExperimentEvalRequest(
      this.readJsonContained(attempt.request_path, state.run_directory, 'H1 evaluation request'),
      contract,
      state.contract_sha256,
    )
    const result = normalizeExperimentEvalResult(
      this.readJsonContained(state.eval_result_path, state.run_directory, 'H1 evaluation result'),
      request,
      contract,
    )
    const predictionsPath = this.requireContainedFile(state.run_directory, result.predictions_path, 'H1 evaluation predictions')
    normalizeExperimentPredictionsJsonl(readFileSync(predictionsPath, 'utf8'), result.cases)
    return result
  }

  private assertMaterializationContract(
    state: GenerationState,
    materialization: GenerationMaterialization,
    contract: ExperimentContract,
    pluginId: string,
  ): void {
    const summary = materialization.data_run.summary
    const source = summary.source
    if (
      contract.subject?.plugin_id !== pluginId
      || contract.data.harness_id !== summary.harness_id
      || contract.data.seed !== summary.seed
      || contract.data.canonical_records !== materialization.data_run.canonical_records.length
      || contract.data.logical_training_units !== materialization.data_run.logical_training_view.length
      || contract.data.canonical_jsonl_sha256 !== materialization.canonical_jsonl_sha256
      || contract.data.logical_view_jsonl_sha256 !== materialization.logical_view_jsonl_sha256
      || contract.data.run_summary_json_sha256 !== materialization.run_summary_json_sha256
      || contract.data.dataset_id !== source.dataset_id
      || contract.data.dataset_revision !== source.dataset_revision
      || materialization.source_pool_sha256 !== sha256(this.readRegularText(
        resolve(state.baseline_run_directory, CANONICAL_FILE),
        state.baseline_run_directory,
        'baseline canonical pool',
      ))
    ) throw new GenerationError('H1 contract differs from the frozen materialization', 'ARTIFACT_INVALID')
  }

  private loadFrozenInputs(state: GenerationState, completedReplay = false): FrozenInputs {
    const baseline = this.requireRegularDirectory(state.baseline_run_directory, 'baseline run directory')
    const canonicalPath = this.requireContainedFile(baseline, resolve(baseline, CANONICAL_FILE), 'baseline canonical pool')
    const summaryPath = this.requireContainedFile(baseline, resolve(baseline, SUMMARY_FILE), 'baseline run summary')
    const searchPath = this.requireContainedFile(baseline, resolve(baseline, SEARCH_RESULTS_FILE), 'baseline B_search results')
    const statePath = this.requireContainedFile(baseline, resolve(baseline, BASELINE_STATE_FILE), 'baseline experiment state')
    const reportPath = this.requireContainedFile(baseline, resolve(baseline, EVALUATION_REPORT_FILE), 'baseline B_dev report')
    const contractPath = this.requireContainedFile(baseline, resolve(baseline, EXPERIMENT_CONTRACT_FILE), 'baseline experiment contract')
    const feedbackPath = this.requireContainedFile(baseline, resolve(baseline, FEEDBACK_FILE), 'baseline feedback')
    const canonicalText = readFileSync(canonicalPath, 'utf8')
    const summaryText = readFileSync(summaryPath, 'utf8')
    const contractText = readFileSync(contractPath, 'utf8')
    const canonicalRecords = parseJsonLines(canonicalText, 'baseline canonical pool')
    const baselineSummary = parseStrictJsonObject(summaryText, 'baseline run summary')
    const baselineState = parseStrictJsonObject(readFileSync(statePath, 'utf8'), 'baseline experiment state')
    let baselineContract: ExperimentContract
    let baselineReport: EvaluationReport
    let baselineFeedback: EvolutionFeedback
    try {
      baselineContract = normalizeExperimentContract(parseStrictJsonObject(contractText, 'baseline experiment contract'))
      baselineReport = normalizeEvaluationReport(
        parseStrictJsonObject(readFileSync(reportPath, 'utf8'), 'baseline B_dev report') as unknown as EvaluationReport,
      )
      baselineFeedback = normalizeEvolutionFeedback(
        parseStrictJsonObject(readFileSync(feedbackPath, 'utf8'), 'baseline feedback') as unknown as EvolutionFeedback,
      )
    } catch (error) {
      throw new GenerationError('formal H0 protocol artifacts are invalid', 'ARTIFACT_INVALID', { cause: error })
    }
    const evolution = this.options.evolution.status(state.profile_id)
    const snapshot = this.options.evolution.store.loadConsistentSnapshot(state.profile_id)
    const contractSha256 = sha256(contractText)
    const sourcePoolSha256 = sha256(canonicalText)
    const summarySha256 = sha256(summaryText)
    if (
      baselineState.profile_id !== state.profile_id
      || baselineState.status !== 'succeeded'
      || baselineState.phase !== 'complete'
      || baselineState.run_directory !== baseline
      || typeof baselineState.run_id !== 'string'
      || baselineState.contract_id !== baselineContract.contract_id
      || baselineState.contract_sha256 !== contractSha256
      || baselineState.evaluation_report_id !== baselineReport.report_id
      || baselineState.feedback_id !== baselineFeedback.feedback_id
      || typeof baselineState.eval_result_path !== 'string'
    ) throw new GenerationError('baseline experiment is not the completed profile H0 run', 'ARTIFACT_INVALID')
    if (
      baselineContract.subject !== undefined
      || baselineContract.profile.id !== state.profile_id
      || baselineContract.profile.benchmark !== evolution.profile.benchmark
      || baselineContract.profile.metric !== evolution.profile.acceptance_policy.metric
      || baselineContract.data.canonical_records !== canonicalRecords.length
      || baselineContract.data.canonical_jsonl_sha256 !== sourcePoolSha256
      || baselineContract.data.run_summary_json_sha256 !== summarySha256
      || baselineContract.data.seed !== baselineSummary.seed
      || !isJsonObject(baselineSummary.counts)
      || baselineSummary.counts.canonical_records !== canonicalRecords.length
    ) throw new GenerationError('baseline data artifacts do not match the frozen H0 contract', 'ARTIFACT_INVALID')
    if (
      baselineReport.profile_id !== state.profile_id
      || baselineReport.run_id !== baselineState.run_id
      || baselineReport.candidate_id !== H0_CANDIDATE_ID
      || baselineReport.benchmark !== evolution.profile.benchmark
      || baselineReport.split !== 'B_dev'
      || baselineReport.metric !== evolution.profile.acceptance_policy.metric
      || !baselineReport.complete
      || baselineReport.cases_expected === undefined
      || baselineReport.cases_evaluated !== baselineReport.cases_expected
      || !isJsonObject(baselineReport.metadata)
      || baselineReport.metadata.contract_id !== baselineContract.contract_id
      || baselineReport.metadata.contract_sha256 !== contractSha256
    ) throw new GenerationError('baseline B_dev report does not match the frozen H0 run', 'ARTIFACT_INVALID')
    const storedEvaluation = snapshot.evaluation_records.find(record => record.report.report_id === baselineReport.report_id)
    if (
      storedEvaluation?.decision !== undefined
      || canonicalJson(storedEvaluation?.report ?? null) !== canonicalJson(baselineReport)
      || (!completedReplay && (
        evolution.state.active_evaluation?.report_id !== baselineReport.report_id
        || evolution.state.active_evaluation.candidate_id !== H0_CANDIDATE_ID
        || evolution.state.active_evaluation.score !== baselineReport.score
        || evolution.state.active_evaluation.split !== baselineReport.split
        || evolution.state.active_evaluation.metric !== baselineReport.metric
      ))
    ) throw new GenerationError('Evolution H0 evaluation does not match the baseline report', 'ARTIFACT_INVALID')
    const predictionsPath = this.requireContainedFile(
      baseline,
      resolve(dirname(baselineState.eval_result_path), 'predictions.jsonl'),
      'baseline predictions',
    )
    const search = normalizeGenerationBSearchResults(
      parseStrictJsonObject(readFileSync(searchPath, 'utf8'), 'baseline B_search results'),
      {
        profile_id: state.profile_id,
        run_id: baselineState.run_id,
        contract_id: baselineContract.contract_id,
        contract_sha256: contractSha256,
        case_ids: baselineContract.evaluation.case_ids.B_search,
        categories: baselineContract.evaluation.categories,
        cases_per_category: baselineContract.evaluation.cases_per_category_per_split,
      },
    )
    const predictions = parseJsonLines(readFileSync(predictionsPath, 'utf8'), 'baseline predictions')
      .filter(value => value.split === 'B_search')
    const casesPath = this.requireRegularFile(state.b_search_cases_jsonl, 'B_search case bundle')
    const cases = parseJsonLines(readFileSync(casesPath, 'utf8'), 'B_search case bundle')
    if (
      cases.some(value => value.split !== 'search')
      || canonicalJson(cases.map(value => value.id)) !== canonicalJson(baselineContract.evaluation.case_ids.B_search)
      || canonicalJson(predictions.map(value => value.case_id)) !== canonicalJson(baselineContract.evaluation.case_ids.B_search)
    ) {
      throw new GenerationError('proposal case bundle must contain B_search cases only', 'ARTIFACT_INVALID')
    }
    if (!completedReplay && (
      evolution.state.generation !== 0
      || evolution.state.active_candidate_id !== H0_CANDIDATE_ID
      || evolution.state.open_candidate_id !== null
      || evolution.state.active_evaluation === undefined
    )) throw new GenerationError('Stage 4C requires a durable H0 baseline with no open candidate', 'INVALID_REQUEST')
    const feedback = completedReplay
      ? snapshot.feedback_records.find(value => value.feedback_id === baselineState.feedback_id)
      : this.options.evolution.feedback(state.profile_id)
    const expectedFailures = search.cases.filter(value => !value.passed).map(value => ({
      case_id: value.case_id,
      summary: value.failure_summary ?? 'BFCL checker rejected prediction',
      category: value.category,
    }))
    if (
      feedback === undefined
      || feedback.candidate_id !== H0_CANDIDATE_ID
      || feedback.split !== 'B_search'
      || feedback.feedback_id !== baselineState.feedback_id
      || canonicalJson(feedback) !== canonicalJson(baselineFeedback)
      || feedback.artifact_path !== searchPath
      || feedback.metadata?.run_id !== baselineState.run_id
      || feedback.metadata.contract_id !== baselineContract.contract_id
      || feedback.metadata.contract_sha256 !== contractSha256
      || feedback.metadata.cases_evaluated !== search.cases.length
      || feedback.metrics?.macro_score !== search.macro_score
      || canonicalJson(feedback.failures) !== canonicalJson(expectedFailures)
    ) {
      throw new GenerationError('Stage 4C requires H0 B_search feedback bound to the baseline artifact', 'INVALID_REQUEST')
    }
    const failedIds = new Set(search.cases.filter(value => !value.passed).map(value => value.case_id))
    const casesById = new Map(cases.filter(isJsonObject)
      .filter(value => typeof value.id === 'string')
      .map(value => [value.id as string, value]))
    const predictionsById = new Map(predictions.filter(isJsonObject)
      .filter(value => typeof value.case_id === 'string')
      .map(value => [value.case_id as string, value]))
    const failures: GenerationFailureContext[] = [...failedIds].sort().map(caseId => {
      const test = casesById.get(caseId)
      const prediction = predictionsById.get(caseId)
      if (test === undefined || prediction === undefined) {
        throw new GenerationError(`B_search failure ${caseId} is missing case or prediction evidence`, 'ARTIFACT_INVALID')
      }
      return Object.freeze({
        case_id: caseId,
        category: typeof test.category === 'string' ? test.category : 'unknown',
        prompt: test.messages ?? null,
        functions: test.functions ?? null,
        expected: test.ground_truth ?? null,
        observed: prediction.tool_calls ?? null,
        failure_summary: typeof prediction.failure_summary === 'string'
          ? prediction.failure_summary
          : 'BFCL checker rejected prediction',
      })
    })
    const metrics: Record<string, number> = {}
    for (const [key, value] of Object.entries(feedback.metrics ?? {})) {
      if (Number.isFinite(value)) metrics[key] = value
    }
    const proposalContext: GenerationProposalContext = Object.freeze({
      profile_id: evolution.profile.id,
      benchmark: evolution.profile.benchmark,
      strategy_plugin_id: evolution.profile.strategy_plugin_id,
      strategy_version: state.strategy_version,
      generation: 1,
      seed: typeof baselineSummary.seed === 'number' ? baselineSummary.seed : 42,
      allowed_capabilities: [...evolution.profile.capabilities],
      b_search: Object.freeze({
        summary: feedback.summary,
        metrics: Object.freeze(metrics),
        failures: Object.freeze(failures),
      }),
      source_pool: Object.freeze({
        canonical_records: canonicalRecords.length,
        canonical_jsonl_sha256: sourcePoolSha256,
        records: Object.freeze(canonicalRecords.map(record => summarizeCanonicalRecord(record))),
      }),
    })
    return Object.freeze({
      canonicalRecords,
      baselineSummary,
      proposalContext,
      sourcePoolSha256,
      baselineFeedbackId: feedback.feedback_id,
    })
  }

  private assertExpectedProposalContext(context: GenerationProposalContext): void {
    const expected = this.options.expected_proposal_context_sha256
    if (expected === undefined) return
    const actual = sha256(`${canonicalJson(context)}\n`)
    if (actual !== expected) {
      throw new GenerationError(
        'recomputed proposal context differs from the protocol-bound context',
        'ARTIFACT_INVALID',
      )
    }
  }

  private candidatePackage(state: GenerationState, draft: GenerationDraft): CandidatePackage {
    const status = this.options.evolution.status(state.profile_id)
    return Object.freeze({
      manifest: Object.freeze({
        schema_version: 'autodata-candidate-manifest-2',
        candidate_id: state.candidate_id,
        profile_id: state.profile_id,
        generation: status.state.generation + 1,
        parent_candidate_id: status.state.active_candidate_id,
        strategy_version: state.strategy_version,
        capabilities: status.profile.capabilities,
        description: draft.description,
      }),
      host_source: draft.host_source,
    })
  }

  private formalCandidatePackage(
    state: GenerationState,
    source: string,
    materialization: GenerationMaterialization,
  ): CandidatePackage {
    const passed = state.attempts.find(attempt => attempt.status === 'passed')
    if (passed === undefined) throw new GenerationError('formal candidate has no passed draft', 'STATE_CORRUPT')
    const response = this.ledger.readJson(passed.response_path, 'accepted ephemeral draft')
    if (
      typeof response.host_source !== 'string'
      || response.host_source !== source
      || typeof response.description !== 'string'
      || response.description.trim().length === 0
    ) throw new GenerationError('accepted draft response does not match the frozen candidate source', 'ARTIFACT_INVALID')
    const profile = this.options.evolution.status(state.profile_id).profile
    const runtimeBinding = this.runtimeBindingForMaterialization(
      state,
      materialization,
      state.candidate_source_sha256 as string,
      state.materialization_sha256 as string,
    )
    const candidate: CandidatePackage = Object.freeze({
      manifest: Object.freeze({
        schema_version: 'autodata-candidate-manifest-2',
        candidate_id: state.candidate_id,
        profile_id: state.profile_id,
        generation: 1,
        parent_candidate_id: H0_CANDIDATE_ID,
        strategy_version: state.strategy_version,
        capabilities: profile.capabilities,
        description: response.description,
        metadata: {
          generation_run_id: state.run_id,
          execution_commit: state.execution_commit,
          source_sha256: state.candidate_source_sha256 as string,
          materialization_sha256: state.materialization_sha256 as string,
          runtime_binding: runtimeBinding as unknown as JsonObject,
          draft_attempt: passed.attempt,
        },
      }),
      host_source: source,
    })
    try {
      candidateRuntimeHostSource(profile, candidate)
    } catch (error) {
      throw new GenerationError('frozen candidate runtime plan cannot be compiled safely', 'VALIDATION_FAILED', {
        cause: error,
      })
    }
    return candidate
  }

  private assertRuntimePlanCompiles(
    state: GenerationState,
    draft: GenerationDraft,
    runtimeBinding: ReturnType<typeof createFrozenSelectionRuntimeBinding>,
    materializationSha256: string,
  ): void {
    const profile = this.options.evolution.status(state.profile_id).profile
    const candidate = this.candidatePackage(state, draft)
    try {
      candidateRuntimeHostSource(profile, {
        ...candidate,
        manifest: {
          ...candidate.manifest,
          metadata: {
            generation_run_id: state.run_id,
            source_sha256: sha256(draft.host_source),
            materialization_sha256: materializationSha256,
            runtime_binding: runtimeBinding as unknown as JsonObject,
          },
        },
      })
    } catch (error) {
      throw new GenerationError('frozen candidate runtime plan cannot be compiled safely', 'VALIDATION_FAILED', {
        cause: error,
      })
    }
  }

  private runtimeBindingForMaterialization(
    state: GenerationState,
    materialization: GenerationMaterialization,
    hostSourceSha256: string,
    materializationSha256: string,
  ) {
    const profile = this.options.evolution.status(state.profile_id).profile
    const frozen = this.loadFrozenInputs(state, true)
    const dataRun = materialization.data_run
    if (
      !Array.isArray(dataRun.canonical_records)
      || !Array.isArray(dataRun.logical_training_view)
      || !isJsonObject(dataRun.summary)
      || !isJsonObject(dataRun.summary.source)
    ) throw new GenerationError('materialized data cannot define a frozen runtime binding', 'ARTIFACT_INVALID')
    if (
      dataRun.summary.generation !== 1
      || dataRun.summary.harness_id !== `${profile.strategy_plugin_id}-h1`
      || dataRun.summary.seed !== frozen.proposalContext.seed
      || !Number.isSafeInteger(dataRun.summary.seed)
      || !Array.isArray(dataRun.summary.plugins)
      || dataRun.summary.plugins.length !== 1
      || dataRun.summary.plugins[0]?.id !== profile.strategy_plugin_id
      || dataRun.summary.plugins[0]?.version !== state.strategy_version
    ) throw new GenerationError('materialized runtime identity differs from the candidate', 'ARTIFACT_INVALID')
    const canonicalText = `${dataRun.canonical_records.map(value => canonicalJson(value)).join('\n')}\n`
    const logicalText = `${dataRun.logical_training_view.map(value => canonicalJson(value)).join('\n')}\n`
    const summaryText = `${canonicalJson(dataRun.summary)}\n`
    if (
      canonicalJson(dataRun.canonical_records) !== canonicalJson(frozen.canonicalRecords)
      || materialization.source_pool_sha256 !== frozen.sourcePoolSha256
      || materialization.canonical_jsonl_sha256 !== sha256(canonicalText)
      || materialization.logical_view_jsonl_sha256 !== sha256(logicalText)
      || materialization.run_summary_json_sha256 !== sha256(summaryText)
    ) throw new GenerationError('materialized data differs from the frozen H0 source pool', 'ARTIFACT_INVALID')
    const sourceRecordIds = materialization.data_run.canonical_records.map((record, index) => {
      if (!isJsonObject(record.source) || typeof record.source.record_id !== 'string') {
        throw new GenerationError(`materialized canonical record ${String(index)} has no record_id`, 'ARTIFACT_INVALID')
      }
      for (const key of ['adapter_id', 'adapter_version', 'dataset_id', 'dataset_revision'] as const) {
        if (record.source[key] !== dataRun.summary.source[key]) {
          throw new GenerationError(`materialized canonical record ${String(index)} has inconsistent source identity`, 'ARTIFACT_INVALID')
        }
      }
      return record.source.record_id
    })
    if (new Set(sourceRecordIds).size !== sourceRecordIds.length) {
      throw new GenerationError('materialized canonical record ids are not unique', 'ARTIFACT_INVALID')
    }
    const decisionsByRank = new Map<number, { readonly record_id: string; readonly note?: string }>()
    for (const [index, unit] of dataRun.logical_training_view.entries()) {
      if (
        !isJsonObject(unit.source)
        || typeof unit.source.record_id !== 'string'
        || !Number.isSafeInteger(unit.selection_rank)
        || unit.selection_rank < 0
        || !Array.isArray(unit.plugin_provenance)
        || unit.plugin_provenance.length !== 1
      ) throw new GenerationError(`materialized logical unit ${String(index)} cannot define a frozen decision`, 'ARTIFACT_INVALID')
      const provenance = unit.plugin_provenance[0]
      if (
        !isJsonObject(provenance)
        || provenance.plugin_id !== profile.strategy_plugin_id
        || provenance.plugin_version !== state.strategy_version
        || (provenance.note !== undefined && typeof provenance.note !== 'string')
      ) throw new GenerationError(`materialized logical unit ${String(index)} has invalid candidate provenance`, 'ARTIFACT_INVALID')
      const decision = Object.freeze({
        record_id: unit.source.record_id,
        ...(provenance.note === undefined ? {} : { note: provenance.note }),
      })
      const existing = decisionsByRank.get(unit.selection_rank)
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(decision)) {
        throw new GenerationError(`materialized selection rank ${String(unit.selection_rank)} is inconsistent`, 'ARTIFACT_INVALID')
      }
      decisionsByRank.set(unit.selection_rank, decision)
    }
    const decisions = materialization.selected_record_ids.map((recordId, rank) => {
      const decision = decisionsByRank.get(rank)
      if (decision?.record_id !== recordId) {
        throw new GenerationError(`materialized selection rank ${String(rank)} does not match selected_record_ids`, 'ARTIFACT_INVALID')
      }
      return decision
    })
    if (decisionsByRank.size !== decisions.length) {
      throw new GenerationError('materialized selection ranks are not contiguous', 'ARTIFACT_INVALID')
    }
    return createFrozenSelectionRuntimeBinding({
      profile_id: state.profile_id,
      candidate_id: state.candidate_id,
      generation: 1,
      parent_candidate_id: H0_CANDIDATE_ID,
      plugin_id: profile.strategy_plugin_id,
      strategy_version: state.strategy_version,
      host_source_sha256: hostSourceSha256,
      source_pool_sha256: materialization.source_pool_sha256,
      materialization_sha256: materializationSha256,
      harness_id: dataRun.summary.harness_id,
      seed: dataRun.summary.seed,
      source: dataRun.summary.source,
      source_record_ids: sourceRecordIds,
      decisions,
    })
  }

  private readFrozenMaterialization(state: GenerationState): GenerationMaterialization {
    if (
      state.materialized_data_path === undefined
      || state.materialization_sha256 === undefined
      || state.candidate_source_sha256 === undefined
    ) throw new GenerationError('formal candidate is missing frozen materialization evidence', 'STATE_CORRUPT')
    const passed = state.attempts.find(attempt => attempt.status === 'passed')
    if (passed === undefined) throw new GenerationError('formal candidate has no passed materialization', 'STATE_CORRUPT')
    const evidencePath = resolve(dirname(passed.response_path), 'materialization-1.json')
    const secondEvidencePath = resolve(dirname(passed.response_path), 'materialization-2.json')
    const evidence = this.ledger.readJson(
      this.requireContainedFile(state.run_directory, evidencePath, 'candidate materialization evidence'),
      'candidate materialization evidence',
    )
    const secondEvidence = this.ledger.readJson(
      this.requireContainedFile(state.run_directory, secondEvidencePath, 'second candidate materialization evidence'),
      'second candidate materialization evidence',
    )
    if (canonicalJson(secondEvidence) !== canonicalJson(evidence)) {
      throw new GenerationError('the two frozen materialization evidence files differ', 'ARTIFACT_INVALID')
    }
    const dataRun = this.ledger.readJson(
      this.requireContainedFile(state.run_directory, state.materialized_data_path, 'H1 materialized data'),
      'H1 materialized data',
    )
    const materialization = normalizeMaterialization({ ...evidence, data_run: dataRun }, state.candidate_id)
    if (
      !Array.isArray(materialization.data_run.canonical_records)
      || !Array.isArray(materialization.data_run.logical_training_view)
      || !isJsonObject(materialization.data_run.summary)
    ) throw new GenerationError('materialized H1 data_run has an invalid shape', 'ARTIFACT_INVALID')
    const canonicalText = `${materialization.data_run.canonical_records.map(value => canonicalJson(value)).join('\n')}\n`
    const logicalText = `${materialization.data_run.logical_training_view.map(value => canonicalJson(value)).join('\n')}\n`
    const summaryText = `${canonicalJson(materialization.data_run.summary)}\n`
    const selectedByRank = new Map<number, string>()
    for (const unit of materialization.data_run.logical_training_view) {
      const selectionRank = unit.selection_rank
      const unitSource = unit.source
      if (
        !isJsonObject(unit)
        || typeof selectionRank !== 'number'
        || !Number.isSafeInteger(selectionRank)
        || selectionRank < 0
        || !isJsonObject(unitSource)
        || typeof unitSource.record_id !== 'string'
      ) throw new GenerationError('materialized logical training unit has an invalid selection identity', 'ARTIFACT_INVALID')
      const existing = selectedByRank.get(selectionRank)
      if (existing !== undefined && existing !== unitSource.record_id) {
        throw new GenerationError('materialized selection rank refers to multiple records', 'ARTIFACT_INVALID')
      }
      selectedByRank.set(selectionRank, unitSource.record_id)
    }
    const selectedIds = [...selectedByRank.entries()]
      .sort(([left], [right]) => left - right)
      .map(([rank, recordId], index) => {
        if (rank !== index) throw new GenerationError('materialized selection ranks are not contiguous', 'ARTIFACT_INVALID')
        return recordId
      })
    if (
      materialization.host_source_sha256 !== state.candidate_source_sha256
      || materialization.source_pool_sha256 !== sha256(canonicalText)
      || materialization.canonical_jsonl_sha256 !== sha256(canonicalText)
      || materialization.logical_view_jsonl_sha256 !== sha256(logicalText)
      || materialization.run_summary_json_sha256 !== sha256(summaryText)
      || canonicalJson(selectedIds) !== canonicalJson(materialization.selected_record_ids)
      || sha256(materializationDigest(materialization)) !== state.materialization_sha256
    ) throw new GenerationError('materialized H1 data no longer matches the two-process gate', 'ARTIFACT_INVALID')
    return materialization
  }

  private materializationRequest(
    state: GenerationState,
    frozen: FrozenInputs,
    draft: GenerationDraft,
  ): GenerationMaterializationRequest {
    return Object.freeze({
      profile_id: state.profile_id,
      candidate_id: state.candidate_id,
      generation: 1,
      strategy_plugin_id: frozen.proposalContext.strategy_plugin_id,
      strategy_version: state.strategy_version,
      host_source: draft.host_source,
      harness_id: `${frozen.proposalContext.strategy_plugin_id}-h1`,
      seed: frozen.proposalContext.seed,
      canonical_records: frozen.canonicalRecords,
      baseline_summary: frozen.baselineSummary,
    })
  }

  private loadBoundExperimentContract(
    state: GenerationState,
    experimentRunDirectory: string,
    contractId: string,
    contractSha256: string,
  ): ExperimentContract {
    const path = this.requireContainedFile(
      experimentRunDirectory,
      resolve(experimentRunDirectory, EXPERIMENT_CONTRACT_FILE),
      'H1 experiment contract',
    )
    const text = readFileSync(path, 'utf8')
    if (sha256(text) !== contractSha256) {
      throw new GenerationError('H1 experiment contract bytes do not match experiment state', 'ARTIFACT_INVALID')
    }
    let contract: ExperimentContract
    try {
      contract = normalizeExperimentContract(parseStrictJsonObject(text, 'H1 experiment contract'))
    } catch (error) {
      throw new GenerationError('H1 experiment contract is invalid', 'ARTIFACT_INVALID', { cause: error })
    }
    const materialization = this.readFrozenMaterialization(state)
    const runtimeBinding = this.runtimeBindingForMaterialization(
      state,
      materialization,
      state.candidate_source_sha256 as string,
      state.materialization_sha256 as string,
    )
    if (
      contract.contract_id !== contractId
      || contract.subject?.candidate_id !== state.candidate_id
      || contract.subject.generation !== 1
      || contract.subject.strategy_version !== state.strategy_version
      || contract.subject.host_source_sha256 !== state.candidate_source_sha256
      || contract.subject.runtime_plan_sha256 !== runtimeBinding.runtime_plan_sha256
      || contract.subject.materialization_sha256 !== runtimeBinding.materialization_sha256
      || contract.profile.id !== state.profile_id
    ) throw new GenerationError('H1 experiment contract does not match the frozen candidate', 'ARTIFACT_INVALID')
    return contract
  }

  private feedbackFromSearch(
    state: GenerationState,
    search: GenerationBSearchResults,
    artifactPath: string,
  ): EvolutionFeedback {
    const failures = search.cases
      .filter(value => !value.passed)
      .map(value => ({
        case_id: value.case_id,
        summary: value.failure_summary ?? 'BFCL checker rejected prediction',
        category: value.category,
      }))
    const metrics: Record<string, number> = { macro_score: search.macro_score }
    for (const [category, value] of Object.entries(search.category_scores)) metrics[`category_${category}`] = value
    const digest = sha256(canonicalJson(search))
    return normalizeEvolutionFeedback({
      schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
      feedback_id: `h1-search-${digest.slice(0, 20)}`,
      profile_id: state.profile_id,
      candidate_id: state.candidate_id,
      benchmark: this.options.evolution.status(state.profile_id).profile.benchmark,
      split: 'B_search',
      summary: `H1 completed ${String(search.cases.length)} B_search cases; macro ${String(search.macro_score)}`,
      failures,
      metrics,
      artifact_path: artifactPath,
      metadata: {
        generation_run_id: state.run_id,
        experiment_run_id: state.experiment_run_id,
        cases_evaluated: search.cases.length,
      },
    })
  }

  private startExperiment(request: unknown, agent: EvolutionRuntimeAgent): ReturnType<GenerationControllerOptions['experiment']['start']> {
    const start = this.options.experiment.start as unknown as (value: unknown, runtimeAgent?: EvolutionRuntimeAgent) => ReturnType<GenerationControllerOptions['experiment']['start']>
    return start.call(this.options.experiment, request, agent)
  }

  private resumeExperiment(profileId: string, runId: string, agent: EvolutionRuntimeAgent): ReturnType<GenerationControllerOptions['experiment']['resume']> {
    const resume = this.options.experiment.resume as unknown as (profile: string, run: string, runtimeAgent?: EvolutionRuntimeAgent) => ReturnType<GenerationControllerOptions['experiment']['resume']>
    return resume.call(this.options.experiment, profileId, runId, agent)
  }

  private assertEvolutionReady(request: GenerationStartRequest): void {
    const status = this.options.evolution.status(request.profile_id)
    let candidatePackages: readonly CandidatePackage[]
    try {
      candidatePackages = this.options.evolution.store.listCandidates(request.profile_id)
    } catch (error) {
      throw new GenerationError('cannot inspect durable candidate history before Stage 4C start', 'STATE_CORRUPT', {
        profile_id: request.profile_id,
        run_id: request.run_id,
        cause: error,
      })
    }
    if (
      status.state.candidates.some(candidate => candidate.candidate_id !== H0_CANDIDATE_ID)
      || candidatePackages.length > 0
    ) {
      throw new GenerationError(
        `TaskProfile ${request.profile_id} already has formal H1 candidate history`,
        'RUN_EXISTS',
        { profile_id: request.profile_id, run_id: request.run_id },
      )
    }
    if (
      status.state.generation !== 0
      || status.state.active_candidate_id !== H0_CANDIDATE_ID
      || status.state.open_candidate_id !== null
      || status.state.active_evaluation === undefined
    ) throw new GenerationError('Stage 4C start requires completed H0 with no open candidate', 'INVALID_REQUEST')
    if (this.options.evolution.feedback(request.profile_id)?.candidate_id !== H0_CANDIDATE_ID) {
      throw new GenerationError('Stage 4C start requires current H0 B_search feedback', 'INVALID_REQUEST')
    }
  }

  private strictOrphanProposalError(response: Record<string, unknown>, directory: string): string {
    if (
      Object.keys(response).length !== 1
      || typeof response.error !== 'string'
      || response.error.trim().length === 0
      || response.error.length > MAX_DRAFT_FAILURE_CHARACTERS
    ) throw new GenerationError('orphan proposal error response is malformed', 'ARTIFACT_INVALID')
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch (error) {
      throw new GenerationError('cannot inspect orphan proposal error directory', 'ARTIFACT_INVALID', { cause: error })
    }
    if (
      entries.length !== 1
      || entries[0]?.name !== 'response.json'
      || entries[0].isSymbolicLink()
      || !entries[0].isFile()
    ) throw new GenerationError('orphan proposal error must be the draft directory\'s only artifact', 'ARTIFACT_INVALID')
    return response.error
  }

  private save(
    state: GenerationState,
    patch: { [Key in keyof GenerationState]?: GenerationState[Key] | undefined },
  ): GenerationState {
    const next = { ...state, ...patch, updated_at: nowIso(this.now) } as Record<string, unknown>
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete next[key]
    }
    return this.ledger.saveState(next as unknown as GenerationState)
  }

  private jobs(): NonNullable<GenerationControllerOptions['jobs']> {
    const jobs = this.options.jobs ?? this.ctx.get('jobs', false) as NonNullable<GenerationControllerOptions['jobs']> | undefined
    if (jobs === undefined) throw new GenerationError('DSH jobs provider is unavailable', 'DEPENDENCY_UNAVAILABLE')
    return jobs
  }

  private ensureJobController(jobs: NonNullable<GenerationControllerOptions['jobs']>): void {
    this.detachJobController ??= jobs.attachController('autodata-generation-controller')
  }

  private note(live: LiveGeneration, value: string): void {
    live.output.push(value)
  }

  private retainSession(profileId: string, session: GenerationProposalSession): void {
    const previous = this.retainedSessions.get(profileId)
    if (previous !== undefined && previous !== session) void previous.dispose().catch(() => undefined)
    this.retainedSessions.set(profileId, session)
  }

  private retainSessionIfNeeded(state: GenerationState, session: GenerationProposalSession): void {
    if (state.decision?.accepted === true) this.retainSession(state.profile_id, session)
  }

  private isRetained(session: GenerationProposalSession): boolean {
    return [...this.retainedSessions.values()].includes(session)
  }

  private requireRegularDirectory(pathInput: string, label: string): string {
    if (!isAbsolute(pathInput)) throw new GenerationError(`${label} must be absolute`, 'PATH_ESCAPE')
    const path = resolve(pathInput)
    let stat
    try { stat = lstatSync(path) } catch (error) { throw new GenerationError(`cannot inspect ${label}: ${path}`, 'ARTIFACT_INVALID', { cause: error }) }
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path) {
      throw new GenerationError(`${label} must be a real directory without symlink aliases`, 'PATH_ESCAPE')
    }
    return path
  }

  private requireRegularFile(pathInput: string, label: string): string {
    if (!isAbsolute(pathInput)) throw new GenerationError(`${label} must be absolute`, 'PATH_ESCAPE')
    const path = resolve(pathInput)
    let stat
    try { stat = lstatSync(path) } catch (error) { throw new GenerationError(`cannot inspect ${label}: ${path}`, 'ARTIFACT_INVALID', { cause: error }) }
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(path) !== path) {
      throw new GenerationError(`${label} must be a real regular file without symlink aliases`, 'PATH_ESCAPE')
    }
    return path
  }

  private requireContainedFile(rootInput: string, pathInput: string, label: string): string {
    const root = resolve(rootInput)
    const path = resolve(pathInput)
    const child = relative(root, path)
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new GenerationError(`${label} escapes the baseline run directory`, 'PATH_ESCAPE')
    }
    return this.requireRegularFile(path, label)
  }

  private readRegularText(path: string, root: string, label: string): string {
    return readFileSync(this.requireContainedFile(root, path, label), 'utf8')
  }

  private readJsonContained(path: string, root: string, label: string): Record<string, unknown> {
    return parseStrictJsonObject(this.readRegularText(path, root, label), label)
  }

  private assertUsable(): void {
    if (this.disposed) throw new GenerationError('generation controller is disposed', 'DEPENDENCY_UNAVAILABLE')
  }
}

function materializationEvidence(value: GenerationMaterialization): Record<string, unknown> {
  return {
    schema_version: value.schema_version,
    candidate_id: value.candidate_id,
    host_source_sha256: value.host_source_sha256,
    source_pool_sha256: value.source_pool_sha256,
    canonical_jsonl_sha256: value.canonical_jsonl_sha256,
    logical_view_jsonl_sha256: value.logical_view_jsonl_sha256,
    run_summary_json_sha256: value.run_summary_json_sha256,
    selected_record_ids: value.selected_record_ids,
  }
}

function summarizeCanonicalRecord(value: JsonObject): GenerationProposalContext['source_pool']['records'][number] {
  if (!isJsonObject(value.source) || typeof value.source.record_id !== 'string' || !Array.isArray(value.messages) || !Array.isArray(value.tools)) {
    throw new GenerationError('baseline canonical pool contains a malformed record', 'ARTIFACT_INVALID')
  }
  const messages = value.messages.filter(isJsonObject) as unknown as CanonicalMessage[]
  const userText = messages.filter(message => message.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : canonicalJson(message.content ?? null))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .slice(0, 320)
  const assistants = messages.filter(message => message.role === 'assistant')
  const assistantToolNames = new Set<string>()
  for (const message of assistants) {
    if (!Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls.filter(isJsonObject)) {
      if (isJsonObject(call.function) && typeof call.function.name === 'string') assistantToolNames.add(call.function.name)
    }
  }
  const availableToolNames = new Set<string>()
  for (const tool of value.tools.filter(isJsonObject)) {
    if (isJsonObject(tool.function) && typeof tool.function.name === 'string') availableToolNames.add(tool.function.name)
  }
  return Object.freeze({
    record_id: value.source.record_id,
    user_excerpt: userText,
    assistant_tool_names: Object.freeze([...assistantToolNames].sort()),
    available_tool_names: Object.freeze([...availableToolNames].sort()),
    assistant_messages: assistants.length,
    no_tool_assistant_messages: assistants.filter(message => !Array.isArray(message.tool_calls) || message.tool_calls.length === 0).length,
  })
}

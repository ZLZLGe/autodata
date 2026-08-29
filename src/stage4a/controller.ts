/** Host-only orchestration for the fixed Stage 4A compatibility gate. */

import type { Context } from '@deepseek-ai/cordis'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { canonicalJson } from '../core/json.js'
import {
  createStage4AEvalRequest,
  createStage4ATrainRequest,
  normalizeStage4AEvalRequest,
  normalizeStage4AEvalResult,
  normalizeStage4AStartRequest,
  normalizeStage4ATrainRequest,
  normalizeStage4ATrainResult,
  validateStage4AId,
} from './contracts.js'
import { Stage4ALedger } from './ledger.js'
import { prepareStage4AData, stageStage4AAssets, stageStage4AData } from './materializer.js'
import { Stage4ARJobClient } from './rjob.js'
import {
  createInitialStage4AState,
  normalizeStage4AState,
  replaceStage4AAttempt,
  stage4ARJobName,
} from './state.js'
import {
  Stage4AError,
  type Stage4AAttempt,
  type Stage4ACommandResult,
  type Stage4AControllerOptions,
  type Stage4AEvalRequest,
  type Stage4AJobRegistry,
  type Stage4ARJobBackend,
  type Stage4ARJobSpec,
  type Stage4AStage,
  type Stage4AStartRequest,
  type Stage4AState,
  type Stage4AStatus,
  type Stage4ATrainRequest,
} from './types.js'

const OUTPUT_LIMIT_BYTES = 64 * 1024
const DEFAULT_POLL_INTERVAL_MS = 30_000

interface LiveRun {
  readonly abort: AbortController
  readonly done: Promise<import('@deepseek-ai/dsh-jobs').JobOutcome>
  readonly output: string[]
  jobId?: JobId
  remoteName?: string
  remoteConfirmed?: boolean
  stop?: Promise<Stage4ACommandResult>
}

function key(profileId: string, runId: string): string {
  return `${profileId}\0${runId}`
}

function nowIso(now: () => Date): string {
  const value = now()
  if (!Number.isFinite(value.getTime())) throw new Stage4AError('Stage 4A clock returned an invalid Date', 'STORE_IO')
  return value.toISOString()
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timeout = setTimeout(resolveSleep, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      reject(signal.reason)
    }, { once: true })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resultPath(state: Stage4AState, stage: Stage4AStage, attempt: number): string {
  return resolve(state.staging_directory, 'outputs', stage, `attempt-${String(attempt)}`, 'result.json')
}

function outputRoot(state: Stage4AState, stage: Stage4AStage, attempt: number): string {
  return resolve(state.staging_directory, 'outputs', stage, `attempt-${String(attempt)}`)
}

/** Resumable orchestrator. It never invokes the Stage 3 evaluation/activation controller. */
export class Stage4AController {
  private readonly ledger: Stage4ALedger
  private readonly assetRoot: string
  private readonly pollIntervalMs: number
  private readonly now: () => Date
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly profileExists: (profileId: string) => boolean
  private backendValue: Stage4ARJobBackend | undefined
  private jobsValue: Stage4AJobRegistry | undefined
  private detachJobController: (() => void) | undefined
  private readonly live = new Map<string, LiveRun>()
  private readonly processJobs = new Map<string, JobId>()
  private disposed = false

  constructor(private readonly ctx: Context, options: Stage4AControllerOptions = {}) {
    this.ledger = new Stage4ALedger(options.run_root, options.staging_root)
    this.assetRoot = resolve(options.asset_root ?? fileURLToPath(new URL('../../stage4a', import.meta.url)))
    const pollInterval = options.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS
    if (!Number.isFinite(pollInterval) || pollInterval < 0) {
      throw new Stage4AError('poll_interval_ms must be a finite non-negative number', 'INVALID_REQUEST')
    }
    this.pollIntervalMs = pollInterval
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? defaultSleep
    this.profileExists = options.profile_exists ?? (() => true)
    this.backendValue = options.backend
    this.jobsValue = options.jobs
  }

  start(request: Stage4AStartRequest): Stage4AStatus {
    this.assertUsable()
    request = normalizeStage4AStartRequest(request)
    const profileId = request.profile_id
    const runId = request.run_id
    if (!this.profileExists(profileId)) {
      throw new Stage4AError(`unknown TaskProfile ${profileId}`, 'INVALID_REQUEST', { profile_id: profileId, run_id: runId })
    }
    if (this.live.has(key(profileId, runId))) {
      throw new Stage4AError(`Stage 4A run ${profileId}/${runId} is already live`, 'RUN_EXISTS')
    }
    const directories = {
      run: this.ledger.runDirectory(profileId, runId),
      staging: this.ledger.stagingDirectory(runId),
    }
    const prepared = prepareStage4AData(request.data_run, directories.staging)
    const created = nowIso(this.now)
    let state = createInitialStage4AState({
      profile_id: profileId,
      run_id: runId,
      run_directory: directories.run,
      staging_directory: directories.staging,
      now: created,
    })
    state = this.ledger.initializeRun(state, {
      ...prepared.files,
      'materialized.json': `${canonicalJson(prepared.materialized)}\n`,
    })
    state = this.completeInitialization(state)
    return this.launch(state, false)
  }

  status(profileIdInput: string, runIdInput: string): Stage4AStatus {
    this.assertUsable()
    const profileId = validateStage4AId(profileIdInput, 'profile_id')
    const runId = validateStage4AId(runIdInput, 'run_id')
    const state = this.ledger.loadState(profileId, runId)
    const jobId = this.processJobs.get(key(profileId, runId))
    return Object.freeze({ state, ...(jobId === undefined ? {} : { job_id: jobId }) })
  }

  resume(profileIdInput: string, runIdInput: string): Stage4AStatus {
    this.assertUsable()
    const profileId = validateStage4AId(profileIdInput, 'profile_id')
    const runId = validateStage4AId(runIdInput, 'run_id')
    if (this.live.has(key(profileId, runId))) {
      throw new Stage4AError(`Stage 4A run ${profileId}/${runId} is already live`, 'RUN_EXISTS')
    }
    const state = this.ledger.loadState(profileId, runId)
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') {
      return this.status(profileId, runId)
    }
    return this.launch(state, true)
  }

  async cancel(profileIdInput: string, runIdInput: string): Promise<Stage4AStatus> {
    this.assertUsable()
    const profileId = validateStage4AId(profileIdInput, 'profile_id')
    const runId = validateStage4AId(runIdInput, 'run_id')
    const runKey = key(profileId, runId)
    const active = this.live.get(runKey)
    if (active?.jobId !== undefined) {
      this.jobs().kill(active.jobId, undefined, 'Stage 4A cancelled by Host')
      await active.done
      return this.status(profileId, runId)
    }
    let state = this.ledger.loadState(profileId, runId)
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') {
      return Object.freeze({ state })
    }
    const attempt = state.attempts.at(-1)
    if (attempt !== undefined && ['submitting', 'submitted', 'monitoring'].includes(attempt.status)) {
      state = await this.reconcileCancellation(state, attempt)
    } else {
      state = this.cancelState(state, attempt)
    }
    this.ledger.saveState(state)
    return Object.freeze({ state })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const work = [...this.live.values()].map(async live => {
      live.abort.abort(new Stage4AError('Stage 4A controller disposed', 'CANCEL_FAILED'))
      if (live.remoteName !== undefined && live.remoteConfirmed === true) {
        live.stop ??= this.backend().stop(live.remoteName)
        await live.stop.catch(() => undefined)
      }
      await live.done
    })
    await Promise.all(work)
    this.detachJobController?.()
    this.detachJobController = undefined
  }

  private launch(state: Stage4AState, recovering: boolean): Stage4AStatus {
    const jobs = this.jobs()
    this.ensureJobController(jobs)
    const runKey = key(state.profile_id, state.run_id)
    let live: LiveRun | undefined
    const jobId = jobs.start({
      kind: 'autodata-stage4a',
      label: `Stage 4A ${state.profile_id}/${state.run_id}`,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run: () => {
        const abort = new AbortController()
        const output: string[] = []
        const holder: LiveRun = { abort, output, done: Promise.resolve({ status: 'failed' }) }
        const done = this.execute(state.profile_id, state.run_id, recovering, holder)
          .catch(error => ({ status: 'failed' as const, detail: errorMessage(error), output: errorMessage(error) }))
          .finally(() => {
            this.live.delete(runKey)
            this.processJobs.delete(runKey)
          })
        Object.defineProperty(holder, 'done', { value: done, enumerable: true })
        live = holder
        this.live.set(runKey, holder)
        return {
          cancel: (reason?: string) => this.cancelLive(holder, reason),
          done,
          readOutput: () => output.splice(0).join('\n'),
        }
      },
    })
    if (live === undefined) throw new Stage4AError('DSH jobs provider did not start the Stage 4A producer', 'DEPENDENCY_UNAVAILABLE')
    live.jobId = jobId
    this.processJobs.set(runKey, jobId)
    return this.status(state.profile_id, state.run_id)
  }

  private cancelLive(live: LiveRun, reason?: string): void {
    if (live.abort.signal.aborted) return
    live.abort.abort(new Stage4AError(reason ?? 'Stage 4A run cancelled', 'CANCEL_FAILED'))
    if (live.remoteName !== undefined && live.remoteConfirmed === true) {
      live.stop ??= this.backend().stop(live.remoteName)
    }
  }

  private async execute(
    profileId: string,
    runId: string,
    recovering: boolean,
    live: LiveRun,
  ): Promise<import('@deepseek-ai/dsh-jobs').JobOutcome> {
    let state = this.ledger.loadState(profileId, runId)
    try {
      if (state.phase === 'initializing') {
        this.note(live, 'recovering Stage 4A staging from durable local inputs')
        state = this.completeInitialization(state)
      }
      this.note(live, recovering ? 'recovering durable Stage 4A run' : 'starting Stage 4A training gate')
      state = recovering
        ? await this.continueRun(state, live)
        : await this.runNewStage(state, 'train', live)
      if (state.status !== 'succeeded' && state.train_result_path !== undefined && state.phase === 'eval') {
        state = await this.runNewStage(state, 'eval', live)
      }
      if (state.status !== 'succeeded') {
        state = normalizeStage4AState({
          ...state,
          status: 'succeeded',
          phase: 'complete',
          updated_at: nowIso(this.now),
        })
        this.ledger.saveState(state)
      }
      this.note(live, 'Stage 4A training and evaluation gates passed')
      return { status: 'completed', detail: 'train+eval passed', output: live.output.join('\n') }
    } catch (error) {
      state = this.ledger.loadState(profileId, runId)
      const attempt = state.attempts.at(-1)
      if (live.abort.signal.aborted) {
        state = await this.reconcileCancellation(state, attempt, live)
        this.ledger.saveState(state)
        return state.status === 'cancelled'
          ? { status: 'killed', detail: 'cancelled', output: errorMessage(error) }
          : {
              status: 'failed',
              detail: state.failure?.code ?? 'CANCEL_FAILED',
              output: state.failure?.message ?? errorMessage(error),
            }
      }
      const stageError = error instanceof Stage4AError
        ? error
        : new Stage4AError(errorMessage(error), 'REMOTE_FAILED', { cause: error })
      state = this.failState(state, stageError, attempt)
      this.ledger.saveState(state)
      this.note(live, `Stage 4A stopped: ${stageError.message}`)
      return { status: 'failed', detail: stageError.code, output: live.output.join('\n') }
    }
  }

  private async continueRun(state: Stage4AState, live: LiveRun): Promise<Stage4AState> {
    const attempt = state.attempts.at(-1)
    if (attempt === undefined) return this.runNewStage(state, 'train', live)
    if (attempt.status === 'succeeded') {
      if (attempt.stage === 'train' && state.train_result_path !== undefined) return this.runNewStage(state, 'eval', live)
      if (attempt.stage === 'eval' && state.eval_result_path !== undefined) return state
      throw new Stage4AError('successful attempt is missing its committed result', 'STATE_CORRUPT')
    }
    if (attempt.status === 'failed' || attempt.status === 'cancelled' || attempt.status === 'recovery_required') {
      throw new Stage4AError(`attempt ${attempt.stage}/${String(attempt.attempt)} cannot be resumed from ${attempt.status}`, 'RECOVERY_REQUIRED')
    }
    const request = this.readAttemptRequest(state, attempt)
    const spec = this.attemptSpec(state, attempt)
    if (['submitting', 'submitted', 'monitoring'].includes(attempt.status)) {
      live.remoteName = attempt.rjob_name
      live.remoteConfirmed = attempt.status !== 'submitting'
      const observation = await this.backend().inspect(attempt.rjob_name, live.abort.signal)
      this.recordObservation(state, attempt, observation.command, 'recovery-inspect')
      if (observation.status === 'missing') {
        throw new Stage4AError(
          `cannot prove whether ${attempt.rjob_name} was submitted; automatic resubmission is forbidden`,
          'RECOVERY_REQUIRED',
          { stage: attempt.stage },
        )
      }
      return this.monitor(state, state.attempts.length - 1, request, spec, live, observation.status)
    }
    return this.preflightAndSubmit(state, state.attempts.length - 1, request, spec, live, attempt.status)
  }

  private async runNewStage(state: Stage4AState, stage: Stage4AStage, live: LiveRun): Promise<Stage4AState> {
    const attemptNumber = state.attempts.filter(attempt => attempt.stage === stage).length + 1
    if (attemptNumber !== 1) {
      throw new Stage4AError('Stage 4A does not automatically retry GPU attempts', 'RECOVERY_REQUIRED', { stage })
    }
    const prepared = this.prepareAttempt(state, stage, attemptNumber)
    state = this.ledger.saveState(prepared.state)
    return this.preflightAndSubmit(state, state.attempts.length - 1, prepared.request, prepared.spec, live, 'prepared')
  }

  private prepareAttempt(state: Stage4AState, stage: Stage4AStage, attemptNumber: number): {
    readonly state: Stage4AState
    readonly request: Stage4ATrainRequest | Stage4AEvalRequest
    readonly spec: Stage4ARJobSpec
  } {
    const localDirectory = this.ledger.localAttemptDirectory(state, stage, attemptNumber)
    const stagedDirectory = this.ledger.stagedAttemptDirectory(state, stage, attemptNumber)
    this.ledger.createDirectory(state.run_directory, localDirectory)
    this.ledger.createDirectory(state.staging_directory, stagedDirectory)
    const output = outputRoot(state, stage, attemptNumber)
    const request = stage === 'train'
      ? createStage4ATrainRequest({
        profile_id: state.profile_id,
        run_id: state.run_id,
        attempt: attemptNumber,
        materialized: {
          canonical_jsonl: resolve(state.staging_directory, 'canonical.jsonl'),
          logical_view_jsonl: resolve(state.staging_directory, 'logical-view.jsonl'),
          run_summary_json: resolve(state.staging_directory, 'run-summary.json'),
        },
        output_root: output,
      })
      : createStage4AEvalRequest({
        profile_id: state.profile_id,
        run_id: state.run_id,
        attempt: attemptNumber,
        checkpoint_path: this.trainingCheckpoint(state),
        output_root: output,
      })
    const requestPath = resolve(stagedDirectory, 'request.json')
    this.ledger.writeNewOrSameJson(state.staging_directory, requestPath, request)
    this.ledger.writeNewOrSameJson(state.run_directory, resolve(localDirectory, 'request.json'), request)
    const createdAt = nowIso(this.now)
    const attempt: Stage4AAttempt = {
      stage,
      attempt: attemptNumber,
      status: 'prepared',
      rjob_name: stage4ARJobName(state.run_id, stage),
      request_path: requestPath,
      result_path: resultPath(state, stage, attemptNumber),
      created_at: createdAt,
      updated_at: createdAt,
    }
    const next = normalizeStage4AState({
      ...state,
      status: 'running',
      phase: stage,
      attempts: [...state.attempts, attempt],
      updated_at: createdAt,
      failure: undefined,
    })
    return {
      state: next,
      request,
      spec: this.attemptSpec(next, attempt),
    }
  }

  private async preflightAndSubmit(
    initial: Stage4AState,
    attemptIndex: number,
    request: Stage4ATrainRequest | Stage4AEvalRequest,
    spec: Stage4ARJobSpec,
    live: LiveRun,
    resumeFrom: Stage4AAttempt['status'],
  ): Promise<Stage4AState> {
    let state = initial
    const local = this.ledger.localAttemptDirectory(state, spec.stage, request.attempt)
    if (resumeFrom === 'prepared' || resumeFrom === 'dry_running') {
      state = this.updateAttempt(state, attemptIndex, { status: 'dry_running' })
      const result = await this.backend().dryRun(spec, live.abort.signal)
      const path = resumeFrom === 'dry_running'
        ? this.ledger.nextArtifactPath(state.run_directory, local, 'dry-run-recovery')
        : resolve(local, 'dry-run.json')
      this.ledger.writeNewJson(state.run_directory, path, result)
      state = this.updateAttempt(state, attemptIndex, { status: 'dry_passed', dry_run_path: path })
      this.note(live, `${spec.stage} dry-run passed`)
    }
    const current = state.attempts[attemptIndex]
    if (current === undefined) throw new Stage4AError('attempt disappeared during preflight', 'STATE_CORRUPT')
    if (current.status === 'dry_passed' || current.status === 'predict_running') {
      state = this.updateAttempt(state, attemptIndex, { status: 'predict_running' })
      const result = await this.backend().predict(spec, live.abort.signal)
      const path = current.status === 'predict_running'
        ? this.ledger.nextArtifactPath(state.run_directory, local, 'prediction-recovery')
        : resolve(local, 'prediction.json')
      this.ledger.writeNewJson(state.run_directory, path, result)
      state = this.updateAttempt(state, attemptIndex, { status: 'predict_passed', prediction_path: path })
      this.note(live, `${spec.stage} predict-only passed 1/1`)
    }
    const predicted = state.attempts[attemptIndex]
    if (predicted?.status !== 'predict_passed') {
      throw new Stage4AError(`cannot submit ${spec.stage} from ${predicted?.status ?? 'missing'} state`, 'STATE_CORRUPT')
    }
    // Commit the ambiguous crash boundary before invoking the GPU submission.
    state = this.updateAttempt(state, attemptIndex, { status: 'submitting' })
    live.remoteName = spec.rjob_name
    live.remoteConfirmed = false
    let submission: Stage4ACommandResult
    try {
      submission = await this.backend().submit(spec, live.abort.signal)
    } catch (error) {
      throw new Stage4AError(
        `submission outcome for ${spec.rjob_name} is unknown; inspect the deterministic RJob name before retrying`,
        'RECOVERY_REQUIRED',
        { stage: spec.stage, cause: error },
      )
    }
    live.remoteConfirmed = true
    const submissionPath = resolve(local, 'submission.json')
    this.ledger.writeNewJson(state.run_directory, submissionPath, submission)
    state = this.updateAttempt(state, attemptIndex, { status: 'submitted', submission_path: submissionPath })
    this.note(live, `${spec.stage} submitted as ${spec.rjob_name}`)
    return this.monitor(state, attemptIndex, request, spec, live)
  }

  private async monitor(
    initial: Stage4AState,
    attemptIndex: number,
    request: Stage4ATrainRequest | Stage4AEvalRequest,
    spec: Stage4ARJobSpec,
    live: LiveRun,
    initialRemoteStatus?: import('./types.js').Stage4ARemoteStatus,
  ): Promise<Stage4AState> {
    let state = initial
    let remoteStatus = initialRemoteStatus
    let missingObservations = 0
    for (;;) {
      if (live.abort.signal.aborted) throw live.abort.signal.reason
      if (remoteStatus === undefined) {
        const observation = await this.backend().inspect(spec.rjob_name, live.abort.signal)
        remoteStatus = observation.status
        this.recordObservation(state, state.attempts[attemptIndex] as Stage4AAttempt, observation.command, 'observation')
      }
      if (remoteStatus === 'succeeded') break
      if (remoteStatus === 'failed') throw new Stage4AError(`${spec.rjob_name} failed`, 'REMOTE_FAILED', { stage: spec.stage })
      if (remoteStatus === 'stopped') throw new Stage4AError(`${spec.rjob_name} stopped`, 'REMOTE_FAILED', { stage: spec.stage })
      if (remoteStatus === 'missing') {
        missingObservations += 1
        if (missingObservations >= 3) {
          throw new Stage4AError(`${spec.rjob_name} is missing after submission`, 'RECOVERY_REQUIRED', { stage: spec.stage })
        }
      } else {
        missingObservations = 0
      }
      state = this.updateAttempt(state, attemptIndex, { status: 'monitoring' })
      await this.sleep(this.pollIntervalMs, live.abort.signal)
      remoteStatus = undefined
    }
    const logs = await this.backend().logs(spec.rjob_name, live.abort.signal)
    const local = this.ledger.localAttemptDirectory(state, spec.stage, request.attempt)
    const logsPath = this.ledger.nextArtifactPath(state.run_directory, local, 'logs')
    this.ledger.writeNewJson(state.run_directory, logsPath, logs)
    const rawResult = this.ledger.readJson(state.staging_directory, request.output.result_json, `${spec.stage} result`)
    const localResultPath = resolve(local, 'result.json')
    if (spec.stage === 'train') {
      const trainRequest = request as Stage4ATrainRequest
      const result = normalizeStage4ATrainResult(rawResult, {
        profile_id: request.profile_id,
        run_id: request.run_id,
        attempt: request.attempt,
        checkpoint_path: trainRequest.output.checkpoint_dir,
      })
      this.ledger.requireDirectory(state.staging_directory, result.checkpoint_path, 'training checkpoint')
      this.ledger.writeNewOrSameJson(state.run_directory, localResultPath, result)
      const succeeded = replaceStage4AAttempt(state, attemptIndex, {
        status: 'succeeded',
        logs_path: logsPath,
      }, nowIso(this.now))
      state = normalizeStage4AState({
        ...succeeded,
        phase: 'eval',
        train_result_path: localResultPath,
        updated_at: nowIso(this.now),
      })
    } else {
      const result = normalizeStage4AEvalResult(rawResult, request)
      this.ledger.writeNewOrSameJson(state.run_directory, localResultPath, result)
      const succeeded = replaceStage4AAttempt(state, attemptIndex, {
        status: 'succeeded',
        logs_path: logsPath,
      }, nowIso(this.now))
      state = normalizeStage4AState({
        ...succeeded,
        status: 'succeeded',
        phase: 'complete',
        eval_result_path: localResultPath,
        updated_at: nowIso(this.now),
      })
    }
    this.ledger.saveState(state)
    this.note(live, `${spec.stage} compatibility result validated`)
    return state
  }

  private readAttemptRequest(state: Stage4AState, attempt: Stage4AAttempt): Stage4ATrainRequest | Stage4AEvalRequest {
    const value = this.ledger.readJson(state.staging_directory, attempt.request_path, `${attempt.stage} request`)
    const request = attempt.stage === 'train'
      ? normalizeStage4ATrainRequest(value)
      : normalizeStage4AEvalRequest(value)
    if (request.profile_id !== state.profile_id || request.run_id !== state.run_id || request.attempt !== attempt.attempt) {
      throw new Stage4AError(`${attempt.stage} request does not match durable state`, 'STATE_CORRUPT')
    }
    const expected = attempt.stage === 'train'
      ? createStage4ATrainRequest({
        profile_id: state.profile_id,
        run_id: state.run_id,
        attempt: attempt.attempt,
        materialized: {
          canonical_jsonl: resolve(state.staging_directory, 'canonical.jsonl'),
          logical_view_jsonl: resolve(state.staging_directory, 'logical-view.jsonl'),
          run_summary_json: resolve(state.staging_directory, 'run-summary.json'),
        },
        output_root: outputRoot(state, 'train', attempt.attempt),
      })
      : createStage4AEvalRequest({
        profile_id: state.profile_id,
        run_id: state.run_id,
        attempt: attempt.attempt,
        checkpoint_path: this.trainingCheckpointFromAttempt(state),
        output_root: outputRoot(state, 'eval', attempt.attempt),
      })
    if (canonicalJson(request) !== canonicalJson(expected)) {
      throw new Stage4AError(`${attempt.stage} request paths or protocol fields do not match durable state`, 'STATE_CORRUPT')
    }
    return request
  }

  private trainingCheckpoint(state: Stage4AState): string {
    const attempt = [...state.attempts].reverse().find(value => value.stage === 'train' && value.status === 'succeeded')
    if (attempt === undefined || state.train_result_path === undefined) {
      throw new Stage4AError('evaluation requires a validated training result', 'STATE_CORRUPT')
    }
    return this.trainingCheckpointFromAttempt(state)
  }

  private trainingCheckpointFromAttempt(state: Stage4AState): string {
    const attempt = [...state.attempts].reverse().find(value => value.stage === 'train' && value.status === 'succeeded')
    if (attempt === undefined) throw new Stage4AError('validated training attempt is missing', 'STATE_CORRUPT')
    return resolve(outputRoot(state, 'train', attempt.attempt), 'train', 'checkpoint-2')
  }

  private attemptSpec(state: Stage4AState, attempt: Stage4AAttempt): Stage4ARJobSpec {
    return Object.freeze({
      stage: attempt.stage,
      rjob_name: attempt.rjob_name,
      staging_directory: state.staging_directory,
      script_path: resolve(state.staging_directory, `${attempt.stage}.sh`),
      request_path: attempt.request_path,
    })
  }

  private updateAttempt(state: Stage4AState, attemptIndex: number, patch: Partial<Stage4AAttempt>): Stage4AState {
    const next = replaceStage4AAttempt(state, attemptIndex, patch, nowIso(this.now))
    return this.ledger.saveState(next)
  }

  private recordObservation(state: Stage4AState, attempt: Stage4AAttempt, result: Stage4ACommandResult, stem: string): void {
    const local = this.ledger.localAttemptDirectory(state, attempt.stage, attempt.attempt)
    const path = this.ledger.nextArtifactPath(state.run_directory, local, stem)
    this.ledger.writeNewJson(state.run_directory, path, result)
  }

  private completeInitialization(state: Stage4AState): Stage4AState {
    if (state.phase !== 'initializing') return state
    this.ledger.ensureStagingDirectory(state)
    stageStage4AData(this.ledger, state.run_directory, state.staging_directory)
    stageStage4AAssets(this.ledger, this.assetRoot, state.staging_directory)
    const materialized = normalizeStage4AState({
      ...state,
      phase: 'materialized',
      updated_at: nowIso(this.now),
    })
    return this.ledger.saveState(materialized)
  }

  private async reconcileCancellation(
    state: Stage4AState,
    attempt: Stage4AAttempt | undefined,
    live?: LiveRun,
  ): Promise<Stage4AState> {
    if (attempt === undefined) return this.cancelState(state)
    const hasRemoteBoundary = live?.remoteName !== undefined
      || ['submitting', 'submitted', 'monitoring'].includes(attempt.status)
    if (!hasRemoteBoundary) return this.cancelState(state, attempt)

    const remoteName = live?.remoteName ?? attempt.rjob_name
    let stopped: Stage4ACommandResult | undefined
    let stopError: unknown
    if (live?.stop !== undefined) {
      try { stopped = await live.stop } catch (error) { stopError = error }
    }
    if (stopped !== undefined) {
      this.recordCancellation(state, attempt, stopped)
      return this.cancelState(state, attempt)
    }

    let observation: import('./types.js').Stage4ARJobObservation
    try {
      observation = await this.backend().inspect(remoteName, new AbortController().signal)
      this.recordObservation(state, attempt, observation.command, 'cancel-inspect')
    } catch (error) {
      return this.failState(state, new Stage4AError(
        `cannot determine remote state while cancelling ${remoteName}: ${errorMessage(error)}`,
        attempt.status === 'submitting' ? 'RECOVERY_REQUIRED' : 'CANCEL_FAILED',
        { stage: attempt.stage, cause: error },
      ), attempt)
    }
    if (observation.status === 'missing' && attempt.status === 'submitting') {
      return this.failState(state, new Stage4AError(
        `submission outcome for ${remoteName} remains unknown after cancellation; inspect the deterministic name before retrying`,
        'RECOVERY_REQUIRED',
        { stage: attempt.stage, cause: stopError },
      ), attempt)
    }
    if (observation.status === 'missing' || ['stopped', 'succeeded', 'failed'].includes(observation.status)) {
      return this.cancelState(state, attempt)
    }
    try {
      const result = await this.backend().stop(remoteName)
      this.recordCancellation(state, attempt, result)
      return this.cancelState(state, attempt)
    } catch (error) {
      try {
        const afterStop = await this.backend().inspect(remoteName, new AbortController().signal)
        this.recordObservation(state, attempt, afterStop.command, 'cancel-recheck')
        if (afterStop.status === 'missing' || ['stopped', 'succeeded', 'failed'].includes(afterStop.status)) {
          return this.cancelState(state, attempt)
        }
      } catch {
        // The original stop failure remains the authoritative cancellation error.
      }
      return this.failState(state, new Stage4AError(
        `remote cancellation failed for ${remoteName}: ${errorMessage(error)}`,
        'CANCEL_FAILED',
        { stage: attempt.stage, cause: error },
      ), attempt)
    }
  }

  private recordCancellation(state: Stage4AState, attempt: Stage4AAttempt, result: Stage4ACommandResult): void {
    const local = this.ledger.localAttemptDirectory(state, attempt.stage, attempt.attempt)
    const path = this.ledger.nextArtifactPath(state.run_directory, local, 'cancel')
    this.ledger.writeNewJson(state.run_directory, path, result)
  }

  private failState(state: Stage4AState, error: Stage4AError, attempt?: Stage4AAttempt): Stage4AState {
    const recovery = error.code === 'RECOVERY_REQUIRED'
    let next = state
    if (attempt !== undefined) {
      const attemptIndex = state.attempts.length - 1
      next = replaceStage4AAttempt(state, attemptIndex, {
        status: recovery ? attempt.status : 'failed',
      }, nowIso(this.now))
    }
    return normalizeStage4AState({
      ...next,
      status: recovery ? 'recovery_required' : 'failed',
      updated_at: nowIso(this.now),
      failure: {
        code: error.code,
        message: error.message,
        ...(attempt === undefined ? {} : { stage: attempt.stage, attempt: attempt.attempt }),
      },
    })
  }

  private cancelState(state: Stage4AState, attempt?: Stage4AAttempt): Stage4AState {
    let next = state
    if (attempt !== undefined && !['succeeded', 'failed', 'cancelled'].includes(attempt.status)) {
      next = replaceStage4AAttempt(state, state.attempts.length - 1, { status: 'cancelled' }, nowIso(this.now))
    }
    return normalizeStage4AState({
      ...next,
      status: 'cancelled',
      updated_at: nowIso(this.now),
      failure: undefined,
    })
  }

  private note(live: LiveRun, message: string): void {
    live.output.push(message)
    while (Buffer.byteLength(live.output.join('\n'), 'utf8') > OUTPUT_LIMIT_BYTES && live.output.length > 1) {
      live.output.shift()
    }
  }

  private backend(): Stage4ARJobBackend {
    return this.backendValue ??= Stage4ARJobClient.fromContext(this.ctx)
  }

  private jobs(): Stage4AJobRegistry {
    if (this.jobsValue !== undefined) return this.jobsValue
    const jobs = this.ctx.get('jobs', false) as Stage4AJobRegistry | undefined
    if (jobs === undefined) throw new Stage4AError('DSH jobs service is unavailable', 'DEPENDENCY_UNAVAILABLE')
    return this.jobsValue = jobs
  }

  private ensureJobController(jobs: Stage4AJobRegistry): void {
    this.detachJobController ??= jobs.attachController('autodata-stage4a-host')
  }

  private assertUsable(): void {
    if (this.disposed) throw new Stage4AError('Stage 4A controller is disposed', 'DEPENDENCY_UNAVAILABLE')
  }
}

/** Narrow helper retained for tests that need a branded synthetic id. */
export function stage4AJobId(value: string): JobId {
  return JobId(value)
}

/** Host-only orchestration for frozen H0 and first-candidate H1 experiments. */

import type { Context } from '@deepseek-ai/cordis'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  AUTODATA_RUN_SUMMARY_VERSION,
  CANONICAL_TRAJECTORY_SCHEMA_VERSION,
  LOGICAL_TRAINING_UNIT_SCHEMA_VERSION,
} from '../core/index.js'
import { canonicalJson, cloneJson, isJsonObject } from '../core/json.js'
import type { DataRunResult } from '../core/types.js'
import {
  EVALUATION_REPORT_SCHEMA_VERSION,
  EVOLUTION_FEEDBACK_SCHEMA_VERSION,
  H0_CANDIDATE_ID,
  candidateFrozenSelectionRuntimeBinding,
  normalizeEvaluationReport,
  normalizeEvolutionFeedback,
  recordEvolutionFeedback,
  type EvaluationReport,
  type EvolutionFeedback,
  type FrozenSelectionRuntimeBinding,
} from '../evolution/index.js'
import { GENERATION_MATERIALIZATION_VERSION } from '../generation/types.js'
import { Stage4ARJobClient } from '../stage4a/rjob.js'
import type {
  Stage4ACommandResult,
  Stage4ARJobObservation,
  Stage4ARJobSpec,
} from '../stage4a/types.js'
import {
  createExperimentEvalRequest,
  createCandidateExperimentContract,
  createExperimentTrainRequest,
  experimentArtifactHashes,
  loadExperimentContract,
  normalizeExperimentEvalRequest,
  normalizeExperimentEvalResult,
  normalizeExperimentStartRequest,
  normalizeExperimentTrainRequest,
  normalizeExperimentTrainResult,
  validateExperimentId,
} from './contracts.js'
import { ExperimentLedger } from './ledger.js'
import { normalizeExperimentPredictionsJsonl } from './predictions.js'
import {
  createInitialExperimentState,
  experimentRJobName,
  normalizeExperimentState,
  replaceExperimentAttempt,
} from './state.js'
import { sleepWithAbort } from './sleep.js'
import {
  ExperimentError,
  type ExperimentAttempt,
  type ExperimentCandidateSubject,
  type ExperimentCommandResult,
  type ExperimentContract,
  type ExperimentControllerOptions,
  type ExperimentErrorCode,
  type ExperimentEvalRequest,
  type ExperimentEvalResult,
  type ExperimentJobRegistry,
  type ExperimentMaterializedData,
  type ExperimentRJobBackend,
  type ExperimentRuntimeAgent,
  type ExperimentStage,
  type ExperimentStartRequest,
  type ExperimentState,
  type ExperimentStatus,
  type ExperimentTrainRequest,
} from './types.js'

const OUTPUT_LIMIT_BYTES = 64 * 1024
const PREDICTIONS_LIMIT_BYTES = 16 * 1024 * 1024
const DEFAULT_POLL_INTERVAL_MS = 30_000
const REQUEST_ENVIRONMENT = 'AUTODATA_EXPERIMENT_REQUEST'
const EXPERIMENT_FILES = Object.freeze([
  '.rjobignore',
  'train.sh',
  'eval.sh',
  'python/autodata_stage4b/__init__.py',
  'python/autodata_stage4b/worker.py',
  'python/autodata_stage4b/bfcl_assets.py',
  'bfcl/selection.json',
  'bfcl/manifest.json',
  'bfcl/search.jsonl',
  'bfcl/dev.jsonl',
] as const)
const COMMON_WORKER_FILES = Object.freeze(['__init__.py', 'worker.py'] as const)
const RETRYABLE_INFRASTRUCTURE_ERRORS = new Set<ExperimentErrorCode>([
  'DRY_RUN_FAILED',
  'UNSCHEDULABLE',
  'REMOTE_FAILED',
])
const EXPERIMENT_ERROR_CODES = new Set<ExperimentErrorCode>([
  'INVALID_REQUEST', 'RUN_EXISTS', 'RUN_NOT_FOUND', 'STATE_CORRUPT', 'ARTIFACT_EXISTS',
  'ARTIFACT_INVALID', 'PATH_ESCAPE', 'DEPENDENCY_UNAVAILABLE', 'DRY_RUN_FAILED',
  'UNSCHEDULABLE', 'SUBMIT_FAILED', 'REMOTE_FAILED', 'WORKER_FAILED', 'RECOVERY_REQUIRED',
  'CANCEL_FAILED', 'STORE_IO', 'BASELINE_REGISTRATION_FAILED', 'EVALUATION_REGISTRATION_FAILED',
])

interface LiveRun {
  readonly abort: AbortController
  readonly done: Promise<import('@deepseek-ai/dsh-jobs').JobOutcome>
  readonly output: string[]
  jobId?: JobId
  remoteName?: string
  remoteConfirmed?: boolean
  stop?: Promise<ExperimentCommandResult>
}

interface PreparedData {
  readonly materialized: ExperimentMaterializedData
  readonly files: Readonly<Record<'canonical.jsonl' | 'logical-view.jsonl' | 'run-summary.json', string>>
}

interface BoundContract {
  readonly contract: ExperimentContract
  readonly sha256: string
  readonly text: string
}

function runKey(profileId: string, runId: string): string {
  return `${profileId}\0${runId}`
}

function nowIso(now: () => Date): string {
  const value = now()
  if (!Number.isFinite(value.getTime())) throw new ExperimentError('experiment clock returned an invalid Date', 'STORE_IO')
  return value.toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asExperimentError(
  error: unknown,
  fallback: ExperimentErrorCode,
  stage?: ExperimentStage,
): ExperimentError {
  if (error instanceof ExperimentError) return error
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const value = error as { readonly code?: unknown; readonly message?: unknown }
    if (
      typeof value.code === 'string'
      && EXPERIMENT_ERROR_CODES.has(value.code as ExperimentErrorCode)
      && typeof value.message === 'string'
    ) {
      return new ExperimentError(value.message, value.code as ExperimentErrorCode, {
        ...(stage === undefined ? {} : { stage }),
        cause: error,
      })
    }
  }
  return new ExperimentError(errorMessage(error), fallback, {
    ...(stage === undefined ? {} : { stage }),
    cause: error,
  })
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function jsonLines(records: readonly unknown[]): string {
  return records.length === 0 ? '' : `${records.map(record => canonicalJson(record)).join('\n')}\n`
}

function outputRoot(state: ExperimentState, stage: ExperimentStage, attempt: number): string {
  return resolve(state.staging_directory, 'outputs', stage, `attempt-${String(attempt)}`)
}

function resultPath(state: ExperimentState, stage: ExperimentStage, attempt: number): string {
  return resolve(outputRoot(state, stage, attempt), 'result.json')
}

function assertSourceFile(rootInput: string, relativePath: string): string {
  const root = resolve(rootInput)
  const target = resolve(root, relativePath)
  const child = relative(root, target)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new ExperimentError(`asset path escapes its configured root: ${relativePath}`, 'PATH_ESCAPE')
  }
  if (!existsSync(root)) throw new ExperimentError(`experiment asset root is missing: ${root}`, 'ARTIFACT_INVALID')
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ExperimentError(`experiment asset root must be a regular directory: ${root}`, 'ARTIFACT_INVALID')
  }
  let cursor = root
  for (const part of child.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    if (!existsSync(cursor)) throw new ExperimentError(`required experiment asset is missing: ${relativePath}`, 'ARTIFACT_INVALID')
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) throw new ExperimentError(`experiment assets must not contain symlinks: ${cursor}`, 'ARTIFACT_INVALID')
  }
  if (!lstatSync(target).isFile()) throw new ExperimentError(`experiment asset must be a regular file: ${relativePath}`, 'ARTIFACT_INVALID')
  return target
}

function serializeDataRun(dataRunInput: DataRunResult): {
  readonly data: DataRunResult
  readonly files: PreparedData['files']
} {
  let cloned: unknown
  try {
    cloned = cloneJson(dataRunInput)
  } catch (error) {
    throw new ExperimentError('data_run must contain only JSON-compatible data', 'INVALID_REQUEST', { cause: error })
  }
  if (!isJsonObject(cloned)) throw new ExperimentError('data_run must be an object', 'INVALID_REQUEST')
  const data = cloned as unknown as DataRunResult
  if (!Array.isArray(data.canonical_records) || !Array.isArray(data.logical_training_view)) {
    throw new ExperimentError('data_run must contain canonical_records and logical_training_view arrays', 'INVALID_REQUEST')
  }
  const summary = data.summary
  if (!isJsonObject(summary) || !isJsonObject(summary.source) || !isJsonObject(summary.counts)) {
    throw new ExperimentError('data_run must contain a valid run summary', 'INVALID_REQUEST')
  }
  if (
    summary?.summary_version !== AUTODATA_RUN_SUMMARY_VERSION
    || summary.canonical_schema_version !== CANONICAL_TRAJECTORY_SCHEMA_VERSION
    || summary.logical_view_schema_version !== LOGICAL_TRAINING_UNIT_SCHEMA_VERSION
  ) throw new ExperimentError('data_run schema versions do not match the current Core', 'INVALID_REQUEST')
  const files = Object.freeze({
    'canonical.jsonl': jsonLines(data.canonical_records),
    'logical-view.jsonl': jsonLines(data.logical_training_view),
    'run-summary.json': `${canonicalJson(summary)}\n`,
  })
  return Object.freeze({ data, files })
}

function prepareData(
  serialized: ReturnType<typeof serializeDataRun>,
  stagingDirectory: string,
  contract: ExperimentContract,
  baseline: ExperimentContract,
): PreparedData {
  const { data, files } = serialized
  const summary = data.summary
  if (
    summary.harness_id !== contract.data.harness_id
    || summary.seed !== contract.data.seed
    || summary.source.dataset_id !== contract.data.dataset_id
    || summary.source.dataset_revision !== contract.data.dataset_revision
  ) throw new ExperimentError('data_run identity does not match the frozen experiment contract', 'INVALID_REQUEST')
  if (
    data.canonical_records.length !== contract.data.canonical_records
    || data.logical_training_view.length !== contract.data.logical_training_units
    || summary.counts.canonical_records !== data.canonical_records.length
    || summary.counts.logical_training_units !== data.logical_training_view.length
  ) throw new ExperimentError('data_run counts do not match the frozen experiment contract', 'INVALID_REQUEST')
  if (data.canonical_records.some(record => record.schema_version !== CANONICAL_TRAJECTORY_SCHEMA_VERSION)) {
    throw new ExperimentError('data_run contains an unsupported canonical record', 'INVALID_REQUEST')
  }
  if (data.logical_training_view.some(unit => unit.schema_version !== LOGICAL_TRAINING_UNIT_SCHEMA_VERSION)) {
    throw new ExperimentError('data_run contains an unsupported logical training unit', 'INVALID_REQUEST')
  }
  const hashes = experimentArtifactHashes(files)
  if (
    hashes['canonical.jsonl'] !== contract.data.canonical_jsonl_sha256
    || hashes['logical-view.jsonl'] !== contract.data.logical_view_jsonl_sha256
    || hashes['run-summary.json'] !== contract.data.run_summary_json_sha256
  ) throw new ExperimentError('materialized data hashes do not match the frozen experiment contract', 'INVALID_REQUEST')
  if (contract.subject !== undefined) {
    if (
      hashes['canonical.jsonl'] !== baseline.data.canonical_jsonl_sha256
      || contract.data.canonical_records !== baseline.data.canonical_records
    ) throw new ExperimentError('H1 must use the exact frozen H0 canonical source pool', 'INVALID_REQUEST')
    if (summary.generation !== contract.subject.generation) {
      throw new ExperimentError('H1 data_run generation does not match the candidate', 'INVALID_REQUEST')
    }
    if (canonicalJson(summary.plugins) !== canonicalJson([{
      id: contract.subject.plugin_id,
      version: contract.subject.strategy_version,
    }])) throw new ExperimentError('H1 data_run plugin identity does not match the candidate', 'INVALID_REQUEST')
    const canonicalById = new Map(data.canonical_records.map(record => [record.source.record_id, record]))
    const rankByRecord = new Map<string, number>()
    let previousRank = -1
    for (const unit of data.logical_training_view) {
      const canonical = canonicalById.get(unit.source.record_id)
      if (canonical === undefined || canonicalJson(unit.source) !== canonicalJson(canonical.source)) {
        throw new ExperimentError('H1 logical view must reference the frozen canonical source pool', 'INVALID_REQUEST')
      }
      const existingRank = rankByRecord.get(unit.source.record_id)
      if (existingRank !== undefined && existingRank !== unit.selection_rank) {
        throw new ExperimentError('H1 logical view assigns one record to multiple selection ranks', 'INVALID_REQUEST')
      }
      if (existingRank === undefined) {
        if (unit.selection_rank !== previousRank + 1) {
          throw new ExperimentError('H1 logical view selection ranks must be contiguous and ordered', 'INVALID_REQUEST')
        }
        rankByRecord.set(unit.source.record_id, unit.selection_rank)
        previousRank = unit.selection_rank
      } else if (unit.selection_rank !== previousRank) {
        throw new ExperimentError('H1 logical units for a selected record must remain contiguous', 'INVALID_REQUEST')
      }
      if (
        unit.plugin_provenance.length !== 1
        || unit.plugin_provenance[0]?.plugin_id !== contract.subject.plugin_id
        || unit.plugin_provenance[0]?.plugin_version !== contract.subject.strategy_version
      ) throw new ExperimentError('H1 logical view provenance does not match the candidate', 'INVALID_REQUEST')
    }
  }
  return Object.freeze({
    files,
    materialized: Object.freeze({
      canonical_jsonl: resolve(stagingDirectory, 'canonical.jsonl'),
      logical_view_jsonl: resolve(stagingDirectory, 'logical-view.jsonl'),
      run_summary_json: resolve(stagingDirectory, 'run-summary.json'),
    }),
  })
}

/** Resumable single-owner controller for the Stage 4B H0 train/evaluate/register workflow. */
export class ExperimentController {
  private readonly ledger: ExperimentLedger
  private readonly assetRoot: string
  private readonly commonWorkerRoot: string
  private readonly baselineContract: ExperimentContract
  private readonly baselineContractSha256: string
  private readonly baselineContractText: string
  private readonly pollIntervalMs: number
  private readonly now: () => Date
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private backendValue: ExperimentRJobBackend | undefined
  private jobsValue: ExperimentJobRegistry | undefined
  private detachJobController: (() => void) | undefined
  private readonly live = new Map<string, LiveRun>()
  private readonly processJobs = new Map<string, JobId>()
  private disposed = false

  constructor(private readonly ctx: Context, private readonly options: ExperimentControllerOptions) {
    this.ledger = new ExperimentLedger(options.run_root, options.staging_root)
    this.assetRoot = resolve(options.asset_root ?? fileURLToPath(new URL('../../stage4b', import.meta.url)))
    this.commonWorkerRoot = resolve(options.common_worker_root
      ?? fileURLToPath(new URL('../../stage4a/python/autodata_stage4a', import.meta.url)))
    const contractPath = resolve(this.assetRoot, 'experiment-contract.json')
    const loaded = loadExperimentContract(contractPath)
    if (loaded.contract.subject !== undefined) {
      throw new ExperimentError('configured experiment asset must be the checked-in H0 baseline contract', 'ARTIFACT_INVALID')
    }
    this.baselineContract = loaded.contract
    this.baselineContractSha256 = loaded.sha256
    this.baselineContractText = readFileSync(contractPath, 'utf8')
    const pollInterval = options.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS
    if (!Number.isFinite(pollInterval) || pollInterval < 0) {
      throw new ExperimentError('poll_interval_ms must be a finite non-negative number', 'INVALID_REQUEST')
    }
    this.pollIntervalMs = pollInterval
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? sleepWithAbort
    this.backendValue = options.backend
    this.jobsValue = options.jobs
  }

  start(requestInput: ExperimentStartRequest, agent?: ExperimentRuntimeAgent): ExperimentStatus {
    this.assertUsable()
    const request = normalizeExperimentStartRequest(requestInput)
    if (request.subject !== undefined && agent === undefined) {
      throw new ExperimentError('an H1 experiment requires a process-local runtime Agent', 'INVALID_REQUEST')
    }
    const runtimeBinding = this.assertProfile(request.profile_id, false, undefined, request.subject)
    const key = runKey(request.profile_id, request.run_id)
    if (this.live.has(key)) throw new ExperimentError(`experiment ${request.profile_id}/${request.run_id} is already live`, 'RUN_EXISTS')
    if ([...this.live.keys()].some(value => value.startsWith(`${request.profile_id}\0`))) {
      throw new ExperimentError(`TaskProfile ${request.profile_id} already has a live experiment`, 'RUN_EXISTS')
    }
    const runDirectory = this.ledger.runDirectory(request.profile_id, request.run_id)
    const stagingDirectory = this.ledger.stagingDirectory(request.run_id)
    const serialized = serializeDataRun(request.data_run)
    if (request.subject !== undefined) {
      if (runtimeBinding === undefined) {
        throw new ExperimentError('H1 subject is missing its durable runtime binding', 'INVALID_REQUEST')
      }
      this.assertCandidateMaterializationBinding(request.subject, runtimeBinding, serialized)
    }
    const binding: BoundContract = request.subject === undefined
      ? {
        contract: this.baselineContract,
        sha256: this.baselineContractSha256,
        text: this.baselineContractText,
      }
      : (() => {
        const contract = createCandidateExperimentContract({
          baseline: this.baselineContract,
          subject: request.subject,
          data_run: serialized.data,
          artifact_hashes: experimentArtifactHashes(serialized.files),
        })
        const text = `${canonicalJson(contract)}\n`
        return { contract, sha256: sha256(text), text }
      })()
    const prepared = prepareData(serialized, stagingDirectory, binding.contract, this.baselineContract)
    const createdAt = nowIso(this.now)
    let state = createInitialExperimentState({
      contract_id: binding.contract.contract_id,
      contract_sha256: binding.sha256,
      profile_id: request.profile_id,
      run_id: request.run_id,
      run_directory: runDirectory,
      staging_directory: stagingDirectory,
      now: createdAt,
      ...(request.subject === undefined ? {} : {
        candidate_id: request.subject.candidate_id,
        candidate_generation: request.subject.generation,
      }),
    })
    const claim = request.subject === undefined
      ? this.ledger.claimProfile(state)
      : this.ledger.claimCandidate(state)
    try {
      state = this.ledger.initializeRun(state, {
        ...prepared.files,
        'materialized.json': `${canonicalJson(prepared.materialized)}\n`,
        'experiment-contract.json': binding.text,
      })
      state = this.completeInitialization(state)
      return this.launch(state, false, agent)
    } catch (error) {
      try {
        if (request.subject === undefined) this.ledger.releaseProfileClaimIfUnpublished(state, claim.created)
        else this.ledger.releaseCandidateClaimIfUnpublished(state, claim.created)
      } catch (cleanupError) {
        throw new ExperimentError('experiment initialization failed and its unpublished profile claim could not be released', 'STORE_IO', {
          profile_id: state.profile_id,
          run_id: state.run_id,
          cause: new AggregateError([error, cleanupError]),
        })
      }
      throw error
    }
  }

  status(profileIdInput: string, runIdInput: string): ExperimentStatus {
    this.assertUsable()
    const profileId = validateExperimentId(profileIdInput, 'profile_id')
    const runId = validateExperimentId(runIdInput, 'run_id')
    const state = this.ledger.loadState(profileId, runId)
    this.assertContractBinding(state)
    const jobId = this.processJobs.get(runKey(profileId, runId))
    return Object.freeze({ state, ...(jobId === undefined ? {} : { job_id: jobId }) })
  }

  resume(profileIdInput: string, runIdInput: string, agent?: ExperimentRuntimeAgent): ExperimentStatus {
    this.assertUsable()
    const profileId = validateExperimentId(profileIdInput, 'profile_id')
    const runId = validateExperimentId(runIdInput, 'run_id')
    if (this.live.has(runKey(profileId, runId))) {
      throw new ExperimentError(`experiment ${profileId}/${runId} is already live`, 'RUN_EXISTS')
    }
    if ([...this.live.keys()].some(value => value.startsWith(`${profileId}\0`))) {
      throw new ExperimentError(`TaskProfile ${profileId} already has a live experiment`, 'RUN_EXISTS')
    }
    const state = this.ledger.loadState(profileId, runId)
    const contract = this.assertContractBinding(state)
    if (contract.subject === undefined) this.ledger.claimProfile(state)
    else this.ledger.claimCandidate(state)
    if (state.status === 'failed' || state.status === 'cancelled') {
      return Object.freeze({ state })
    }
    if (state.status === 'succeeded' && contract.subject === undefined) return Object.freeze({ state })
    if (contract.subject !== undefined && agent === undefined) {
      throw new ExperimentError('resuming an H1 experiment requires a process-local runtime Agent', 'INVALID_REQUEST')
    }
    if (state.status !== 'succeeded') this.assertProfile(profileId, true, state, contract.subject)
    return this.launch(state, true, agent)
  }

  async cancel(profileIdInput: string, runIdInput: string): Promise<ExperimentStatus> {
    this.assertUsable()
    const profileId = validateExperimentId(profileIdInput, 'profile_id')
    const runId = validateExperimentId(runIdInput, 'run_id')
    const key = runKey(profileId, runId)
    const active = this.live.get(key)
    if (active?.jobId !== undefined) {
      this.jobs().kill(active.jobId, undefined, 'experiment cancelled by Host')
      await active.done
      return this.status(profileId, runId)
    }
    let state = this.ledger.loadState(profileId, runId)
    const contract = this.assertContractBinding(state)
    if (contract.subject === undefined) this.ledger.claimProfile(state)
    else this.ledger.claimCandidate(state)
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') {
      return Object.freeze({ state })
    }
    if (state.phase === 'registering') {
      throw new ExperimentError(
        'evaluation registration may already have committed; resume the experiment to reconcile it',
        'RECOVERY_REQUIRED',
        { profile_id: profileId, run_id: runId },
      )
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
    await Promise.all([...this.live.values()].map(async live => {
      live.abort.abort(new ExperimentError('experiment controller disposed', 'CANCEL_FAILED'))
      if (live.remoteName !== undefined && live.remoteConfirmed === true) {
        live.stop ??= this.backend().stop(live.remoteName)
        await live.stop.catch(() => undefined)
      }
      await live.done
    }))
    this.detachJobController?.()
    this.detachJobController = undefined
  }

  private launch(state: ExperimentState, recovering: boolean, agent?: ExperimentRuntimeAgent): ExperimentStatus {
    const jobs = this.jobs()
    this.ensureJobController(jobs)
    const key = runKey(state.profile_id, state.run_id)
    let live: LiveRun | undefined
    const jobId = jobs.start({
      kind: 'autodata-experiment',
      label: `Experiment ${state.profile_id}/${state.run_id}`,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run: () => {
        const abort = new AbortController()
        const output: string[] = []
        const holder: LiveRun = { abort, output, done: Promise.resolve({ status: 'failed' }) }
        const done = this.execute(state.profile_id, state.run_id, recovering, holder, agent)
          .catch(error => ({ status: 'failed' as const, detail: errorMessage(error), output: errorMessage(error) }))
          .finally(() => {
            this.live.delete(key)
            this.processJobs.delete(key)
          })
        Object.defineProperty(holder, 'done', { value: done, enumerable: true })
        live = holder
        this.live.set(key, holder)
        return {
          cancel: (reason?: string) => this.cancelLive(holder, reason),
          done,
          readOutput: () => output.splice(0).join('\n'),
        }
      },
    })
    if (live === undefined) throw new ExperimentError('DSH jobs provider did not start the experiment producer', 'DEPENDENCY_UNAVAILABLE')
    live.jobId = jobId
    this.processJobs.set(key, jobId)
    return this.status(state.profile_id, state.run_id)
  }

  private cancelLive(live: LiveRun, reason?: string): void {
    if (live.abort.signal.aborted) return
    live.abort.abort(new ExperimentError(reason ?? 'experiment cancelled', 'CANCEL_FAILED'))
    if (live.remoteName !== undefined && live.remoteConfirmed === true) {
      live.stop ??= this.backend().stop(live.remoteName)
    }
  }

  private async execute(
    profileId: string,
    runId: string,
    recovering: boolean,
    live: LiveRun,
    agent?: ExperimentRuntimeAgent,
  ): Promise<import('@deepseek-ai/dsh-jobs').JobOutcome> {
    let state = this.ledger.loadState(profileId, runId)
    const contract = this.assertContractBinding(state)
    const completedCandidateReplay = state.status === 'succeeded'
      && state.phase === 'complete'
      && contract.subject !== undefined
    try {
      if (completedCandidateReplay) {
        if (agent === undefined || state.decision === undefined) {
          throw new ExperimentError('completed H1 runtime reconciliation requires its Agent and decision', 'STATE_CORRUPT')
        }
        const resumed = await this.options.evolution.resume(profileId, agent)
        const expectedActive = state.decision.accepted ? contract.subject.candidate_id : H0_CANDIDATE_ID
        const expectedStatus = state.decision.accepted ? 'accepted' : 'rejected'
        const candidate = resumed.state.candidates.find(value => value.candidate_id === contract.subject?.candidate_id)
        if (
          resumed.state.active_candidate_id !== expectedActive
          || resumed.state.active_evaluation?.candidate_id !== expectedActive
          || resumed.state.open_candidate_id !== null
          || candidate?.status !== expectedStatus
        ) throw new ExperimentError('completed H1 runtime conflicts with its durable decision', 'STATE_CORRUPT')
        this.note(live, `restored runtime from completed H1 decision (${expectedActive})`)
        return { status: 'completed', detail: 'H1 runtime restored', output: live.output.join('\n') }
      }
      if (state.phase === 'initializing') {
        this.note(live, 'recovering experiment staging from durable local inputs')
        state = this.completeInitialization(state)
      }
      this.note(live, recovering ? 'recovering durable experiment' : `starting ${contract.subject === undefined ? 'H0' : 'H1'} experiment`)
      if (state.phase === 'materialized' || state.phase === 'train') {
        state = await this.runStageWithRetry(state, 'train', live, contract)
      }
      if (state.phase === 'eval') state = await this.runStageWithRetry(state, 'eval', live, contract)
      if (state.phase === 'registering') state = await this.registerResult(state, live, contract, agent)
      if (state.status !== 'succeeded' || state.phase !== 'complete') {
        throw new ExperimentError('experiment stopped before committing its evaluation', 'STATE_CORRUPT')
      }
      const detail = contract.subject === undefined ? 'H0 baseline registered' : 'H1 evaluation decided'
      this.note(live, `${contract.subject === undefined ? 'H0 baseline' : 'H1 candidate'} trained, evaluated, and registered`)
      return { status: 'completed', detail, output: live.output.join('\n') }
    } catch (error) {
      if (completedCandidateReplay) {
        this.note(live, `completed H1 runtime reconciliation failed: ${errorMessage(error)}`)
        return { status: 'failed', detail: errorMessage(error), output: live.output.join('\n') }
      }
      state = this.ledger.loadState(profileId, runId)
      const attempt = state.attempts.at(-1)
      if (live.abort.signal.aborted) {
        state = await this.reconcileCancellation(state, attempt, live)
        this.ledger.saveState(state)
        return state.status === 'cancelled'
          ? { status: 'killed', detail: 'cancelled', output: errorMessage(error) }
          : { status: 'failed', detail: state.failure?.code ?? 'CANCEL_FAILED', output: state.failure?.message ?? errorMessage(error) }
      }
      const experimentError = asExperimentError(error, 'REMOTE_FAILED')
      state = state.phase === 'registering'
        ? this.registrationFailureState(state, experimentError)
        : this.failState(state, experimentError, attempt)
      this.ledger.saveState(state)
      this.note(live, `experiment stopped: ${experimentError.message}`)
      return { status: 'failed', detail: experimentError.code, output: live.output.join('\n') }
    }
  }

  private async runStageWithRetry(
    initial: ExperimentState,
    stage: ExperimentStage,
    live: LiveRun,
    contract: ExperimentContract,
  ): Promise<ExperimentState> {
    let state = initial
    for (;;) {
      let attempt = [...state.attempts].reverse().find(value => value.stage === stage)
      if (attempt?.status === 'succeeded') return state
      if (attempt === undefined || attempt.status === 'failed') {
        const prepared = this.prepareAttempt(state, stage, contract)
        state = this.ledger.saveState(prepared.state)
        attempt = state.attempts.at(-1)
        if (attempt === undefined) throw new ExperimentError('prepared attempt disappeared', 'STATE_CORRUPT', { stage })
      }
      try {
        const request = this.readAttemptRequest(state, attempt, contract)
        const spec = this.attemptSpec(state, attempt, contract)
        return ['submitting', 'submitted', 'monitoring'].includes(attempt.status)
          ? await this.reconcileAndMonitor(state, state.attempts.length - 1, request, spec, live, attempt, contract)
          : await this.preflightAndSubmit(state, state.attempts.length - 1, request, spec, live, attempt.status, contract)
      } catch (error) {
        if (live.abort.signal.aborted) throw error
        const experimentError = asExperimentError(error, 'REMOTE_FAILED', stage)
        state = this.ledger.loadState(state.profile_id, state.run_id)
        const current = state.attempts.at(-1)
        if (this.canRetryInfrastructure(experimentError, current, stage, contract)) {
          const failed = replaceExperimentAttempt(state, state.attempts.length - 1, {
            status: 'failed',
            failure_code: experimentError.code,
            failure_message: experimentError.message,
          }, nowIso(this.now))
          state = this.ledger.saveState(normalizeExperimentState({
            ...failed,
            status: 'running',
            phase: stage,
            updated_at: nowIso(this.now),
            failure: {
              code: experimentError.code,
              message: experimentError.message,
              stage,
              attempt: current?.attempt,
            },
          }))
          delete live.remoteName
          delete live.remoteConfirmed
          delete live.stop
          this.note(live, `${stage} infrastructure attempt failed; starting the one allowed identical retry`)
          continue
        }
        throw experimentError
      }
    }
  }

  private async reconcileAndMonitor(
    state: ExperimentState,
    attemptIndex: number,
    request: ExperimentTrainRequest | ExperimentEvalRequest,
    spec: Stage4ARJobSpec,
    live: LiveRun,
    attempt: ExperimentAttempt,
    contract: ExperimentContract,
  ): Promise<ExperimentState> {
    live.remoteName = attempt.rjob_name
    live.remoteConfirmed = attempt.status !== 'submitting'
    const observation = await this.inspectForRecovery(state, attempt, live)
    if (observation.status === 'missing') {
      throw new ExperimentError(
        `cannot prove whether ${attempt.rjob_name} was submitted; automatic resubmission is forbidden`,
        'RECOVERY_REQUIRED',
        { stage: attempt.stage },
      )
    }
    live.remoteConfirmed = true
    // A positive lookup resolves the ambiguous submitting boundary. Persist
    // that fact before interpreting a terminal remote failure as retryable.
    if (attempt.status === 'submitting') {
      state = this.updateAttempt(state, attemptIndex, { status: 'submitted' })
    }
    return this.monitor(state, attemptIndex, request, spec, live, contract, observation.status)
  }

  private prepareAttempt(state: ExperimentState, stage: ExperimentStage, contract: ExperimentContract): {
    readonly state: ExperimentState
    readonly request: ExperimentTrainRequest | ExperimentEvalRequest
  } {
    const attemptNumber = state.attempts.filter(attempt => attempt.stage === stage).length + 1
    if (attemptNumber > contract.retry.infrastructure_retries_per_stage + 1) {
      throw new ExperimentError(`${stage} exhausted its single infrastructure retry`, 'RECOVERY_REQUIRED', { stage })
    }
    if (attemptNumber === 2) {
      const previous = [...state.attempts].reverse().find(attempt => attempt.stage === stage)
      if (
        previous?.status !== 'failed'
        || previous.failure_code === undefined
        || !RETRYABLE_INFRASTRUCTURE_ERRORS.has(previous.failure_code)
      ) {
        throw new ExperimentError('a second attempt is allowed only after a classified infrastructure failure', 'STATE_CORRUPT', { stage })
      }
      try {
        this.ledger.removeStagedAttemptOutput(state, stage, previous.attempt)
      } catch (error) {
        throw new ExperimentError(
          `cannot safely release failed ${stage} attempt output before retry: ${errorMessage(error)}`,
          'RECOVERY_REQUIRED',
          { stage, cause: error },
        )
      }
      const previousDirectory = this.ledger.localAttemptDirectory(state, stage, previous.attempt)
      const cleanupPath = resolve(previousDirectory, 'output-cleanup.json')
      this.ledger.writeNewOrSameJson(state.run_directory, cleanupPath, {
        schema_version: 'autodata-experiment-output-cleanup-1',
        stage,
        attempt: previous.attempt,
        removed_path: outputRoot(state, stage, previous.attempt),
        failure_code: previous.failure_code,
        failure_message: previous.failure_message,
      })
      state = replaceExperimentAttempt(state, state.attempts.length - 1, {
        output_cleanup_path: cleanupPath,
      }, nowIso(this.now))
    }
    const localDirectory = this.ledger.localAttemptDirectory(state, stage, attemptNumber)
    const stagedDirectory = this.ledger.stagedAttemptDirectory(state, stage, attemptNumber)
    this.ledger.createDirectory(state.run_directory, localDirectory)
    this.ledger.createDirectory(state.staging_directory, stagedDirectory)
    const output = outputRoot(state, stage, attemptNumber)
    const request = stage === 'train'
      ? createExperimentTrainRequest({
        contract,
        contract_sha256: state.contract_sha256,
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
      : createExperimentEvalRequest({
        contract,
        contract_sha256: state.contract_sha256,
        profile_id: state.profile_id,
        run_id: state.run_id,
        attempt: attemptNumber,
        checkpoint_path: this.trainingCheckpoint(state, contract),
        output_root: output,
      })
    const requestPath = resolve(stagedDirectory, 'request.json')
    this.ledger.writeNewOrSameJson(state.staging_directory, requestPath, request)
    this.ledger.writeNewOrSameJson(state.run_directory, resolve(localDirectory, 'request.json'), request)
    const createdAt = nowIso(this.now)
    const attempt: ExperimentAttempt = {
      stage,
      attempt: attemptNumber,
      status: 'prepared',
      rjob_name: experimentRJobName(state.run_id, stage, attemptNumber),
      request_path: requestPath,
      result_path: resultPath(state, stage, attemptNumber),
      created_at: createdAt,
      updated_at: createdAt,
      ...(attemptNumber === 2 ? { retry_classification: 'infrastructure' as const } : {}),
    }
    return {
      state: normalizeExperimentState({
        ...state,
        status: 'running',
        phase: stage,
        attempts: [...state.attempts, attempt],
        updated_at: createdAt,
        failure: undefined,
      }),
      request,
    }
  }

  private async preflightAndSubmit(
    initial: ExperimentState,
    attemptIndex: number,
    request: ExperimentTrainRequest | ExperimentEvalRequest,
    spec: Stage4ARJobSpec,
    live: LiveRun,
    resumeFrom: ExperimentAttempt['status'],
    contract: ExperimentContract,
  ): Promise<ExperimentState> {
    let state = initial
    const local = this.ledger.localAttemptDirectory(state, spec.stage, request.attempt)
    if (resumeFrom === 'prepared' || resumeFrom === 'dry_running') {
      state = this.updateAttempt(state, attemptIndex, { status: 'dry_running' })
      let result: Stage4ACommandResult
      try { result = await this.backend().dryRun(spec, live.abort.signal) } catch (error) {
        throw asExperimentError(error, 'DRY_RUN_FAILED', spec.stage)
      }
      const path = resumeFrom === 'dry_running'
        ? this.ledger.nextArtifactPath(state.run_directory, local, 'dry-run-recovery')
        : resolve(local, 'dry-run.json')
      this.ledger.writeNewJson(state.run_directory, path, result)
      state = this.updateAttempt(state, attemptIndex, { status: 'dry_passed', dry_run_path: path })
      this.note(live, `${spec.stage} dry-run passed`)
    }
    const current = state.attempts[attemptIndex]
    if (current === undefined) throw new ExperimentError('attempt disappeared during preflight', 'STATE_CORRUPT', { stage: spec.stage })
    if (current.status === 'dry_passed' || current.status === 'predict_running') {
      state = this.updateAttempt(state, attemptIndex, { status: 'predict_running' })
      let result: Stage4ACommandResult
      try { result = await this.backend().predict(spec, live.abort.signal) } catch (error) {
        throw asExperimentError(error, 'UNSCHEDULABLE', spec.stage)
      }
      const path = current.status === 'predict_running'
        ? this.ledger.nextArtifactPath(state.run_directory, local, 'prediction-recovery')
        : resolve(local, 'prediction.json')
      this.ledger.writeNewJson(state.run_directory, path, result)
      state = this.updateAttempt(state, attemptIndex, { status: 'predict_passed', prediction_path: path })
      this.note(live, `${spec.stage} predict-only passed 1/1`)
    }
    const predicted = state.attempts[attemptIndex]
    if (predicted?.status !== 'predict_passed') {
      throw new ExperimentError(`cannot submit ${spec.stage} from ${predicted?.status ?? 'missing'} state`, 'STATE_CORRUPT', { stage: spec.stage })
    }
    state = this.updateAttempt(state, attemptIndex, { status: 'submitting' })
    live.remoteName = spec.rjob_name
    live.remoteConfirmed = false
    let submission: Stage4ACommandResult
    try {
      submission = await this.backend().submit(spec, live.abort.signal)
    } catch (error) {
      throw new ExperimentError(
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
    return this.monitor(state, attemptIndex, request, spec, live, contract)
  }

  private async monitor(
    initial: ExperimentState,
    attemptIndex: number,
    request: ExperimentTrainRequest | ExperimentEvalRequest,
    spec: Stage4ARJobSpec,
    live: LiveRun,
    contract: ExperimentContract,
    initialRemoteStatus?: Stage4ARJobObservation['status'],
  ): Promise<ExperimentState> {
    let state = initial
    let remoteStatus = initialRemoteStatus
    let missingObservations = 0
    for (;;) {
      if (live.abort.signal.aborted) throw live.abort.signal.reason
      if (remoteStatus === undefined) {
        const attempt = state.attempts[attemptIndex]
        if (attempt === undefined) throw new ExperimentError('attempt disappeared while monitoring', 'STATE_CORRUPT', { stage: spec.stage })
        const observation = await this.inspectForRecovery(state, attempt, live)
        remoteStatus = observation.status
      }
      if (remoteStatus === 'succeeded') break
      if (remoteStatus === 'failed' || remoteStatus === 'stopped') {
        state = (await this.collectTerminalLogs(state, attemptIndex, spec, live, 'failed')).state
        // A worker-written result is authoritative evidence of a scientific or
        // protocol failure. Validate it strictly so it can never consume the
        // infrastructure retry merely because the enclosing RJob exited 1.
        if (existsSync(request.output.result_json)) {
          const failedResult = this.ledger.readJson(
            state.staging_directory,
            request.output.result_json,
            `${spec.stage} failed result`,
          )
          const result = spec.stage === 'train'
            ? normalizeExperimentTrainResult(
              failedResult,
              request as ExperimentTrainRequest,
              contract,
              { allow_failed: true },
            )
            : normalizeExperimentEvalResult(
              failedResult,
              request as ExperimentEvalRequest,
              contract,
              { allow_failed: true },
            )
          if (result.status === 'failed') {
            throw new ExperimentError(
              `${spec.rjob_name} worker failed: ${result.failure as string}`,
              'WORKER_FAILED',
              { stage: spec.stage },
            )
          }
          throw new ExperimentError(
            `${spec.rjob_name} ${remoteStatus} despite emitting a passing result`,
            'ARTIFACT_INVALID',
            { stage: spec.stage },
          )
        }
        throw new ExperimentError(`${spec.rjob_name} ${remoteStatus} without a worker result`, 'REMOTE_FAILED', { stage: spec.stage })
      }
      if (remoteStatus === 'missing') {
        missingObservations += 1
        if (missingObservations >= 3) {
          throw new ExperimentError(`${spec.rjob_name} is missing after submission`, 'RECOVERY_REQUIRED', { stage: spec.stage })
        }
      } else {
        missingObservations = 0
      }
      state = this.updateAttempt(state, attemptIndex, { status: 'monitoring' })
      await this.sleep(this.pollIntervalMs, live.abort.signal)
      remoteStatus = undefined
    }
    const collected = await this.collectTerminalLogs(state, attemptIndex, spec, live, 'completed')
    state = collected.state
    const local = this.ledger.localAttemptDirectory(state, spec.stage, request.attempt)
    const logsPath = collected.logsPath
    const rawResult = this.ledger.readJson(state.staging_directory, request.output.result_json, `${spec.stage} result`)
    const localResultPath = resolve(local, 'result.json')
    if (spec.stage === 'train') {
      const trainRequest = request as ExperimentTrainRequest
      const result = normalizeExperimentTrainResult(rawResult, trainRequest, contract)
      this.ledger.requireDirectory(state.staging_directory, result.checkpoint_path, 'training checkpoint')
      this.ledger.writeNewOrSameJson(state.run_directory, localResultPath, result)
      const succeeded = replaceExperimentAttempt(state, attemptIndex, { status: 'succeeded', logs_path: logsPath }, nowIso(this.now))
      state = normalizeExperimentState({
        ...succeeded,
        phase: 'eval',
        train_result_path: localResultPath,
        updated_at: nowIso(this.now),
        failure: undefined,
      })
    } else {
      const evalRequest = request as ExperimentEvalRequest
      const result = normalizeExperimentEvalResult(rawResult, evalRequest, contract)
      const localPredictionsPath = resolve(local, 'predictions.jsonl')
      this.ledger.copyNewOrSame(state.run_directory, result.predictions_path, localPredictionsPath)
      const predictionsStat = lstatSync(localPredictionsPath)
      if (!predictionsStat.isFile() || predictionsStat.size > PREDICTIONS_LIMIT_BYTES) {
        throw new ExperimentError(
          'evaluation predictions must be a regular JSONL file no larger than 16 MiB',
          'ARTIFACT_INVALID',
          { stage: 'eval' },
        )
      }
      let predictionsText: string
      try {
        predictionsText = readFileSync(localPredictionsPath, 'utf8')
      } catch (error) {
        throw new ExperimentError('cannot read durable evaluation predictions', 'ARTIFACT_INVALID', {
          stage: 'eval',
          cause: error,
        })
      }
      normalizeExperimentPredictionsJsonl(predictionsText, result.cases)
      this.ledger.writeNewOrSameJson(state.run_directory, localResultPath, result)
      const succeeded = replaceExperimentAttempt(state, attemptIndex, { status: 'succeeded', logs_path: logsPath }, nowIso(this.now))
      state = normalizeExperimentState({
        ...succeeded,
        status: 'running',
        phase: 'registering',
        eval_result_path: localResultPath,
        updated_at: nowIso(this.now),
        failure: undefined,
      })
    }
    this.ledger.saveState(state)
    delete live.remoteName
    delete live.remoteConfirmed
    delete live.stop
    this.note(live, `${spec.stage} experiment result validated`)
    return state
  }

  private async inspectForRecovery(
    state: ExperimentState,
    attempt: ExperimentAttempt,
    live: LiveRun,
  ): Promise<Stage4ARJobObservation> {
    let observation: Stage4ARJobObservation
    try {
      observation = await this.backend().inspect(attempt.rjob_name, live.abort.signal)
    } catch (error) {
      throw new ExperimentError(`cannot determine remote state for ${attempt.rjob_name}`, 'RECOVERY_REQUIRED', {
        stage: attempt.stage,
        cause: error,
      })
    }
    this.recordObservation(state, attempt, observation.command, 'observation')
    return observation
  }

  private async collectTerminalLogs(
    state: ExperimentState,
    attemptIndex: number,
    spec: Stage4ARJobSpec,
    live: LiveRun,
    terminal: 'completed' | 'failed',
  ): Promise<{ readonly state: ExperimentState; readonly logsPath: string }> {
    const attempt = state.attempts[attemptIndex]
    if (attempt === undefined) {
      throw new ExperimentError('attempt disappeared while collecting logs', 'STATE_CORRUPT', { stage: spec.stage })
    }
    if (attempt.logs_path !== undefined) {
      this.ledger.readJson(state.run_directory, attempt.logs_path, `${spec.stage} logs`)
      return { state, logsPath: attempt.logs_path }
    }
    let logs: Stage4ACommandResult
    try { logs = await this.backend().logs(spec.rjob_name, live.abort.signal) } catch (error) {
      throw new ExperimentError(`cannot collect logs for ${terminal} ${spec.rjob_name}`, 'RECOVERY_REQUIRED', {
        stage: spec.stage,
        cause: error,
      })
    }
    const local = this.ledger.localAttemptDirectory(state, spec.stage, attempt.attempt)
    const logsPath = this.ledger.nextArtifactPath(state.run_directory, local, 'logs')
    this.ledger.writeNewJson(state.run_directory, logsPath, logs)
    return { state: this.updateAttempt(state, attemptIndex, { logs_path: logsPath }), logsPath }
  }

  private readAttemptRequest(
    state: ExperimentState,
    attempt: ExperimentAttempt,
    contract: ExperimentContract,
  ): ExperimentTrainRequest | ExperimentEvalRequest {
    const value = this.ledger.readJson(state.staging_directory, attempt.request_path, `${attempt.stage} request`)
    const request = attempt.stage === 'train'
      ? normalizeExperimentTrainRequest(value, contract, state.contract_sha256)
      : normalizeExperimentEvalRequest(value, contract, state.contract_sha256)
    if (request.profile_id !== state.profile_id || request.run_id !== state.run_id || request.attempt !== attempt.attempt) {
      throw new ExperimentError(`${attempt.stage} request does not match durable state`, 'STATE_CORRUPT', { stage: attempt.stage })
    }
    const expected = attempt.stage === 'train'
      ? createExperimentTrainRequest({
        contract,
        contract_sha256: state.contract_sha256,
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
      : createExperimentEvalRequest({
        contract,
        contract_sha256: state.contract_sha256,
        profile_id: state.profile_id,
        run_id: state.run_id,
        attempt: attempt.attempt,
        checkpoint_path: this.trainingCheckpoint(state, contract),
        output_root: outputRoot(state, 'eval', attempt.attempt),
      })
    if (canonicalJson(request) !== canonicalJson(expected)) {
      throw new ExperimentError(`${attempt.stage} request paths or protocol fields do not match durable state`, 'STATE_CORRUPT', { stage: attempt.stage })
    }
    return request
  }

  private trainingCheckpoint(state: ExperimentState, contract: ExperimentContract): string {
    const attempt = [...state.attempts].reverse().find(value => value.stage === 'train' && value.status === 'succeeded')
    if (attempt === undefined || state.train_result_path === undefined) {
      throw new ExperimentError('evaluation requires a validated training result', 'STATE_CORRUPT', { stage: 'eval' })
    }
    return resolve(outputRoot(state, 'train', attempt.attempt), 'train', `checkpoint-${String(contract.training.max_steps)}`)
  }

  private attemptSpec(state: ExperimentState, attempt: ExperimentAttempt, contract: ExperimentContract): Stage4ARJobSpec {
    return Object.freeze({
      stage: attempt.stage,
      rjob_name: attempt.rjob_name,
      staging_directory: state.staging_directory,
      script_path: resolve(state.staging_directory, `${attempt.stage}.sh`),
      request_path: attempt.request_path,
      request_environment: REQUEST_ENVIRONMENT,
      // The H-cluster rejects zero. A platform replay cannot repeat scientific
      // work because each worker creates its attempt output root exclusively;
      // only the Controller may clean that root and create formal attempt 2.
      backoff_limit: contract.execution.rjob_backoff_limit,
      container_image: contract.execution.container_image,
      resources: attempt.stage === 'train'
        ? { gpu: contract.training.gpus, cpu: 64, memory_mib: 327_680 }
        : { gpu: contract.evaluation.gpus, cpu: 16, memory_mib: 81_920 },
    })
  }

  private updateAttempt(state: ExperimentState, attemptIndex: number, patch: Partial<ExperimentAttempt>): ExperimentState {
    return this.ledger.saveState(replaceExperimentAttempt(state, attemptIndex, patch, nowIso(this.now)))
  }

  private recordObservation(state: ExperimentState, attempt: ExperimentAttempt, result: ExperimentCommandResult, stem: string): void {
    const local = this.ledger.localAttemptDirectory(state, attempt.stage, attempt.attempt)
    this.ledger.writeNewJson(state.run_directory, this.ledger.nextArtifactPath(state.run_directory, local, stem), result)
  }

  private completeInitialization(state: ExperimentState): ExperimentState {
    if (state.phase !== 'initializing') return state
    this.ledger.ensureStagingDirectory(state)
    for (const name of ['canonical.jsonl', 'logical-view.jsonl', 'run-summary.json', 'experiment-contract.json'] as const) {
      this.ledger.copyNewOrSame(state.staging_directory, resolve(state.run_directory, name), resolve(state.staging_directory, name))
    }
    for (const name of EXPERIMENT_FILES) {
      this.ledger.copyNewOrSame(state.staging_directory, assertSourceFile(this.assetRoot, name), resolve(state.staging_directory, name))
    }
    for (const name of COMMON_WORKER_FILES) {
      this.ledger.copyNewOrSame(
        state.staging_directory,
        assertSourceFile(this.commonWorkerRoot, name),
        resolve(state.staging_directory, 'python/autodata_stage4a', name),
      )
    }
    const materialized = normalizeExperimentState({
      ...state,
      phase: 'materialized',
      updated_at: nowIso(this.now),
    })
    return this.ledger.saveState(materialized)
  }

  private async registerResult(
    state: ExperimentState,
    live: LiveRun,
    contract: ExperimentContract,
    agent?: ExperimentRuntimeAgent,
  ): Promise<ExperimentState> {
    return contract.subject === undefined
      ? this.registerBaseline(state, live, contract)
      : this.registerCandidateEvaluation(state, live, contract, agent)
  }

  private registerBaseline(state: ExperimentState, live: LiveRun, contract: ExperimentContract): ExperimentState {
    const result = this.readValidatedEvaluation(state, contract)
    const evaluationResultPath = state.eval_result_path
    if (evaluationResultPath === undefined) {
      throw new ExperimentError('baseline registration requires a durable evaluation result', 'STATE_CORRUPT')
    }
    const { feedbackId, reportId } = this.baselineIds(state)
    const searchCases = result.cases.filter(value => value.split === 'B_search')
    const searchArtifactPath = resolve(state.run_directory, 'b-search-results.json')
    this.ledger.writeNewOrSameJson(state.run_directory, searchArtifactPath, {
      schema_version: 'autodata-b-search-results-1',
      contract_id: state.contract_id,
      contract_sha256: state.contract_sha256,
      profile_id: state.profile_id,
      run_id: state.run_id,
      cases: searchCases,
      category_scores: result.category_scores.B_search,
      macro_score: result.macro_scores.B_search,
    })
    const feedback: EvolutionFeedback = {
      schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
      feedback_id: feedbackId,
      profile_id: state.profile_id,
      candidate_id: H0_CANDIDATE_ID,
      benchmark: contract.profile.benchmark,
      split: 'B_search',
      summary: `H0 completed ${String(searchCases.length)} B_search cases; macro ${String(result.macro_scores.B_search)}`,
      failures: searchCases.filter(value => !value.passed).map(value => ({
        case_id: value.case_id,
        category: value.category,
        summary: value.failure_summary ?? 'BFCL case failed',
      })),
      metrics: {
        macro_score: result.macro_scores.B_search,
        ...Object.fromEntries(Object.entries(result.category_scores.B_search).map(([category, score]) => [`category_${category}`, score])),
      },
      artifact_path: searchArtifactPath,
      metadata: {
        contract_id: state.contract_id,
        contract_sha256: state.contract_sha256,
        run_id: state.run_id,
        cases_evaluated: searchCases.length,
      },
    }
    const devCases = result.cases.filter(value => value.split === 'B_dev')
    const report: EvaluationReport = {
      schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
      report_id: reportId,
      profile_id: state.profile_id,
      candidate_id: H0_CANDIDATE_ID,
      benchmark: contract.profile.benchmark,
      split: 'B_dev',
      metric: contract.profile.metric,
      score: result.macro_scores.B_dev,
      complete: true,
      cases_evaluated: devCases.length,
      cases_expected: contract.evaluation.categories.length * contract.evaluation.cases_per_category_per_split,
      run_id: state.run_id,
      category_scores: result.category_scores.B_dev,
      metadata: {
        contract_id: state.contract_id,
        contract_sha256: state.contract_sha256,
        evaluation_result_path: evaluationResultPath,
      },
    }
    this.ledger.writeNewOrSameJson(state.run_directory, resolve(state.run_directory, 'feedback.json'), feedback)
    this.ledger.writeNewOrSameJson(state.run_directory, resolve(state.run_directory, 'evaluation-report.json'), report)
    try {
      this.ensureFeedback(feedback)
      if (state.feedback_id === undefined) {
        state = this.ledger.saveState(normalizeExperimentState({
          ...state,
          feedback_id: feedbackId,
          updated_at: nowIso(this.now),
        }))
      } else if (state.feedback_id !== feedbackId) {
        throw new ExperimentError('durable experiment feedback id conflicts with the evaluated result', 'STATE_CORRUPT')
      }
      this.options.evolution.registerBaseline(report)
    } catch (error) {
      throw new ExperimentError(`cannot register the H0 baseline: ${errorMessage(error)}`, 'BASELINE_REGISTRATION_FAILED', { cause: error })
    }
    const complete = normalizeExperimentState({
      ...state,
      status: 'succeeded',
      phase: 'complete',
      evaluation_report_id: reportId,
      updated_at: nowIso(this.now),
      failure: undefined,
    })
    this.note(live, 'B_search feedback and B_dev H0 evaluation are durably registered')
    return this.ledger.saveState(complete)
  }

  private async registerCandidateEvaluation(
    state: ExperimentState,
    live: LiveRun,
    contract: ExperimentContract,
    agent?: ExperimentRuntimeAgent,
  ): Promise<ExperimentState> {
    const subject = contract.subject
    if (subject === undefined || state.candidate_id !== subject.candidate_id || agent === undefined) {
      throw new ExperimentError('H1 evaluation registration requires its frozen candidate and runtime Agent', 'STATE_CORRUPT')
    }
    const result = this.readValidatedEvaluation(state, contract)
    const evaluationResultPath = state.eval_result_path
    if (evaluationResultPath === undefined) {
      throw new ExperimentError('candidate registration requires a durable evaluation result', 'STATE_CORRUPT')
    }
    const snapshot = this.options.evolution.store.loadConsistentSnapshot(state.profile_id)
    // Stage 4C is pre-registered against H0, not whichever candidate happens
    // to be active when an idempotent replay reaches this point. In the crash
    // window after recordEvaluation() commits an accepted H1 but before the
    // experiment ledger stores its decision, active_evaluation already points
    // at H1. The immutable H0 candidate summary remains the comparison anchor.
    const baseline = snapshot.state.candidates
      .find(candidate => candidate.candidate_id === H0_CANDIDATE_ID)?.evaluation
    if (
      baseline === undefined
      || baseline.candidate_id !== H0_CANDIDATE_ID
      || baseline.benchmark !== contract.profile.benchmark
      || baseline.split !== 'B_dev'
      || baseline.metric !== contract.profile.metric
    ) {
      throw new ExperimentError('candidate evaluation requires the durable H0 B_dev baseline', 'EVALUATION_REGISTRATION_FAILED')
    }
    const { reportId } = this.candidateIds(state)
    const searchCases = result.cases.filter(value => value.split === 'B_search')
    const searchArtifactPath = resolve(state.run_directory, 'b-search-results.json')
    this.ledger.writeNewOrSameJson(state.run_directory, searchArtifactPath, {
      schema_version: 'autodata-b-search-results-1',
      contract_id: state.contract_id,
      contract_sha256: state.contract_sha256,
      profile_id: state.profile_id,
      run_id: state.run_id,
      candidate_id: subject.candidate_id,
      cases: searchCases,
      category_scores: result.category_scores.B_search,
      macro_score: result.macro_scores.B_search,
    })
    const devCases = result.cases.filter(value => value.split === 'B_dev')
    const report: EvaluationReport = {
      schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
      report_id: reportId,
      profile_id: state.profile_id,
      candidate_id: subject.candidate_id,
      benchmark: contract.profile.benchmark,
      split: 'B_dev',
      metric: contract.profile.metric,
      score: result.macro_scores.B_dev,
      complete: true,
      cases_evaluated: devCases.length,
      cases_expected: contract.evaluation.categories.length * contract.evaluation.cases_per_category_per_split,
      run_id: state.run_id,
      baseline_candidate_id: baseline.candidate_id,
      baseline_score: baseline.score,
      category_scores: result.category_scores.B_dev,
      metadata: {
        contract_id: state.contract_id,
        contract_sha256: state.contract_sha256,
        evaluation_result_path: evaluationResultPath,
        b_search_artifact_path: searchArtifactPath,
      },
    }
    const reportPath = resolve(state.run_directory, 'evaluation-report.json')
    const decisionPath = resolve(state.run_directory, 'decision.json')
    this.ledger.writeNewOrSameJson(state.run_directory, reportPath, report)
    try {
      const outcome = await this.options.evolution.recordEvaluation(report, agent)
      this.ledger.writeNewOrSameJson(state.run_directory, decisionPath, outcome.decision)
      const complete = normalizeExperimentState({
        ...state,
        status: 'succeeded',
        phase: 'complete',
        evaluation_report_id: reportId,
        decision_path: decisionPath,
        decision: outcome.decision,
        updated_at: nowIso(this.now),
        failure: undefined,
      })
      this.note(live, `B_dev H1 evaluation durably decided: ${outcome.decision.reason}`)
      return this.ledger.saveState(complete)
    } catch (error) {
      throw new ExperimentError(
        `cannot register the H1 evaluation: ${errorMessage(error)}`,
        'EVALUATION_REGISTRATION_FAILED',
        { cause: error },
      )
    }
  }

  private ensureFeedback(feedback: EvolutionFeedback): void {
    const snapshot = this.options.evolution.store.loadConsistentSnapshot(feedback.profile_id)
    const referenced = snapshot.feedback_records.find(value => value.feedback_id === feedback.feedback_id)
    if (referenced !== undefined) {
      if (canonicalJson(referenced) !== canonicalJson(feedback)) {
        throw new ExperimentError(`feedback ${feedback.feedback_id} conflicts with its durable record`, 'BASELINE_REGISTRATION_FAILED')
      }
      return
    }
    const orphan = this.options.evolution.store.getFeedback(feedback.profile_id, feedback.feedback_id)
    if (orphan === undefined) {
      this.options.evolution.recordFeedback(feedback)
      return
    }
    if (canonicalJson(orphan) !== canonicalJson(feedback)) {
      throw new ExperimentError(`feedback ${feedback.feedback_id} conflicts with an orphan record`, 'BASELINE_REGISTRATION_FAILED')
    }
    const next = recordEvolutionFeedback(snapshot.state, feedback)
    this.options.evolution.store.saveState(next)
  }

  private baselineIds(state: ExperimentState): { readonly feedbackId: string; readonly reportId: string } {
    const suffix = sha256(`${state.contract_sha256}\0${state.profile_id}\0${state.run_id}`).slice(0, 20)
    return { feedbackId: `h0-search-${suffix}`, reportId: `h0-dev-${suffix}` }
  }

  private candidateIds(state: ExperimentState): { readonly reportId: string } {
    const suffix = sha256(`${state.contract_sha256}\0${state.profile_id}\0${state.run_id}\0${state.candidate_id ?? ''}`).slice(0, 20)
    return { reportId: `h1-dev-${suffix}` }
  }

  private assertProfile(
    profileId: string,
    allowRegisteredBaseline: boolean,
    registrationState?: ExperimentState,
    subject?: ExperimentCandidateSubject,
  ): FrozenSelectionRuntimeBinding | undefined {
    if (profileId !== this.baselineContract.profile.id) {
      throw new ExperimentError(`profile_id must equal frozen contract profile ${this.baselineContract.profile.id}`, 'INVALID_REQUEST')
    }
    let status
    try { status = this.options.evolution.status(profileId) } catch (error) {
      throw new ExperimentError(`cannot load TaskProfile ${profileId}: ${errorMessage(error)}`, 'INVALID_REQUEST', { cause: error })
    }
    if (
      status.profile.benchmark !== this.baselineContract.profile.benchmark
      || status.profile.acceptance_policy.metric !== this.baselineContract.profile.metric
      || status.profile.acceptance_policy.split !== 'B_dev'
    ) throw new ExperimentError('TaskProfile does not match the frozen experiment contract', 'INVALID_REQUEST')
    if (subject !== undefined) {
      const snapshot = this.options.evolution.store.loadConsistentSnapshot(profileId)
      const candidate = snapshot.state.candidates.find(value => value.candidate_id === subject.candidate_id)
      const candidatePackage = snapshot.candidate_packages.find(value => value.manifest.candidate_id === subject.candidate_id)
      let runtimeBinding
      try {
        runtimeBinding = candidatePackage === undefined
          ? null
          : candidateFrozenSelectionRuntimeBinding(status.profile, candidatePackage)
      } catch (error) {
        throw new ExperimentError('H1 subject candidate has an invalid frozen runtime binding', 'INVALID_REQUEST', {
          cause: error,
        })
      }
      if (
        candidatePackage === undefined
        || runtimeBinding === null
        || candidatePackage.manifest.generation !== subject.generation
        || candidatePackage.manifest.strategy_version !== subject.strategy_version
        || status.profile.strategy_plugin_id !== subject.plugin_id
        || sha256(candidatePackage.host_source) !== subject.host_source_sha256
        || runtimeBinding.runtime_plan_sha256 !== subject.runtime_plan_sha256
        || runtimeBinding.materialization_sha256 !== subject.materialization_sha256
      ) throw new ExperimentError('H1 subject does not match the durable candidate package', 'INVALID_REQUEST')
      const expectedReportId = registrationState === undefined
        ? undefined
        : this.candidateIds(registrationState).reportId
      const committed = registrationState?.phase === 'registering'
        && candidate?.evaluation?.report_id === expectedReportId
      if (!committed && (
        snapshot.state.active_candidate_id !== H0_CANDIDATE_ID
        || snapshot.state.active_evaluation?.candidate_id !== H0_CANDIDATE_ID
        || snapshot.state.open_candidate_id !== subject.candidate_id
        || candidate?.status !== 'validated'
        || candidate?.parent_candidate_id !== H0_CANDIDATE_ID
      )) throw new ExperimentError('H1 experiment requires the single validated open child of H0', 'INVALID_REQUEST')
      return runtimeBinding
    }
    if (status.state.active_candidate_id !== H0_CANDIDATE_ID || status.state.open_candidate_id !== null) {
      const expectedReportId = registrationState === undefined
        ? undefined
        : this.baselineIds(registrationState).reportId
      const committedH0 = status.state.candidates.find(candidate => candidate.candidate_id === H0_CANDIDATE_ID)
      if (
        registrationState?.phase !== 'registering'
        || committedH0?.evaluation?.report_id !== expectedReportId
      ) {
        throw new ExperimentError('H0 baseline can only be run before candidate evolution begins', 'INVALID_REQUEST')
      }
    }
    if (!allowRegisteredBaseline && status.state.active_evaluation !== undefined) {
      throw new ExperimentError('the TaskProfile already has a registered H0 baseline', 'INVALID_REQUEST')
    }
    return undefined
  }

  /** Prove that the H1 training payload is the exact materialization named by the candidate binding. */
  private assertCandidateMaterializationBinding(
    subject: ExperimentCandidateSubject,
    binding: FrozenSelectionRuntimeBinding,
    serialized: ReturnType<typeof serializeDataRun>,
  ): void {
    const hashes = experimentArtifactHashes(serialized.files)
    const materialization = {
      schema_version: GENERATION_MATERIALIZATION_VERSION,
      candidate_id: subject.candidate_id,
      host_source_sha256: subject.host_source_sha256,
      source_pool_sha256: hashes['canonical.jsonl'],
      canonical_jsonl_sha256: hashes['canonical.jsonl'],
      logical_view_jsonl_sha256: hashes['logical-view.jsonl'],
      run_summary_json_sha256: hashes['run-summary.json'],
      selected_record_ids: binding.decisions.map(decision => decision.record_id),
      data_run: serialized.data,
    }
    if (
      binding.source_pool_sha256 !== hashes['canonical.jsonl']
      || sha256(canonicalJson(materialization)) !== binding.materialization_sha256
    ) {
      throw new ExperimentError(
        'H1 data_run does not match the candidate frozen materialization',
        'INVALID_REQUEST',
      )
    }
  }

  private assertContractBinding(state: ExperimentState): ExperimentContract {
    const localContract = resolve(state.run_directory, 'experiment-contract.json')
    let loaded: ReturnType<typeof loadExperimentContract>
    try { loaded = loadExperimentContract(localContract) } catch (error) {
      throw new ExperimentError('durable experiment contract is missing', 'STATE_CORRUPT', { cause: error })
    }
    if (loaded.sha256 !== state.contract_sha256 || loaded.contract.contract_id !== state.contract_id) {
      throw new ExperimentError('durable experiment contract binding changed', 'STATE_CORRUPT')
    }
    const contract = loaded.contract
    if (contract.subject === undefined) {
      if (
        state.candidate_id !== undefined
        || state.contract_sha256 !== this.baselineContractSha256
        || canonicalJson(contract) !== canonicalJson(this.baselineContract)
      ) throw new ExperimentError('H0 state is not bound to the checked-in baseline contract', 'STATE_CORRUPT')
    } else if (
      state.candidate_id !== contract.subject.candidate_id
      || state.candidate_generation !== contract.subject.generation
      || canonicalJson(contract.profile) !== canonicalJson(this.baselineContract.profile)
      || canonicalJson(contract.model) !== canonicalJson(this.baselineContract.model)
      || canonicalJson(contract.execution) !== canonicalJson(this.baselineContract.execution)
      || canonicalJson(contract.training) !== canonicalJson(this.baselineContract.training)
      || canonicalJson(contract.evaluation) !== canonicalJson(this.baselineContract.evaluation)
      || canonicalJson(contract.retry) !== canonicalJson(this.baselineContract.retry)
      || contract.data.dataset_id !== this.baselineContract.data.dataset_id
      || contract.data.dataset_subset !== this.baselineContract.data.dataset_subset
      || contract.data.dataset_revision !== this.baselineContract.data.dataset_revision
      || contract.data.seed !== this.baselineContract.data.seed
      || contract.data.canonical_records !== this.baselineContract.data.canonical_records
      || contract.data.historical_training_tokens !== this.baselineContract.data.historical_training_tokens
      || contract.data.canonical_jsonl_sha256 !== this.baselineContract.data.canonical_jsonl_sha256
    ) throw new ExperimentError('H1 contract does not preserve the frozen H0 protocol and source pool', 'STATE_CORRUPT')
    if (state.status === 'succeeded') {
      this.readValidatedEvaluation(state, contract)
      if (contract.subject === undefined) this.assertRegisteredBaseline(state)
      else this.assertRegisteredCandidate(state, contract)
    }
    return contract
  }

  /** Revalidate the durable result and its exact 50-case prediction sidecar on every registration/replay. */
  private readValidatedEvaluation(
    state: ExperimentState,
    contract: ExperimentContract,
  ): ExperimentEvalResult {
    if (state.eval_result_path === undefined) {
      throw new ExperimentError('evaluation registration requires a durable result', 'STATE_CORRUPT')
    }
    const attempt = [...state.attempts].reverse().find(value =>
      value.stage === 'eval' && value.status === 'succeeded')
    if (attempt === undefined) {
      throw new ExperimentError('evaluation registration requires a successful evaluation attempt', 'STATE_CORRUPT')
    }
    const expectedResultPath = resolve(
      this.ledger.localAttemptDirectory(state, 'eval', attempt.attempt),
      'result.json',
    )
    if (state.eval_result_path !== expectedResultPath) {
      throw new ExperimentError('durable evaluation result path does not match its successful attempt', 'STATE_CORRUPT')
    }
    const request = this.readAttemptRequest(state, attempt, contract) as ExperimentEvalRequest
    const raw = this.ledger.readJson(state.run_directory, state.eval_result_path, 'durable evaluation result')
    const result = normalizeExperimentEvalResult(raw, request, contract)
    const predictionsPath = assertSourceFile(
      state.run_directory,
      relative(
        state.run_directory,
        resolve(this.ledger.localAttemptDirectory(state, 'eval', attempt.attempt), 'predictions.jsonl'),
      ),
    )
    const predictionsStat = lstatSync(predictionsPath)
    if (predictionsStat.size > PREDICTIONS_LIMIT_BYTES) {
      throw new ExperimentError(
        'evaluation predictions must be no larger than 16 MiB',
        'ARTIFACT_INVALID',
        { stage: 'eval' },
      )
    }
    let predictionsText: string
    try {
      predictionsText = readFileSync(predictionsPath, 'utf8')
    } catch (error) {
      throw new ExperimentError('cannot read durable evaluation predictions', 'ARTIFACT_INVALID', {
        stage: 'eval',
        cause: error,
      })
    }
    normalizeExperimentPredictionsJsonl(predictionsText, result.cases)
    return result
  }

  private assertRegisteredBaseline(state: ExperimentState): void {
    if (state.feedback_id === undefined || state.evaluation_report_id === undefined) {
      throw new ExperimentError('completed experiment is missing its baseline identifiers', 'STATE_CORRUPT')
    }
    try {
      const localFeedback = normalizeEvolutionFeedback(this.ledger.readJson(
        state.run_directory,
        resolve(state.run_directory, 'feedback.json'),
        'durable B_search feedback',
      ) as EvolutionFeedback)
      const localReport = normalizeEvaluationReport(this.ledger.readJson(
        state.run_directory,
        resolve(state.run_directory, 'evaluation-report.json'),
        'durable B_dev evaluation report',
      ) as EvaluationReport)
      if (
        localFeedback.feedback_id !== state.feedback_id
        || localReport.report_id !== state.evaluation_report_id
        || localFeedback.profile_id !== state.profile_id
        || localReport.profile_id !== state.profile_id
        || localReport.run_id !== state.run_id
      ) throw new Error('local baseline records do not match experiment state')
      const snapshot = this.options.evolution.store.loadConsistentSnapshot(state.profile_id)
      const storedFeedback = snapshot.feedback_records.find(value => value.feedback_id === state.feedback_id)
      const storedEvaluation = snapshot.evaluation_records.find(value =>
        value.report.report_id === state.evaluation_report_id)
      if (
        storedFeedback === undefined
        || storedEvaluation === undefined
        || canonicalJson(storedFeedback) !== canonicalJson(localFeedback)
        || canonicalJson(storedEvaluation.report) !== canonicalJson(localReport)
        || storedEvaluation.decision !== undefined
      ) throw new Error('Evolution store does not contain the committed H0 baseline records')
    } catch (error) {
      if (error instanceof ExperimentError && error.code === 'STATE_CORRUPT') throw error
      throw new ExperimentError(
        `completed experiment baseline is inconsistent: ${errorMessage(error)}`,
        'STATE_CORRUPT',
        { profile_id: state.profile_id, run_id: state.run_id, cause: error },
      )
    }
  }

  private assertRegisteredCandidate(state: ExperimentState, contract: ExperimentContract): void {
    if (
      contract.subject === undefined
      || state.evaluation_report_id === undefined
      || state.decision === undefined
      || state.decision_path === undefined
      || state.feedback_id !== undefined
    ) throw new ExperimentError('completed H1 experiment is missing its decision identifiers', 'STATE_CORRUPT')
    try {
      const localReport = normalizeEvaluationReport(this.ledger.readJson(
        state.run_directory,
        resolve(state.run_directory, 'evaluation-report.json'),
        'durable H1 B_dev evaluation report',
      ) as EvaluationReport)
      const localDecision = this.ledger.readJson(state.run_directory, state.decision_path, 'durable H1 decision')
      const snapshot = this.options.evolution.store.loadConsistentSnapshot(state.profile_id)
      const stored = snapshot.evaluation_records.find(value => value.report.report_id === state.evaluation_report_id)
      const candidate = snapshot.state.candidates.find(value => value.candidate_id === contract.subject?.candidate_id)
      if (
        localReport.report_id !== state.evaluation_report_id
        || localReport.profile_id !== state.profile_id
        || localReport.candidate_id !== contract.subject.candidate_id
        || localReport.run_id !== state.run_id
        || canonicalJson(localDecision) !== canonicalJson(state.decision)
        || stored?.decision === undefined
        || canonicalJson(stored.report) !== canonicalJson(localReport)
        || canonicalJson(stored.decision) !== canonicalJson(state.decision)
        || candidate?.evaluation?.report_id !== state.evaluation_report_id
      ) throw new Error('Evolution store does not contain the committed H1 evaluation decision')
    } catch (error) {
      if (error instanceof ExperimentError && error.code === 'STATE_CORRUPT') throw error
      throw new ExperimentError(
        `completed candidate experiment is inconsistent: ${errorMessage(error)}`,
        'STATE_CORRUPT',
        { profile_id: state.profile_id, run_id: state.run_id, cause: error },
      )
    }
  }

  private canRetryInfrastructure(
    error: ExperimentError,
    attempt: ExperimentAttempt | undefined,
    stage: ExperimentStage,
    contract: ExperimentContract,
  ): boolean {
    return attempt?.stage === stage
      && attempt.attempt === 1
      && !['submitting', 'succeeded', 'cancelled'].includes(attempt.status)
      && RETRYABLE_INFRASTRUCTURE_ERRORS.has(error.code)
      && contract.retry.infrastructure_retries_per_stage === 1
  }

  private async reconcileCancellation(
    state: ExperimentState,
    attempt: ExperimentAttempt | undefined,
    live?: LiveRun,
  ): Promise<ExperimentState> {
    if (attempt === undefined) return this.cancelState(state)
    const hasRemoteBoundary = live?.remoteName !== undefined || ['submitting', 'submitted', 'monitoring'].includes(attempt.status)
    if (!hasRemoteBoundary) return this.cancelState(state, attempt)
    const remoteName = live?.remoteName ?? attempt.rjob_name
    let stopped: ExperimentCommandResult | undefined
    let stopError: unknown
    if (live?.stop !== undefined) {
      try { stopped = await live.stop } catch (error) { stopError = error }
    }
    if (stopped !== undefined) {
      this.recordCancellation(state, attempt, stopped)
      return this.cancelState(state, attempt)
    }
    let observation: Stage4ARJobObservation
    try {
      observation = await this.backend().inspect(remoteName, new AbortController().signal)
      this.recordObservation(state, attempt, observation.command, 'cancel-inspect')
    } catch (error) {
      return this.failState(state, new ExperimentError(
        `cannot determine remote state while cancelling ${remoteName}: ${errorMessage(error)}`,
        'RECOVERY_REQUIRED',
        { stage: attempt.stage, cause: error },
      ), attempt)
    }
    if (observation.status === 'missing' && attempt.status === 'submitting') {
      return this.failState(state, new ExperimentError(
        `submission outcome for ${remoteName} remains unknown after cancellation`,
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
      return this.failState(state, new ExperimentError(
        `remote cancellation failed for ${remoteName}: ${errorMessage(error)}`,
        'RECOVERY_REQUIRED',
        { stage: attempt.stage, cause: error },
      ), attempt)
    }
  }

  private recordCancellation(state: ExperimentState, attempt: ExperimentAttempt, result: ExperimentCommandResult): void {
    const local = this.ledger.localAttemptDirectory(state, attempt.stage, attempt.attempt)
    this.ledger.writeNewJson(state.run_directory, this.ledger.nextArtifactPath(state.run_directory, local, 'cancel'), result)
  }

  private failState(state: ExperimentState, error: ExperimentError, attempt?: ExperimentAttempt): ExperimentState {
    const recovery = error.code === 'RECOVERY_REQUIRED'
    let next = state
    if (attempt !== undefined && !['succeeded', 'failed', 'cancelled'].includes(attempt.status)) {
      next = replaceExperimentAttempt(state, state.attempts.length - 1, {
        status: recovery ? attempt.status : 'failed',
        ...(recovery ? {} : { failure_code: error.code, failure_message: error.message }),
      }, nowIso(this.now))
    }
    return normalizeExperimentState({
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

  private registrationFailureState(state: ExperimentState, error: ExperimentError): ExperimentState {
    const code = error.code === 'EVALUATION_REGISTRATION_FAILED'
      ? 'EVALUATION_REGISTRATION_FAILED'
      : 'BASELINE_REGISTRATION_FAILED'
    return normalizeExperimentState({
      ...state,
      status: 'recovery_required',
      updated_at: nowIso(this.now),
      failure: { code, message: error.message },
    })
  }

  private cancelState(state: ExperimentState, attempt?: ExperimentAttempt): ExperimentState {
    let next = state
    if (attempt !== undefined && !['succeeded', 'failed', 'cancelled'].includes(attempt.status)) {
      next = replaceExperimentAttempt(state, state.attempts.length - 1, { status: 'cancelled' }, nowIso(this.now))
    }
    return normalizeExperimentState({ ...next, status: 'cancelled', updated_at: nowIso(this.now), failure: undefined })
  }

  private note(live: LiveRun, message: string): void {
    live.output.push(message)
    while (Buffer.byteLength(live.output.join('\n'), 'utf8') > OUTPUT_LIMIT_BYTES && live.output.length > 1) live.output.shift()
  }

  private backend(): ExperimentRJobBackend {
    return this.backendValue ??= Stage4ARJobClient.fromContext(this.ctx)
  }

  private jobs(): ExperimentJobRegistry {
    if (this.jobsValue !== undefined) return this.jobsValue
    const jobs = this.ctx.get('jobs', false) as ExperimentJobRegistry | undefined
    if (jobs === undefined) throw new ExperimentError('DSH jobs service is unavailable', 'DEPENDENCY_UNAVAILABLE')
    return this.jobsValue = jobs
  }

  private ensureJobController(jobs: ExperimentJobRegistry): void {
    this.detachJobController ??= jobs.attachController('autodata-experiment-host')
  }

  private assertUsable(): void {
    if (this.disposed) throw new ExperimentError('experiment controller is disposed', 'DEPENDENCY_UNAVAILABLE')
  }
}

/** Narrow helper retained for tests that need a branded synthetic id. */
export function experimentJobId(value: string): JobId {
  return JobId(value)
}

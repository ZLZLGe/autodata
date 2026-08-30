/** Durable experiment ledger built on the hardened Stage 4A artifact primitives. */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalJson, immutableJson, isJsonObject } from '../core/json.js'
import {
  DEFAULT_STAGE4A_RUN_ROOT,
  DEFAULT_STAGE4A_STAGING_ROOT,
  Stage4ALedger,
} from '../stage4a/ledger.js'
import { validateExperimentId } from './contracts.js'
import { experimentRJobName, normalizeExperimentState } from './state.js'
import {
  EXPERIMENT_STATE_VERSION,
  ExperimentError,
  type ExperimentAttempt,
  type ExperimentStage,
  type ExperimentState,
} from './types.js'

export const DEFAULT_EXPERIMENT_RUN_ROOT = resolve(DEFAULT_STAGE4A_RUN_ROOT, 'experiments')
export const DEFAULT_EXPERIMENT_STAGING_ROOT = resolve(DEFAULT_STAGE4A_STAGING_ROOT, 'experiments')
const EXPERIMENT_PROFILE_CLAIM_VERSION = 'autodata-experiment-profile-claim-1'
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

let temporarySequence = 0

function storeError(message: string, cause?: unknown): ExperimentError {
  return new ExperimentError(message, 'STORE_IO', { ...(cause === undefined ? {} : { cause }) })
}

function assertContained(root: string, path: string, label: string): string {
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(path)
  const child = relative(absoluteRoot, absolutePath)
  if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) return absolutePath
  throw new ExperimentError(`${label} escapes its configured root`, 'PATH_ESCAPE')
}

/**
 * Inspect every existing component from a trusted root through a deletion
 * target. Missing components mean the target is absent; symlinks are always
 * rejected, including a broken symlink at the target itself.
 */
function removableDirectoryExists(root: string, target: string, label: string): boolean {
  const absoluteRoot = resolve(root)
  const absoluteTarget = assertContained(absoluteRoot, target, label)
  const components = relative(absoluteRoot, absoluteTarget).split(sep).filter(Boolean)
  let cursor = absoluteRoot

  for (const component of ['', ...components]) {
    if (component !== '') cursor = resolve(cursor, component)
    let stat
    try {
      stat = lstatSync(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw storeError(`cannot inspect ${label}: ${cursor}`, error)
    }
    if (stat.isSymbolicLink()) {
      throw new ExperimentError(`${label} must not contain symbolic links: ${cursor}`, 'PATH_ESCAPE')
    }
    if (!stat.isDirectory()) {
      throw new ExperimentError(`${label} must be a directory: ${cursor}`, 'ARTIFACT_INVALID')
    }
  }
  return true
}

function durableWriteNew(path: string, content: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ExperimentError(`artifact already exists: ${path}`, 'ARTIFACT_EXISTS')
    }
    throw storeError(`cannot durably create artifact: ${path}`, error)
  }
}

interface ExperimentProfileClaim {
  readonly schema_version: typeof EXPERIMENT_PROFILE_CLAIM_VERSION
  readonly contract_id: string
  readonly contract_sha256: string
  readonly profile_id: string
  readonly run_id: string
}

function normalizeProfileClaim(value: unknown, path: string): ExperimentProfileClaim {
  if (!isJsonObject(value)) throw new ExperimentError(`experiment profile claim is corrupt: ${path}`, 'STATE_CORRUPT')
  const fields = ['schema_version', 'contract_id', 'contract_sha256', 'profile_id', 'run_id'] as const
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new ExperimentError(`experiment profile claim is corrupt: ${path}`, 'STATE_CORRUPT')
  }
  if (
    value.schema_version !== EXPERIMENT_PROFILE_CLAIM_VERSION
    || typeof value.contract_id !== 'string'
    || value.contract_id.length === 0
    || typeof value.contract_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.contract_sha256)
  ) throw new ExperimentError(`experiment profile claim is corrupt: ${path}`, 'STATE_CORRUPT')
  return Object.freeze({
    schema_version: EXPERIMENT_PROFILE_CLAIM_VERSION,
    contract_id: value.contract_id,
    contract_sha256: value.contract_sha256,
    profile_id: validateExperimentId(value.profile_id, 'profile_id'),
    run_id: validateExperimentId(value.run_id, 'run_id'),
  })
}

/** Experiment-specific state validation with shared safe artifact operations. */
export class ExperimentLedger {
  readonly runRoot: string
  readonly stagingRoot: string
  private readonly files: Stage4ALedger

  constructor(runRoot = DEFAULT_EXPERIMENT_RUN_ROOT, stagingRoot = DEFAULT_EXPERIMENT_STAGING_ROOT) {
    if (!isAbsolute(runRoot) || !isAbsolute(stagingRoot)) {
      throw new ExperimentError('experiment roots must be absolute paths', 'INVALID_REQUEST')
    }
    this.runRoot = resolve(runRoot)
    this.stagingRoot = resolve(stagingRoot)
    this.files = new Stage4ALedger(this.runRoot, this.stagingRoot)
  }

  runDirectory(profileId: string, runId: string): string {
    return resolve(this.runRoot, validateExperimentId(profileId, 'profile_id'), validateExperimentId(runId, 'run_id'))
  }

  stagingDirectory(runId: string): string {
    return resolve(this.stagingRoot, validateExperimentId(runId, 'run_id'))
  }

  profileClaimPath(profileId: string): string {
    return resolve(this.runRoot, '.h0-owners', `${validateExperimentId(profileId, 'profile_id')}.json`)
  }

  /**
   * Permanently bind one TaskProfile to its H0 run. The claim intentionally
   * survives terminal states; a new H0 run requires explicit operator
   * adjudication instead of changing run_id to bypass the retry contract.
   */
  claimProfile(state: Pick<ExperimentState, 'contract_id' | 'contract_sha256' | 'profile_id' | 'run_id'>): {
    readonly created: boolean
    readonly path: string
  } {
    const profileId = validateExperimentId(state.profile_id, 'profile_id')
    const runId = validateExperimentId(state.run_id, 'run_id')
    const expected: ExperimentProfileClaim = {
      schema_version: EXPERIMENT_PROFILE_CLAIM_VERSION,
      contract_id: state.contract_id,
      contract_sha256: state.contract_sha256,
      profile_id: profileId,
      run_id: runId,
    }
    const claimsDirectory = resolve(this.runRoot, '.h0-owners')
    const path = this.profileClaimPath(profileId)
    this.files.createDirectory(this.runRoot, this.runRoot)
    this.files.createDirectory(this.runRoot, claimsDirectory)

    const existing = this.readProfileClaim(path)
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(expected)) {
        throw new ExperimentError(
          `TaskProfile ${profileId} is durably owned by H0 run ${existing.run_id}; explicit adjudication is required`,
          'RUN_EXISTS',
          { profile_id: profileId, run_id: runId },
        )
      }
      this.assertNoOtherNonTerminalRun(profileId, runId)
      return Object.freeze({ created: false, path })
    }

    this.assertNoOtherNonTerminalRun(profileId, runId)
    try {
      durableWriteNew(path, `${canonicalJson(expected)}\n`)
      const descriptor = openSync(claimsDirectory, constants.O_RDONLY)
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    } catch (error) {
      if (error instanceof ExperimentError && error.code === 'ARTIFACT_EXISTS') {
        const raced = this.readProfileClaim(path)
        if (raced !== undefined && canonicalJson(raced) === canonicalJson(expected)) {
          this.assertNoOtherNonTerminalRun(profileId, runId)
          return Object.freeze({ created: false, path })
        }
        throw new ExperimentError(
          `TaskProfile ${profileId} acquired a concurrent H0 owner; start is refused`,
          'RUN_EXISTS',
          { profile_id: profileId, run_id: runId, cause: error },
        )
      }
      throw error
    }
    try {
      this.assertNoOtherNonTerminalRun(profileId, runId)
    } catch (error) {
      this.releaseProfileClaimIfUnpublished(state, true)
      throw error
    }
    return Object.freeze({ created: true, path })
  }

  /** Release only a claim created for a run that never became durable. */
  releaseProfileClaimIfUnpublished(
    state: Pick<ExperimentState, 'contract_id' | 'contract_sha256' | 'profile_id' | 'run_id'>,
    claimWasCreated: boolean,
  ): boolean {
    if (!claimWasCreated || existsSync(this.runDirectory(state.profile_id, state.run_id))) return false
    const path = this.profileClaimPath(state.profile_id)
    const existing = this.readProfileClaim(path)
    if (existing === undefined) return false
    const expected: ExperimentProfileClaim = {
      schema_version: EXPERIMENT_PROFILE_CLAIM_VERSION,
      contract_id: state.contract_id,
      contract_sha256: state.contract_sha256,
      profile_id: validateExperimentId(state.profile_id, 'profile_id'),
      run_id: validateExperimentId(state.run_id, 'run_id'),
    }
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw new ExperimentError('refusing to release a different experiment profile claim', 'STATE_CORRUPT')
    }
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new ExperimentError(`experiment profile claim is not a regular file: ${path}`, 'PATH_ESCAPE')
      }
      unlinkSync(path)
      const descriptor = openSync(dirname(path), constants.O_RDONLY)
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
      return true
    } catch (error) {
      if (error instanceof ExperimentError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw storeError(`cannot release unpublished experiment profile claim: ${path}`, error)
    }
  }

  /** Publish ordinary inputs and the first state as one visible directory rename. */
  initializeRun(stateInput: ExperimentState, artifacts: Readonly<Record<string, string>>): ExperimentState {
    const state = normalizeExperimentState(stateInput)
    const run = this.runDirectory(state.profile_id, state.run_id)
    const staging = this.stagingDirectory(state.run_id)
    if (state.phase !== 'initializing' || state.run_directory !== run || state.staging_directory !== staging) {
      throw new ExperimentError('initial experiment state does not match configured roots', 'STATE_CORRUPT')
    }
    this.files.createDirectory(this.runRoot, this.runRoot)
    this.files.createDirectory(this.stagingRoot, this.stagingRoot)
    const profileDirectory = dirname(run)
    this.files.createDirectory(this.runRoot, profileDirectory)
    if (existsSync(run) || existsSync(staging)) {
      throw new ExperimentError(`experiment run ${state.profile_id}/${state.run_id} already exists`, 'RUN_EXISTS', {
        profile_id: state.profile_id,
        run_id: state.run_id,
      })
    }
    let temporary: string | undefined
    try {
      temporary = mkdtempSync(resolve(profileDirectory, `.${state.run_id}.initializing.`))
      for (const [name, content] of Object.entries(artifacts)) {
        if (name === 'state.json' || name.length === 0 || isAbsolute(name)) {
          throw new ExperimentError(`invalid initial artifact name: ${name}`, 'PATH_ESCAPE')
        }
        const target = assertContained(temporary, resolve(temporary, name), 'initial artifact path')
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        durableWriteNew(target, content)
      }
      durableWriteNew(resolve(temporary, 'state.json'), `${canonicalJson(state)}\n`)
      const temporaryDescriptor = openSync(temporary, constants.O_RDONLY)
      try { fsyncSync(temporaryDescriptor) } finally { closeSync(temporaryDescriptor) }
      renameSync(temporary, run)
      const profileDescriptor = openSync(profileDirectory, constants.O_RDONLY)
      try { fsyncSync(profileDescriptor) } finally { closeSync(profileDescriptor) }
      return immutableJson(state) as unknown as ExperimentState
    } catch (error) {
      if (temporary !== undefined) {
        try { rmSync(temporary, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      if (error instanceof ExperimentError) throw error
      throw storeError(`cannot initialize experiment run ${state.profile_id}/${state.run_id}`, error)
    }
  }

  ensureStagingDirectory(state: ExperimentState): void {
    if (resolve(state.staging_directory) !== this.stagingDirectory(state.run_id)) {
      throw new ExperimentError('state staging path does not match configured root', 'PATH_ESCAPE')
    }
    this.files.createDirectory(this.stagingRoot, state.staging_directory)
  }

  requireRunDirectories(profileId: string, runId: string): { readonly run: string; readonly staging: string } {
    try {
      return this.files.requireRunDirectories(profileId, runId)
    } catch (error) {
      throw this.translate(error)
    }
  }

  createDirectory(root: string, path: string): void {
    try { this.files.createDirectory(root, path) } catch (error) { throw this.translate(error) }
  }

  writeNew(root: string, path: string, content: string): void {
    try { this.files.writeNew(root, path, content) } catch (error) { throw this.translate(error) }
  }

  writeNewJson(root: string, path: string, value: unknown): void {
    try { this.files.writeNewJson(root, path, value) } catch (error) { throw this.translate(error) }
  }

  writeNewOrSameJson(root: string, path: string, value: unknown): void {
    try { this.files.writeNewOrSameJson(root, path, value) } catch (error) { throw this.translate(error) }
  }

  copyNewOrSame(root: string, source: string, target: string): void {
    try { this.files.copyNewOrSame(root, source, target) } catch (error) { throw this.translate(error) }
  }

  copyNew(root: string, source: string, target: string): void {
    try { this.files.copyNew(root, source, target) } catch (error) { throw this.translate(error) }
  }

  nextArtifactPath(root: string, directory: string, stem: string): string {
    try { return this.files.nextArtifactPath(root, directory, stem) } catch (error) { throw this.translate(error) }
  }

  readJson(root: string, path: string, label: string): unknown {
    try { return this.files.readJson(root, path, label) } catch (error) { throw this.translate(error) }
  }

  requireDirectory(root: string, path: string, label: string): string {
    try { return this.files.requireDirectory(root, path, label) } catch (error) { throw this.translate(error) }
  }

  /** Remove only one failed remote attempt's staged output before an infrastructure retry. */
  removeStagedAttemptOutput(state: ExperimentState, stage: ExperimentStage, attempt: number): void {
    const expectedStaging = this.stagingDirectory(state.run_id)
    if (!isAbsolute(state.staging_directory) || resolve(state.staging_directory) !== expectedStaging) {
      throw new ExperimentError('state staging path does not match configured root', 'PATH_ESCAPE')
    }
    if (stage !== 'train' && stage !== 'eval') {
      throw new ExperimentError('experiment stage is invalid', 'INVALID_REQUEST')
    }
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new ExperimentError('experiment attempt must be a positive integer', 'INVALID_REQUEST')
    }

    const outputRoot = resolve(expectedStaging, 'outputs')
    const target = assertContained(
      outputRoot,
      resolve(outputRoot, stage, `attempt-${String(attempt)}`),
      'staged attempt output',
    )
    if (!removableDirectoryExists(expectedStaging, target, 'staged attempt output')) return

    try {
      rmSync(target, { recursive: true, force: true })
    } catch (error) {
      throw storeError(`cannot remove staged attempt output: ${target}`, error)
    }
  }

  saveState(stateInput: ExperimentState): ExperimentState {
    const state = normalizeExperimentState(stateInput)
    const { run } = this.requireRunDirectories(state.profile_id, state.run_id)
    if (resolve(state.run_directory) !== run || resolve(state.staging_directory) !== this.stagingDirectory(state.run_id)) {
      throw new ExperimentError('experiment state paths do not match configured roots', 'PATH_ESCAPE')
    }
    const target = resolve(run, 'state.json')
    temporarySequence += 1
    const temporary = resolve(run, `.state.${String(process.pid)}.${String(temporarySequence)}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      writeFileSync(descriptor, `${canonicalJson(state)}\n`, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, target)
      const directoryDescriptor = openSync(run, constants.O_RDONLY)
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
      return immutableJson(state) as unknown as ExperimentState
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch { /* best effort */ }
      }
      throw storeError(`cannot atomically save experiment state: ${target}`, error)
    }
  }

  loadState(profileId: string, runId: string): ExperimentState {
    const { run } = this.requireRunDirectories(profileId, runId)
    const path = resolve(run, 'state.json')
    let state: ExperimentState
    try {
      state = normalizeExperimentState(this.readJson(this.runRoot, path, 'experiment state'))
    } catch (error) {
      throw this.translate(error)
    }
    if (
      state.schema_version !== EXPERIMENT_STATE_VERSION
      || state.profile_id !== profileId
      || state.run_id !== runId
      || state.run_directory !== run
      || state.staging_directory !== this.stagingDirectory(runId)
    ) throw new ExperimentError(`experiment state is corrupt: ${path}`, 'STATE_CORRUPT')
    for (const attempt of state.attempts) {
      if (attempt.rjob_name !== experimentRJobName(runId, attempt.stage, attempt.attempt)) {
        throw new ExperimentError('experiment attempt RJob name is corrupt', 'STATE_CORRUPT')
      }
      const stagedAttempt = this.stagedAttemptDirectory(state, attempt.stage, attempt.attempt)
      if (resolve(attempt.request_path) !== resolve(stagedAttempt, 'request.json')) {
        throw new ExperimentError('experiment attempt request path is corrupt', 'STATE_CORRUPT')
      }
      const expectedResult = resolve(
        state.staging_directory,
        'outputs',
        attempt.stage,
        `attempt-${String(attempt.attempt)}`,
        'result.json',
      )
      if (resolve(attempt.result_path) !== expectedResult) {
        throw new ExperimentError('experiment attempt result path is corrupt', 'STATE_CORRUPT')
      }
      const localAttempt = this.localAttemptDirectory(state, attempt.stage, attempt.attempt)
      for (const artifact of [
        attempt.dry_run_path,
        attempt.prediction_path,
        attempt.submission_path,
        attempt.logs_path,
        attempt.output_cleanup_path,
      ]) {
        if (artifact !== undefined) assertContained(localAttempt, artifact, 'attempt artifact path')
      }
    }
    if (state.train_result_path !== undefined) assertContained(run, state.train_result_path, 'training result path')
    if (state.eval_result_path !== undefined) assertContained(run, state.eval_result_path, 'evaluation result path')
    return immutableJson(state) as unknown as ExperimentState
  }

  localAttemptDirectory(state: ExperimentState, stage: ExperimentStage, attempt: number): string {
    return resolve(state.run_directory, 'attempts', stage, String(attempt).padStart(4, '0'))
  }

  stagedAttemptDirectory(state: ExperimentState, stage: ExperimentStage, attempt: number): string {
    return resolve(state.staging_directory, 'attempts', stage, String(attempt).padStart(4, '0'))
  }

  latestAttempt(state: ExperimentState): ExperimentAttempt | undefined {
    return state.attempts.at(-1)
  }

  private readProfileClaim(path: string): ExperimentProfileClaim | undefined {
    try {
      lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw storeError(`cannot inspect experiment profile claim: ${path}`, error)
    }
    return normalizeProfileClaim(this.readJson(this.runRoot, path, 'experiment profile claim'), path)
  }

  private assertNoOtherNonTerminalRun(profileId: string, allowedRunId: string): void {
    const profileDirectory = resolve(this.runRoot, profileId)
    let entries
    try {
      if (!existsSync(profileDirectory)) return
      const stat = lstatSync(profileDirectory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ExperimentError(`experiment profile run directory is invalid: ${profileDirectory}`, 'STATE_CORRUPT')
      }
      entries = readdirSync(profileDirectory, { withFileTypes: true })
    } catch (error) {
      if (error instanceof ExperimentError) throw error
      throw storeError(`cannot inspect experiment runs for TaskProfile ${profileId}`, error)
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new ExperimentError(`unexpected experiment run entry: ${entry.name}`, 'STATE_CORRUPT')
      }
      const runId = validateExperimentId(entry.name, 'run_id')
      if (runId === allowedRunId) continue
      const state = this.loadState(profileId, runId)
      if (!TERMINAL_RUN_STATUSES.has(state.status)) {
        throw new ExperimentError(
          `TaskProfile ${profileId} already has non-terminal H0 run ${runId}; resume that run instead`,
          'RUN_EXISTS',
          { profile_id: profileId, run_id: allowedRunId },
        )
      }
    }
  }

  private translate(error: unknown): ExperimentError {
    if (error instanceof ExperimentError) return error
    if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
      const value = error as { readonly code?: unknown; readonly message?: unknown }
      const known = new Set([
        'INVALID_REQUEST', 'RUN_EXISTS', 'RUN_NOT_FOUND', 'STATE_CORRUPT', 'ARTIFACT_EXISTS',
        'ARTIFACT_INVALID', 'PATH_ESCAPE', 'DEPENDENCY_UNAVAILABLE', 'DRY_RUN_FAILED',
        'UNSCHEDULABLE', 'SUBMIT_FAILED', 'REMOTE_FAILED', 'WORKER_FAILED', 'RECOVERY_REQUIRED',
        'CANCEL_FAILED', 'STORE_IO',
      ])
      if (typeof value.code === 'string' && known.has(value.code) && typeof value.message === 'string') {
        return new ExperimentError(value.message, value.code as ExperimentError['code'], { cause: error })
      }
    }
    return storeError(error instanceof Error ? error.message : String(error), error)
  }
}

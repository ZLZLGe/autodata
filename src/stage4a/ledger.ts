/** Filesystem ledger for resumable Stage 4A runs. */

import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalJson, immutableJson, parseStrictJsonObject } from '../core/json.js'
import { validateStage4AId } from './contracts.js'
import { normalizeStage4AState } from './state.js'
import {
  STAGE4A_STATE_VERSION,
  Stage4AError,
  type Stage4AAttempt,
  type Stage4AState,
} from './types.js'

export const DEFAULT_STAGE4A_RUN_ROOT = '/data/codex-work/autodata/runs'
export const DEFAULT_STAGE4A_STAGING_ROOT = '/mnt/shared-storage-user/gezhilong/autodata/staging'

let temporarySequence = 0

function storeError(message: string, cause?: unknown): Stage4AError {
  return new Stage4AError(message, 'STORE_IO', { ...(cause === undefined ? {} : { cause }) })
}

function assertDirectory(path: string, label: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    throw storeError(`cannot inspect ${label}: ${path}`, error)
  }
  if (stat.isSymbolicLink()) throw new Stage4AError(`${label} must not be a symbolic link: ${path}`, 'PATH_ESCAPE')
  if (!stat.isDirectory()) throw storeError(`${label} is not a directory: ${path}`)
}

function ensureDirectory(path: string, label: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw storeError(`cannot create ${label}: ${path}`, error)
  }
  assertDirectory(path, label)
}

function assertContained(root: string, path: string, label: string): string {
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(path)
  const child = relative(absoluteRoot, absolutePath)
  if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) return absolutePath
  throw new Stage4AError(`${label} escapes its configured root`, 'PATH_ESCAPE')
}

function assertNoSymlink(root: string, target: string): void {
  const absoluteRoot = resolve(root)
  const absoluteTarget = assertContained(root, target, 'artifact path')
  const child = relative(absoluteRoot, absoluteTarget)
  let cursor = absoluteRoot
  assertDirectory(cursor, 'artifact root')
  for (const part of child.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    if (!existsSync(cursor)) return
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) throw new Stage4AError(`symbolic links are forbidden in Stage 4A paths: ${cursor}`, 'PATH_ESCAPE')
  }
}

function writeNewText(path: string, text: string): void {
  try {
    writeFileSync(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Stage4AError(`artifact already exists: ${path}`, 'ARTIFACT_EXISTS')
    throw storeError(`cannot create artifact: ${path}`, error)
  }
}

function writeNewDurableText(path: string, text: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(descriptor, text, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best-effort descriptor cleanup */ }
    }
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Stage4AError(`artifact already exists: ${path}`, 'ARTIFACT_EXISTS')
    throw storeError(`cannot durably create artifact: ${path}`, error)
  }
}

function frozenState(state: Stage4AState): Stage4AState {
  return immutableJson(state) as unknown as Stage4AState
}

function filesEqual(left: string, right: string, size: number): boolean {
  const leftDescriptor = openSync(left, constants.O_RDONLY)
  const rightDescriptor = openSync(right, constants.O_RDONLY)
  const leftBuffer = Buffer.allocUnsafe(64 * 1024)
  const rightBuffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let offset = 0
    while (offset < size) {
      const length = Math.min(leftBuffer.length, size - offset)
      const leftRead = readSync(leftDescriptor, leftBuffer, 0, length, offset)
      const rightRead = readSync(rightDescriptor, rightBuffer, 0, length, offset)
      if (leftRead !== rightRead || leftRead === 0) return false
      if (!leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))) return false
      offset += leftRead
    }
    return true
  } finally {
    closeSync(leftDescriptor)
    closeSync(rightDescriptor)
  }
}

/** Durable paths and append-only artifact operations for one Stage 4A root pair. */
export class Stage4ALedger {
  readonly runRoot: string
  readonly stagingRoot: string

  constructor(runRoot = DEFAULT_STAGE4A_RUN_ROOT, stagingRoot = DEFAULT_STAGE4A_STAGING_ROOT) {
    if (!isAbsolute(runRoot) || !isAbsolute(stagingRoot)) {
      throw new Stage4AError('Stage 4A roots must be absolute paths', 'INVALID_REQUEST')
    }
    this.runRoot = resolve(runRoot)
    this.stagingRoot = resolve(stagingRoot)
  }

  runDirectory(profileId: string, runId: string): string {
    return resolve(this.runRoot, validateStage4AId(profileId, 'profile_id'), validateStage4AId(runId, 'run_id'))
  }

  stagingDirectory(runId: string): string {
    return resolve(this.stagingRoot, validateStage4AId(runId, 'run_id'))
  }

  createRunDirectories(profileId: string, runId: string): { readonly run: string; readonly staging: string } {
    const run = this.runDirectory(profileId, runId)
    const staging = this.stagingDirectory(runId)
    ensureDirectory(this.runRoot, 'Stage 4A run root')
    ensureDirectory(this.stagingRoot, 'Stage 4A staging root')
    const profileDirectory = dirname(run)
    ensureDirectory(profileDirectory, 'Stage 4A profile directory')
    if (existsSync(run) || existsSync(staging)) {
      throw new Stage4AError(`Stage 4A run ${profileId}/${runId} already exists`, 'RUN_EXISTS', {
        profile_id: profileId,
        run_id: runId,
      })
    }
    try {
      mkdirSync(run, { mode: 0o700 })
      mkdirSync(staging, { mode: 0o700 })
    } catch (error) {
      throw storeError(`cannot create Stage 4A run directories for ${profileId}/${runId}`, error)
    }
    return Object.freeze({ run, staging })
  }

  /** Publish the first durable state and local inputs as one visible directory rename. */
  initializeRun(state: Stage4AState, artifacts: Readonly<Record<string, string>>): Stage4AState {
    const value = normalizeStage4AState(state)
    const run = this.runDirectory(value.profile_id, value.run_id)
    const staging = this.stagingDirectory(value.run_id)
    if (value.phase !== 'initializing' || value.run_directory !== run || value.staging_directory !== staging) {
      throw new Stage4AError('initial Stage 4A state does not match configured roots', 'STATE_CORRUPT')
    }
    ensureDirectory(this.runRoot, 'Stage 4A run root')
    ensureDirectory(this.stagingRoot, 'Stage 4A staging root')
    const profileDirectory = dirname(run)
    ensureDirectory(profileDirectory, 'Stage 4A profile directory')
    if (existsSync(run) || existsSync(staging)) {
      throw new Stage4AError(`Stage 4A run ${value.profile_id}/${value.run_id} already exists`, 'RUN_EXISTS', {
        profile_id: value.profile_id,
        run_id: value.run_id,
      })
    }
    let temporary: string | undefined
    try {
      temporary = mkdtempSync(resolve(profileDirectory, `.${value.run_id}.initializing.`))
      for (const [name, content] of Object.entries(artifacts)) {
        if (name === 'state.json' || name.length === 0 || isAbsolute(name)) {
          throw new Stage4AError(`invalid initial artifact name: ${name}`, 'PATH_ESCAPE')
        }
        const target = assertContained(temporary, resolve(temporary, name), 'initial artifact path')
        this.createDirectory(temporary, dirname(target))
        writeNewDurableText(target, content)
      }
      writeNewDurableText(resolve(temporary, 'state.json'), `${canonicalJson(value)}\n`)
      const temporaryDescriptor = openSync(temporary, constants.O_RDONLY)
      try { fsyncSync(temporaryDescriptor) } finally { closeSync(temporaryDescriptor) }
      renameSync(temporary, run)
      const profileDescriptor = openSync(profileDirectory, constants.O_RDONLY)
      try { fsyncSync(profileDescriptor) } finally { closeSync(profileDescriptor) }
      return frozenState(value)
    } catch (error) {
      if (temporary !== undefined) {
        try { rmSync(temporary, { recursive: true, force: true }) } catch { /* best-effort private temp cleanup */ }
      }
      if (error instanceof Stage4AError) throw error
      throw storeError(`cannot initialize Stage 4A run ${value.profile_id}/${value.run_id}`, error)
    }
  }

  ensureStagingDirectory(state: Stage4AState): void {
    const expected = this.stagingDirectory(state.run_id)
    if (resolve(state.staging_directory) !== expected) {
      throw new Stage4AError('state staging path does not match configured root', 'PATH_ESCAPE')
    }
    this.createDirectory(this.stagingRoot, expected)
  }

  requireRunDirectories(profileId: string, runId: string): { readonly run: string; readonly staging: string } {
    const run = this.runDirectory(profileId, runId)
    const staging = this.stagingDirectory(runId)
    if (!existsSync(run)) {
      throw new Stage4AError(`Stage 4A run ${profileId}/${runId} does not exist`, 'RUN_NOT_FOUND', {
        profile_id: profileId,
        run_id: runId,
      })
    }
    assertNoSymlink(this.runRoot, run)
    assertDirectory(run, 'Stage 4A run directory')
    if (existsSync(staging)) {
      assertNoSymlink(this.stagingRoot, staging)
      assertDirectory(staging, 'Stage 4A staging directory')
    }
    return Object.freeze({ run, staging })
  }

  createDirectory(root: string, path: string): void {
    const absolute = assertContained(root, path, 'directory path')
    if (absolute !== resolve(root)) assertNoSymlink(root, dirname(absolute))
    try {
      mkdirSync(absolute, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw storeError(`cannot create directory: ${absolute}`, error)
    }
    assertNoSymlink(root, absolute)
    assertDirectory(absolute, 'Stage 4A artifact directory')
  }

  writeNew(root: string, path: string, content: string): void {
    const absolute = assertContained(root, path, 'artifact path')
    this.createDirectory(root, dirname(absolute))
    assertNoSymlink(root, absolute)
    writeNewText(absolute, content)
  }

  writeNewJson(root: string, path: string, value: unknown): void {
    this.writeNew(root, path, `${canonicalJson(value)}\n`)
  }

  /** Create an immutable JSON artifact, accepting only byte-equivalent replay. */
  writeNewOrSameJson(root: string, path: string, value: unknown): void {
    const expected = canonicalJson(value)
    const absolute = assertContained(root, path, 'artifact path')
    if (existsSync(absolute)) {
      const existing = this.readJson(root, absolute, 'immutable replay artifact')
      if (canonicalJson(existing) !== expected) {
        throw new Stage4AError(`immutable artifact conflicts with replay: ${absolute}`, 'ARTIFACT_EXISTS')
      }
      return
    }
    this.writeNew(root, absolute, `${expected}\n`)
  }

  /** Copy an immutable file, accepting replay only when every byte still matches. */
  copyNewOrSame(root: string, source: string, target: string): void {
    const absoluteTarget = assertContained(root, target, 'artifact target')
    this.createDirectory(root, dirname(absoluteTarget))
    assertNoSymlink(root, absoluteTarget)
    const sourceStat = lstatSync(source)
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Stage4AError(`asset source must be a regular file: ${source}`, 'ARTIFACT_INVALID')
    }
    if (existsSync(absoluteTarget)) {
      const targetStat = lstatSync(absoluteTarget)
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new Stage4AError(`replayed artifact must be a regular file: ${absoluteTarget}`, 'ARTIFACT_INVALID')
      }
      if (sourceStat.size !== targetStat.size || !filesEqual(source, absoluteTarget, sourceStat.size)) {
        throw new Stage4AError(`immutable artifact conflicts with replay: ${absoluteTarget}`, 'ARTIFACT_EXISTS')
      }
      return
    }
    this.copyNew(root, source, absoluteTarget)
  }

  nextArtifactPath(root: string, directory: string, stem: string): string {
    const absoluteDirectory = assertContained(root, directory, 'attempt artifact directory')
    for (let index = 1; index <= 10_000; index += 1) {
      const path = resolve(absoluteDirectory, `${stem}-${String(index).padStart(4, '0')}.json`)
      assertContained(root, path, 'attempt artifact path')
      if (!existsSync(path)) return path
    }
    throw new Stage4AError(`too many ${stem} artifacts in ${absoluteDirectory}`, 'STORE_IO')
  }

  copyNew(root: string, source: string, target: string): void {
    const absoluteTarget = assertContained(root, target, 'artifact target')
    this.createDirectory(root, dirname(absoluteTarget))
    assertNoSymlink(root, absoluteTarget)
    const sourceStat = lstatSync(source)
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Stage4AError(`asset source must be a regular file: ${source}`, 'ARTIFACT_INVALID')
    }
    try {
      copyFileSync(source, absoluteTarget, constants.COPYFILE_EXCL)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') throw new Stage4AError(`artifact already exists: ${absoluteTarget}`, 'ARTIFACT_EXISTS')
      throw storeError(`cannot copy asset to ${absoluteTarget}`, error)
    }
  }

  saveState(state: Stage4AState): Stage4AState {
    const value = frozenState(state)
    const run = this.runDirectory(value.profile_id, value.run_id)
    this.requireRunDirectories(value.profile_id, value.run_id)
    if (resolve(value.run_directory) !== run || resolve(value.staging_directory) !== this.stagingDirectory(value.run_id)) {
      throw new Stage4AError('state paths do not match configured roots', 'PATH_ESCAPE')
    }
    const target = resolve(run, 'state.json')
    assertNoSymlink(this.runRoot, target)
    temporarySequence += 1
    const temporary = resolve(run, `.state.${String(process.pid)}.${String(temporarySequence)}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      writeFileSync(descriptor, `${canonicalJson(value)}\n`, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, target)
      const directoryDescriptor = openSync(run, constants.O_RDONLY)
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
      return value
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch { /* best-effort descriptor cleanup */ }
      }
      throw storeError(`cannot atomically save Stage 4A state: ${target}`, error)
    }
  }

  loadState(profileId: string, runId: string): Stage4AState {
    const { run } = this.requireRunDirectories(profileId, runId)
    const path = resolve(run, 'state.json')
    const value = normalizeStage4AState(this.readJson(this.runRoot, path, 'Stage 4A state'))
    if (
      value.schema_version !== STAGE4A_STATE_VERSION
      || value.profile_id !== profileId
      || value.run_id !== runId
      || value.run_directory !== run
      || value.staging_directory !== this.stagingDirectory(runId)
      || !Array.isArray(value.attempts)
    ) {
      throw new Stage4AError(`Stage 4A state is corrupt: ${path}`, 'STATE_CORRUPT', {
        profile_id: profileId,
        run_id: runId,
      })
    }
    for (const attempt of value.attempts) {
      const stagedAttempt = this.stagedAttemptDirectory(value, attempt.stage, attempt.attempt)
      if (resolve(attempt.request_path) !== resolve(stagedAttempt, 'request.json')) {
        throw new Stage4AError('Stage 4A attempt request path is corrupt', 'STATE_CORRUPT')
      }
      if (resolve(attempt.result_path) !== resolve(
        value.staging_directory,
        'outputs',
        attempt.stage,
        `attempt-${String(attempt.attempt)}`,
        'result.json',
      )) throw new Stage4AError('Stage 4A attempt result path is corrupt', 'STATE_CORRUPT')
      const localAttempt = this.localAttemptDirectory(value, attempt.stage, attempt.attempt)
      for (const artifact of [attempt.dry_run_path, attempt.prediction_path, attempt.submission_path, attempt.logs_path]) {
        if (artifact !== undefined) assertContained(localAttempt, artifact, 'attempt artifact path')
      }
    }
    if (value.train_result_path !== undefined) assertContained(run, value.train_result_path, 'training result path')
    if (value.eval_result_path !== undefined) assertContained(run, value.eval_result_path, 'evaluation result path')
    return frozenState(value)
  }

  readJson(root: string, path: string, label: string): unknown {
    const absolute = assertContained(root, path, label)
    assertNoSymlink(root, absolute)
    let stat
    try {
      stat = lstatSync(absolute)
    } catch (error) {
      throw new Stage4AError(`${label} is missing: ${absolute}`, 'ARTIFACT_INVALID', { cause: error })
    }
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
      throw new Stage4AError(`${label} must be a regular JSON file no larger than 16 MiB`, 'ARTIFACT_INVALID')
    }
    try {
      return parseStrictJsonObject(readFileSync(absolute, 'utf8'), label)
    } catch (error) {
      if (error instanceof Stage4AError) throw error
      throw new Stage4AError(`${label} is not strict JSON`, 'ARTIFACT_INVALID', { cause: error })
    }
  }

  requireDirectory(root: string, path: string, label: string): string {
    const absolute = assertContained(root, path, label)
    assertNoSymlink(root, absolute)
    if (!existsSync(absolute)) throw new Stage4AError(`${label} is missing: ${absolute}`, 'ARTIFACT_INVALID')
    assertDirectory(absolute, label)
    return absolute
  }

  localAttemptDirectory(state: Stage4AState, stage: 'train' | 'eval', attempt: number): string {
    return resolve(state.run_directory, 'attempts', stage, String(attempt).padStart(4, '0'))
  }

  stagedAttemptDirectory(state: Stage4AState, stage: 'train' | 'eval', attempt: number): string {
    return resolve(state.staging_directory, 'attempts', stage, String(attempt).padStart(4, '0'))
  }

  latestAttempt(state: Stage4AState): Stage4AAttempt | undefined {
    return state.attempts.at(-1)
  }
}

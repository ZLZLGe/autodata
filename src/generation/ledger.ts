import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalJson, parseStrictJsonObject } from '../core/json.js'
import { validateExperimentId } from '../experiment/contracts.js'
import { GenerationError, type GenerationState } from './types.js'
import { normalizeGenerationState } from './state.js'

export const DEFAULT_GENERATION_RUN_ROOT = '/data/codex-work/autodata/runs/generations'
const FIRST_H1_CLAIM_VERSION = 'autodata-first-h1-claim-1'
const FIRST_H1_CLAIM_FILE = 'first-h1-claim.json'
let temporarySequence = 0

function storeError(message: string, cause?: unknown): GenerationError {
  return new GenerationError(message, 'STORE_IO', { ...(cause === undefined ? {} : { cause }) })
}

function assertContained(rootInput: string, pathInput: string, label: string): string {
  const root = resolve(rootInput)
  const path = resolve(pathInput)
  const child = relative(root, path)
  if (child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))) return path
  throw new GenerationError(`${label} escapes its configured root`, 'PATH_ESCAPE')
}

function assertDirectory(path: string, label: string): void {
  let stat
  try { stat = lstatSync(path) } catch (error) { throw storeError(`cannot inspect ${label}: ${path}`, error) }
  if (stat.isSymbolicLink()) throw new GenerationError(`${label} must not be a symbolic link: ${path}`, 'PATH_ESCAPE')
  if (!stat.isDirectory()) throw storeError(`${label} must be a directory: ${path}`)
}

function ensureDirectory(path: string): void {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }) } catch (error) { throw storeError(`cannot create directory: ${path}`, error) }
  assertDirectory(path, 'generation directory')
}

function assertNoSymlink(rootInput: string, pathInput: string): void {
  const root = resolve(rootInput)
  const path = assertContained(root, pathInput, 'generation artifact path')
  let cursor = root
  assertDirectory(cursor, 'generation root')
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    if (!existsSync(cursor)) return
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) throw new GenerationError(`symbolic links are forbidden in generation paths: ${cursor}`, 'PATH_ESCAPE')
  }
}

function durableCreate(path: string, content: string): void {
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
      throw new GenerationError(`artifact already exists: ${path}`, 'ARTIFACT_EXISTS')
    }
    throw storeError(`cannot durably create artifact: ${path}`, error)
  }
}

export class GenerationLedger {
  readonly root: string

  constructor(root = DEFAULT_GENERATION_RUN_ROOT) {
    if (!isAbsolute(root)) throw new GenerationError('generation run root must be absolute', 'INVALID_REQUEST')
    this.root = resolve(root)
  }

  runDirectory(profileId: string, runId: string): string {
    return resolve(this.root, validateExperimentId(profileId, 'profile_id'), validateExperimentId(runId, 'run_id'))
  }

  /**
   * Permanently reserve the one Stage 4C generation allowed for a profile.
   *
   * The claim deliberately survives pre-candidate failures: otherwise a new
   * commit/run ID could reset the three-draft budget and silently turn the
   * pre-registered first-H1 experiment into candidate shopping. Replaying the
   * exact same identity is allowed so a crash between claim and run-directory
   * publication can finish initialization.
   */
  claimFirstH1(stateInput: GenerationState): void {
    const state = normalizeGenerationState(stateInput)
    ensureDirectory(this.root)
    const profile = dirname(this.runDirectory(state.profile_id, state.run_id))
    ensureDirectory(profile)
    const path = resolve(profile, FIRST_H1_CLAIM_FILE)
    assertNoSymlink(this.root, path)
    const claim = this.firstH1Claim(state)
    const content = `${canonicalJson(claim)}\n`
    if (!existsSync(path)) this.assertNoPriorGenerationHistory(profile, state)
    try {
      durableCreate(path, content)
      const descriptor = openSync(profile, constants.O_RDONLY)
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
      return
    } catch (error) {
      if (!(error instanceof GenerationError) || error.code !== 'ARTIFACT_EXISTS') throw error
    }
    const existing = this.readJson(path, 'first H1 generation claim')
    if (canonicalJson(existing) !== canonicalJson(claim)) {
      throw new GenerationError(
        `TaskProfile ${state.profile_id} already consumed its one formal Stage 4C generation`,
        'RUN_EXISTS',
        { profile_id: state.profile_id, run_id: state.run_id },
      )
    }
    this.assertNoConflictingGenerationHistory(profile, state)
  }

  initialize(stateInput: GenerationState, artifacts: Readonly<Record<string, string>>): GenerationState {
    const state = normalizeGenerationState(stateInput)
    const run = this.runDirectory(state.profile_id, state.run_id)
    if (state.run_directory !== run || state.phase !== 'initialized') {
      throw new GenerationError('initial generation state does not match its ledger path', 'STATE_CORRUPT')
    }
    ensureDirectory(this.root)
    const profile = dirname(run)
    ensureDirectory(profile)
    this.requireFirstH1Claim(state)
    if (existsSync(run)) throw new GenerationError(`generation ${state.profile_id}/${state.run_id} already exists`, 'RUN_EXISTS')
    let temporary: string | undefined
    try {
      temporary = mkdtempSync(resolve(profile, `.${state.run_id}.initializing.`))
      for (const [name, content] of Object.entries(artifacts)) {
        if (name === 'state.json' || name.length === 0 || isAbsolute(name)) {
          throw new GenerationError(`invalid initial generation artifact name: ${name}`, 'PATH_ESCAPE')
        }
        const path = assertContained(temporary, resolve(temporary, name), 'initial generation artifact')
        ensureDirectory(dirname(path))
        durableCreate(path, content)
      }
      durableCreate(resolve(temporary, 'state.json'), `${canonicalJson(state)}\n`)
      const descriptor = openSync(temporary, constants.O_RDONLY)
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
      renameSync(temporary, run)
      const profileDescriptor = openSync(profile, constants.O_RDONLY)
      try { fsyncSync(profileDescriptor) } finally { closeSync(profileDescriptor) }
      return state
    } catch (error) {
      if (temporary !== undefined) {
        try { rmSync(temporary, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      if (error instanceof GenerationError) throw error
      throw storeError(`cannot initialize generation ${state.profile_id}/${state.run_id}`, error)
    }
  }

  saveState(stateInput: GenerationState): GenerationState {
    const state = normalizeGenerationState(stateInput)
    const run = this.requireRun(state.profile_id, state.run_id)
    if (state.run_directory !== run) throw new GenerationError('generation state path does not match configured root', 'PATH_ESCAPE')
    const target = resolve(run, 'state.json')
    assertNoSymlink(this.root, target)
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
      return state
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch { /* best effort */ }
      }
      try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
      throw storeError(`cannot save generation state: ${target}`, error)
    }
  }

  loadState(profileId: string, runId: string): GenerationState {
    const run = this.requireRun(profileId, runId)
    const path = resolve(run, 'state.json')
    const state = normalizeGenerationState(this.readJson(path, 'generation state'))
    if (state.run_directory !== run || state.profile_id !== profileId || state.run_id !== runId) {
      throw new GenerationError('generation state identity does not match its ledger path', 'STATE_CORRUPT')
    }
    this.requireFirstH1Claim(state)
    return state
  }

  writeNew(path: string, content: string, runDirectory: string): void {
    const target = assertContained(runDirectory, path, 'generation artifact')
    ensureDirectory(dirname(target))
    assertNoSymlink(runDirectory, target)
    durableCreate(target, content)
  }

  writeNewOrSame(path: string, content: string, runDirectory: string): void {
    const target = assertContained(runDirectory, path, 'generation artifact')
    if (existsSync(target)) {
      assertNoSymlink(runDirectory, target)
      let actual: string
      try {
        const stat = lstatSync(target)
        if (!stat.isFile()) throw new GenerationError(`generation artifact is not a regular file: ${target}`, 'PATH_ESCAPE')
        actual = readFileSync(target, 'utf8')
      } catch (error) {
        if (error instanceof GenerationError) throw error
        throw storeError(`cannot read immutable generation artifact: ${target}`, error)
      }
      if (actual !== content) throw new GenerationError(`immutable artifact conflicts with replay: ${target}`, 'ARTIFACT_EXISTS')
      return
    }
    this.writeNew(target, content, runDirectory)
  }

  writeNewJson(path: string, value: unknown, runDirectory: string): void {
    this.writeNew(path, `${canonicalJson(value)}\n`, runDirectory)
  }

  writeNewOrSameJson(path: string, value: unknown, runDirectory: string): void {
    const target = assertContained(runDirectory, path, 'generation artifact')
    const expected = canonicalJson(value)
    if (existsSync(target)) {
      const actual = canonicalJson(this.readJson(target, 'immutable generation artifact'))
      if (actual !== expected) throw new GenerationError(`immutable artifact conflicts with replay: ${target}`, 'ARTIFACT_EXISTS')
      return
    }
    this.writeNew(target, `${expected}\n`, runDirectory)
  }

  readJson(path: string, label: string): Record<string, unknown> {
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new GenerationError(`${label} must be a regular file: ${path}`, 'PATH_ESCAPE')
      return parseStrictJsonObject(readFileSync(path, 'utf8'), label)
    } catch (error) {
      if (error instanceof GenerationError) throw error
      throw new GenerationError(`cannot read ${label}: ${path}`, 'ARTIFACT_INVALID', { cause: error })
    }
  }

  private firstH1Claim(state: GenerationState): Readonly<Record<string, string>> {
    return Object.freeze({
      schema_version: FIRST_H1_CLAIM_VERSION,
      profile_id: state.profile_id,
      run_id: state.run_id,
      experiment_run_id: state.experiment_run_id,
      candidate_id: state.candidate_id,
      execution_commit: state.execution_commit,
    })
  }

  private requireFirstH1Claim(state: GenerationState): void {
    const profile = dirname(this.runDirectory(state.profile_id, state.run_id))
    const path = resolve(profile, FIRST_H1_CLAIM_FILE)
    assertNoSymlink(this.root, path)
    let existing: Record<string, unknown>
    try {
      existing = this.readJson(path, 'first H1 generation claim')
    } catch (error) {
      throw new GenerationError('generation is missing its durable first-H1 claim', 'STATE_CORRUPT', {
        profile_id: state.profile_id,
        run_id: state.run_id,
        cause: error,
      })
    }
    if (canonicalJson(existing) !== canonicalJson(this.firstH1Claim(state))) {
      throw new GenerationError('generation state conflicts with its durable first-H1 claim', 'STATE_CORRUPT', {
        profile_id: state.profile_id,
        run_id: state.run_id,
      })
    }
  }

  private assertNoPriorGenerationHistory(profile: string, state: GenerationState): void {
    let entries: string[]
    try {
      entries = readdirSync(profile)
    } catch (error) {
      throw storeError(`cannot inspect generation history for TaskProfile ${state.profile_id}`, error)
    }
    if (entries.length > 0) {
      throw new GenerationError(
        `TaskProfile ${state.profile_id} already has formal generation history`,
        'RUN_EXISTS',
        { profile_id: state.profile_id, run_id: state.run_id },
      )
    }
  }

  private assertNoConflictingGenerationHistory(profile: string, state: GenerationState): void {
    let entries: string[]
    try {
      entries = readdirSync(profile)
    } catch (error) {
      throw storeError(`cannot inspect generation history for TaskProfile ${state.profile_id}`, error)
    }
    const temporaryPrefix = `.${state.run_id}.initializing.`
    const conflicting = entries.filter(name =>
      name !== FIRST_H1_CLAIM_FILE
      && name !== state.run_id
      && !name.startsWith(temporaryPrefix))
    if (conflicting.length > 0) {
      throw new GenerationError(
        `TaskProfile ${state.profile_id} has generation history outside its durable first-H1 claim`,
        'RUN_EXISTS',
        { profile_id: state.profile_id, run_id: state.run_id },
      )
    }
  }

  private requireRun(profileId: string, runId: string): string {
    const run = this.runDirectory(profileId, runId)
    if (!existsSync(run)) {
      throw new GenerationError(`generation ${profileId}/${runId} does not exist`, 'RUN_NOT_FOUND', {
        profile_id: profileId,
        run_id: runId,
      })
    }
    ensureDirectory(this.root)
    assertNoSymlink(this.root, run)
    assertDirectory(run, 'generation run directory')
    return run
  }
}

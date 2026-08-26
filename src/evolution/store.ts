/** Ordinary-file and in-memory persistence for one-writer Stage 3 controllers. */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseStrictJsonObject } from '../core/json.js'
import {
  EvolutionError,
  H0_CANDIDATE_ID,
  type AcceptanceDecision,
  type CandidatePackage,
  type EvaluationRecord,
  type EvolutionFeedback,
  type EvolutionSnapshot,
  type EvolutionState,
  type EvolutionStore,
  type TaskProfile,
} from './types.js'
import {
  normalizeCandidateManifest,
  normalizeEvaluationReport,
  normalizeEvolutionFeedback,
  normalizeTaskProfile,
  validateCandidateForProfile,
} from './profile.js'
import {
  createInitialEvolutionState,
  validateEvolutionState,
} from './state.js'

const ID = /^[a-z][a-z0-9-]*$/u
const DECISION_REASONS = new Set<AcceptanceDecision['reason']>([
  'accepted_strict_improvement',
  'candidate_not_found',
  'candidate_not_validated',
  'profile_mismatch',
  'report_incomplete',
  'wrong_split',
  'wrong_metric',
  'wrong_benchmark',
  'baseline_missing',
  'baseline_fields_incomplete',
  'baseline_candidate_mismatch',
  'baseline_score_mismatch',
  'not_strictly_better',
  'runtime_activation_failed',
])
let temporaryFileSequence = 0

function storeError(message: string, cause?: unknown): EvolutionError {
  return new EvolutionError(message, 'STORE_IO', cause === undefined ? {} : { cause })
}

function validateId(value: string, label: string): string {
  if (!ID.test(value)) throw new EvolutionError(`${label} must match ${String(ID)}`, 'STORE_IO')
  return value
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  temporaryFileSequence += 1
  const temporary = `${path}.tmp-${String(process.pid)}-${String(temporaryFileSequence)}`
  try {
    writeFileSync(temporary, jsonText(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* preserve the original failure */ }
    throw storeError(`failed to atomically write ${path}`, error)
  }
}

function writeNewFile(path: string, contents: string): void {
  try {
    writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    throw storeError(`failed to write new file ${path}`, error)
  }
}

function readJson(path: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw storeError(`failed to read ${path}`, error)
  }
  try {
    return parseStrictJsonObject(text, path)
  } catch (error) {
    throw new EvolutionError(`${path} does not contain valid strict JSON`, 'STATE_CORRUPT', { cause: error })
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (error) {
    if (isMissing(error)) return false
    throw storeError(`failed to inspect ${path}`, error)
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    if (isMissing(error)) return false
    throw storeError(`failed to inspect ${path}`, error)
  }
}

function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw storeError(`failed to inspect ${path}`, error)
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function snapshotCandidate(candidateInput: CandidatePackage): CandidatePackage {
  const candidate = candidateInput as CandidatePackage & Record<string, unknown>
  const allowed = new Set(['manifest', 'host_source'])
  const extra = Object.keys(candidate).find(key => !allowed.has(key))
  if (extra !== undefined) {
    throw new EvolutionError(`candidate package has unsupported field ${extra}`, 'INVALID_CANDIDATE')
  }
  const manifest = normalizeCandidateManifest(candidate.manifest)
  if (typeof candidate.host_source !== 'string' || candidate.host_source.trim().length === 0) {
    throw new EvolutionError('candidate host_source must be a non-empty string', 'INVALID_CANDIDATE', {
      profile_id: manifest.profile_id,
      candidate_id: manifest.candidate_id,
    })
  }
  return Object.freeze({
    manifest,
    host_source: candidate.host_source,
  })
}

function snapshotFeedback(feedbackInput: EvolutionFeedback): EvolutionFeedback {
  return normalizeEvolutionFeedback(feedbackInput)
}

function snapshotDecision(value: AcceptanceDecision): AcceptanceDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EvolutionError('acceptance decision must be an object', 'INVALID_EVALUATION')
  }
  const decision = value as unknown as Record<string, unknown>
  const allowed = new Set([
    'candidate_id', 'accepted', 'reason', 'split', 'metric', 'candidate_score', 'baseline_score',
  ])
  const extra = Object.keys(decision).find(key => !allowed.has(key))
  if (extra !== undefined) {
    throw new EvolutionError(`acceptance decision has unsupported field ${extra}`, 'INVALID_EVALUATION')
  }
  if (typeof decision.candidate_id !== 'string' || !ID.test(decision.candidate_id)) {
    throw new EvolutionError('acceptance decision candidate_id is invalid', 'INVALID_EVALUATION')
  }
  if (
    typeof decision.accepted !== 'boolean'
    || typeof decision.reason !== 'string'
    || !DECISION_REASONS.has(decision.reason as AcceptanceDecision['reason'])
  ) {
    throw new EvolutionError('acceptance decision must contain accepted and reason', 'INVALID_EVALUATION')
  }
  if (decision.accepted !== (decision.reason === 'accepted_strict_improvement')) {
    throw new EvolutionError('acceptance decision accepted flag contradicts reason', 'INVALID_EVALUATION')
  }
  if (decision.split !== 'B_search' && decision.split !== 'B_dev' && decision.split !== 'B_test') {
    throw new EvolutionError('acceptance decision split is invalid', 'INVALID_EVALUATION')
  }
  if (typeof decision.metric !== 'string' || decision.metric.trim().length === 0) {
    throw new EvolutionError('acceptance decision metric is invalid', 'INVALID_EVALUATION')
  }
  if (typeof decision.candidate_score !== 'number' || !Number.isFinite(decision.candidate_score)) {
    throw new EvolutionError('acceptance decision candidate_score is invalid', 'INVALID_EVALUATION')
  }
  if (
    decision.baseline_score !== undefined
    && (typeof decision.baseline_score !== 'number' || !Number.isFinite(decision.baseline_score))
  ) {
    throw new EvolutionError('acceptance decision baseline_score is invalid', 'INVALID_EVALUATION')
  }
  if (decision.accepted && decision.baseline_score === undefined) {
    throw new EvolutionError('accepted decision must contain baseline_score', 'INVALID_EVALUATION')
  }
  return Object.freeze({
    candidate_id: decision.candidate_id,
    accepted: decision.accepted,
    reason: decision.reason as AcceptanceDecision['reason'],
    split: decision.split,
    metric: decision.metric,
    candidate_score: decision.candidate_score,
    ...(decision.baseline_score === undefined ? {} : { baseline_score: decision.baseline_score }),
  })
}

function snapshotEvaluation(record: EvaluationRecord): EvaluationRecord {
  const report = normalizeEvaluationReport(record.report)
  const decision = record.decision === undefined ? undefined : snapshotDecision(record.decision)
  if (decision !== undefined && decision.candidate_id !== report.candidate_id) {
    throw new EvolutionError('evaluation decision candidate_id does not match report', 'INVALID_EVALUATION')
  }
  if (
    decision !== undefined
    && (
      decision.split !== report.split
      || decision.metric !== report.metric
      || decision.candidate_score !== report.score
    )
  ) {
    throw new EvolutionError('evaluation decision scores do not match report', 'INVALID_EVALUATION')
  }
  if (
    decision?.accepted
    && (
      !report.complete
      || report.split !== 'B_dev'
      || report.cases_evaluated === undefined
      || report.cases_expected === undefined
      || report.cases_expected <= 0
      || report.cases_evaluated !== report.cases_expected
      || decision.baseline_score === undefined
      || !(report.score > decision.baseline_score)
      || (report.baseline_score !== undefined && report.baseline_score !== decision.baseline_score)
    )
  ) {
    throw new EvolutionError('accepted evaluation record is not a strict complete B_dev improvement', 'INVALID_EVALUATION')
  }
  return Object.freeze({ report, ...(decision === undefined ? {} : { decision }) })
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Resolve AUTODATA_HOME without inventing a second DSH home convention. */
export function resolveAutoDataHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.AUTODATA_HOME
  if (configured !== undefined && configured.length > 0) return resolve(configured)
  const dshHome = environment.DSH_HOME
  if (dshHome !== undefined && dshHome.length > 0) return resolve(dshHome, 'autodata')
  throw new EvolutionError('AUTODATA_HOME is unset and DSH_HOME is unavailable', 'STORE_IO')
}

/** Cross-check only records referenced by state.json; unreferenced append artifacts are ignored. */
export function validateEvolutionSnapshot(
  profileInput: TaskProfile,
  stateInput: EvolutionState,
  candidateInputs: readonly CandidatePackage[],
  feedbackInputs: readonly EvolutionFeedback[] = [],
): EvolutionSnapshot {
  const profile = normalizeTaskProfile(profileInput)
  const state = validateEvolutionState(stateInput)
  if (state.profile_id !== profile.id) {
    throw new EvolutionError('EvolutionState profile_id does not match profile.json', 'STATE_CORRUPT', {
      profile_id: profile.id,
    })
  }
  const referencedCandidateIds = new Set(state.candidates
    .filter(candidate => candidate.candidate_id !== H0_CANDIDATE_ID)
    .map(candidate => candidate.candidate_id))
  // Filter by the persisted ID before normalizing so a malformed orphan is ignored;
  // a malformed record that state.json references still fails below.
  const packages = candidateInputs
    .filter((candidate) => {
      const manifest = (candidate as unknown as { manifest?: unknown }).manifest
      return typeof manifest === 'object' && manifest !== null
        && referencedCandidateIds.has((manifest as { candidate_id?: unknown }).candidate_id as string)
    })
    .map(snapshotCandidate)
  const byId = new Map<string, CandidatePackage>()
  for (const candidatePackage of packages) {
    const manifest = validateCandidateForProfile(profile, candidatePackage.manifest)
    if (byId.has(manifest.candidate_id)) {
      throw new EvolutionError(`duplicate candidate package ${manifest.candidate_id}`, 'STATE_CORRUPT', {
        profile_id: profile.id,
        candidate_id: manifest.candidate_id,
      })
    }
    byId.set(manifest.candidate_id, candidatePackage)
  }

  for (const candidate of state.candidates) {
    if (candidate.candidate_id === H0_CANDIDATE_ID) continue
    const candidatePackage = byId.get(candidate.candidate_id)
    if (candidatePackage === undefined) {
      throw new EvolutionError(`candidate ${candidate.candidate_id} has no persisted host source`, 'STATE_CORRUPT', {
        profile_id: profile.id,
        candidate_id: candidate.candidate_id,
      })
    }
    const manifest = candidatePackage.manifest
    if (
      manifest.profile_id !== state.profile_id
      || manifest.generation !== candidate.generation
      || manifest.parent_candidate_id !== candidate.parent_candidate_id
    ) {
      throw new EvolutionError(`candidate ${candidate.candidate_id} manifest does not match state.json`, 'STATE_CORRUPT', {
        profile_id: profile.id,
        candidate_id: candidate.candidate_id,
      })
    }
    byId.delete(candidate.candidate_id)
  }

  const referencedFeedbackIds = new Set(state.feedback_ids)
  const feedbackRecords = feedbackInputs
    .filter((feedback) => referencedFeedbackIds.has(
      (feedback as unknown as { feedback_id?: unknown }).feedback_id as string,
    ))
    .map(snapshotFeedback)
  const feedbackById = new Map<string, EvolutionFeedback>()
  for (const feedback of feedbackRecords) {
    if (feedbackById.has(feedback.feedback_id)) {
      throw new EvolutionError(`duplicate feedback record ${feedback.feedback_id}`, 'STATE_CORRUPT', {
        profile_id: profile.id,
        candidate_id: feedback.candidate_id,
      })
    }
    if (feedback.profile_id !== profile.id || feedback.benchmark !== profile.benchmark) {
      throw new EvolutionError(`feedback ${feedback.feedback_id} does not match its TaskProfile`, 'STATE_CORRUPT', {
        profile_id: profile.id,
        candidate_id: feedback.candidate_id,
      })
    }
    const candidate = state.candidates.find(value => value.candidate_id === feedback.candidate_id)
    if (candidate === undefined || (candidate.status !== 'accepted' && candidate.status !== 'retired')) {
      throw new EvolutionError(`feedback ${feedback.feedback_id} does not target accepted candidate history`, 'STATE_CORRUPT', {
        profile_id: profile.id,
        candidate_id: feedback.candidate_id,
      })
    }
    feedbackById.set(feedback.feedback_id, feedback)
  }
  for (const feedbackId of state.feedback_ids) {
    if (!feedbackById.has(feedbackId)) {
      throw new EvolutionError(`feedback ${feedbackId} is referenced by state.json but missing`, 'STATE_CORRUPT', {
        profile_id: profile.id,
      })
    }
  }
  if (state.current_feedback_id !== null) {
    const current = feedbackById.get(state.current_feedback_id)
    if (current === undefined || current.candidate_id !== state.active_candidate_id) {
      throw new EvolutionError('current_feedback_id must target the active candidate', 'STATE_CORRUPT', {
        profile_id: profile.id,
        candidate_id: state.active_candidate_id,
      })
    }
  }
  return Object.freeze({
    profile,
    state,
    candidate_packages: Object.freeze(state.candidates
      .filter(candidate => candidate.candidate_id !== H0_CANDIDATE_ID)
      .map(candidate => byId.get(candidate.candidate_id) ?? packages.find(value =>
        value.manifest.candidate_id === candidate.candidate_id)!)),
    feedback_records: Object.freeze(state.feedback_ids.map(feedbackId => feedbackById.get(feedbackId)!)),
  })
}

/** Read and validate one complete profile snapshot before runtime mutation. */
export function loadConsistentEvolutionSnapshot(store: EvolutionStore, profileId: string): EvolutionSnapshot {
  validateId(profileId, 'profileId')
  const profile = store.getProfile(profileId)
  if (profile === undefined) {
    throw new EvolutionError(`profile ${profileId} does not exist`, 'PROFILE_NOT_FOUND', { profile_id: profileId })
  }
  const collidingProfile = store.listProfiles().find(value =>
    value.id !== profile.id && value.strategy_plugin_id === profile.strategy_plugin_id)
  if (collidingProfile !== undefined) {
    throw new EvolutionError(
      `strategy_plugin_id ${profile.strategy_plugin_id} is shared by profiles ${profile.id} and ${collidingProfile.id}`,
      'STATE_CORRUPT',
      { profile_id: profile.id },
    )
  }
  const state = store.getState(profileId)
  if (state === undefined) {
    throw new EvolutionError(`profile ${profileId} has no state.json`, 'STATE_CORRUPT', {
      profile_id: profileId,
    })
  }
  const candidates = state.candidates
    .filter(candidate => candidate.candidate_id !== H0_CANDIDATE_ID)
    .map((candidate) => {
      const candidatePackage = store.getCandidate(profileId, candidate.candidate_id)
      if (candidatePackage === undefined) {
        throw new EvolutionError(`candidate ${candidate.candidate_id} has no persisted host source`, 'STATE_CORRUPT', {
          profile_id: profile.id,
          candidate_id: candidate.candidate_id,
        })
      }
      return candidatePackage
    })
  const feedback = state.feedback_ids.map((feedbackId) => {
    const record = store.getFeedback(profileId, feedbackId)
    if (record === undefined) {
      throw new EvolutionError(`feedback ${feedbackId} is referenced by state.json but missing`, 'STATE_CORRUPT', {
        profile_id: profile.id,
      })
    }
    return record
  })
  return validateEvolutionSnapshot(profile, state, candidates, feedback)
}

/** Process-local Store with the same append/replace semantics as the file Store. */
export class MemoryEvolutionStore implements EvolutionStore {
  private readonly profiles = new Map<string, TaskProfile>()
  private readonly states = new Map<string, EvolutionState>()
  private readonly candidates = new Map<string, Map<string, CandidatePackage>>()
  private readonly feedback = new Map<string, Map<string, EvolutionFeedback>>()
  private readonly evaluations = new Map<string, Map<string, EvaluationRecord>>()

  createProfile(profileInput: TaskProfile): EvolutionState {
    const profile = normalizeTaskProfile(profileInput)
    if (this.profiles.has(profile.id)) {
      throw new EvolutionError(`profile ${profile.id} already exists`, 'PROFILE_EXISTS', { profile_id: profile.id })
    }
    const collision = [...this.profiles.values()].find(value => value.strategy_plugin_id === profile.strategy_plugin_id)
    if (collision !== undefined) {
      throw new EvolutionError(
        `strategy_plugin_id ${profile.strategy_plugin_id} is already used by profile ${collision.id}`,
        'INVALID_PROFILE',
        { profile_id: profile.id },
      )
    }
    const state = createInitialEvolutionState(profile)
    this.profiles.set(profile.id, profile)
    this.states.set(profile.id, state)
    return state
  }

  saveProfile(profileInput: TaskProfile): void {
    const profile = normalizeTaskProfile(profileInput)
    const current = this.profiles.get(profile.id)
    if (current !== undefined && !sameJson(current, profile)) {
      throw new EvolutionError(`profile ${profile.id} is immutable`, 'PROFILE_EXISTS', { profile_id: profile.id })
    }
    if (current === undefined) {
      const collision = [...this.profiles.values()].find(value => value.strategy_plugin_id === profile.strategy_plugin_id)
      if (collision !== undefined) {
        throw new EvolutionError(
          `strategy_plugin_id ${profile.strategy_plugin_id} is already used by profile ${collision.id}`,
          'INVALID_PROFILE',
          { profile_id: profile.id },
        )
      }
    }
    this.profiles.set(profile.id, profile)
  }

  getProfile(profileId: string): TaskProfile | undefined {
    validateId(profileId, 'profileId')
    return this.profiles.get(profileId)
  }

  listProfiles(): readonly TaskProfile[] {
    return Object.freeze([...this.profiles.values()].sort((left, right) => left.id.localeCompare(right.id)))
  }

  saveState(stateInput: EvolutionState): void {
    const state = validateEvolutionState(stateInput)
    if (!this.profiles.has(state.profile_id)) {
      throw new EvolutionError(`profile ${state.profile_id} does not exist`, 'PROFILE_NOT_FOUND', { profile_id: state.profile_id })
    }
    this.states.set(state.profile_id, state)
  }

  getState(profileId: string): EvolutionState | undefined {
    validateId(profileId, 'profileId')
    return this.states.get(profileId)
  }

  saveCandidate(candidateInput: CandidatePackage): void {
    const candidate = snapshotCandidate(candidateInput)
    const profile = this.profiles.get(candidate.manifest.profile_id)
    if (profile === undefined) {
      throw new EvolutionError(`profile ${candidate.manifest.profile_id} does not exist`, 'PROFILE_NOT_FOUND', {
        profile_id: candidate.manifest.profile_id,
      })
    }
    validateCandidateForProfile(profile, candidate.manifest)
    let entries = this.candidates.get(candidate.manifest.profile_id)
    if (entries === undefined) {
      entries = new Map()
      this.candidates.set(candidate.manifest.profile_id, entries)
    }
    if (entries.has(candidate.manifest.candidate_id)) {
      throw new EvolutionError(`candidate ${candidate.manifest.candidate_id} already exists`, 'CANDIDATE_EXISTS', {
        profile_id: candidate.manifest.profile_id,
        candidate_id: candidate.manifest.candidate_id,
      })
    }
    entries.set(candidate.manifest.candidate_id, candidate)
  }

  getCandidate(profileId: string, candidateId: string): CandidatePackage | undefined {
    validateId(profileId, 'profileId')
    validateId(candidateId, 'candidateId')
    return this.candidates.get(profileId)?.get(candidateId)
  }

  listCandidates(profileId: string): readonly CandidatePackage[] {
    validateId(profileId, 'profileId')
    return Object.freeze([...this.candidates.get(profileId)?.values() ?? []]
      .sort((left, right) => left.manifest.candidate_id.localeCompare(right.manifest.candidate_id)))
  }

  saveFeedback(feedbackInput: EvolutionFeedback): void {
    const feedback = snapshotFeedback(feedbackInput)
    const profile = this.profiles.get(feedback.profile_id)
    if (profile === undefined) {
      throw new EvolutionError(`profile ${feedback.profile_id} does not exist`, 'PROFILE_NOT_FOUND', {
        profile_id: feedback.profile_id,
      })
    }
    let entries = this.feedback.get(feedback.profile_id)
    if (entries === undefined) {
      entries = new Map()
      this.feedback.set(feedback.profile_id, entries)
    }
    if (entries.has(feedback.feedback_id)) {
      throw new EvolutionError(`feedback ${feedback.feedback_id} already exists`, 'FEEDBACK_EXISTS', {
        profile_id: feedback.profile_id,
        candidate_id: feedback.candidate_id,
      })
    }
    this.validateFeedbackOwner(profile, feedback)
    entries.set(feedback.feedback_id, feedback)
  }

  getFeedback(profileId: string, feedbackId: string): EvolutionFeedback | undefined {
    validateId(profileId, 'profileId')
    validateId(feedbackId, 'feedbackId')
    return this.feedback.get(profileId)?.get(feedbackId)
  }

  listFeedback(profileId: string): readonly EvolutionFeedback[] {
    validateId(profileId, 'profileId')
    return Object.freeze([...this.feedback.get(profileId)?.values() ?? []]
      .sort((left, right) => left.feedback_id.localeCompare(right.feedback_id)))
  }

  saveEvaluation(profileId: string, recordInput: EvaluationRecord): void {
    validateId(profileId, 'profileId')
    if (!this.profiles.has(profileId)) {
      throw new EvolutionError(`profile ${profileId} does not exist`, 'PROFILE_NOT_FOUND', { profile_id: profileId })
    }
    const record = snapshotEvaluation(recordInput)
    if (record.report.profile_id !== profileId) {
      throw new EvolutionError('evaluation profile_id does not match Store profile', 'INVALID_EVALUATION')
    }
    if (this.getEvaluation(profileId, record.report.report_id) !== undefined) {
      throw new EvolutionError(`evaluation ${record.report.report_id} already exists`, 'INVALID_EVALUATION', {
        profile_id: profileId,
        candidate_id: record.report.candidate_id,
      })
    }
    let entries = this.evaluations.get(profileId)
    if (entries === undefined) {
      entries = new Map()
      this.evaluations.set(profileId, entries)
    }
    if (entries.has(record.report.report_id)) {
      throw new EvolutionError(`evaluation ${record.report.report_id} already exists`, 'INVALID_EVALUATION')
    }
    const runId = record.report.run_id ?? record.report.report_id
    if ([...entries.values()].some(value => (value.report.run_id ?? value.report.report_id) === runId)) {
      throw new EvolutionError(`evaluation run ${runId} already exists`, 'INVALID_EVALUATION', {
        profile_id: profileId,
        candidate_id: record.report.candidate_id,
      })
    }
    entries.set(record.report.report_id, record)
  }

  getEvaluation(profileId: string, reportId: string): EvaluationRecord | undefined {
    validateId(profileId, 'profileId')
    validateId(reportId, 'reportId')
    return this.evaluations.get(profileId)?.get(reportId)
  }

  loadConsistentSnapshot(profileId: string): EvolutionSnapshot {
    return loadConsistentEvolutionSnapshot(this, profileId)
  }

  private validateFeedbackOwner(profile: TaskProfile, feedback: EvolutionFeedback): void {
    const state = this.states.get(profile.id)
    if (feedback.benchmark !== profile.benchmark) {
      throw new EvolutionError('feedback benchmark does not match TaskProfile', 'INVALID_FEEDBACK', {
        profile_id: profile.id,
        candidate_id: feedback.candidate_id,
      })
    }
    if (state === undefined || feedback.candidate_id !== state.active_candidate_id) {
      throw new EvolutionError('feedback must target the current active candidate', 'INVALID_FEEDBACK', {
        profile_id: profile.id,
        candidate_id: feedback.candidate_id,
      })
    }
  }
}

export type InMemoryEvolutionStore = MemoryEvolutionStore

export interface FileEvolutionStoreOptions {
  readonly root?: string
  readonly env?: NodeJS.ProcessEnv
}

/** Ordinary JSON/source files with append-only records and atomic state replacement. */
export class FileEvolutionStore implements EvolutionStore {
  readonly root: string

  constructor(options: string | FileEvolutionStoreOptions = {}) {
    this.root = resolve(typeof options === 'string' ? options : options.root ?? resolveAutoDataHome(options.env))
  }

  createProfile(profileInput: TaskProfile): EvolutionState {
    const profile = normalizeTaskProfile(profileInput)
    const collision = this.listProfiles().find(value => value.strategy_plugin_id === profile.strategy_plugin_id)
    if (collision !== undefined) {
      throw new EvolutionError(
        `strategy_plugin_id ${profile.strategy_plugin_id} is already used by profile ${collision.id}`,
        'INVALID_PROFILE',
        { profile_id: profile.id },
      )
    }
    const directory = this.profileDirectory(profile.id)
    try {
      mkdirSync(join(this.root, 'profiles'), { recursive: true, mode: 0o700 })
      mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST') {
        throw new EvolutionError(`profile ${profile.id} already exists`, 'PROFILE_EXISTS', { profile_id: profile.id })
      }
      throw storeError(`failed to create profile directory ${directory}`, error)
    }
    const state = createInitialEvolutionState(profile)
    try {
      writeNewFile(join(directory, 'profile.json'), jsonText(profile))
      atomicWrite(join(directory, 'state.json'), state)
      mkdirSync(join(directory, 'candidates'), { mode: 0o700 })
      mkdirSync(join(directory, 'feedback'), { mode: 0o700 })
      mkdirSync(join(directory, 'runs'), { mode: 0o700 })
    } catch (error) {
      throw error instanceof EvolutionError ? error : storeError(`failed to initialize profile ${profile.id}`, error)
    }
    return state
  }

  saveProfile(profileInput: TaskProfile): void {
    const profile = normalizeTaskProfile(profileInput)
    const path = join(this.profileDirectory(profile.id), 'profile.json')
    if (fileExists(path)) {
      const current = normalizeTaskProfile(readJson(path) as unknown as TaskProfile)
      if (!sameJson(current, profile)) {
        throw new EvolutionError(`profile ${profile.id} is immutable`, 'PROFILE_EXISTS', { profile_id: profile.id })
      }
      return
    }
    const collision = this.listProfiles().find(value => value.strategy_plugin_id === profile.strategy_plugin_id)
    if (collision !== undefined) {
      throw new EvolutionError(
        `strategy_plugin_id ${profile.strategy_plugin_id} is already used by profile ${collision.id}`,
        'INVALID_PROFILE',
        { profile_id: profile.id },
      )
    }
    mkdirSync(this.profileDirectory(profile.id), { recursive: true, mode: 0o700 })
    writeNewFile(path, jsonText(profile))
  }

  getProfile(profileId: string): TaskProfile | undefined {
    const path = join(this.profileDirectory(profileId), 'profile.json')
    if (!fileExists(path)) return undefined
    let profile: TaskProfile
    try {
      profile = normalizeTaskProfile(readJson(path) as unknown as TaskProfile)
    } catch (error) {
      throw new EvolutionError(`profile ${profileId} is corrupt`, 'STATE_CORRUPT', {
        profile_id: profileId,
        cause: error,
      })
    }
    if (profile.id !== profileId) {
      throw new EvolutionError(`profile.json id does not match directory ${profileId}`, 'STATE_CORRUPT', {
        profile_id: profileId,
      })
    }
    return profile
  }

  listProfiles(): readonly TaskProfile[] {
    const directory = join(this.root, 'profiles')
    if (!directoryExists(directory)) return Object.freeze([])
    let names: string[]
    try {
      names = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort()
    } catch (error) {
      throw storeError(`failed to list profiles in ${directory}`, error)
    }
    return Object.freeze(names.map((profileId) => {
      validateId(profileId, 'profile directory')
      const profile = this.getProfile(profileId)
      if (profile === undefined) {
        throw new EvolutionError(`profile directory ${profileId} has no profile.json`, 'STATE_CORRUPT', {
          profile_id: profileId,
        })
      }
      return profile
    }))
  }

  saveState(stateInput: EvolutionState): void {
    const state = validateEvolutionState(stateInput)
    this.requireProfile(state.profile_id)
    atomicWrite(join(this.profileDirectory(state.profile_id), 'state.json'), state)
  }

  getState(profileId: string): EvolutionState | undefined {
    const path = join(this.profileDirectory(profileId), 'state.json')
    if (!fileExists(path)) return undefined
    const state = validateEvolutionState(readJson(path))
    if (state.profile_id !== profileId) {
      throw new EvolutionError(`state.json profile_id does not match directory ${profileId}`, 'STATE_CORRUPT', {
        profile_id: profileId,
      })
    }
    return state
  }

  saveCandidate(candidateInput: CandidatePackage): void {
    const candidate = snapshotCandidate(candidateInput)
    const profileId = candidate.manifest.profile_id
    const candidateId = candidate.manifest.candidate_id
    const profile = this.requireProfile(profileId)
    validateCandidateForProfile(profile, candidate.manifest)
    const candidatesDirectory = join(this.profileDirectory(profileId), 'candidates')
    mkdirSync(candidatesDirectory, { recursive: true, mode: 0o700 })
    const finalDirectory = join(candidatesDirectory, candidateId)
    if (directoryExists(finalDirectory)) {
      throw new EvolutionError(`candidate ${candidateId} already exists`, 'CANDIDATE_EXISTS', {
        profile_id: profileId,
        candidate_id: candidateId,
      })
    }
    temporaryFileSequence += 1
    const stagingDirectory = join(candidatesDirectory, `.${candidateId}.tmp-${String(process.pid)}-${String(temporaryFileSequence)}`)
    try {
      mkdirSync(stagingDirectory, { mode: 0o700 })
      writeNewFile(join(stagingDirectory, 'package-host.js'), candidate.host_source)
      writeNewFile(join(stagingDirectory, 'manifest.json'), jsonText(candidate.manifest))
      renameSync(stagingDirectory, finalDirectory)
    } catch (error) {
      try { rmSync(stagingDirectory, { recursive: true, force: true }) } catch { /* preserve the original failure */ }
      if (error instanceof EvolutionError) throw error
      throw storeError(`failed to append candidate ${candidateId}`, error)
    }
  }

  getCandidate(profileId: string, candidateId: string): CandidatePackage | undefined {
    const directory = this.candidateDirectory(profileId, candidateId)
    if (!directoryExists(directory)) return undefined
    const manifestPath = join(directory, 'manifest.json')
    const hostPath = join(directory, 'package-host.js')
    const clientPath = join(directory, 'package-client.js')
    if (!fileExists(manifestPath) || !fileExists(hostPath)) {
      throw new EvolutionError(`candidate ${candidateId} is incomplete`, 'STATE_CORRUPT', {
        profile_id: profileId,
        candidate_id: candidateId,
      })
    }
    if (fileExists(clientPath)) {
      throw new EvolutionError(`candidate ${candidateId} contains a forbidden client half`, 'STATE_CORRUPT', {
        profile_id: profileId,
        candidate_id: candidateId,
      })
    }
    let manifest: CandidatePackage['manifest']
    try {
      manifest = normalizeCandidateManifest(readJson(manifestPath) as unknown as CandidatePackage['manifest'])
    } catch (error) {
      throw new EvolutionError(`candidate ${candidateId} manifest is corrupt`, 'STATE_CORRUPT', {
        profile_id: profileId,
        candidate_id: candidateId,
        cause: error,
      })
    }
    if (manifest.profile_id !== profileId || manifest.candidate_id !== candidateId) {
      throw new EvolutionError(`candidate ${candidateId} manifest does not match its directory`, 'STATE_CORRUPT', {
        profile_id: profileId,
        candidate_id: candidateId,
      })
    }
    let hostSource: string
    try {
      hostSource = readFileSync(hostPath, 'utf8')
    } catch (error) {
      throw storeError(`failed to read candidate ${candidateId}`, error)
    }
    return snapshotCandidate({
      manifest,
      host_source: hostSource,
    })
  }

  listCandidates(profileId: string): readonly CandidatePackage[] {
    const directory = join(this.profileDirectory(profileId), 'candidates')
    if (!directoryExists(directory)) return Object.freeze([])
    let names: string[]
    try {
      names = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort()
    } catch (error) {
      throw storeError(`failed to list candidates for ${profileId}`, error)
    }
    return Object.freeze(names.map((candidateId) => {
      validateId(candidateId, 'candidate directory')
      const candidate = this.getCandidate(profileId, candidateId)
      if (candidate === undefined) throw new EvolutionError(`candidate ${candidateId} disappeared`, 'STATE_CORRUPT')
      return candidate
    }))
  }

  saveFeedback(feedbackInput: EvolutionFeedback): void {
    const feedback = snapshotFeedback(feedbackInput)
    const profile = this.requireProfile(feedback.profile_id)
    const path = this.feedbackPath(feedback.profile_id, feedback.feedback_id)
    if (pathExists(path)) {
      throw new EvolutionError(`feedback ${feedback.feedback_id} already exists`, 'FEEDBACK_EXISTS', {
        profile_id: feedback.profile_id,
        candidate_id: feedback.candidate_id,
      })
    }
    this.validateFeedbackOwner(profile, feedback)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeNewFile(path, jsonText(feedback))
  }

  getFeedback(profileId: string, feedbackId: string): EvolutionFeedback | undefined {
    const path = this.feedbackPath(profileId, feedbackId)
    if (!fileExists(path)) return undefined
    let feedback: EvolutionFeedback
    try {
      feedback = normalizeEvolutionFeedback(readJson(path) as unknown as EvolutionFeedback)
    } catch (error) {
      throw new EvolutionError(`feedback ${feedbackId} is corrupt`, 'STATE_CORRUPT', {
        profile_id: profileId,
        cause: error,
      })
    }
    if (feedback.profile_id !== profileId || feedback.feedback_id !== feedbackId) {
      throw new EvolutionError(`feedback ${feedbackId} does not match its file name`, 'STATE_CORRUPT', {
        profile_id: profileId,
        candidate_id: feedback.candidate_id,
      })
    }
    return feedback
  }

  listFeedback(profileId: string): readonly EvolutionFeedback[] {
    const directory = join(this.profileDirectory(profileId), 'feedback')
    if (!directoryExists(directory)) return Object.freeze([])
    let names: string[]
    try {
      names = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.json'))
        .map(entry => entry.name.slice(0, -'.json'.length))
        .sort()
    } catch (error) {
      throw storeError(`failed to list feedback for ${profileId}`, error)
    }
    return Object.freeze(names.map((feedbackId) => {
      validateId(feedbackId, 'feedback file')
      const feedback = this.getFeedback(profileId, feedbackId)
      if (feedback === undefined) throw new EvolutionError(`feedback ${feedbackId} disappeared`, 'STATE_CORRUPT')
      return feedback
    }))
  }

  saveEvaluation(profileId: string, recordInput: EvaluationRecord): void {
    const record = snapshotEvaluation(recordInput)
    validateId(profileId, 'profileId')
    this.requireProfile(profileId)
    if (record.report.profile_id !== profileId) {
      throw new EvolutionError('evaluation profile_id does not match Store profile', 'INVALID_EVALUATION')
    }
    if (this.getEvaluation(profileId, record.report.report_id) !== undefined) {
      throw new EvolutionError(`evaluation ${record.report.report_id} already exists`, 'INVALID_EVALUATION', {
        profile_id: profileId,
        candidate_id: record.report.candidate_id,
      })
    }
    const runsDirectory = join(this.profileDirectory(profileId), 'runs')
    mkdirSync(runsDirectory, { recursive: true, mode: 0o700 })
    const runId = record.report.run_id ?? record.report.report_id
    validateId(runId, 'evaluation run_id')
    const finalDirectory = join(runsDirectory, runId)
    if (directoryExists(finalDirectory)) {
      throw new EvolutionError(`evaluation run ${runId} already exists`, 'INVALID_EVALUATION')
    }
    temporaryFileSequence += 1
    const stagingDirectory = join(runsDirectory, `.${runId}.tmp-${String(process.pid)}-${String(temporaryFileSequence)}`)
    try {
      mkdirSync(stagingDirectory, { mode: 0o700 })
      writeNewFile(join(stagingDirectory, 'summary.json'), jsonText(record.report))
      if (record.decision !== undefined) {
        writeNewFile(join(stagingDirectory, 'decision.json'), jsonText(record.decision))
      }
      renameSync(stagingDirectory, finalDirectory)
    } catch (error) {
      try { rmSync(stagingDirectory, { recursive: true, force: true }) } catch { /* preserve the original failure */ }
      if (error instanceof EvolutionError) throw error
      throw storeError(`failed to append evaluation run ${runId}`, error)
    }
  }

  getEvaluation(profileId: string, reportId: string): EvaluationRecord | undefined {
    validateId(profileId, 'profileId')
    validateId(reportId, 'reportId')
    const runsDirectory = join(this.profileDirectory(profileId), 'runs')
    if (!directoryExists(runsDirectory)) return undefined
    let runNames: string[]
    try {
      runNames = readdirSync(runsDirectory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort()
    } catch (error) {
      throw storeError(`failed to list evaluation runs for ${profileId}`, error)
    }
    let found: EvaluationRecord | undefined
    for (const runName of runNames) {
      const summaryPath = join(runsDirectory, runName, 'summary.json')
      if (!fileExists(summaryPath)) throw new EvolutionError(`evaluation run ${runName} is incomplete`, 'STATE_CORRUPT')
      const report = normalizeEvaluationReport(readJson(summaryPath) as unknown as EvaluationRecord['report'])
      const expectedRunName = report.run_id ?? report.report_id
      if (report.profile_id !== profileId || expectedRunName !== runName) {
        throw new EvolutionError(`evaluation run ${runName} does not match its directory`, 'STATE_CORRUPT', {
          profile_id: profileId,
          candidate_id: report.candidate_id,
        })
      }
      if (report.report_id !== reportId) continue
      const decisionPath = join(runsDirectory, runName, 'decision.json')
      const decision = fileExists(decisionPath)
        ? snapshotDecision(readJson(decisionPath) as unknown as AcceptanceDecision)
        : undefined
      const record = snapshotEvaluation({ report, ...(decision === undefined ? {} : { decision }) })
      if (found !== undefined) {
        throw new EvolutionError(`evaluation ${reportId} is stored more than once`, 'STATE_CORRUPT', {
          profile_id: profileId,
          candidate_id: report.candidate_id,
        })
      }
      found = record
    }
    return found
  }

  loadConsistentSnapshot(profileId: string): EvolutionSnapshot {
    return loadConsistentEvolutionSnapshot(this, profileId)
  }

  private profileDirectory(profileId: string): string {
    return join(this.root, 'profiles', validateId(profileId, 'profileId'))
  }

  private candidateDirectory(profileId: string, candidateId: string): string {
    return join(this.profileDirectory(profileId), 'candidates', validateId(candidateId, 'candidateId'))
  }

  private feedbackPath(profileId: string, feedbackId: string): string {
    return join(this.profileDirectory(profileId), 'feedback', `${validateId(feedbackId, 'feedbackId')}.json`)
  }

  private requireProfile(profileId: string): TaskProfile {
    const profile = this.getProfile(profileId)
    if (profile === undefined) {
      throw new EvolutionError(`profile ${profileId} does not exist`, 'PROFILE_NOT_FOUND', { profile_id: profileId })
    }
    return profile
  }

  private validateFeedbackOwner(profile: TaskProfile, feedback: EvolutionFeedback): void {
    const state = this.getState(profile.id)
    if (feedback.benchmark !== profile.benchmark) {
      throw new EvolutionError('feedback benchmark does not match TaskProfile', 'INVALID_FEEDBACK', {
        profile_id: profile.id,
        candidate_id: feedback.candidate_id,
      })
    }
    if (state === undefined || feedback.candidate_id !== state.active_candidate_id) {
      throw new EvolutionError('feedback must target the current active candidate', 'INVALID_FEEDBACK', {
        profile_id: profile.id,
        candidate_id: feedback.candidate_id,
      })
    }
  }
}

export type FileSystemEvolutionStore = FileEvolutionStore

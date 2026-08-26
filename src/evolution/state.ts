/** Pure synchronous state transitions for one TaskProfile. */

import { immutableJson, isJsonObject } from '../core/json.js'
import {
  EVOLUTION_STATE_SCHEMA_VERSION,
  EvolutionError,
  H0_CANDIDATE_ID,
  type AcceptanceDecision,
  type CandidateManifest,
  type CandidateManifestInput,
  type CandidateState,
  type CandidateStatus,
  type EvaluationReport,
  type EvaluationSummary,
  type EvolutionFeedback,
  type EvolutionFeedbackInput,
  type EvolutionState,
  type TaskProfile,
  type TaskProfileInput,
} from './types.js'
import {
  normalizeEvaluationReport,
  normalizeEvolutionFeedback,
  normalizeTaskProfile,
  validateCandidateForProfile,
} from './profile.js'

const CANDIDATE_STATUSES = new Set<CandidateStatus>([
  'proposed', 'validated', 'accepted', 'rejected', 'retired',
])

function fail(
  message: string,
  code: 'INVALID_CANDIDATE' | 'CANDIDATE_NOT_FOUND' | 'CANDIDATE_STATE' | 'OPEN_CANDIDATE_EXISTS' | 'INVALID_EVALUATION' | 'INVALID_FEEDBACK' | 'FEEDBACK_EXISTS' | 'STATE_CORRUPT',
  state?: EvolutionState,
  candidateId?: string,
): never {
  throw new EvolutionError(message, code, {
    ...(state === undefined ? {} : { profile_id: state.profile_id }),
    ...(candidateId === undefined ? {} : { candidate_id: candidateId }),
  })
}

function freezeState(state: EvolutionState): EvolutionState {
  return immutableJson(state) as unknown as EvolutionState
}

function candidateIndex(state: EvolutionState, candidateId: string): number {
  return state.candidates.findIndex(candidate => candidate.candidate_id === candidateId)
}

function requireCandidate(state: EvolutionState, candidateId: string): CandidateState {
  const candidate = state.candidates[candidateIndex(state, candidateId)]
  if (candidate === undefined) fail(`candidate ${candidateId} does not exist`, 'CANDIDATE_NOT_FOUND', state, candidateId)
  return candidate
}

function replaceCandidate(
  state: EvolutionState,
  candidateId: string,
  replace: (candidate: CandidateState) => CandidateState,
  rest: Partial<Pick<EvolutionState, 'generation' | 'active_candidate_id' | 'open_candidate_id' | 'active_evaluation'>> = {},
): EvolutionState {
  const index = candidateIndex(state, candidateId)
  if (index < 0) fail(`candidate ${candidateId} does not exist`, 'CANDIDATE_NOT_FOUND', state, candidateId)
  const candidates = state.candidates.map((candidate, candidatePosition) =>
    candidatePosition === index ? replace(candidate) : candidate)
  const next: Record<string, unknown> = {
    ...state,
    ...rest,
    candidates,
  }
  if (Object.hasOwn(rest, 'active_evaluation') && rest.active_evaluation === undefined) {
    delete next.active_evaluation
  }
  return validateEvolutionState(next)
}

function reportSummary(report: EvaluationReport): EvaluationSummary {
  return Object.freeze({
    report_id: report.report_id,
    candidate_id: report.candidate_id,
    benchmark: report.benchmark,
    split: report.split,
    metric: report.metric,
    score: report.score,
  })
}

function decision(
  candidateId: string,
  accepted: boolean,
  reason: AcceptanceDecision['reason'],
  report?: EvaluationReport,
  baselineScore?: number,
): AcceptanceDecision {
  return Object.freeze({
    candidate_id: candidateId,
    accepted,
    reason,
    ...(report === undefined ? {} : {
      split: report.split,
      metric: report.metric,
      candidate_score: report.score,
    }),
    ...(baselineScore === undefined ? {} : { baseline_score: baselineScore }),
  })
}

function assertProfileOwnsState(profile: TaskProfile, state: EvolutionState): void {
  if (profile.id !== state.profile_id) {
    fail('TaskProfile id does not match EvolutionState profile_id', 'STATE_CORRUPT', state)
  }
}

/** New profiles start with the built-in H0 candidate accepted and active. */
export function createInitialEvolutionState(profileInput: TaskProfile): EvolutionState {
  const profile = normalizeTaskProfile(profileInput)
  return freezeState({
    schema_version: EVOLUTION_STATE_SCHEMA_VERSION,
    profile_id: profile.id,
    generation: 0,
    active_candidate_id: H0_CANDIDATE_ID,
    open_candidate_id: null,
    feedback_ids: [],
    current_feedback_id: null,
    candidates: [{
      candidate_id: H0_CANDIDATE_ID,
      generation: 0,
      status: 'accepted',
      parent_candidate_id: null,
    }],
  })
}

/** Compatibility alias for controller implementations. */
export const createEvolutionState = createInitialEvolutionState

/** Append Host-authored B_search evidence and make it current for the active candidate. */
export function recordEvolutionFeedback(
  stateInput: EvolutionState,
  feedbackInput: EvolutionFeedbackInput | EvolutionFeedback,
): EvolutionState {
  const state = validateEvolutionState(stateInput)
  const feedback = normalizeEvolutionFeedback(feedbackInput)
  if (feedback.profile_id !== state.profile_id) {
    fail('EvolutionFeedback profile_id does not match EvolutionState', 'INVALID_FEEDBACK', state, feedback.candidate_id)
  }
  if (feedback.candidate_id !== state.active_candidate_id) {
    fail('EvolutionFeedback must target the current active candidate', 'INVALID_FEEDBACK', state, feedback.candidate_id)
  }
  if (state.feedback_ids.includes(feedback.feedback_id)) {
    fail(`feedback ${feedback.feedback_id} already exists`, 'FEEDBACK_EXISTS', state, feedback.candidate_id)
  }
  return validateEvolutionState({
    ...state,
    feedback_ids: [...state.feedback_ids, feedback.feedback_id],
    current_feedback_id: feedback.feedback_id,
  })
}

/** Add the profile's only open formal candidate. */
export function proposeCandidate(
  profileInput: TaskProfileInput | TaskProfile,
  stateInput: EvolutionState,
  manifestInput: CandidateManifestInput | CandidateManifest,
): EvolutionState {
  const profile = normalizeTaskProfile(profileInput)
  const state = validateEvolutionState(stateInput)
  assertProfileOwnsState(profile, state)
  const manifest = validateCandidateForProfile(profile, manifestInput)
  if (manifest.profile_id !== state.profile_id) {
    fail('candidate profile_id does not match EvolutionState', 'INVALID_CANDIDATE', state, manifest.candidate_id)
  }
  if (state.open_candidate_id !== null) {
    fail(`candidate ${state.open_candidate_id} is already open`, 'OPEN_CANDIDATE_EXISTS', state, manifest.candidate_id)
  }
  if (candidateIndex(state, manifest.candidate_id) >= 0) {
    fail(`candidate ${manifest.candidate_id} already exists`, 'INVALID_CANDIDATE', state, manifest.candidate_id)
  }
  if (manifest.parent_candidate_id !== state.active_candidate_id) {
    fail('candidate parent_candidate_id must be the current active candidate', 'INVALID_CANDIDATE', state, manifest.candidate_id)
  }
  if (manifest.generation !== state.generation + 1) {
    fail('candidate generation must be current generation plus one', 'INVALID_CANDIDATE', state, manifest.candidate_id)
  }
  return validateEvolutionState({
    ...state,
    open_candidate_id: manifest.candidate_id,
    candidates: [...state.candidates, {
      candidate_id: manifest.candidate_id,
      generation: manifest.generation,
      status: 'proposed' as const,
      parent_candidate_id: manifest.parent_candidate_id,
    }],
  })
}

/** Promote a successfully isolated candidate from proposed to validated. */
export function validateCandidate(stateInput: EvolutionState, candidateId: string): EvolutionState {
  const state = validateEvolutionState(stateInput)
  if (state.open_candidate_id !== candidateId) {
    fail(`candidate ${candidateId} is not the open candidate`, 'CANDIDATE_STATE', state, candidateId)
  }
  const candidate = requireCandidate(state, candidateId)
  if (candidate.status !== 'proposed') {
    fail(`candidate ${candidateId} must be proposed before validation`, 'CANDIDATE_STATE', state, candidateId)
  }
  return replaceCandidate(state, candidateId, value => ({ ...value, status: 'validated' }))
}

/** Reject a proposed candidate after technical validation fails. */
export function rejectCandidate(
  stateInput: EvolutionState,
  candidateId: string,
  evaluation?: EvaluationSummary,
): EvolutionState {
  const state = validateEvolutionState(stateInput)
  if (state.open_candidate_id !== candidateId) {
    fail(`candidate ${candidateId} is not the open candidate`, 'CANDIDATE_STATE', state, candidateId)
  }
  const candidate = requireCandidate(state, candidateId)
  if (candidate.status !== 'proposed' && candidate.status !== 'validated') {
    fail(`candidate ${candidateId} cannot be rejected from ${candidate.status}`, 'CANDIDATE_STATE', state, candidateId)
  }
  return replaceCandidate(state, candidateId, value => ({
    ...value,
    status: 'rejected',
    ...(evaluation === undefined ? {} : { evaluation }),
  }), { open_candidate_id: null })
}

/**
 * Compare a validated candidate with the current active candidate.
 * Incomplete, wrong-split, wrong-metric, tie, and regression reports fail closed.
 */
export function decideEvaluation(
  profileInput: TaskProfileInput | TaskProfile,
  stateInput: EvolutionState,
  reportInput: EvaluationReport,
): AcceptanceDecision {
  const profile = normalizeTaskProfile(profileInput)
  const state = validateEvolutionState(stateInput)
  assertProfileOwnsState(profile, state)
  const report = normalizeEvaluationReport(reportInput)
  const policy = profile.acceptance_policy
  if (report.profile_id !== state.profile_id) return decision(report.candidate_id, false, 'profile_mismatch', report)
  const candidate = state.candidates.find(value => value.candidate_id === report.candidate_id)
  if (candidate === undefined) return decision(report.candidate_id, false, 'candidate_not_found', report)
  if (candidate.status !== 'validated' || state.open_candidate_id !== candidate.candidate_id) {
    return decision(report.candidate_id, false, 'candidate_not_validated', report)
  }
  if (
    !report.complete
    || report.cases_evaluated === undefined
    || report.cases_expected === undefined
    || report.cases_expected <= 0
    || report.cases_evaluated !== report.cases_expected
  ) {
    return decision(candidate.candidate_id, false, 'report_incomplete', report)
  }
  if (report.split !== policy.split) return decision(candidate.candidate_id, false, 'wrong_split', report)
  if (report.metric !== policy.metric) return decision(candidate.candidate_id, false, 'wrong_metric', report)
  if (report.benchmark !== profile.benchmark) return decision(candidate.candidate_id, false, 'wrong_benchmark', report)

  const hasBaselineId = report.baseline_candidate_id !== undefined
  const hasBaselineScore = report.baseline_score !== undefined
  if (hasBaselineId !== hasBaselineScore) {
    return decision(candidate.candidate_id, false, 'baseline_fields_incomplete', report)
  }
  if (report.baseline_candidate_id !== undefined && report.baseline_candidate_id !== state.active_candidate_id) {
    return decision(candidate.candidate_id, false, 'baseline_candidate_mismatch', report)
  }

  const activeEvaluation = state.active_evaluation
  let baselineScore: number
  if (activeEvaluation === undefined) {
    if (report.baseline_score === undefined) {
      return decision(candidate.candidate_id, false, 'baseline_missing', report)
    }
    baselineScore = report.baseline_score
  } else {
    if (
      activeEvaluation.candidate_id !== state.active_candidate_id
      || activeEvaluation.benchmark !== profile.benchmark
      || activeEvaluation.split !== policy.split
      || activeEvaluation.metric !== policy.metric
    ) {
      return decision(candidate.candidate_id, false, 'baseline_missing', report)
    }
    baselineScore = activeEvaluation.score
    if (report.baseline_score !== undefined && report.baseline_score !== baselineScore) {
      return decision(candidate.candidate_id, false, 'baseline_score_mismatch', report, baselineScore)
    }
  }
  if (!(report.score > baselineScore)) {
    return decision(candidate.candidate_id, false, 'not_strictly_better', report, baselineScore)
  }
  return decision(candidate.candidate_id, true, 'accepted_strict_improvement', report, baselineScore)
}

/** Apply one already-decided evaluation to the state. */
function applyEvaluationDecision(
  stateInput: EvolutionState,
  reportInput: EvaluationReport,
  result: AcceptanceDecision,
): EvolutionState {
  const state = validateEvolutionState(stateInput)
  const report = normalizeEvaluationReport(reportInput)
  if (result.candidate_id !== report.candidate_id) {
    fail('decision candidate_id does not match EvaluationReport', 'INVALID_EVALUATION', state, report.candidate_id)
  }
  const candidate = requireCandidate(state, report.candidate_id)
  if (candidate.status !== 'validated' || state.open_candidate_id !== candidate.candidate_id) {
    fail(`candidate ${candidate.candidate_id} is not ready for an evaluation decision`, 'CANDIDATE_STATE', state, candidate.candidate_id)
  }
  const summary = reportSummary(report)
  if (!result.accepted) return rejectCandidate(state, candidate.candidate_id, summary)

  const previousActiveId = state.active_candidate_id
  const candidates = state.candidates.map((value): CandidateState => {
    if (value.candidate_id === previousActiveId) return Object.freeze({ ...value, status: 'retired' })
    if (value.candidate_id === candidate.candidate_id) {
      return Object.freeze({ ...value, status: 'accepted', evaluation: summary })
    }
    return value
  })
  return validateEvolutionState({
    ...state,
    generation: candidate.generation,
    active_candidate_id: candidate.candidate_id,
    open_candidate_id: null,
    candidates,
    active_evaluation: summary,
    current_feedback_id: null,
  })
}

/** Reject a B_dev winner whose runtime activation failed after the old active was restored. */
export function rejectRuntimeActivation(
  stateInput: EvolutionState,
  reportInput: EvaluationReport,
  acceptedDecision: AcceptanceDecision,
): { readonly state: EvolutionState; readonly decision: AcceptanceDecision } {
  const state = validateEvolutionState(stateInput)
  const report = normalizeEvaluationReport(reportInput)
  if (
    !acceptedDecision.accepted
    || acceptedDecision.reason !== 'accepted_strict_improvement'
    || acceptedDecision.candidate_id !== report.candidate_id
    || acceptedDecision.split !== report.split
    || acceptedDecision.metric !== report.metric
    || acceptedDecision.candidate_score !== report.score
    || acceptedDecision.baseline_score === undefined
    || !(report.score > acceptedDecision.baseline_score)
    || (report.baseline_score !== undefined && report.baseline_score !== acceptedDecision.baseline_score)
  ) {
    fail('runtime activation rejection requires the accepted decision for this report', 'INVALID_EVALUATION', state, report.candidate_id)
  }
  const rejectedDecision = decision(
    report.candidate_id,
    false,
    'runtime_activation_failed',
    report,
    acceptedDecision.baseline_score,
  )
  return Object.freeze({
    state: rejectCandidate(state, report.candidate_id, reportSummary(report)),
    decision: rejectedDecision,
  })
}

/** Compare and apply a complete report in one pure operation. */
export function recordEvaluation(
  profileInput: TaskProfileInput | TaskProfile,
  stateInput: EvolutionState,
  reportInput: EvaluationReport,
): { readonly state: EvolutionState; readonly decision: AcceptanceDecision } {
  const profile = normalizeTaskProfile(profileInput)
  const stateInputSnapshot = validateEvolutionState(stateInput)
  assertProfileOwnsState(profile, stateInputSnapshot)
  const report = normalizeEvaluationReport(reportInput)
  const candidate = stateInputSnapshot.candidates.find(value => value.candidate_id === report.candidate_id)
  if (
    report.profile_id !== stateInputSnapshot.profile_id
    || candidate === undefined
    || candidate.status !== 'validated'
    || stateInputSnapshot.open_candidate_id !== candidate.candidate_id
  ) {
    fail('EvaluationReport must target the validated open candidate', 'INVALID_EVALUATION', stateInputSnapshot, report.candidate_id)
  }
  const decisionResult = decideEvaluation(profile, stateInputSnapshot, report)
  const state = applyEvaluationDecision(stateInputSnapshot, report, decisionResult)
  return Object.freeze({ state, decision: decisionResult })
}

/** Restore any previously accepted or retired candidate without deleting history. */
export function rollbackCandidate(stateInput: EvolutionState, targetCandidateId: string): EvolutionState {
  const state = validateEvolutionState(stateInput)
  if (state.open_candidate_id !== null) {
    fail('cannot rollback while a formal candidate is open', 'OPEN_CANDIDATE_EXISTS', state, targetCandidateId)
  }
  const target = requireCandidate(state, targetCandidateId)
  if (target.status !== 'retired' && target.status !== 'accepted') {
    fail(`candidate ${targetCandidateId} is not an accepted history version`, 'CANDIDATE_STATE', state, targetCandidateId)
  }
  if (target.candidate_id === state.active_candidate_id) return state
  const candidates = state.candidates.map((candidate): CandidateState => {
    if (candidate.candidate_id === state.active_candidate_id) return Object.freeze({ ...candidate, status: 'retired' })
    if (candidate.candidate_id === target.candidate_id) return Object.freeze({ ...candidate, status: 'accepted' })
    return candidate
  })
  return validateEvolutionState({
    ...state,
    generation: target.generation,
    active_candidate_id: target.candidate_id,
    candidates,
    current_feedback_id: null,
    ...(target.evaluation === undefined ? { active_evaluation: undefined } : { active_evaluation: target.evaluation }),
  })
}

/** Validate a deserialized EvolutionState and return a detached immutable snapshot. */
export function validateEvolutionState(input: unknown): EvolutionState {
  if (!isJsonObject(input)) throw new EvolutionError('EvolutionState must be an object', 'STATE_CORRUPT')
  const allowed = new Set([
    'schema_version', 'profile_id', 'generation', 'active_candidate_id',
    'open_candidate_id', 'candidates', 'feedback_ids', 'current_feedback_id', 'active_evaluation',
  ])
  const extra = Object.keys(input).find(key => !allowed.has(key))
  if (extra !== undefined) throw new EvolutionError(`EvolutionState has unsupported field ${extra}`, 'STATE_CORRUPT')
  if (input.schema_version !== EVOLUTION_STATE_SCHEMA_VERSION) {
    throw new EvolutionError(`unsupported EvolutionState schema_version ${JSON.stringify(input.schema_version)}`, 'STATE_CORRUPT')
  }
  const profileId = requireStateId(input.profile_id, 'profile_id')
  const activeCandidateId = requireStateId(input.active_candidate_id, 'active_candidate_id')
  const generation = input.generation
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
    throw new EvolutionError('EvolutionState generation must be a non-negative safe integer', 'STATE_CORRUPT', { profile_id: profileId })
  }
  const openValue = input.open_candidate_id
  const openCandidateId = openValue === null ? null : requireStateId(openValue, 'open_candidate_id')
  if (!Array.isArray(input.feedback_ids)) {
    throw new EvolutionError('EvolutionState feedback_ids must be an array', 'STATE_CORRUPT', { profile_id: profileId })
  }
  const seenFeedbackIds = new Set<string>()
  const feedbackIds = input.feedback_ids.map((value, index) => {
    const feedbackId = requireStateId(value, `feedback_ids[${String(index)}]`)
    if (seenFeedbackIds.has(feedbackId)) {
      throw new EvolutionError(`duplicate feedback ${feedbackId}`, 'STATE_CORRUPT', { profile_id: profileId })
    }
    seenFeedbackIds.add(feedbackId)
    return feedbackId
  })
  const currentFeedbackValue = input.current_feedback_id
  const currentFeedbackId = currentFeedbackValue === null
    ? null
    : requireStateId(currentFeedbackValue, 'current_feedback_id')
  if (currentFeedbackId !== null && !seenFeedbackIds.has(currentFeedbackId)) {
    throw new EvolutionError('current_feedback_id must identify an entry in feedback_ids', 'STATE_CORRUPT', {
      profile_id: profileId,
    })
  }
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new EvolutionError('EvolutionState candidates must be a non-empty array', 'STATE_CORRUPT', { profile_id: profileId })
  }
  const seen = new Set<string>()
  const candidates = input.candidates.map((entry, index): CandidateState => {
    if (!isJsonObject(entry)) throw new EvolutionError(`candidates[${String(index)}] must be an object`, 'STATE_CORRUPT')
    const candidateAllowed = new Set(['candidate_id', 'generation', 'status', 'parent_candidate_id', 'evaluation'])
    const candidateExtra = Object.keys(entry).find(key => !candidateAllowed.has(key))
    if (candidateExtra !== undefined) {
      throw new EvolutionError(`candidates[${String(index)}] has unsupported field ${candidateExtra}`, 'STATE_CORRUPT')
    }
    const candidateId = requireStateId(entry.candidate_id, `candidates[${String(index)}].candidate_id`)
    if (seen.has(candidateId)) throw new EvolutionError(`duplicate candidate ${candidateId}`, 'STATE_CORRUPT')
    seen.add(candidateId)
    const candidateGeneration = entry.generation
    if (typeof candidateGeneration !== 'number' || !Number.isSafeInteger(candidateGeneration) || candidateGeneration < 0) {
      throw new EvolutionError(`candidate ${candidateId} generation must be non-negative`, 'STATE_CORRUPT')
    }
    if (typeof entry.status !== 'string' || !CANDIDATE_STATUSES.has(entry.status as CandidateStatus)) {
      throw new EvolutionError(`candidate ${candidateId} has invalid status`, 'STATE_CORRUPT')
    }
    const parentValue = entry.parent_candidate_id
    const parentCandidateId = parentValue === null ? null : requireStateId(parentValue, `candidate ${candidateId} parent_candidate_id`)
    const evaluation = entry.evaluation === undefined ? undefined : validateEvaluationSummary(entry.evaluation, candidateId)
    return Object.freeze({
      candidate_id: candidateId,
      generation: candidateGeneration,
      status: entry.status as CandidateStatus,
      parent_candidate_id: parentCandidateId,
      ...(evaluation === undefined ? {} : { evaluation }),
    })
  })
  const h0 = candidates.find(candidate => candidate.candidate_id === H0_CANDIDATE_ID)
  if (
    h0 === undefined
    || h0.generation !== 0
    || h0.parent_candidate_id !== null
    || (h0.status !== 'accepted' && h0.status !== 'retired')
  ) {
    throw new EvolutionError('EvolutionState must contain the H0 generation-0 root candidate', 'STATE_CORRUPT', {
      profile_id: profileId,
    })
  }
  for (const candidate of candidates) {
    if (candidate.candidate_id === H0_CANDIDATE_ID) continue
    if (candidate.generation < 1 || candidate.parent_candidate_id === null) {
      throw new EvolutionError(`candidate ${candidate.candidate_id} must have a parent and positive generation`, 'STATE_CORRUPT', {
        profile_id: profileId,
        candidate_id: candidate.candidate_id,
      })
    }
    const parent = candidates.find(value => value.candidate_id === candidate.parent_candidate_id)
    if (
      parent === undefined
      || (parent.status !== 'accepted' && parent.status !== 'retired')
      || candidate.generation !== parent.generation + 1
    ) {
      throw new EvolutionError(`candidate ${candidate.candidate_id} has an invalid parent generation`, 'STATE_CORRUPT', {
        profile_id: profileId,
        candidate_id: candidate.candidate_id,
      })
    }
    if (
      (candidate.status === 'accepted' || candidate.status === 'retired')
      && (candidate.evaluation === undefined || candidate.evaluation.split !== 'B_dev')
    ) {
      throw new EvolutionError(`accepted history candidate ${candidate.candidate_id} must have a B_dev evaluation`, 'STATE_CORRUPT', {
        profile_id: profileId,
        candidate_id: candidate.candidate_id,
      })
    }
    if (
      (candidate.status === 'proposed' || candidate.status === 'validated')
      && candidate.evaluation !== undefined
    ) {
      throw new EvolutionError(`open candidate ${candidate.candidate_id} cannot already have an evaluation`, 'STATE_CORRUPT', {
        profile_id: profileId,
        candidate_id: candidate.candidate_id,
      })
    }
  }
  const active = candidates.find(candidate => candidate.candidate_id === activeCandidateId)
  if (active === undefined || active.status !== 'accepted') {
    throw new EvolutionError('active_candidate_id must identify the single accepted candidate', 'STATE_CORRUPT', { profile_id: profileId })
  }
  if (candidates.filter(candidate => candidate.status === 'accepted').length !== 1) {
    throw new EvolutionError('EvolutionState must contain exactly one accepted candidate', 'STATE_CORRUPT', { profile_id: profileId })
  }
  if (openCandidateId === null) {
    if (candidates.some(candidate => candidate.status === 'proposed' || candidate.status === 'validated')) {
      throw new EvolutionError('open_candidate_id is missing for an open candidate', 'STATE_CORRUPT', { profile_id: profileId })
    }
  } else {
    const open = candidates.find(candidate => candidate.candidate_id === openCandidateId)
    if (open === undefined || (open.status !== 'proposed' && open.status !== 'validated')) {
      throw new EvolutionError('open_candidate_id must identify a proposed or validated candidate', 'STATE_CORRUPT', { profile_id: profileId })
    }
    if (candidates.filter(candidate => candidate.status === 'proposed' || candidate.status === 'validated').length !== 1) {
      throw new EvolutionError('EvolutionState must contain at most one open candidate', 'STATE_CORRUPT', { profile_id: profileId })
    }
    if (open.parent_candidate_id !== activeCandidateId || open.generation !== active.generation + 1) {
      throw new EvolutionError('open candidate must directly descend from the active candidate', 'STATE_CORRUPT', {
        profile_id: profileId,
      })
    }
  }
  const activeEvaluation = input.active_evaluation === undefined
    ? undefined
    : validateEvaluationSummary(input.active_evaluation, activeCandidateId)
  if (generation !== active.generation) {
    throw new EvolutionError('EvolutionState generation must equal the active candidate generation', 'STATE_CORRUPT', { profile_id: profileId })
  }
  if (!sameEvaluation(activeEvaluation, active.evaluation)) {
    throw new EvolutionError('active_evaluation must equal the active candidate evaluation', 'STATE_CORRUPT', {
      profile_id: profileId,
    })
  }
  return freezeState({
    schema_version: EVOLUTION_STATE_SCHEMA_VERSION,
    profile_id: profileId,
    generation,
    active_candidate_id: activeCandidateId,
    open_candidate_id: openCandidateId,
    candidates,
    feedback_ids: feedbackIds,
    current_feedback_id: currentFeedbackId,
    ...(activeEvaluation === undefined ? {} : { active_evaluation: activeEvaluation }),
  })
}

function requireStateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new EvolutionError(`${label} is not a valid id`, 'STATE_CORRUPT')
  }
  return value
}

function validateEvaluationSummary(input: unknown, candidateId: string): EvaluationSummary {
  if (!isJsonObject(input)) throw new EvolutionError('evaluation summary must be an object', 'STATE_CORRUPT')
  const allowed = new Set(['report_id', 'candidate_id', 'benchmark', 'split', 'metric', 'score'])
  const extra = Object.keys(input).find(key => !allowed.has(key))
  if (extra !== undefined) throw new EvolutionError(`evaluation summary has unsupported field ${extra}`, 'STATE_CORRUPT')
  const reportId = requireStateId(input.report_id, 'evaluation report_id')
  const summaryCandidateId = requireStateId(input.candidate_id, 'evaluation candidate_id')
  if (summaryCandidateId !== candidateId) throw new EvolutionError('evaluation summary candidate_id mismatch', 'STATE_CORRUPT')
  if (typeof input.benchmark !== 'string' || input.benchmark.trim().length === 0) {
    throw new EvolutionError('evaluation summary benchmark is invalid', 'STATE_CORRUPT')
  }
  if (input.split !== 'B_search' && input.split !== 'B_dev' && input.split !== 'B_test') {
    throw new EvolutionError('evaluation summary split is invalid', 'STATE_CORRUPT')
  }
  if (typeof input.metric !== 'string' || input.metric.length === 0) {
    throw new EvolutionError('evaluation summary metric is invalid', 'STATE_CORRUPT')
  }
  if (typeof input.score !== 'number' || !Number.isFinite(input.score)) {
    throw new EvolutionError('evaluation summary score is invalid', 'STATE_CORRUPT')
  }
  return Object.freeze({
    report_id: reportId,
    candidate_id: summaryCandidateId,
    benchmark: input.benchmark,
    split: input.split,
    metric: input.metric,
    score: input.score,
  })
}

function sameEvaluation(left: EvaluationSummary | undefined, right: EvaluationSummary | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.report_id === right.report_id
    && left.candidate_id === right.candidate_id
    && left.benchmark === right.benchmark
    && left.split === right.split
    && left.metric === right.metric
    && left.score === right.score
}

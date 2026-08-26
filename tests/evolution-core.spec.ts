import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_POLICY_SCHEMA_VERSION,
  CANDIDATE_MANIFEST_SCHEMA_VERSION,
  EVALUATION_REPORT_SCHEMA_VERSION,
  EVOLUTION_FEEDBACK_SCHEMA_VERSION,
  FileEvolutionStore,
  H0_CANDIDATE_ID,
  H0_PLUGIN_ID,
  MemoryEvolutionStore,
  createInitialEvolutionState,
  decideEvaluation,
  normalizeCandidateManifest,
  normalizeEvolutionFeedback,
  normalizeTaskProfile,
  proposeCandidate,
  recordEvaluation,
  recordEvolutionFeedback,
  rejectRuntimeActivation,
  rollbackCandidate,
  validateCandidate,
  validateCandidateForProfile,
  validateEvolutionState,
  type AcceptanceDecision,
  type CandidateManifest,
  type CandidatePackage,
  type EvaluationReport,
  type EvolutionFeedback,
  type EvolutionState,
  type EvolutionStore,
  type TaskProfile,
  type TaskProfileInput,
} from '../src/evolution/index.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function taskProfile(overrides: Partial<TaskProfileInput> = {}): TaskProfile {
  return normalizeTaskProfile({
    id: 'bfcl',
    benchmark: 'bfcl-v3',
    acceptance_policy: {
      schema_version: ACCEPTANCE_POLICY_SCHEMA_VERSION,
      metric: 'accuracy',
    },
    ...overrides,
  })
}

function manifest(
  profile: TaskProfile,
  state: EvolutionState,
  candidateId = `candidate-${String(state.generation + 1)}`,
  overrides: Partial<CandidateManifest> = {},
): CandidateManifest {
  return normalizeCandidateManifest({
    schema_version: CANDIDATE_MANIFEST_SCHEMA_VERSION,
    candidate_id: candidateId,
    profile_id: profile.id,
    generation: state.generation + 1,
    parent_candidate_id: state.active_candidate_id,
    strategy_version: `strategy-${String(state.generation + 1)}`,
    capabilities: ['data-select'],
    ...overrides,
  })
}

function feedback(
  profile: TaskProfile,
  state: EvolutionState,
  feedbackId = `feedback-${String(state.feedback_ids.length + 1)}`,
): EvolutionFeedback {
  return normalizeEvolutionFeedback({
    schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
    feedback_id: feedbackId,
    profile_id: profile.id,
    candidate_id: state.active_candidate_id,
    benchmark: profile.benchmark,
    split: 'B_search',
    summary: 'The active strategy missed one tool-call pattern.',
    failures: [{ case_id: 'case-1', summary: 'Selected an irrelevant record.' }],
    metrics: { accuracy: 0.5 },
    artifact_path: '/data/codex-work/autodata/feedback.json',
  })
}

function candidatePackage(candidateManifest: CandidateManifest): CandidatePackage {
  return Object.freeze({
    manifest: candidateManifest,
    host_source: 'return { inject: ["autodata"], apply() {} }',
  })
}

function validatedCandidate(
  profile: TaskProfile,
  state = createInitialEvolutionState(profile),
  candidateId?: string,
): { readonly state: EvolutionState; readonly manifest: CandidateManifest } {
  const candidateManifest = manifest(profile, state, candidateId)
  const proposed = proposeCandidate(profile, state, candidateManifest)
  return Object.freeze({
    state: validateCandidate(proposed, candidateManifest.candidate_id),
    manifest: candidateManifest,
  })
}

function evaluationReport(
  profile: TaskProfile,
  state: EvolutionState,
  candidateId: string,
  overrides: Partial<EvaluationReport> = {},
  includeBaseline = true,
): EvaluationReport {
  return {
    schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
    report_id: `report-${candidateId}`,
    profile_id: profile.id,
    candidate_id: candidateId,
    benchmark: profile.benchmark,
    split: 'B_dev',
    metric: profile.acceptance_policy.metric,
    score: 0.6,
    complete: true,
    cases_evaluated: 10,
    cases_expected: 10,
    ...(includeBaseline ? {
      baseline_candidate_id: state.active_candidate_id,
      baseline_score: state.active_evaluation?.score ?? 0.5,
    } : {}),
    ...overrides,
  }
}

function persistCandidate(store: EvolutionStore, profile: TaskProfile, state: EvolutionState, candidateId = 'candidate-1') {
  const candidateManifest = manifest(profile, state, candidateId)
  const proposed = proposeCandidate(profile, state, candidateManifest)
  store.saveCandidate(candidatePackage(candidateManifest))
  store.saveState(proposed)
  return { manifest: candidateManifest, state: proposed }
}

describe('Stage 3 profile and candidate contracts', () => {
  it('uses a profile-owned strategy id and reserves the built-in H0 identity', () => {
    expect(taskProfile().strategy_plugin_id).toBe('bfcl-strategy')
    expect(() => normalizeTaskProfile({ id: 'missing-benchmark' } as unknown as TaskProfileInput)).toThrow(/benchmark/)
    expect(() => taskProfile({ strategy_plugin_id: H0_PLUGIN_ID })).toThrow(/reserved/)
    expect(() => taskProfile({ capabilities: ['replace-controller'] as never })).toThrow(/Stage 3/)
  })

  it('requires a strategy version and enforces the profile capability subset', () => {
    const profile = taskProfile({ capabilities: ['data-select'] })
    const state = createInitialEvolutionState(profile)
    const candidate = manifest(profile, state)
    expect(validateCandidateForProfile(profile, candidate)).toEqual(candidate)
    expect(() => normalizeCandidateManifest({
      ...candidate,
      strategy_version: undefined,
    } as unknown as CandidateManifest)).toThrow(/strategy_version/)
    expect(() => validateCandidateForProfile(profile, {
      ...candidate,
      capabilities: ['data-filter'],
    })).toThrow(/not enabled/)
  })
})

describe('Stage 3 state and strict B_dev decisions', () => {
  it('accepts a strict improvement and can roll back to the source-less H0 baseline', () => {
    const profile = taskProfile()
    const initial = createInitialEvolutionState(profile)
    const h0Feedback = feedback(profile, initial, 'feedback-h0')
    const withFeedback = recordEvolutionFeedback(initial, h0Feedback)
    const validated = validatedCandidate(profile, withFeedback)
    const report = evaluationReport(profile, validated.state, validated.manifest.candidate_id)
    const accepted = recordEvaluation(profile, validated.state, report)

    expect(accepted.decision).toMatchObject({
      accepted: true,
      reason: 'accepted_strict_improvement',
      baseline_score: 0.5,
    })
    expect(accepted.state.active_candidate_id).toBe(validated.manifest.candidate_id)
    expect(accepted.state.active_evaluation).toMatchObject({ benchmark: profile.benchmark, score: 0.6 })
    expect(accepted.state.feedback_ids).toEqual(['feedback-h0'])
    expect(accepted.state.current_feedback_id).toBeNull()

    const candidateFeedback = feedback(profile, accepted.state, 'feedback-candidate')
    const withCandidateFeedback = recordEvolutionFeedback(accepted.state, candidateFeedback)
    const rolledBack = rollbackCandidate(withCandidateFeedback, H0_CANDIDATE_ID)
    expect(rolledBack.active_candidate_id).toBe(H0_CANDIDATE_ID)
    expect(rolledBack.active_evaluation).toBeUndefined()
    expect(rolledBack.feedback_ids).toEqual(['feedback-h0', 'feedback-candidate'])
    expect(rolledBack.current_feedback_id).toBeNull()
    expect(rolledBack.candidates.find(value => value.candidate_id === validated.manifest.candidate_id)?.status)
      .toBe('retired')
  })

  it('rejects a B_dev winner after runtime activation fails without changing active state', () => {
    const profile = taskProfile()
    const initial = createInitialEvolutionState(profile)
    const currentFeedback = feedback(profile, initial)
    const withFeedback = recordEvolutionFeedback(initial, currentFeedback)
    const validated = validatedCandidate(profile, withFeedback)
    const report = evaluationReport(profile, validated.state, validated.manifest.candidate_id)
    const acceptedDecision = decideEvaluation(profile, validated.state, report)
    const rejected = rejectRuntimeActivation(validated.state, report, acceptedDecision)

    expect(rejected.decision).toMatchObject({ accepted: false, reason: 'runtime_activation_failed' })
    expect(rejected.state.active_candidate_id).toBe(H0_CANDIDATE_ID)
    expect(rejected.state.open_candidate_id).toBeNull()
    expect(rejected.state.current_feedback_id).toBe(currentFeedback.feedback_id)
    expect(rejected.state.candidates.find(value => value.candidate_id === report.candidate_id)).toMatchObject({
      status: 'rejected',
      evaluation: { report_id: report.report_id },
    })
  })

  it.each([
    [{ complete: false }, 'report_incomplete'],
    [{ cases_evaluated: 0, cases_expected: 0 }, 'report_incomplete'],
    [{ cases_evaluated: 9, cases_expected: 10 }, 'report_incomplete'],
    [{ split: 'B_test' }, 'wrong_split'],
    [{ metric: 'other' }, 'wrong_metric'],
    [{ benchmark: 'other-benchmark' }, 'wrong_benchmark'],
    [{ baseline_candidate_id: undefined }, 'baseline_fields_incomplete'],
    [{ baseline_candidate_id: 'old-active' }, 'baseline_candidate_mismatch'],
    [{ score: 0.5 }, 'not_strictly_better'],
  ] as const)('rejects an invalid formal report with %s', (overrides, reason) => {
    const profile = taskProfile()
    const validated = validatedCandidate(profile)
    const report = evaluationReport(
      profile,
      validated.state,
      validated.manifest.candidate_id,
      overrides as Partial<EvaluationReport>,
    )
    expect(decideEvaluation(profile, validated.state, report)).toMatchObject({ accepted: false, reason })
  })

  it('uses the persisted active evaluation and rejects a conflicting reported baseline score', () => {
    const profile = taskProfile()
    const first = validatedCandidate(profile)
    const firstAccepted = recordEvaluation(
      profile,
      first.state,
      evaluationReport(profile, first.state, first.manifest.candidate_id),
    ).state
    const second = validatedCandidate(profile, firstAccepted, 'candidate-2')

    const withoutRepeatedBaseline = evaluationReport(
      profile,
      second.state,
      second.manifest.candidate_id,
      { score: 0.7 },
      false,
    )
    expect(decideEvaluation(profile, second.state, withoutRepeatedBaseline)).toMatchObject({
      accepted: true,
      baseline_score: 0.6,
    })

    const conflictingBaseline = evaluationReport(profile, second.state, second.manifest.candidate_id, {
      score: 0.7,
      baseline_candidate_id: first.manifest.candidate_id,
      baseline_score: 0.59,
    })
    expect(decideEvaluation(profile, second.state, conflictingBaseline)).toMatchObject({
      accepted: false,
      reason: 'baseline_score_mismatch',
      baseline_score: 0.6,
    })
  })

  it('rejects corrupt H0 roots, lineage, open-parent, and active evaluation snapshots', () => {
    const profile = taskProfile()
    const initial = createInitialEvolutionState(profile)
    expect(() => validateEvolutionState({ ...initial, candidates: [] })).toThrow(/H0|non-empty/)

    const proposed = proposeCandidate(profile, initial, manifest(profile, initial))
    const badLineage = structuredClone(proposed) as unknown as { candidates: Array<Record<string, unknown>> }
    badLineage.candidates[1]!.generation = 3
    expect(() => validateEvolutionState(badLineage)).toThrow(/parent generation/)

    const accepted = recordEvaluation(
      profile,
      validateCandidate(proposed, 'candidate-1'),
      evaluationReport(profile, validateCandidate(proposed, 'candidate-1'), 'candidate-1'),
    ).state
    const mismatchedEvaluation = structuredClone(accepted) as unknown as { active_evaluation: { score: number } }
    mismatchedEvaluation.active_evaluation.score = 0.1
    expect(() => validateEvolutionState(mismatchedEvaluation)).toThrow(/active_evaluation/)

    const nextManifest = manifest(profile, accepted, 'candidate-2')
    const next = proposeCandidate(profile, accepted, nextManifest)
    const badOpenParent = structuredClone(next) as unknown as { candidates: Array<Record<string, unknown>> }
    badOpenParent.candidates[2]!.parent_candidate_id = H0_CANDIDATE_ID
    expect(() => validateEvolutionState(badOpenParent)).toThrow(/parent generation|directly descend/)

    expect(() => validateEvolutionState({
      ...initial,
      feedback_ids: ['feedback-1', 'feedback-1'],
    })).toThrow(/duplicate feedback/)
    expect(() => validateEvolutionState({
      ...initial,
      current_feedback_id: 'feedback-missing',
    })).toThrow(/current_feedback_id/)
  })
})

describe('Stage 3 persistence consistency', () => {
  it('loads only state references, reserves orphan ids, and rejects missing records in memory', () => {
    const profile = taskProfile()

    const missingSourceStore = new MemoryEvolutionStore()
    const missingState = missingSourceStore.createProfile(profile)
    const missingManifest = manifest(profile, missingState)
    missingSourceStore.saveState(proposeCandidate(profile, missingState, missingManifest))
    expect(() => missingSourceStore.loadConsistentSnapshot(profile.id)).toThrow(/no persisted host source/)

    const orphanStore = new MemoryEvolutionStore()
    const orphanState = orphanStore.createProfile(profile)
    const orphanCandidate = candidatePackage(manifest(profile, orphanState))
    orphanStore.saveCandidate(orphanCandidate)
    expect(orphanStore.loadConsistentSnapshot(profile.id).candidate_packages).toEqual([])
    expect(() => orphanStore.saveCandidate(orphanCandidate)).toThrow(/already exists/)

    const orphanFeedback = feedback(profile, orphanState)
    orphanStore.saveFeedback(orphanFeedback)
    expect(orphanStore.loadConsistentSnapshot(profile.id).feedback_records).toEqual([])
    expect(() => orphanStore.saveFeedback(orphanFeedback)).toThrow(/already exists/)
    orphanStore.saveState(recordEvolutionFeedback(orphanState, orphanFeedback))
    expect(orphanStore.loadConsistentSnapshot(profile.id).feedback_records).toEqual([orphanFeedback])

    const missingFeedbackStore = new MemoryEvolutionStore()
    const feedbackState = missingFeedbackStore.createProfile(profile)
    missingFeedbackStore.saveState(recordEvolutionFeedback(feedbackState, feedback(profile, feedbackState)))
    expect(() => missingFeedbackStore.loadConsistentSnapshot(profile.id)).toThrow(/feedback.*missing/)

    const clientStore = new MemoryEvolutionStore()
    clientStore.createProfile(profile)
    expect(() => clientStore.saveCandidate({
      ...candidatePackage(manifest(profile, createInitialEvolutionState(profile))),
      client_source: 'forbidden',
    } as unknown as CandidatePackage)).toThrow(/client_source|unsupported field/)
  })

  it('returns a cross-checked snapshot and prevents strategy ids shared by profiles', () => {
    const store = new MemoryEvolutionStore()
    const profile = taskProfile()
    const state = store.createProfile(profile)
    persistCandidate(store, profile, state)
    expect(store.loadConsistentSnapshot(profile.id).candidate_packages.map(value => value.manifest.candidate_id))
      .toEqual(['candidate-1'])
    expect(() => store.createProfile(taskProfile({ id: 'other', strategy_plugin_id: profile.strategy_plugin_id })))
      .toThrow(/already used/)
  })

  it('rejects duplicate report ids and incoherent accepted decisions in both Stores', () => {
    const profile = taskProfile()
    const memory = new MemoryEvolutionStore()
    const initial = memory.createProfile(profile)
    const persisted = persistCandidate(memory, profile, initial)
    const validated = validateCandidate(persisted.state, persisted.manifest.candidate_id)
    memory.saveState(validated)
    const report = evaluationReport(profile, validated, persisted.manifest.candidate_id, { run_id: 'run-one' })
    const decision = decideEvaluation(profile, validated, report)
    memory.saveEvaluation(profile.id, { report, decision })
    expect(() => memory.saveEvaluation(profile.id, {
      report: { ...report, run_id: 'run-two' },
      decision,
    })).toThrow(/already exists/)

    const forgedDecision: AcceptanceDecision = {
      ...decision,
      accepted: true,
      reason: 'accepted_strict_improvement',
      baseline_score: report.score,
    }
    expect(() => memory.saveEvaluation(profile.id, {
      report: { ...report, report_id: 'forged-report', run_id: 'forged-run' },
      decision: forgedDecision,
    })).toThrow(/strict complete B_dev improvement/)

    const directory = mkdtempSync(join(tmpdir(), 'autodata-evolution-'))
    temporaryDirectories.push(directory)
    const files = new FileEvolutionStore(directory)
    files.createProfile(profile)
    files.saveEvaluation(profile.id, { report, decision })
    expect(() => files.saveEvaluation(profile.id, {
      report: { ...report, run_id: 'run-two' },
      decision,
    })).toThrow(/already exists/)
  })

  it('uses state.json as the only pointer and ignores file orphans without reusing ids', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autodata-evolution-'))
    temporaryDirectories.push(directory)
    const store = new FileEvolutionStore(directory)
    const profile = taskProfile()
    const state = store.createProfile(profile)
    expect(existsSync(join(directory, 'profiles', profile.id, 'active.json'))).toBe(false)

    const orphanCandidate = candidatePackage(manifest(profile, state))
    store.saveCandidate(orphanCandidate)
    const orphanFeedback = feedback(profile, state, 'feedback-orphan')
    store.saveFeedback(orphanFeedback)
    expect(store.loadConsistentSnapshot(profile.id)).toMatchObject({
      candidate_packages: [],
      feedback_records: [],
    })
    expect(() => store.saveCandidate(orphanCandidate)).toThrow(/already exists/)
    expect(() => store.saveFeedback(orphanFeedback)).toThrow(/already exists/)

    writeFileSync(
      join(directory, 'profiles', profile.id, 'feedback', 'broken-orphan.json'),
      '{ not json',
      'utf8',
    )
    expect(store.loadConsistentSnapshot(profile.id).feedback_records).toEqual([])
  })

  it('fails clearly when state.json references missing or corrupt file records', () => {
    const profile = taskProfile()

    const missingDirectory = mkdtempSync(join(tmpdir(), 'autodata-evolution-'))
    temporaryDirectories.push(missingDirectory)
    const missingStore = new FileEvolutionStore(missingDirectory)
    const missingState = missingStore.createProfile(profile)
    const missingFeedback = feedback(profile, missingState)
    missingStore.saveState(recordEvolutionFeedback(missingState, missingFeedback))
    expect(() => missingStore.loadConsistentSnapshot(profile.id)).toThrow(/feedback.*missing/)

    const candidateDirectory = mkdtempSync(join(tmpdir(), 'autodata-evolution-'))
    temporaryDirectories.push(candidateDirectory)
    const candidateStore = new FileEvolutionStore(candidateDirectory)
    const candidateState = candidateStore.createProfile(profile)
    const persisted = persistCandidate(candidateStore, profile, candidateState)
    writeFileSync(
      join(
        candidateDirectory,
        'profiles',
        profile.id,
        'candidates',
        persisted.manifest.candidate_id,
        'manifest.json',
      ),
      '{ broken',
      'utf8',
    )
    expect(() => candidateStore.loadConsistentSnapshot(profile.id)).toThrow(/manifest.*corrupt/)

    const corruptDirectory = mkdtempSync(join(tmpdir(), 'autodata-evolution-'))
    temporaryDirectories.push(corruptDirectory)
    const corruptStore = new FileEvolutionStore(corruptDirectory)
    const corruptState = corruptStore.createProfile(profile)
    const corruptFeedback = feedback(profile, corruptState)
    corruptStore.saveFeedback(corruptFeedback)
    corruptStore.saveState(recordEvolutionFeedback(corruptState, corruptFeedback))
    writeFileSync(
      join(corruptDirectory, 'profiles', profile.id, 'feedback', `${corruptFeedback.feedback_id}.json`),
      '{ broken',
      'utf8',
    )
    expect(() => corruptStore.loadConsistentSnapshot(profile.id)).toThrow(/feedback.*corrupt/)

    rmSync(join(corruptDirectory, 'profiles', profile.id, 'state.json'))
    expect(() => corruptStore.loadConsistentSnapshot(profile.id)).toThrow(/no state\.json/)
  })
})

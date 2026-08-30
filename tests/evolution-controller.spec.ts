import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CANDIDATE_MANIFEST_SCHEMA_VERSION,
  EVALUATION_REPORT_SCHEMA_VERSION,
  EVOLUTION_FEEDBACK_SCHEMA_VERSION,
  CandidateActivationError,
  EvolutionController,
  EvolutionError,
  FileEvolutionStore,
  MemoryEvolutionStore,
  type CandidatePackage,
  type CandidateValidationResult,
  type CandidateValidator,
  type EvolutionRuntime,
  type EvolutionRuntimeAgent,
  type EvolutionStore,
  type RuntimeActivation,
  type TaskProfile,
} from '../src/evolution/index.js'

const agent = { id: 'controller-test-agent' } as EvolutionRuntimeAgent
const hostSource = 'return { inject: ["autodata"], apply() {} }'

class FixedValidator implements CandidateValidator {
  unavailable = false
  hook: (() => Promise<void>) | undefined

  constructor(private readonly ok: boolean) {}

  async validate(profile: TaskProfile, candidate: CandidatePackage): Promise<CandidateValidationResult> {
    if (this.unavailable) throw new EvolutionError('validator unavailable', 'VALIDATION_UNAVAILABLE')
    await this.hook?.()
    return {
      schema_version: 'autodata-candidate-validation-1',
      candidate_id: candidate.manifest.candidate_id,
      ok: this.ok,
      ...(this.ok ? {
        plugin_id: profile.strategy_plugin_id,
        plugin_version: candidate.manifest.strategy_version,
      } : { reason: 'fixture rejected the candidate' }),
    }
  }
}

class FakeRuntime implements EvolutionRuntime {
  readonly ensured: Array<string | null> = []
  readonly activated: string[] = []
  readonly rolledBack: string[] = []
  failActivation: 'candidate' | 'ambiguous' | 'unavailable' | 'degraded' | null = null
  activateHook: (() => Promise<void>) | undefined
  ensureHook: (() => Promise<void>) | undefined
  disposed = false

  async ensureActive(_profile: TaskProfile, candidate: CandidatePackage | null): Promise<void> {
    this.ensured.push(candidate?.manifest.candidate_id ?? null)
    await this.ensureHook?.()
  }

  async activate(
    _profile: TaskProfile,
    _current: CandidatePackage | null,
    candidate: CandidatePackage,
  ): Promise<RuntimeActivation> {
    await this.activateHook?.()
    if (this.failActivation !== null) {
      if (this.failActivation === 'candidate') throw new CandidateActivationError('activation failed')
      if (this.failActivation === 'ambiguous') throw new EvolutionError('activation failed', 'RUNTIME_FAILED')
      throw new EvolutionError(
        'activation failed',
        this.failActivation === 'unavailable' ? 'RUNTIME_UNAVAILABLE' : 'RUNTIME_DEGRADED',
      )
    }
    this.activated.push(candidate.manifest.candidate_id)
    return {
      rollback: async () => { this.rolledBack.push(candidate.manifest.candidate_id) },
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

class FailEvaluationCommitStore extends MemoryEvolutionStore {
  failNextEvaluationCommit = false

  override saveState(state: Parameters<MemoryEvolutionStore['saveState']>[0]): void {
    if (
      this.failNextEvaluationCommit
      && state.candidates.some(candidate => candidate.evaluation !== undefined)
    ) {
      this.failNextEvaluationCommit = false
      throw new EvolutionError('simulated state commit failure', 'STORE_IO')
    }
    super.saveState(state)
  }
}

class FailCandidateCommitStore extends MemoryEvolutionStore {
  failNextCandidateCommit = false

  override saveState(state: Parameters<MemoryEvolutionStore['saveState']>[0]): void {
    if (this.failNextCandidateCommit && state.open_candidate_id !== null) {
      this.failNextCandidateCommit = false
      throw new EvolutionError('simulated candidate state commit failure', 'STORE_IO')
    }
    super.saveState(state)
  }
}

class FailFeedbackCommitStore extends MemoryEvolutionStore {
  failNextFeedbackCommit = false

  override saveState(state: Parameters<MemoryEvolutionStore['saveState']>[0]): void {
    if (this.failNextFeedbackCommit && state.feedback_ids.length > 0) {
      this.failNextFeedbackCommit = false
      throw new EvolutionError('simulated feedback state commit failure', 'STORE_IO')
    }
    super.saveState(state)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function setupController<T extends CandidateValidator>(
  validator: T,
  store: EvolutionStore = new MemoryEvolutionStore(),
  runtime = new FakeRuntime(),
  registerBaseline = true,
) {
  const controller = new EvolutionController({
    store,
    validator,
    runtime,
  })
  controller.createProfile({
    id: 'bfcl',
    benchmark: 'bfcl-v3',
    capabilities: ['data-select', 'data-filter', 'data-order'],
    acceptance: { metric: 'accuracy' },
  })
  if (registerBaseline) controller.registerBaseline(baselineReport())
  return { controller, runtime, validator }
}

function createController(ok = true, store: EvolutionStore = new MemoryEvolutionStore(), registerBaseline = true) {
  return setupController(new FixedValidator(ok), store, new FakeRuntime(), registerBaseline)
}

function submit(controller: EvolutionController, candidateId: string, version: string) {
  return controller.submitCandidate('bfcl', {
    candidate_id: candidateId,
    strategy_version: version,
    host_source: hostSource,
  })
}

function report(candidateId: string, baselineId: string, baselineScore: number, score: number) {
  return {
    schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
    report_id: `report-${candidateId}`,
    profile_id: 'bfcl',
    candidate_id: candidateId,
    benchmark: 'bfcl-v3',
    split: 'B_dev' as const,
    metric: 'accuracy',
    score,
    complete: true,
    cases_evaluated: 10,
    cases_expected: 10,
    baseline_candidate_id: baselineId,
    baseline_score: baselineScore,
  }
}

function baselineReport(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
    report_id: 'report-h0',
    profile_id: 'bfcl',
    candidate_id: 'h0',
    benchmark: 'bfcl-v3',
    split: 'B_dev' as const,
    metric: 'accuracy',
    score: 0.5,
    complete: true,
    cases_evaluated: 10,
    cases_expected: 10,
    ...overrides,
  }
}

describe('EvolutionController', () => {
  it('registers H0 without runtime activation and blocks proposals until it is durable', () => {
    const { controller, runtime } = createController(true, new MemoryEvolutionStore(), false)
    expect(() => submit(controller, 'candidate-one', '1')).toThrow(/registered baseline/iu)

    const outcome = controller.registerBaseline(baselineReport())
    expect(outcome.status.state.active_evaluation).toMatchObject({ candidate_id: 'h0', score: 0.5 })
    expect(controller.store.getEvaluation('bfcl', 'report-h0')).toEqual({ report: baselineReport() })
    expect(runtime.activated).toEqual([])
    expect(runtime.ensured).toEqual([])
    expect(() => submit(controller, 'candidate-one', '1')).not.toThrow()
  })

  it('replays an H0 record left before state commit and rejects conflicting replays', () => {
    const store = new FailEvaluationCommitStore()
    const { controller } = createController(true, store, false)
    const baseline = baselineReport()
    store.failNextEvaluationCommit = true

    expect(() => controller.registerBaseline(baseline)).toThrow(/simulated state commit failure/)
    expect(store.getEvaluation('bfcl', 'report-h0')).toEqual({ report: baseline })
    expect(controller.status('bfcl').state.active_evaluation).toBeUndefined()

    const restarted = new EvolutionController({
      store,
      validator: new FixedValidator(true),
      runtime: new FakeRuntime(),
    })
    const replayed = restarted.registerBaseline(baseline)
    expect(replayed.status.state.active_evaluation).toMatchObject({ report_id: 'report-h0', score: 0.5 })
    expect(restarted.registerBaseline(baseline).status.state).toEqual(replayed.status.state)
    expect(() => restarted.registerBaseline(baselineReport({ score: 0.4 }))).toThrow(/conflicts|already registered/iu)
  })

  it.each([
    { complete: false },
    { cases_evaluated: 9 },
    { cases_evaluated: 0, cases_expected: 0 },
    { split: 'B_test' },
    { metric: 'other' },
    { benchmark: 'other' },
    { baseline_candidate_id: 'h0', baseline_score: 0.5 },
  ])('rejects invalid H0 baseline report %s', (overrides) => {
    const { controller } = createController(true, new MemoryEvolutionStore(), false)
    expect(() => controller.registerBaseline(baselineReport(overrides))).toThrow()
  })

  it('creates H0, records Host feedback, and reads the current record', () => {
    const { controller } = createController()
    const status = controller.status('bfcl')
    expect(status.profile.strategy_plugin_id).toBe('bfcl-strategy')
    expect(status.state).toMatchObject({
      generation: 0,
      active_candidate_id: 'h0',
      open_candidate_id: null,
      current_feedback_id: null,
    })

    const feedback = controller.recordFeedback({
      schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
      feedback_id: 'feedback-h0',
      profile_id: 'bfcl',
      candidate_id: 'h0',
      benchmark: 'bfcl-v3',
      split: 'B_search',
      summary: 'One fixed failure.',
      failures: [{ case_id: 'case-one', summary: 'Wrong selection.' }],
    })
    expect(controller.feedback('bfcl')).toEqual(feedback)
    expect(controller.feedback('bfcl', 'feedback-h0')).toEqual(feedback)
  })

  it('idempotently attaches an identical orphan feedback after a state-write crash', () => {
    const store = new FailFeedbackCommitStore()
    const { controller } = createController(true, store)
    const feedback = {
      schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
      feedback_id: 'feedback-orphan',
      profile_id: 'bfcl',
      candidate_id: 'h0',
      benchmark: 'bfcl-v3',
      split: 'B_search' as const,
      summary: 'Durable feedback awaiting its state reference.',
      failures: [{ case_id: 'case-one', summary: 'Wrong selection.' }],
    }
    store.failNextFeedbackCommit = true

    expect(() => controller.recordFeedback(feedback)).toThrow(/feedback state commit failure/iu)
    expect(store.getFeedback('bfcl', feedback.feedback_id)).toEqual(feedback)
    expect(controller.status('bfcl').state).toMatchObject({
      feedback_ids: [],
      current_feedback_id: null,
    })
    expect(() => controller.recordFeedback({ ...feedback, summary: 'conflicting replay' }))
      .toThrowError(expect.objectContaining({ code: 'FEEDBACK_EXISTS' }))

    expect(controller.recordFeedback(feedback)).toEqual(feedback)
    expect(controller.status('bfcl').state).toMatchObject({
      feedback_ids: [feedback.feedback_id],
      current_feedback_id: feedback.feedback_id,
    })
    expect(controller.feedback('bfcl')).toEqual(feedback)
    expect(controller.recordFeedback(feedback)).toEqual(feedback)
    expect(controller.status('bfcl').state.feedback_ids).toEqual([feedback.feedback_id])
  })

  it('submits, validates, strictly accepts, rejects a tie, and rolls back H0', async () => {
    const { controller, runtime } = createController()
    const proposed = submit(controller, 'candidate-one', '1')
    expect(proposed.state.open_candidate_id).toBe('candidate-one')
    expect(proposed.candidates[0]).not.toHaveProperty('package')

    const validated = await controller.validateCandidate('bfcl', 'candidate-one')
    expect(validated.validation.ok).toBe(true)
    expect(validated.status.state.candidates).toContainEqual(expect.objectContaining({
      candidate_id: 'candidate-one',
      status: 'validated',
    }))

    const accepted = await controller.recordEvaluation(report('candidate-one', 'h0', 0.5, 0.6), agent)
    expect(accepted.decision).toMatchObject({ accepted: true, reason: 'accepted_strict_improvement' })
    expect(accepted.status.state.active_candidate_id).toBe('candidate-one')
    expect(runtime.activated).toEqual(['candidate-one'])

    submit(controller, 'candidate-two', '2')
    await controller.validateCandidate('bfcl', 'candidate-two')
    const tied = await controller.recordEvaluation(report('candidate-two', 'candidate-one', 0.6, 0.6), agent)
    expect(tied.decision).toMatchObject({ accepted: false, reason: 'not_strictly_better' })
    expect(tied.status.state.active_candidate_id).toBe('candidate-one')
    expect(tied.status.state.open_candidate_id).toBeNull()
    expect(runtime.activated).toEqual(['candidate-one'])

    const rolledBack = await controller.rollback('bfcl', 'h0', agent)
    expect(rolledBack.state.active_candidate_id).toBe('h0')
    expect(runtime.ensured).toEqual([null])
  })

  it('idempotently abandons an unevaluated open candidate', async () => {
    const { controller } = createController()
    submit(controller, 'candidate-abandoned', '1')
    await controller.validateCandidate('bfcl', 'candidate-abandoned')

    const abandoned = controller.abandonCandidate('bfcl', 'candidate-abandoned')
    expect(abandoned.state).toMatchObject({ active_candidate_id: 'h0', open_candidate_id: null })
    expect(abandoned.state.candidates).toContainEqual(expect.objectContaining({
      candidate_id: 'candidate-abandoned',
      status: 'rejected',
    }))
    expect(controller.abandonCandidate('bfcl', 'candidate-abandoned').state).toEqual(abandoned.state)
  })

  it('submits and validates in one call while closing a technical failure', async () => {
    const accepted = createController(true)
    const ok = await accepted.controller.submitAndValidateCandidate('bfcl', {
      candidate_id: 'candidate-good', strategy_version: '1', host_source: hostSource,
    })
    expect(ok.validation.ok).toBe(true)
    expect(ok.status.state.open_candidate_id).toBe('candidate-good')

    const rejected = createController(false)
    const failed = await rejected.controller.submitAndValidateCandidate('bfcl', {
      candidate_id: 'candidate-bad', strategy_version: '1', host_source: hostSource,
    })
    expect(failed.validation).toMatchObject({ ok: false, reason: 'fixture rejected the candidate' })
    expect(failed.status.state).toMatchObject({ active_candidate_id: 'h0', open_candidate_id: null })
  })

  it('idempotently commits an identical orphan candidate after a state-write crash', () => {
    const store = new FailCandidateCommitStore()
    const { controller } = createController(true, store)
    store.failNextCandidateCommit = true

    expect(() => submit(controller, 'candidate-orphan', '1')).toThrow(/state commit failure/iu)
    expect(store.getCandidate('bfcl', 'candidate-orphan')).toBeDefined()
    expect(controller.status('bfcl').state.candidates).not.toContainEqual(expect.objectContaining({
      candidate_id: 'candidate-orphan',
    }))

    expect(() => submit(controller, 'candidate-orphan', '2')).toThrow(/different content/iu)
    expect(() => controller.submitCandidate('bfcl', {
      candidate_id: 'candidate-orphan',
      strategy_version: '1',
      host_source: `${hostSource}\n`,
    })).toThrow(/different content/iu)

    const recovered = submit(controller, 'candidate-orphan', '1')
    expect(recovered.state.open_candidate_id).toBe('candidate-orphan')
    expect(recovered.state.candidates).toContainEqual(expect.objectContaining({
      candidate_id: 'candidate-orphan', status: 'proposed',
    }))
    expect(() => submit(controller, 'candidate-orphan', '1')).toThrow(/already/iu)
  })

  it('recovers an identical orphan candidate from a File Store without rewriting it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autodata-candidate-replay-'))
    try {
      const store = new FileEvolutionStore(directory)
      const { controller } = createController(true, store)
      const profile = controller.status('bfcl').profile
      const orphan: CandidatePackage = {
        manifest: {
          schema_version: CANDIDATE_MANIFEST_SCHEMA_VERSION,
          candidate_id: 'candidate-orphan',
          profile_id: profile.id,
          generation: 1,
          parent_candidate_id: 'h0',
          strategy_version: '1',
          capabilities: profile.capabilities,
        },
        host_source: hostSource,
      }
      store.saveCandidate(orphan)

      const restarted = new EvolutionController({
        store: new FileEvolutionStore(directory),
        validator: new FixedValidator(true),
        runtime: new FakeRuntime(),
      })
      expect(() => submit(restarted, 'candidate-orphan', '2')).toThrow(/different content/iu)
      const recovered = submit(restarted, 'candidate-orphan', '1')

      expect(recovered.state.open_candidate_id).toBe('candidate-orphan')
      expect(new FileEvolutionStore(directory).loadConsistentSnapshot('bfcl').candidate_packages)
        .toEqual([orphan])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps a proposal open when validation infrastructure is unavailable', async () => {
    const { controller, validator } = createController()
    submit(controller, 'candidate-one', '1')
    validator.unavailable = true
    await expect(controller.validateCandidate('bfcl', 'candidate-one'))
      .rejects.toMatchObject({ code: 'VALIDATION_UNAVAILABLE' })
    expect(controller.status('bfcl').state).toMatchObject({
      active_candidate_id: 'h0',
      open_candidate_id: 'candidate-one',
    })
  })

  it('preserves feedback committed while external validation is awaiting', async () => {
    const { controller, validator } = createController()
    submit(controller, 'candidate-one', '1')
    const entered = deferred()
    const release = deferred()
    validator.hook = async () => {
      entered.resolve()
      await release.promise
    }

    const validation = controller.validateCandidate('bfcl', 'candidate-one')
    await entered.promise
    controller.recordFeedback({
      schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
      feedback_id: 'feedback-during-validation',
      profile_id: 'bfcl',
      candidate_id: 'h0',
      benchmark: 'bfcl-v3',
      split: 'B_search',
      summary: 'Committed while the validator was running.',
      failures: [],
    })
    release.resolve()
    await validation

    expect(controller.status('bfcl').state).toMatchObject({
      feedback_ids: ['feedback-during-validation'],
      current_feedback_id: 'feedback-during-validation',
      open_candidate_id: 'candidate-one',
    })
  })

  it.each([
    {
      schema_version: 'autodata-candidate-validation-1', candidate_id: 'unknown', ok: true,
      plugin_id: 'bfcl-strategy', plugin_version: '1',
    },
    {
      schema_version: 'autodata-candidate-validation-1', candidate_id: 'candidate-one', ok: true,
      plugin_id: 'forged-strategy', plugin_version: '1',
    },
    {
      schema_version: 'autodata-candidate-validation-1', candidate_id: 'candidate-one', ok: true,
      plugin_id: 'bfcl-strategy', plugin_version: '1', extra: true,
    },
    {
      schema_version: 'autodata-candidate-validation-1', candidate_id: 'candidate-one', ok: false,
      reason: '   ',
    },
  ])('rejects a malformed injected Validator result without closing the candidate', async (forged) => {
    const validator = {
      async validate() { return forged as unknown as CandidateValidationResult },
    }
    const { controller } = setupController(validator)
    submit(controller, 'candidate-one', '1')

    await expect(controller.validateCandidate('bfcl', 'candidate-one'))
      .rejects.toMatchObject({ code: 'VALIDATION_UNAVAILABLE' })
    expect(controller.status('bfcl').state.open_candidate_id).toBe('candidate-one')
    expect(controller.status('bfcl').state.candidates).toContainEqual(expect.objectContaining({
      candidate_id: 'candidate-one', status: 'proposed',
    }))
  })

  it('durably rejects a candidate-specific activation failure', async () => {
    const { controller, runtime } = createController()
    submit(controller, 'candidate-one', '1')
    await controller.validateCandidate('bfcl', 'candidate-one')
    runtime.failActivation = 'candidate'
    const outcome = await controller.recordEvaluation(report('candidate-one', 'h0', 0.5, 0.6), agent)
    expect(outcome.decision).toMatchObject({ accepted: false, reason: 'runtime_activation_failed' })
    expect(outcome.status.state).toMatchObject({ active_candidate_id: 'h0', open_candidate_id: null })
    expect(outcome.status.state.candidates).toContainEqual(expect.objectContaining({
      candidate_id: 'candidate-one', status: 'rejected',
    }))
  })

  it('does not durably reject a generic runtime failure that lacks restoration proof', async () => {
    const { controller, runtime } = createController()
    submit(controller, 'candidate-one', '1')
    await controller.validateCandidate('bfcl', 'candidate-one')
    runtime.failActivation = 'ambiguous'

    await expect(controller.recordEvaluation(report('candidate-one', 'h0', 0.5, 0.6), agent))
      .rejects.toMatchObject({ code: 'RUNTIME_FAILED' })
    expect(controller.status('bfcl').state).toMatchObject({
      active_candidate_id: 'h0', open_candidate_id: 'candidate-one',
    })
  })

  it('serializes profile operations and preserves feedback across activation', async () => {
    const { controller, runtime } = createController()
    submit(controller, 'candidate-one', '1')
    await controller.validateCandidate('bfcl', 'candidate-one')
    const entered = deferred()
    const release = deferred()
    runtime.activateHook = async () => {
      entered.resolve()
      await release.promise
    }

    const evaluation = controller.recordEvaluation(report('candidate-one', 'h0', 0.5, 0.6), agent)
    await entered.promise
    const resumed = controller.resume('bfcl', agent)
    await Promise.resolve()
    expect(runtime.ensured).toEqual([])
    controller.recordFeedback({
      schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
      feedback_id: 'feedback-during-activation',
      profile_id: 'bfcl',
      candidate_id: 'h0',
      benchmark: 'bfcl-v3',
      split: 'B_search',
      summary: 'Committed while runtime activation was running.',
      failures: [],
    })
    release.resolve()
    await evaluation
    await resumed

    expect(runtime.ensured).toEqual(['candidate-one'])
    expect(controller.status('bfcl').state).toMatchObject({
      active_candidate_id: 'candidate-one',
      feedback_ids: ['feedback-during-activation'],
      current_feedback_id: null,
    })
  })

  it('preserves feedback committed while rollback awaits the runtime', async () => {
    const { controller, runtime } = createController()
    submit(controller, 'candidate-one', '1')
    await controller.validateCandidate('bfcl', 'candidate-one')
    await controller.recordEvaluation(report('candidate-one', 'h0', 0.5, 0.6), agent)
    const entered = deferred()
    const release = deferred()
    runtime.ensureHook = async () => {
      entered.resolve()
      await release.promise
    }

    const rollback = controller.rollback('bfcl', 'h0', agent)
    await entered.promise
    controller.recordFeedback({
      schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
      feedback_id: 'feedback-during-rollback',
      profile_id: 'bfcl',
      candidate_id: 'candidate-one',
      benchmark: 'bfcl-v3',
      split: 'B_search',
      summary: 'Committed while rollback was running.',
      failures: [],
    })
    release.resolve()
    await rollback

    expect(controller.status('bfcl').state).toMatchObject({
      active_candidate_id: 'h0',
      feedback_ids: ['feedback-during-rollback'],
      current_feedback_id: null,
    })
  })

  it('treats failure to activate an accepted rollback target as degraded', async () => {
    const { controller, runtime } = createController()
    submit(controller, 'candidate-one', '1')
    await controller.validateCandidate('bfcl', 'candidate-one')
    await controller.recordEvaluation(report('candidate-one', 'h0', 0.5, 0.6), agent)
    await controller.rollback('bfcl', 'h0', agent)
    runtime.failActivation = 'candidate'

    await expect(controller.rollback('bfcl', 'candidate-one', agent))
      .rejects.toMatchObject({ code: 'RUNTIME_DEGRADED' })
    expect(controller.status('bfcl').state.active_candidate_id).toBe('h0')
  })

  it('replays an evaluation record left before the state commit and is idempotent after commit', async () => {
    const store = new FailEvaluationCommitStore()
    const { controller, runtime } = createController(true, store)
    submit(controller, 'candidate-one', '1')
    await controller.validateCandidate('bfcl', 'candidate-one')
    const evaluation = report('candidate-one', 'h0', 0.5, 0.6)
    store.failNextEvaluationCommit = true

    await expect(controller.recordEvaluation(evaluation, agent)).rejects.toMatchObject({ code: 'STORE_IO' })
    expect(store.getEvaluation('bfcl', evaluation.report_id)?.decision).toMatchObject({ accepted: true })
    expect(controller.status('bfcl').state.open_candidate_id).toBe('candidate-one')
    expect(runtime.rolledBack).toEqual(['candidate-one'])

    const replayed = await controller.recordEvaluation(evaluation, agent)
    expect(replayed.decision).toMatchObject({ accepted: true })
    expect(replayed.status.state.active_candidate_id).toBe('candidate-one')
    expect(runtime.activated).toEqual(['candidate-one', 'candidate-one'])

    const repeated = await controller.recordEvaluation(evaluation, agent)
    expect(repeated.decision).toEqual(replayed.decision)
    expect(runtime.activated).toEqual(['candidate-one', 'candidate-one'])
  })

  it('restores a durable accepted candidate when its evaluation is replayed in a fresh process', async () => {
    const store = new MemoryEvolutionStore()
    const { controller } = createController(true, store)
    submit(controller, 'candidate-one', '1')
    await controller.validateCandidate('bfcl', 'candidate-one')
    const evaluation = report('candidate-one', 'h0', 0.5, 0.6)
    await controller.recordEvaluation(evaluation, agent)

    const runtime = new FakeRuntime()
    const restarted = new EvolutionController({ store, validator: new FixedValidator(true), runtime })
    const replayed = await restarted.recordEvaluation(evaluation, agent)

    expect(replayed.decision).toMatchObject({ accepted: true })
    expect(replayed.status.state.active_candidate_id).toBe('candidate-one')
    expect(runtime.ensured).toEqual(['candidate-one'])
  })

  it('restores H0 after a rejected H1 evaluation is replayed in a fresh process', async () => {
    const store = new MemoryEvolutionStore()
    const { controller } = createController(true, store)
    submit(controller, 'candidate-one', '1')
    await controller.validateCandidate('bfcl', 'candidate-one')
    const evaluation = report('candidate-one', 'h0', 0.5, 0.5)
    await controller.recordEvaluation(evaluation, agent)

    const runtime = new FakeRuntime()
    const restarted = new EvolutionController({ store, validator: new FixedValidator(true), runtime })
    const replayed = await restarted.recordEvaluation(evaluation, agent)

    expect(replayed.decision).toMatchObject({ accepted: false, reason: 'not_strictly_better' })
    expect(replayed.status.state.active_candidate_id).toBe('h0')
    expect(runtime.ensured).toEqual([null])
  })

  it('restores the durable parent after a rejected evaluation is replayed or resumed in a fresh process', async () => {
    const store = new MemoryEvolutionStore()
    const { controller } = createController(true, store)
    submit(controller, 'candidate-one', '1')
    await controller.validateCandidate('bfcl', 'candidate-one')
    await controller.recordEvaluation(report('candidate-one', 'h0', 0.5, 0.6), agent)
    submit(controller, 'candidate-two', '2')
    await controller.validateCandidate('bfcl', 'candidate-two')
    const evaluation = report('candidate-two', 'candidate-one', 0.6, 0.6)
    await controller.recordEvaluation(evaluation, agent)

    const replayRuntime = new FakeRuntime()
    const replayedController = new EvolutionController({
      store, validator: new FixedValidator(true), runtime: replayRuntime,
    })
    const replayed = await replayedController.recordEvaluation(evaluation, agent)
    expect(replayed.decision).toMatchObject({ accepted: false, reason: 'not_strictly_better' })
    expect(replayed.status.state.active_candidate_id).toBe('candidate-one')
    expect(replayRuntime.ensured).toEqual(['candidate-one'])

    const resumeRuntime = new FakeRuntime()
    const resumedController = new EvolutionController({
      store, validator: new FixedValidator(true), runtime: resumeRuntime,
    })
    const resumed = await resumedController.resume('bfcl', agent)
    expect(resumed.state.active_candidate_id).toBe('candidate-one')
    expect(resumeRuntime.ensured).toEqual(['candidate-one'])
  })

  it.each(['unavailable', 'degraded'] as const)(
    'keeps a validated candidate open on %s runtime infrastructure failure',
    async (failure) => {
      const { controller, runtime } = createController()
      submit(controller, 'candidate-one', '1')
      await controller.validateCandidate('bfcl', 'candidate-one')
      runtime.failActivation = failure
      await expect(controller.recordEvaluation(report('candidate-one', 'h0', 0.5, 0.6), agent))
        .rejects.toMatchObject({ code: failure === 'unavailable' ? 'RUNTIME_UNAVAILABLE' : 'RUNTIME_DEGRADED' })
      expect(controller.status('bfcl').state).toMatchObject({
        active_candidate_id: 'h0', open_candidate_id: 'candidate-one',
      })
    },
  )

  it('refuses a second open candidate and disposes its owned runtime', async () => {
    const { controller, runtime } = createController()
    submit(controller, 'candidate-one', '1')
    expect(() => submit(controller, 'candidate-two', '2')).toThrow(/already open/iu)
    await controller.dispose()
    expect(runtime.disposed).toBe(true)
    expect(() => controller.status('bfcl')).toThrow(/disposed/iu)
  })
})

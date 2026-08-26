import { describe, expect, it } from 'vitest'
import {
  EVALUATION_REPORT_SCHEMA_VERSION,
  EVOLUTION_FEEDBACK_SCHEMA_VERSION,
  EvolutionController,
  EvolutionError,
  MemoryEvolutionStore,
  type CandidatePackage,
  type CandidateValidationResult,
  type CandidateValidator,
  type EvolutionRuntime,
  type EvolutionRuntimeAgent,
  type RuntimeActivation,
  type TaskProfile,
} from '../src/evolution/index.js'

const agent = { id: 'controller-test-agent' } as EvolutionRuntimeAgent
const hostSource = 'return { inject: ["autodata"], apply() {} }'

class FixedValidator implements CandidateValidator {
  unavailable = false

  constructor(private readonly ok: boolean) {}

  async validate(profile: TaskProfile, candidate: CandidatePackage): Promise<CandidateValidationResult> {
    if (this.unavailable) throw new EvolutionError('validator unavailable', 'VALIDATION_UNAVAILABLE')
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
  failActivation: 'candidate' | 'unavailable' | 'degraded' | null = null
  disposed = false

  async ensureActive(_profile: TaskProfile, candidate: CandidatePackage | null): Promise<void> {
    this.ensured.push(candidate?.manifest.candidate_id ?? null)
  }

  async activate(
    _profile: TaskProfile,
    _current: CandidatePackage | null,
    candidate: CandidatePackage,
  ): Promise<RuntimeActivation> {
    if (this.failActivation !== null) {
      const code = this.failActivation === 'candidate'
        ? 'RUNTIME_FAILED'
        : this.failActivation === 'unavailable'
          ? 'RUNTIME_UNAVAILABLE'
          : 'RUNTIME_DEGRADED'
      throw new EvolutionError('activation failed', code)
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

function createController(ok = true) {
  const runtime = new FakeRuntime()
  const validator = new FixedValidator(ok)
  const controller = new EvolutionController({
    store: new MemoryEvolutionStore(),
    validator,
    runtime,
  })
  controller.createProfile({
    id: 'bfcl',
    benchmark: 'bfcl-v3',
    capabilities: ['data-select', 'data-filter', 'data-order'],
    acceptance: { metric: 'accuracy' },
  })
  return { controller, runtime, validator }
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

describe('EvolutionController', () => {
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

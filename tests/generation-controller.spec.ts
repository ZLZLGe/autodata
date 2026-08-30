import { Context } from '@deepseek-ai/cordis'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../src/core/json.js'
import type { DataRunResult } from '../src/core/types.js'
import {
  EVALUATION_REPORT_SCHEMA_VERSION,
  EVOLUTION_FEEDBACK_SCHEMA_VERSION,
  EvolutionController,
  H0_CANDIDATE_ID,
  MemoryEvolutionStore,
  type CandidatePackage,
  type CandidateValidationResult,
  type CandidateValidator,
  type EvolutionRuntime,
  type EvolutionRuntimeAgent,
  type RuntimeActivation,
  type TaskProfile,
} from '../src/evolution/index.js'
import { ExperimentController } from '../src/experiment/controller.js'
import { ExperimentError } from '../src/experiment/types.js'
import { GenerationController } from '../src/generation/controller.js'
import {
  GENERATION_MATERIALIZATION_VERSION,
  type GenerationDraft,
  type GenerationDraftRequest,
  type GenerationJobHooks,
  type GenerationJobRegistry,
  type GenerationMaterialization,
  type GenerationMaterializationRequest,
  type GenerationMaterializer,
  type GenerationProposalSession,
  type GenerationProposer,
  type GenerationStartRequest,
  type GenerationState,
} from '../src/generation/types.js'

const PROFILE_ID = 'bfcl-v4'
const BENCHMARK = 'bfcl-v4'
const CANDIDATE_ID = 'candidate-h1'
const STRATEGY_VERSION = '1'
const EXECUTION_COMMIT = 'a'.repeat(40)
const HOST_SOURCE = "return { inject: ['autodata'], apply(ctx) { ctx.autodata.register({ id: 'bfcl-v4-strategy', version: '1', run(input) { return input.map(item => ({ record_id: item.record.source.record_id })) } }) } }"
const BASELINE_SCORE = 0.8
const CATEGORIES = ['simple_python', 'multiple', 'parallel', 'parallel_multiple', 'irrelevance'] as const
const B_SEARCH_CASE_IDS = CATEGORIES.flatMap(category =>
  Array.from({ length: 5 }, (_value, index) => `${category}_${String(index + 1000)}`))

const directories: string[] = []
const contexts: Context[] = []
const controllers: GenerationController[] = []

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.dispose()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${canonicalJson(value)}\n`)
}

function writeJsonLines(path: string, values: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${values.map(value => canonicalJson(value)).join('\n')}\n`)
}

function jsonLines(values: readonly unknown[]): string {
  return `${values.map(value => canonicalJson(value)).join('\n')}\n`
}

function makeBaseline(root: string): {
  readonly directory: string
  readonly searchCases: string
  readonly report: Parameters<EvolutionController['registerBaseline']>[0]
  readonly feedback: Parameters<EvolutionController['recordFeedback']>[0]
} {
  const directory = resolve(root, 'baseline')
  const evalDirectory = resolve(directory, 'attempts/eval-01')
  const searchCases = resolve(root, 'fixtures/b-search.jsonl')
  const canonical = Array.from({ length: 100 }, (_value, index) => ({
    schema_version: 'autodata.canonical_trajectory.v1',
    source: {
      adapter_id: 'openai-tool-trajectory',
      adapter_version: '2',
      dataset_id: 'nex-agi/agent-sft',
      dataset_revision: 'd8d4de5643f9fe9d3fc3f89b3d55b8709ddc35c9',
      record_id: `record-${String(index + 1)}`,
      record_index: index,
      record_line: index + 1,
    },
    messages: [
      { role: 'user', content: `Find the weather for record ${String(index + 1)}.` },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `call-${String(index + 1)}`, type: 'function', function: { name: 'weather', arguments: '{}' } }],
      },
    ],
    tools: [{ type: 'function', function: { name: 'weather', description: 'Weather', parameters: {} } }],
  }))
  const canonicalText = `${canonical.map(value => canonicalJson(value)).join('\n')}\n`
  const summary = { seed: 42, counts: { canonical_records: canonical.length } }
  const summaryText = `${canonicalJson(summary)}\n`
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'canonical.jsonl'), canonicalText)
  writeFileSync(resolve(directory, 'run-summary.json'), summaryText)
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), 'stage4b/experiment-contract.json'), 'utf8')) as {
    contract_id: string
    data: Record<string, unknown>
    evaluation: { case_ids: { B_search: string[] } }
  }
  contract.data.canonical_jsonl_sha256 = hash(canonicalText)
  contract.data.run_summary_json_sha256 = hash(summaryText)
  contract.evaluation.case_ids.B_search = [...B_SEARCH_CASE_IDS]
  const contractText = `${canonicalJson(contract)}\n`
  const contractSha256 = hash(contractText)
  writeFileSync(resolve(directory, 'experiment-contract.json'), contractText)
  const caseResults = B_SEARCH_CASE_IDS.map((caseId, index) => ({
    case_id: caseId,
    split: 'B_search',
    category: CATEGORIES[Math.floor(index / 5)],
    passed: index % 5 !== 4,
    failure_summary: index % 5 === 4 ? 'checker rejected the baseline call' : null,
  }))
  writeJson(resolve(directory, 'b-search-results.json'), {
    schema_version: 'autodata-b-search-results-1',
    contract_id: contract.contract_id,
    contract_sha256: contractSha256,
    profile_id: PROFILE_ID,
    run_id: 'h0-run',
    macro_score: BASELINE_SCORE,
    category_scores: Object.fromEntries(CATEGORIES.map(category => [category, BASELINE_SCORE])),
    cases: caseResults,
  })
  const report = {
    schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
    report_id: 'h0-evaluation',
    profile_id: PROFILE_ID,
    candidate_id: 'h0',
    benchmark: BENCHMARK,
    split: 'B_dev' as const,
    metric: 'equal_category_accuracy',
    score: BASELINE_SCORE,
    complete: true,
    cases_evaluated: 25,
    cases_expected: 25,
    run_id: 'h0-run',
    metadata: { contract_id: contract.contract_id, contract_sha256: contractSha256 },
  }
  writeJson(resolve(directory, 'evaluation-report.json'), report)
  const feedback = {
    schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
    feedback_id: 'h0-search-feedback',
    profile_id: PROFILE_ID,
    candidate_id: 'h0',
    benchmark: BENCHMARK,
    split: 'B_search' as const,
    summary: 'H0 search failures',
    failures: caseResults.filter(value => !value.passed).map(value => ({
      case_id: value.case_id,
      summary: value.failure_summary as string,
      category: value.category as string,
    })),
    metrics: {
      macro_score: BASELINE_SCORE,
      ...Object.fromEntries(CATEGORIES.map(category => [`category_${category}`, BASELINE_SCORE])),
    },
    artifact_path: resolve(directory, 'b-search-results.json'),
    metadata: {
      contract_id: contract.contract_id,
      contract_sha256: contractSha256,
      run_id: 'h0-run',
      cases_evaluated: 25,
    },
  }
  writeJson(resolve(directory, 'feedback.json'), feedback)
  writeJson(resolve(directory, 'state.json'), {
    schema_version: 'autodata-experiment-state-1',
    contract_id: contract.contract_id,
    contract_sha256: contractSha256,
    profile_id: PROFILE_ID,
    run_id: 'h0-run',
    status: 'succeeded',
    phase: 'complete',
    run_directory: directory,
    eval_result_path: resolve(evalDirectory, 'result.json'),
    evaluation_report_id: report.report_id,
    feedback_id: feedback.feedback_id,
  })
  writeJsonLines(resolve(evalDirectory, 'predictions.jsonl'), caseResults.map(value => ({
    case_id: value.case_id,
    split: 'B_search',
    tool_calls: value.passed ? [{ name: 'weather', arguments: {} }] : [{ name: 'wrong_tool', arguments: {} }],
    failure_summary: value.failure_summary,
  })))
  writeJsonLines(searchCases, B_SEARCH_CASE_IDS.map((caseId, index) => ({
    id: caseId,
    split: 'search',
    category: CATEGORIES[Math.floor(index / 5)],
    messages: [{ role: 'user', content: 'Find the weather.' }],
    functions: [{ name: 'weather', parameters: {} }],
    ground_truth: [{ name: 'weather', arguments: {} }],
  })))
  return { directory, searchCases, report, feedback }
}

class FakeJobs implements GenerationJobRegistry {
  private sequence = 0
  private readonly hooks = new Map<string, GenerationJobHooks>()
  private readonly outcomes = new Map<string, Promise<JobOutcome>>()
  private attached = 0

  start(spec: Parameters<GenerationJobRegistry['start']>[0]): JobId {
    if (this.attached === 0) throw new Error('generation controller is not attached')
    const id = JobId(`generation-${String(++this.sequence)}`)
    const hooks = spec.run()
    this.hooks.set(id, hooks)
    this.outcomes.set(id, hooks.done)
    return id
  }

  get(id: JobId): { readonly status: string } {
    if (!this.hooks.has(id)) throw new Error('unknown generation job')
    return { status: 'running' }
  }

  kill(id: JobId, _caller?: undefined, reason?: string): 'requested' | 'already-finished' {
    const hooks = this.hooks.get(id)
    if (hooks === undefined) return 'already-finished'
    hooks.cancel(reason)
    return 'requested'
  }

  attachController(): () => void {
    this.attached += 1
    return () => { this.attached -= 1 }
  }

  async done(id: JobId): Promise<JobOutcome> {
    const outcome = this.outcomes.get(id)
    if (outcome === undefined) throw new Error('unknown generation job')
    return outcome
  }
}

class FixedValidator implements CandidateValidator {
  calls = 0

  constructor(
    private readonly ok: boolean,
    private readonly reason = 'fixture rejected the ephemeral draft',
  ) {}

  async validate(profile: TaskProfile, candidate: CandidatePackage): Promise<CandidateValidationResult> {
    this.calls += 1
    return {
      schema_version: 'autodata-candidate-validation-1',
      candidate_id: candidate.manifest.candidate_id,
      ok: this.ok,
      ...(this.ok
        ? { plugin_id: profile.strategy_plugin_id, plugin_version: candidate.manifest.strategy_version }
        : { reason: this.reason }),
    }
  }
}

class FakeRuntime implements EvolutionRuntime {
  readonly activated: string[] = []
  readonly ensured: Array<string | null> = []

  async ensureActive(
    _profile: TaskProfile,
    candidate: CandidatePackage | null,
    _agent: EvolutionRuntimeAgent,
  ): Promise<void> {
    this.ensured.push(candidate?.manifest.candidate_id ?? null)
  }

  async activate(
    _profile: TaskProfile,
    _current: CandidatePackage | null,
    candidate: CandidatePackage,
    _agent: EvolutionRuntimeAgent,
  ): Promise<RuntimeActivation> {
    this.activated.push(candidate.manifest.candidate_id)
    return { rollback: async () => undefined }
  }

  async dispose(): Promise<void> {}
}

class ScriptedProposer implements GenerationProposer {
  readonly requests: GenerationDraftRequest[] = []
  sessions = 0
  disposed = 0

  constructor(private readonly draft: (request: GenerationDraftRequest) => GenerationDraft = () => ({
    host_source: HOST_SOURCE,
    description: 'fake autonomous H1',
  })) {}

  async create(): Promise<GenerationProposalSession> {
    this.sessions += 1
    const sessionNumber = this.sessions
    return {
      agent: { id: `generation-agent-${String(sessionNumber)}` } as EvolutionRuntimeAgent,
      propose: async (request) => {
        this.requests.push(request)
        return this.draft(request)
      },
      cancel() {},
      dispose: async () => { this.disposed += 1 },
    }
  }
}

class ScriptedMaterializer implements GenerationMaterializer {
  readonly requests: GenerationMaterializationRequest[] = []
  private cursor = 0

  constructor(
    private readonly variants: readonly string[],
    private readonly corruption?: 'harness' | 'seed' | 'source' | 'provenance' | 'rank' | 'oversized-plan',
  ) {
    if (variants.length === 0) throw new Error('at least one materialization variant is required')
  }

  async materialize(request: GenerationMaterializationRequest): Promise<GenerationMaterialization> {
    this.requests.push(request)
    const variant = this.variants[Math.min(this.cursor, this.variants.length - 1)] as string
    this.cursor += 1
    const first = request.canonical_records[0] as DataRunResult['canonical_records'][number]
    const selectedRecords = this.corruption === 'oversized-plan'
      ? request.canonical_records as DataRunResult['canonical_records']
      : [first]
    const logicalTrainingView = selectedRecords.map((record, index) => ({
      schema_version: 'dataharness-logical-training-unit-4',
      id: `${record.source.record_id}:assistant:1`,
      source: record.source,
      assistant_message_index: 1,
      messages: record.messages,
      tools: record.tools,
      selection_rank: this.corruption === 'rank' ? 1 : index,
      plugin_provenance: [{
        plugin_id: this.corruption === 'provenance' ? 'wrong-strategy' : request.strategy_plugin_id,
        plugin_version: request.strategy_version,
        note: this.corruption === 'oversized-plan' ? 'x'.repeat(4096) : variant,
      }],
    }))
    const dataRun = {
      canonical_records: request.canonical_records,
      logical_training_view: logicalTrainingView,
      summary: {
        ...(request.baseline_summary as Record<string, unknown>),
        harness_id: this.corruption === 'harness' ? 'wrong-harness' : request.harness_id,
        generation: request.generation,
        seed: this.corruption === 'seed' ? request.seed + 1 : request.seed,
        source: {
          adapter_id: first.source.adapter_id,
          adapter_version: first.source.adapter_version,
          dataset_id: first.source.dataset_id,
          dataset_revision: this.corruption === 'source' ? 'wrong-revision' : first.source.dataset_revision,
        },
        plugins: [{ id: request.strategy_plugin_id, version: request.strategy_version }],
      },
    } as unknown as DataRunResult
    const canonicalText = jsonLines(dataRun.canonical_records)
    const logicalText = jsonLines(dataRun.logical_training_view)
    const summaryText = `${canonicalJson(dataRun.summary)}\n`
    return {
      schema_version: GENERATION_MATERIALIZATION_VERSION,
      candidate_id: request.candidate_id,
      host_source_sha256: hash(request.host_source),
      source_pool_sha256: hash(canonicalText),
      canonical_jsonl_sha256: hash(canonicalText),
      logical_view_jsonl_sha256: hash(logicalText),
      run_summary_json_sha256: hash(summaryText),
      selected_record_ids: logicalTrainingView.map(unit => unit.source.record_id),
      data_run: dataRun,
    }
  }
}

interface FakeExperimentRequest {
  readonly profile_id: string
  readonly run_id: string
  readonly data_run: DataRunResult
  readonly subject: {
    readonly candidate_id: string
    readonly generation: number
    readonly plugin_id: string
    readonly strategy_version: string
    readonly host_source_sha256: string
    readonly runtime_plan_sha256: string
    readonly materialization_sha256: string
  }
}

interface FakeExperimentState {
  readonly profile_id: string
  readonly run_id: string
  readonly status: 'running' | 'succeeded' | 'failed'
  readonly phase: 'train' | 'complete'
  readonly run_directory: string
  readonly contract_id: string
  readonly contract_sha256: string
  readonly candidate_id: string
  readonly candidate_generation: number
  readonly attempts: readonly Record<string, unknown>[]
  readonly eval_result_path?: string
  readonly evaluation_report_id?: string
  readonly decision_path?: string
  readonly decision?: {
    readonly candidate_id: string
    readonly accepted: boolean
    readonly reason: 'accepted_strict_improvement' | 'not_strictly_better'
    readonly split: 'B_dev'
    readonly metric: string
    readonly candidate_score: number
    readonly baseline_score: number
  }
  readonly failure?: { readonly message: string }
}

class FakeExperiment {
  readonly starts: FakeExperimentRequest[] = []
  readonly resumes: Array<{ readonly profileId: string; readonly runId: string }> = []
  private readonly states = new Map<string, FakeExperimentState>()

  constructor(
    private readonly root: string,
    readonly candidateScore: number,
    readonly initiallyPending = false,
    private startFailuresRemaining = 0,
    private readonly terminalFailure = false,
  ) {}

  start(request: FakeExperimentRequest): { readonly state: FakeExperimentState } {
    if (this.startFailuresRemaining > 0) {
      this.startFailuresRemaining -= 1
      throw new Error('simulated experiment start crash')
    }
    this.starts.push(request)
    const runDirectory = resolve(this.root, 'experiments', request.profile_id, request.run_id)
    mkdirSync(runDirectory, { recursive: true })
    const contract = JSON.parse(readFileSync(resolve(process.cwd(), 'stage4b/experiment-contract.json'), 'utf8')) as {
      contract_id: string
      subject?: FakeExperimentRequest['subject']
      data: Record<string, unknown>
      evaluation: { case_ids: { B_search: string[] } }
    }
    contract.contract_id = 'stage4c-candidate-1'
    contract.subject = request.subject
    const canonicalText = jsonLines(request.data_run.canonical_records)
    const logicalText = jsonLines(request.data_run.logical_training_view)
    const summaryText = `${canonicalJson(request.data_run.summary)}\n`
    contract.data.harness_id = request.data_run.summary.harness_id
    contract.data.seed = request.data_run.summary.seed
    contract.data.canonical_records = request.data_run.canonical_records.length
    contract.data.logical_training_units = request.data_run.logical_training_view.length
    contract.data.canonical_jsonl_sha256 = hash(canonicalText)
    contract.data.logical_view_jsonl_sha256 = hash(logicalText)
    contract.data.run_summary_json_sha256 = hash(summaryText)
    contract.evaluation.case_ids.B_search = [...B_SEARCH_CASE_IDS]
    const contractText = `${canonicalJson(contract)}\n`
    const contractSha256 = hash(contractText)
    writeFileSync(resolve(runDirectory, 'experiment-contract.json'), contractText)
    const state: FakeExperimentState = {
      profile_id: request.profile_id,
      run_id: request.run_id,
      status: 'running',
      phase: 'train',
      run_directory: runDirectory,
      contract_id: contract.contract_id,
      contract_sha256: contractSha256,
      candidate_id: request.subject.candidate_id,
      candidate_generation: request.subject.generation,
      attempts: [],
    }
    this.states.set(this.key(request.profile_id, request.run_id), state)
    if (this.terminalFailure) {
      this.states.set(this.key(request.profile_id, request.run_id), {
        ...state,
        status: 'failed',
        failure: { message: 'simulated terminal experiment failure' },
      })
    } else if (!this.initiallyPending) this.complete(request.profile_id, request.run_id)
    return this.status(request.profile_id, request.run_id)
  }

  status(profileId: string, runId: string): { readonly state: FakeExperimentState } {
    const state = this.states.get(this.key(profileId, runId))
    if (state === undefined) throw new ExperimentError(`unknown fake experiment ${profileId}/${runId}`, 'RUN_NOT_FOUND')
    return { state }
  }

  resume(profileId: string, runId: string): { readonly state: FakeExperimentState } {
    this.resumes.push({ profileId, runId })
    return this.status(profileId, runId)
  }

  async cancel(): Promise<void> {}

  complete(profileId: string, runId: string): void {
    const current = this.states.get(this.key(profileId, runId))
    if (current === undefined) throw new Error(`unknown fake experiment ${profileId}/${runId}`)
    if (this.candidateScore !== 1 && this.candidateScore !== BASELINE_SCORE) {
      throw new Error('fake candidate score must be exactly 1 or the 0.8 baseline')
    }
    const contract = JSON.parse(readFileSync(resolve(current.run_directory, 'experiment-contract.json'), 'utf8')) as {
      contract_id: string
      profile: { benchmark: string; metric: string }
      model: Record<string, unknown>
      evaluation: {
        gpus: number
        gpu_family: string
        vllm_version: string
        tool_call_parser: string
        categories: string[]
        case_ids: { B_search: string[]; B_dev: string[] }
        macro: string
      }
    }
    const evalDirectory = resolve(current.run_directory, 'attempts/eval-01')
    const resultPath = resolve(evalDirectory, 'result.json')
    const predictionsPath = resolve(evalDirectory, 'predictions.jsonl')
    const requestPath = resolve(evalDirectory, 'request.json')
    const checkpointPath = resolve(current.run_directory, 'attempts/train-01/checkpoint')
    const evalRequest = {
      schema_version: 'autodata-experiment-eval-request-1',
      contract_id: current.contract_id,
      contract_sha256: current.contract_sha256,
      profile_id: profileId,
      run_id: runId,
      attempt: 1,
      checkpoint_path: checkpointPath,
      output: { root: evalDirectory, result_json: resultPath, predictions_jsonl: predictionsPath },
      model: contract.model,
      runtime: {
        gpus: contract.evaluation.gpus,
        gpu_family: contract.evaluation.gpu_family,
        vllm_version: contract.evaluation.vllm_version,
        tool_call_parser: contract.evaluation.tool_call_parser,
      },
      benchmark: {
        id: contract.profile.benchmark,
        metric: contract.profile.metric,
        categories: contract.evaluation.categories,
        case_ids: contract.evaluation.case_ids,
        macro: contract.evaluation.macro,
      },
    }
    writeJson(requestPath, evalRequest)
    const cases = (['B_search', 'B_dev'] as const).flatMap(split =>
      contract.evaluation.case_ids[split].map((caseId, index) => {
        const category = [...contract.evaluation.categories]
          .sort((left, right) => right.length - left.length)
          .find(value => caseId.startsWith(`${value}_`)) as string
        const passed = split === 'B_search' ? index % 5 !== 4 : this.candidateScore === 1 || index % 5 !== 4
        return {
          case_id: caseId,
          split,
          category,
          passed,
          failure_summary: passed ? null : `${split} checker rejection`,
        }
      }))
    const categoryScores = {
      B_search: Object.fromEntries(CATEGORIES.map(category => [category, BASELINE_SCORE])),
      B_dev: Object.fromEntries(CATEGORIES.map(category => [category, this.candidateScore])),
    }
    writeJsonLines(predictionsPath, cases.map(value => ({
      schema_version: 'autodata-experiment-prediction-1',
      ...value,
      tool_calls: value.category === 'irrelevance' ? [] : [{ weather: '{}' }],
    })))
    writeJson(resultPath, {
      schema_version: 'autodata-experiment-eval-result-1',
      contract_id: current.contract_id,
      contract_sha256: current.contract_sha256,
      profile_id: profileId,
      run_id: runId,
      attempt: 1,
      status: 'completed',
      checks: {
        gpu_count: 1,
        gpu_family: 'NVIDIA H200',
        model_revision: contract.model.revision,
        vllm_version: contract.evaluation.vllm_version,
        tool_call_parser: contract.evaluation.tool_call_parser,
        loaded_weight_shards: 4,
      },
      cases,
      category_scores: categoryScores,
      macro_scores: { B_search: BASELINE_SCORE, B_dev: this.candidateScore },
      predictions_path: predictionsPath,
      failure: null,
    })
    const reportId = `${runId}-evaluation`
    const reportPath = resolve(current.run_directory, 'evaluation-report.json')
    const searchPath = resolve(current.run_directory, 'b-search-results.json')
    writeJson(reportPath, {
      schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
      report_id: reportId,
      run_id: runId,
      profile_id: profileId,
      candidate_id: CANDIDATE_ID,
      benchmark: BENCHMARK,
      split: 'B_dev',
      metric: 'equal_category_accuracy',
      score: this.candidateScore,
      complete: true,
      cases_evaluated: 25,
      cases_expected: 25,
      baseline_candidate_id: 'h0',
      baseline_score: BASELINE_SCORE,
      category_scores: categoryScores.B_dev,
      metadata: {
        contract_id: current.contract_id,
        contract_sha256: current.contract_sha256,
        evaluation_result_path: resultPath,
        b_search_artifact_path: searchPath,
      },
    })
    writeJson(searchPath, {
      schema_version: 'autodata-b-search-results-1',
      contract_id: current.contract_id,
      contract_sha256: current.contract_sha256,
      profile_id: profileId,
      run_id: runId,
      candidate_id: CANDIDATE_ID,
      macro_score: BASELINE_SCORE,
      category_scores: Object.fromEntries(CATEGORIES.map(category => [category, BASELINE_SCORE])),
      cases: cases.filter(value => value.split === 'B_search'),
    })
    const decision = {
      candidate_id: CANDIDATE_ID,
      accepted: this.candidateScore > BASELINE_SCORE,
      reason: this.candidateScore > BASELINE_SCORE
        ? 'accepted_strict_improvement' as const
        : 'not_strictly_better' as const,
      split: 'B_dev' as const,
      metric: 'equal_category_accuracy',
      candidate_score: this.candidateScore,
      baseline_score: BASELINE_SCORE,
    }
    const decisionPath = resolve(current.run_directory, 'decision.json')
    writeJson(decisionPath, decision)
    this.states.set(this.key(profileId, runId), {
      ...current,
      status: 'succeeded',
      phase: 'complete',
      attempts: [{
        stage: 'eval',
        attempt: 1,
        status: 'succeeded',
        rjob_name: 'fake-eval',
        request_path: requestPath,
        result_path: resultPath,
        created_at: '2026-08-30T00:00:00.000Z',
        updated_at: '2026-08-30T00:00:00.000Z',
      }],
      eval_result_path: resultPath,
      evaluation_report_id: reportId,
      decision_path: decisionPath,
      decision,
    })
  }

  private key(profileId: string, runId: string): string {
    return `${profileId}\0${runId}`
  }
}

interface FixtureOptions {
  readonly validatorOk?: boolean
  readonly validatorReason?: string
  readonly materializationVariants?: readonly string[]
  readonly candidateScore?: number
  readonly experimentPending?: boolean
  readonly experimentStartFailures?: number
  readonly experimentTerminalFailure?: boolean
  readonly materializationCorruption?: 'harness' | 'seed' | 'source' | 'provenance' | 'rank' | 'oversized-plan'
  readonly expectedProposalContextSha256?: string
}

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'autodata-generation-controller-'))
  directories.push(root)
  const baseline = makeBaseline(root)
  const validator = new FixedValidator(options.validatorOk ?? true, options.validatorReason)
  const runtime = new FakeRuntime()
  const store = new MemoryEvolutionStore()
  const evolution = new EvolutionController({ store, validator, runtime })
  evolution.createProfile({
    id: PROFILE_ID,
    benchmark: BENCHMARK,
    capabilities: ['data-select'],
    acceptance: { metric: 'equal_category_accuracy' },
  })
  evolution.registerBaseline(baseline.report)
  evolution.recordFeedback(baseline.feedback)
  const proposer = new ScriptedProposer()
  const materializer = new ScriptedMaterializer(
    options.materializationVariants ?? ['stable', 'stable'],
    options.materializationCorruption,
  )
  const experiment = new FakeExperiment(
    root,
    options.candidateScore ?? 1,
    options.experimentPending ?? false,
    options.experimentStartFailures ?? 0,
    options.experimentTerminalFailure ?? false,
  )
  const jobs = new FakeJobs()
  const ctx = new Context()
  contexts.push(ctx)
  const generation = new GenerationController(ctx, {
    evolution,
    experiment: experiment as unknown as ExperimentController,
    proposer,
    materializer,
    validator,
    run_root: resolve(root, 'generations'),
    ...(options.expectedProposalContextSha256 === undefined
      ? {}
      : { expected_proposal_context_sha256: options.expectedProposalContextSha256 }),
    poll_interval_ms: 0,
    jobs,
    now: () => new Date('2026-08-30T00:00:00.000Z'),
    sleep: (_milliseconds, signal) => new Promise((resolveSleep, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  controllers.push(generation)
  const request: GenerationStartRequest = {
    profile_id: PROFILE_ID,
    run_id: 'generation-one',
    experiment_run_id: 'experiment-h1',
    execution_commit: EXECUTION_COMMIT,
    baseline_run_directory: baseline.directory,
    b_search_cases_jsonl: baseline.searchCases,
    candidate_id: CANDIDATE_ID,
    strategy_version: STRATEGY_VERSION,
  }
  return { root, validator, runtime, store, evolution, proposer, materializer, experiment, jobs, generation, request }
}

async function startAndWait(value: ReturnType<typeof fixture>): Promise<JobOutcome> {
  const started = value.generation.start(value.request)
  expect(started.job_id).toBeDefined()
  return value.jobs.done(started.job_id as JobId)
}

function restartGeneration(
  value: ReturnType<typeof fixture>,
  expectedProposalContextSha256?: string,
): { readonly controller: GenerationController; readonly jobs: FakeJobs } {
  const jobs = new FakeJobs()
  const ctx = new Context()
  contexts.push(ctx)
  const controller = new GenerationController(ctx, {
    evolution: value.evolution,
    experiment: value.experiment as unknown as ExperimentController,
    proposer: value.proposer,
    materializer: value.materializer,
    validator: value.validator,
    run_root: resolve(value.root, 'generations'),
    ...(expectedProposalContextSha256 === undefined
      ? {}
      : { expected_proposal_context_sha256: expectedProposalContextSha256 }),
    poll_interval_ms: 0,
    jobs,
    now: () => new Date('2026-08-30T00:00:01.000Z'),
    sleep: async () => undefined,
  })
  controllers.push(controller)
  return { controller, jobs }
}

async function completeGeneration(value: ReturnType<typeof fixture>): Promise<GenerationState> {
  await expect(startAndWait(value)).resolves.toMatchObject({ status: 'completed' })
  return value.generation.status(PROFILE_ID, value.request.run_id).state
}

describe('GenerationController fake end-to-end workflow', () => {
  it('rejects a protocol-bound proposal-context mismatch before claiming or calling the model', () => {
    const value = fixture({ expectedProposalContextSha256: '0'.repeat(64) })

    expect(() => value.generation.start(value.request)).toThrowError(expect.objectContaining({
      code: 'ARTIFACT_INVALID',
    }))
    expect(value.proposer.requests).toHaveLength(0)
    expect(existsSync(resolve(value.root, 'generations', PROFILE_ID, 'first-h1-claim.json'))).toBe(false)
  })

  it('accepts the exact protocol-bound context and revalidates it on fresh-process resume', async () => {
    const reference = fixture()
    await completeGeneration(reference)
    const referenceContext = readFileSync(resolve(
      reference.root,
      'generations',
      PROFILE_ID,
      reference.request.run_id,
      'proposal-context.json',
    ))
    const expectedProposalContextSha256 = createHash('sha256').update(referenceContext).digest('hex')

    const value = fixture({ expectedProposalContextSha256 })
    await completeGeneration(value)
    await value.generation.dispose()

    const restarted = restartGeneration(value, expectedProposalContextSha256)
    const resumed = restarted.controller.resume(PROFILE_ID, value.request.run_id)
    await expect(restarted.jobs.done(resumed.job_id as JobId)).resolves.toMatchObject({
      status: 'completed',
      detail: 'Stage 4C runtime restored',
    })
  })

  it('caps ephemeral repair at three failed drafts without persisting a formal candidate', async () => {
    const value = fixture({ validatorOk: false })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'PROPOSAL_FAILED' })

    const state = value.generation.status(PROFILE_ID, value.request.run_id).state
    expect(value.proposer.requests.map(request => request.attempt)).toEqual([1, 2, 3])
    expect(value.proposer.requests.every(request => request.max_attempts === 3)).toBe(true)
    expect(value.proposer.requests[1]?.previous_failure).toMatch(/fixture rejected/iu)
    expect(state.attempts).toHaveLength(3)
    expect(state.attempts.every(attempt => attempt.status === 'failed')).toBe(true)
    expect(state).toMatchObject({ status: 'failed', phase: 'proposing', formal_candidate_persisted: false })
    expect(value.evolution.status(PROFILE_ID).state).toMatchObject({ open_candidate_id: null, generation: 0 })
    expect(value.experiment.starts).toHaveLength(0)
  })

  it('gives the next draft concise actionable feedback while retaining full validation evidence', async () => {
    const validatorReason = [
      'AutoDataCoreError: plugin pipeline produced no selected records',
      '    at runDataCore (/root/autodata/lib/core/runner.js:292:15)',
      '    at main (/root/autodata/lib/evolution/validator-worker.js:93:9)',
    ].join('\n')
    const value = fixture({ validatorOk: false, validatorReason })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'PROPOSAL_FAILED' })

    const feedback = value.proposer.requests[1]?.previous_failure
    expect(feedback).toContain('item.record.source.record_id')
    expect(feedback).not.toContain('at runDataCore')
    expect(feedback?.length).toBeLessThanOrEqual(1000)
    expect(value.generation.status(PROFILE_ID, value.request.run_id).state.attempts[0]?.failure)
      .toBe(validatorReason)
  })

  it('persists the one-formal-H1 claim even when all ephemeral drafts fail', async () => {
    const value = fixture({ validatorOk: false })
    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'PROPOSAL_FAILED' })
    await value.generation.dispose()

    const restarted = restartGeneration(value)
    expect(() => restarted.controller.start({
      ...value.request,
      run_id: 'generation-two',
      experiment_run_id: 'experiment-h1-two',
      candidate_id: 'candidate-h1-two',
    })).toThrowError(expect.objectContaining({ code: 'RUN_EXISTS' }))
  })

  it('replays the exact claim after a crash before generation publication', async () => {
    const value = fixture()
    const ledger = (value.generation as unknown as {
      ledger: { initialize(state: GenerationState, artifacts: Readonly<Record<string, string>>): GenerationState }
    }).ledger
    vi.spyOn(ledger, 'initialize').mockImplementationOnce(() => {
      throw new Error('simulated crash after durable claim')
    })

    expect(() => value.generation.start(value.request)).toThrow(/simulated crash after durable claim/iu)
    expect(existsSync(resolve(value.root, 'generations', PROFILE_ID, 'first-h1-claim.json'))).toBe(true)

    const started = value.generation.start(value.request)
    await expect(value.jobs.done(started.job_id as JobId)).resolves.toMatchObject({ status: 'completed' })
  })

  it('refuses legacy generation history that predates the durable first-H1 claim', () => {
    const value = fixture()
    const profileDirectory = resolve(value.root, 'generations', PROFILE_ID)
    mkdirSync(resolve(profileDirectory, 'legacy-formal-generation'), { recursive: true })

    expect(() => value.generation.start(value.request)).toThrowError(
      expect.objectContaining({ code: 'RUN_EXISTS' }),
    )
    expect(existsSync(resolve(profileDirectory, 'first-h1-claim.json'))).toBe(false)
    expect(value.proposer.requests).toHaveLength(0)
  })

  it('refuses referenced or orphan formal candidate history even when H0 remains active', async () => {
    const referenced = fixture()
    await referenced.evolution.submitAndValidateCandidate(PROFILE_ID, {
      candidate_id: 'prior-h1',
      strategy_version: STRATEGY_VERSION,
      host_source: HOST_SOURCE,
      capabilities: ['data-select'],
    })
    referenced.evolution.abandonCandidate(PROFILE_ID, 'prior-h1')
    expect(referenced.evolution.status(PROFILE_ID).state).toMatchObject({
      generation: 0,
      active_candidate_id: 'h0',
      open_candidate_id: null,
    })
    expect(() => referenced.generation.start(referenced.request)).toThrowError(
      expect.objectContaining({ code: 'RUN_EXISTS' }),
    )

    const orphan = fixture()
    orphan.store.saveCandidate({
      manifest: {
        schema_version: 'autodata-candidate-manifest-2',
        candidate_id: 'orphan-h1',
        profile_id: PROFILE_ID,
        generation: 1,
        parent_candidate_id: 'h0',
        strategy_version: STRATEGY_VERSION,
        capabilities: ['data-select'],
      },
      host_source: HOST_SOURCE,
    })
    expect(orphan.evolution.status(PROFILE_ID).state.candidates).toHaveLength(1)
    expect(() => orphan.generation.start(orphan.request)).toThrowError(
      expect.objectContaining({ code: 'RUN_EXISTS' }),
    )
  })

  it('requires every persisted generation state to retain its matching first-H1 claim', async () => {
    const value = fixture({ validatorOk: false })
    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'PROPOSAL_FAILED' })
    rmSync(resolve(value.root, 'generations', PROFILE_ID, 'first-h1-claim.json'))

    expect(() => value.generation.status(PROFILE_ID, value.request.run_id)).toThrowError(
      expect.objectContaining({ code: 'STATE_CORRUPT' }),
    )
  })

  it('rejects an H0 artifact that no longer matches the durable baseline', async () => {
    const value = fixture()
    const reportPath = resolve(value.request.baseline_run_directory, 'evaluation-report.json')
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    writeJson(reportPath, { ...report, score: 0.6 })

    expect(() => value.generation.start(value.request)).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_INVALID' }),
    )
    expect(value.proposer.requests).toHaveLength(0)
    expect(value.experiment.starts).toHaveLength(0)
  })

  it('reconciles a candidate committed just before the generation ledger update', async () => {
    const value = fixture()
    const submit = value.evolution.submitAndValidateCandidate.bind(value.evolution)
    vi.spyOn(value.evolution, 'submitAndValidateCandidate').mockImplementationOnce(async (profileId, input) => {
      await submit(profileId, input)
      throw new Error('simulated crash after candidate commit')
    })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'RECOVERY_REQUIRED' })
    expect(value.generation.status(PROFILE_ID, value.request.run_id).state).toMatchObject({
      status: 'recovery_required',
      phase: 'candidate_ready',
      formal_candidate_persisted: false,
    })
    expect(value.evolution.status(PROFILE_ID).state).toMatchObject({ open_candidate_id: CANDIDATE_ID })
    await value.generation.dispose()

    const restarted = restartGeneration(value)
    const resumed = restarted.controller.resume(PROFILE_ID, value.request.run_id)
    await expect(restarted.jobs.done(resumed.job_id as JobId)).resolves.toMatchObject({ status: 'completed' })

    expect(restarted.controller.status(PROFILE_ID, value.request.run_id).state).toMatchObject({
      status: 'succeeded',
      phase: 'complete',
      formal_candidate_persisted: true,
      decision: { accepted: true },
    })
    expect(value.proposer.requests).toHaveLength(1)
    expect(value.materializer.requests).toHaveLength(2)
    expect(value.experiment.starts).toHaveLength(1)
  })

  it('recovers a complete draft published just before candidate_ready state', async () => {
    const value = fixture()
    const ledger = (value.generation as unknown as {
      ledger: { saveState(state: GenerationState): GenerationState }
    }).ledger
    const saveState = ledger.saveState.bind(ledger)
    let injected = 0
    const spy = vi.spyOn(ledger, 'saveState').mockImplementation((state) => {
      if (
        (state.phase === 'candidate_ready' && injected === 0)
        || (state.phase === 'proposing' && state.attempts.length === 1 && injected === 1)
      ) {
        injected += 1
        throw new Error('simulated crash after complete draft publication')
      }
      return saveState(state)
    })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'RECOVERY_REQUIRED' })
    expect(value.generation.status(PROFILE_ID, value.request.run_id).state).toMatchObject({
      status: 'recovery_required',
      phase: 'proposing',
      attempts: [],
    })
    spy.mockRestore()
    await value.generation.dispose()

    const restarted = restartGeneration(value)
    const resumed = restarted.controller.resume(PROFILE_ID, value.request.run_id)
    await expect(restarted.jobs.done(resumed.job_id as JobId)).resolves.toMatchObject({ status: 'completed' })
    const state = restarted.controller.status(PROFILE_ID, value.request.run_id).state
    expect(state).toMatchObject({ status: 'succeeded', formal_candidate_persisted: true })
    expect(state.attempts.map(attempt => attempt.status)).toEqual(['passed'])
    expect(value.proposer.requests).toHaveLength(1)
    expect(value.materializer.requests).toHaveLength(4)
  })

  it('recovers an orphan proposal error as one consumed draft', async () => {
    const value = fixture()
    const proposer = value.proposer as ScriptedProposer
    let proposal = 0
    const originalCreate = proposer.create.bind(proposer)
    vi.spyOn(proposer, 'create').mockImplementation(async () => {
      const session = await originalCreate()
      return {
        ...session,
        propose: async (request, signal) => {
          proposal += 1
          if (proposal === 1) throw new Error('simulated proposal failure')
          return session.propose(request, signal)
        },
      }
    })
    const ledger = (value.generation as unknown as {
      ledger: { saveState(state: GenerationState): GenerationState }
    }).ledger
    const saveState = ledger.saveState.bind(ledger)
    let interrupted = false
    const saveSpy = vi.spyOn(ledger, 'saveState').mockImplementation((state) => {
      if (!interrupted && state.phase === 'proposing' && state.attempts.length === 1) {
        interrupted = true
        throw new Error('simulated crash after proposal error publication')
      }
      return saveState(state)
    })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'RECOVERY_REQUIRED' })
    expect(value.generation.status(PROFILE_ID, value.request.run_id).state).toMatchObject({
      status: 'recovery_required',
      phase: 'proposing',
      attempts: [],
    })
    saveSpy.mockRestore()
    await value.generation.dispose()

    const restarted = restartGeneration(value)
    const resumed = restarted.controller.resume(PROFILE_ID, value.request.run_id)
    await expect(restarted.jobs.done(resumed.job_id as JobId)).resolves.toMatchObject({ status: 'completed' })
    const state = restarted.controller.status(PROFILE_ID, value.request.run_id).state
    expect(state.attempts.map(attempt => attempt.status)).toEqual(['failed', 'passed'])
    expect(state.attempts[0]?.failure).toMatch(/simulated proposal failure/iu)
  })

  it('rejects an orphan proposal error accompanied by any other draft artifact', async () => {
    const value = fixture()
    const proposer = value.proposer as ScriptedProposer
    const originalCreate = proposer.create.bind(proposer)
    vi.spyOn(proposer, 'create').mockImplementation(async () => {
      const session = await originalCreate()
      return {
        ...session,
        propose: async () => { throw new Error('simulated proposal failure') },
      }
    })
    const ledger = (value.generation as unknown as {
      ledger: { saveState(state: GenerationState): GenerationState }
    }).ledger
    const saveState = ledger.saveState.bind(ledger)
    let interrupted = false
    const saveSpy = vi.spyOn(ledger, 'saveState').mockImplementation((state) => {
      if (!interrupted && state.phase === 'proposing' && state.attempts.length === 1) {
        interrupted = true
        throw new Error('simulated crash after proposal error publication')
      }
      return saveState(state)
    })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'RECOVERY_REQUIRED' })
    const draftDirectory = resolve(
      value.root,
      'generations',
      PROFILE_ID,
      value.request.run_id,
      'attempts',
      'draft-01',
    )
    writeFileSync(resolve(draftDirectory, 'package-host.js'), HOST_SOURCE)
    saveSpy.mockRestore()
    await value.generation.dispose()

    const restarted = restartGeneration(value)
    const resumed = restarted.controller.resume(PROFILE_ID, value.request.run_id)
    await expect(restarted.jobs.done(resumed.job_id as JobId)).resolves.toMatchObject({
      status: 'failed',
      detail: 'ARTIFACT_INVALID',
    })
    expect(restarted.controller.status(PROFILE_ID, value.request.run_id).state).toMatchObject({
      status: 'failed',
      failure: { code: 'ARTIFACT_INVALID' },
      attempts: [],
    })
  })

  it('refuses a materialized payload changed after the two-process gate', async () => {
    const value = fixture()
    vi.spyOn(value.evolution, 'submitAndValidateCandidate').mockRejectedValueOnce(
      new Error('simulated crash before candidate commit'),
    )

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'RECOVERY_REQUIRED' })
    const interrupted = value.generation.status(PROFILE_ID, value.request.run_id).state
    expect(interrupted.materialized_data_path).toBeDefined()
    writeJson(interrupted.materialized_data_path as string, { tampered: true })
    await value.generation.dispose()

    const restarted = restartGeneration(value)
    const resumed = restarted.controller.resume(PROFILE_ID, value.request.run_id)
    await expect(restarted.jobs.done(resumed.job_id as JobId)).resolves.toMatchObject({
      status: 'failed',
      detail: 'ARTIFACT_INVALID',
    })
    expect(value.proposer.requests).toHaveLength(1)
    expect(value.experiment.starts).toHaveLength(0)
  })

  it('marks every post-candidate failure recoverable and resumes without reproposal', async () => {
    const value = fixture({ experimentStartFailures: 1 })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed' })
    expect(value.generation.status(PROFILE_ID, value.request.run_id).state).toMatchObject({
      status: 'recovery_required',
      formal_candidate_persisted: true,
      experiment_started: true,
    })
    await value.generation.dispose()

    const restarted = restartGeneration(value)
    const resumed = restarted.controller.resume(PROFILE_ID, value.request.run_id)
    await expect(restarted.jobs.done(resumed.job_id as JobId)).resolves.toMatchObject({ status: 'completed' })
    expect(restarted.controller.status(PROFILE_ID, value.request.run_id).state.status).toBe('succeeded')
    expect(value.proposer.requests).toHaveLength(1)
    expect(value.materializer.requests).toHaveLength(2)
    expect(value.experiment.starts).toHaveLength(1)
  })

  it('fails closed when the durable H1 experiment is terminal', async () => {
    const value = fixture({ experimentTerminalFailure: true })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'failed', detail: 'EXPERIMENT_FAILED' })
    expect(value.generation.status(PROFILE_ID, value.request.run_id).state).toMatchObject({
      status: 'failed',
      phase: 'experiment',
      formal_candidate_persisted: true,
      failure: { code: 'EXPERIMENT_FAILED' },
    })
    expect(value.evolution.status(PROFILE_ID).state).toMatchObject({
      active_candidate_id: 'h0',
      open_candidate_id: null,
    })
    expect(value.evolution.status(PROFILE_ID).state.candidates).toContainEqual(expect.objectContaining({
      candidate_id: CANDIDATE_ID,
      status: 'rejected',
    }))
    expect(value.runtime.ensured).toContain(null)
    expect(value.generation.resume(PROFILE_ID, value.request.run_id).job_id).toBeUndefined()
  })

  it('repairs a nondeterministic two-run materialization and accepts the one formal H1', async () => {
    const value = fixture({ materializationVariants: ['first-a', 'first-b', 'stable', 'stable'] })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'completed' })

    const state = value.generation.status(PROFILE_ID, value.request.run_id).state
    expect(value.materializer.requests).toHaveLength(4)
    expect(value.proposer.requests.map(request => request.attempt)).toEqual([1, 2])
    expect(value.proposer.requests[1]?.previous_failure).toMatch(/materializations differ/iu)
    expect(state.attempts.map(attempt => attempt.status)).toEqual(['failed', 'passed'])
    expect(state).toMatchObject({
      status: 'succeeded',
      phase: 'complete',
      formal_candidate_persisted: true,
      decision: { accepted: true, candidate_score: 1, baseline_score: BASELINE_SCORE },
    })
    const evolution = value.evolution.status(PROFILE_ID)
    expect(evolution.state).toMatchObject({ active_candidate_id: CANDIDATE_ID, open_candidate_id: null, generation: 1 })
    expect(evolution.state.candidates.filter(candidate => candidate.candidate_id !== 'h0')).toHaveLength(1)
    expect(value.runtime.activated).toEqual([CANDIDATE_ID])
    expect(value.evolution.feedback(PROFILE_ID)).toMatchObject({ candidate_id: CANDIDATE_ID, split: 'B_search' })
    expect(value.store.listFeedback(PROFILE_ID).map(feedback => feedback.candidate_id).sort()).toEqual([CANDIDATE_ID, 'h0'].sort())
  })

  it.each(['harness', 'seed', 'source', 'provenance', 'rank'] as const)(
    'rejects a deterministic materialization with invalid %s binding evidence',
    async materializationCorruption => {
      const value = fixture({ materializationCorruption })

      await expect(startAndWait(value)).resolves.toMatchObject({
        status: 'failed',
        detail: 'PROPOSAL_FAILED',
      })
      const state = value.generation.status(PROFILE_ID, value.request.run_id).state
      expect(state).toMatchObject({ formal_candidate_persisted: false, status: 'failed' })
      expect(value.evolution.status(PROFILE_ID).state.open_candidate_id).toBeNull()
      expect(value.experiment.starts).toHaveLength(0)
    },
  )

  it('rejects an oversized compiled runtime plan before persisting or experimenting on H1', async () => {
    const value = fixture({ materializationCorruption: 'oversized-plan' })

    await expect(startAndWait(value)).resolves.toMatchObject({
      status: 'failed',
      detail: 'PROPOSAL_FAILED',
    })
    const state = value.generation.status(PROFILE_ID, value.request.run_id).state
    expect(state.attempts).toHaveLength(3)
    expect(state.attempts.every(attempt => attempt.failure?.includes('cannot be compiled safely'))).toBe(true)
    expect(state.formal_candidate_persisted).toBe(false)
    expect(state.experiment_started).toBeUndefined()
    expect(value.evolution.status(PROFILE_ID).state.open_candidate_id).toBeNull()
    expect(value.experiment.starts).toHaveLength(0)
  })

  it('keeps H0 active and does not register H1 B_search feedback after rejection', async () => {
    const value = fixture({ candidateScore: BASELINE_SCORE })

    await expect(startAndWait(value)).resolves.toMatchObject({ status: 'completed' })

    const state = value.generation.status(PROFILE_ID, value.request.run_id).state
    expect(state).toMatchObject({
      status: 'succeeded',
      phase: 'complete',
      decision: { accepted: false, candidate_score: BASELINE_SCORE, baseline_score: BASELINE_SCORE },
    })
    expect(state.feedback_id).toBeUndefined()
    expect(value.evolution.status(PROFILE_ID).state).toMatchObject({
      active_candidate_id: 'h0',
      open_candidate_id: null,
      generation: 0,
    })
    expect(value.runtime.activated).toEqual([])
    expect(value.runtime.ensured).toContain(null)
    expect(value.evolution.feedback(PROFILE_ID)).toMatchObject({
      feedback_id: 'h0-search-feedback',
      candidate_id: 'h0',
    })
    expect(value.store.listFeedback(PROFILE_ID).map(feedback => feedback.candidate_id)).toEqual(['h0'])
    expect(existsSync(resolve(state.run_directory, 'h1-b-search-results.json'))).toBe(true)
    expect(existsSync(resolve(state.run_directory, 'evolution-feedback.json'))).toBe(false)
  })

  it('revalidates all completed evidence before restoring the accepted runtime', async () => {
    const value = fixture()
    await completeGeneration(value)
    const proposals = value.proposer.requests.length
    const materializations = value.materializer.requests.length
    await value.generation.dispose()

    const restarted = restartGeneration(value)
    const resumed = restarted.controller.resume(PROFILE_ID, value.request.run_id)
    await expect(restarted.jobs.done(resumed.job_id as JobId)).resolves.toMatchObject({
      status: 'completed',
      detail: 'Stage 4C runtime restored',
    })
    expect(value.proposer.requests).toHaveLength(proposals)
    expect(value.materializer.requests).toHaveLength(materializations)
    expect(value.runtime.ensured.at(-1)).toBe(CANDIDATE_ID)
  })

  it.each([
    ['second materialization', (value: ReturnType<typeof fixture>, state: GenerationState) => {
      writeJson(resolve(dirname(state.candidate_source_path as string), 'materialization-2.json'), { tampered: true })
    }],
    ['proposal context', (_value: ReturnType<typeof fixture>, state: GenerationState) => {
      writeJson(resolve(state.run_directory, 'proposal-context.json'), { tampered: true })
    }],
    ['source lineage', (_value: ReturnType<typeof fixture>, state: GenerationState) => {
      writeJson(resolve(state.run_directory, 'source-lineage.json'), { tampered: true })
    }],
    ['experiment contract', (value: ReturnType<typeof fixture>) => {
      const path = resolve(value.root, 'experiments', PROFILE_ID, value.request.experiment_run_id, 'experiment-contract.json')
      writeFileSync(path, `${readFileSync(path, 'utf8')} `)
    }],
    ['evaluation result', (value: ReturnType<typeof fixture>) => {
      writeJson(resolve(value.root, 'experiments', PROFILE_ID, value.request.experiment_run_id, 'attempts/eval-01/result.json'), { tampered: true })
    }],
    ['evaluation predictions', (value: ReturnType<typeof fixture>) => {
      writeFileSync(resolve(value.root, 'experiments', PROFILE_ID, value.request.experiment_run_id, 'attempts/eval-01/predictions.jsonl'), '{}\n')
    }],
    ['evaluation report', (value: ReturnType<typeof fixture>) => {
      writeJson(resolve(value.root, 'experiments', PROFILE_ID, value.request.experiment_run_id, 'evaluation-report.json'), { tampered: true })
    }],
    ['experiment decision', (value: ReturnType<typeof fixture>) => {
      writeJson(resolve(value.root, 'experiments', PROFILE_ID, value.request.experiment_run_id, 'decision.json'), { tampered: true })
    }],
    ['experiment B_search sidecar', (value: ReturnType<typeof fixture>) => {
      writeJson(resolve(value.root, 'experiments', PROFILE_ID, value.request.experiment_run_id, 'b-search-results.json'), { tampered: true })
    }],
    ['Generation decision copy', (_value: ReturnType<typeof fixture>, state: GenerationState) => {
      writeJson(resolve(state.run_directory, 'decision.json'), { tampered: true })
    }],
    ['Generation B_search copy', (_value: ReturnType<typeof fixture>, state: GenerationState) => {
      writeJson(resolve(state.run_directory, 'h1-b-search-results.json'), { tampered: true })
    }],
    ['accepted feedback copy', (_value: ReturnType<typeof fixture>, state: GenerationState) => {
      writeJson(resolve(state.run_directory, 'evolution-feedback.json'), { tampered: true })
    }],
  ] as const)('fails status closed when completed %s evidence is changed', async (_label, tamper) => {
    const value = fixture()
    const state = await completeGeneration(value)
    const runtimeCalls = value.runtime.ensured.length
    const sessions = value.proposer.sessions

    tamper(value, state)

    expect(() => value.generation.status(PROFILE_ID, value.request.run_id)).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_INVALID' }),
    )
    expect(value.runtime.ensured).toHaveLength(runtimeCalls)
    expect(value.proposer.sessions).toBe(sessions)
  })

  it('fails completed status closed when the durable candidate runtime binding changes', async () => {
    const value = fixture()
    await completeGeneration(value)
    const snapshot = value.store.loadConsistentSnapshot(PROFILE_ID)
    const stored = snapshot.candidate_packages[0] as CandidatePackage
    vi.spyOn(value.store, 'loadConsistentSnapshot').mockReturnValue({
      ...snapshot,
      candidate_packages: [{
        ...stored,
        manifest: {
          ...stored.manifest,
          metadata: { ...stored.manifest.metadata, runtime_binding: { tampered: true } },
        },
      }],
    })

    expect(() => value.generation.status(PROFILE_ID, value.request.run_id)).toThrowError(
      expect.objectContaining({ code: 'DECISION_FAILED' }),
    )
  })

  it('fails completed status closed when Evolution terminal state conflicts with the decision', async () => {
    const value = fixture()
    await completeGeneration(value)
    const snapshot = value.store.loadConsistentSnapshot(PROFILE_ID)
    vi.spyOn(value.store, 'loadConsistentSnapshot').mockReturnValue({
      ...snapshot,
      state: { ...snapshot.state, active_candidate_id: H0_CANDIDATE_ID },
    })

    expect(() => value.generation.status(PROFILE_ID, value.request.run_id)).toThrowError(
      expect.objectContaining({ code: 'DECISION_FAILED' }),
    )
  })

  it('resumes after cancellation at the durable experiment boundary without reproposing H1', async () => {
    const value = fixture({ experimentPending: true })
    const started = value.generation.start(value.request)
    expect(started.job_id).toBeDefined()
    await vi.waitFor(() => {
      expect(value.generation.status(PROFILE_ID, value.request.run_id).state.experiment_started).toBe(true)
    })

    const cancelled = await value.generation.cancel(PROFILE_ID, value.request.run_id)
    expect(cancelled.state).toMatchObject({ status: 'recovery_required', formal_candidate_persisted: true, experiment_started: true })
    await expect(value.jobs.done(started.job_id as JobId)).resolves.toMatchObject({ status: 'killed' })
    value.experiment.complete(PROFILE_ID, value.request.experiment_run_id)
    await value.generation.dispose()

    const restarted = restartGeneration(value)

    const resumed = restarted.controller.resume(PROFILE_ID, value.request.run_id)
    expect(resumed.job_id).toBeDefined()
    await expect(restarted.jobs.done(resumed.job_id as JobId)).resolves.toMatchObject({ status: 'completed' })

    expect(restarted.controller.status(PROFILE_ID, value.request.run_id).state).toMatchObject({
      status: 'succeeded',
      phase: 'complete',
      decision: { accepted: true },
    })
    expect(value.proposer.requests).toHaveLength(1)
    expect(value.materializer.requests).toHaveLength(2)
    expect(value.experiment.starts).toHaveLength(1)
    expect(value.evolution.status(PROFILE_ID).state).toMatchObject({ active_candidate_id: CANDIDATE_ID, open_candidate_id: null })
  })
})

import { Context } from '@deepseek-ai/cordis'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTODATA_RUN_SUMMARY_VERSION,
  CANONICAL_TRAJECTORY_SCHEMA_VERSION,
  LOGICAL_TRAINING_UNIT_SCHEMA_VERSION,
} from '../src/core/index.js'
import { canonicalJson } from '../src/core/json.js'
import type { DataRunResult, JsonObject } from '../src/core/types.js'
import { createFrozenSelectionRuntimeBinding } from '../src/evolution/candidate-sandbox.js'
import { EvolutionController } from '../src/evolution/controller.js'
import { MemoryEvolutionStore } from '../src/evolution/store.js'
import type { CandidateValidator } from '../src/evolution/validator.js'
import type { EvolutionRuntime, EvolutionRuntimeAgent, RuntimeActivation } from '../src/evolution/runtime.js'
import type { CandidatePackage, TaskProfile } from '../src/evolution/types.js'
import { ExperimentController } from '../src/experiment/controller.js'
import { EXPERIMENT_PREDICTION_VERSION } from '../src/experiment/predictions.js'
import { experimentRJobName } from '../src/experiment/state.js'
import { GENERATION_MATERIALIZATION_VERSION } from '../src/generation/types.js'
import {
  EXPERIMENT_CONTRACT_VERSION,
  EXPERIMENT_EVAL_RESULT_VERSION,
  EXPERIMENT_TRAIN_RESULT_VERSION,
  type ExperimentCommandResult,
  type ExperimentJobHooks,
  type ExperimentJobRegistry,
  type ExperimentRJobBackend,
} from '../src/experiment/types.js'
import type { Stage4ARJobObservation, Stage4ARJobSpec } from '../src/stage4a/types.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fixtureData(): DataRunResult {
  const source = {
    adapter_id: 'openai-tool-trajectory',
    adapter_version: '2',
    dataset_id: 'nex-agi/agent-sft',
    dataset_revision: 'd8d4de5643f9fe9d3fc3f89b3d55b8709ddc35c9',
  }
  const canonicalRecords = Array.from({ length: 100 }, (_, index) => ({
    schema_version: CANONICAL_TRAJECTORY_SCHEMA_VERSION,
    source: { ...source, record_id: `record-${String(index)}`, record_index: index, record_line: index + 1 },
    messages: [{ role: 'user' as const, content: `question ${String(index)}` }],
    tools: [],
  }))
  const logicalTrainingView = Array.from({ length: 236 }, (_, index) => ({
    schema_version: LOGICAL_TRAINING_UNIT_SCHEMA_VERSION,
    id: `unit-${String(index)}`,
    source: { ...source, record_id: `record-${String(index % 100)}`, record_index: index % 100, record_line: index % 100 + 1 },
    assistant_message_index: 0,
    messages: [{ role: 'assistant' as const, content: `answer ${String(index)}` }],
    tools: [],
    selection_rank: index,
    plugin_provenance: [],
  }))
  return {
    canonical_records: canonicalRecords,
    logical_training_view: logicalTrainingView,
    summary: {
      summary_version: AUTODATA_RUN_SUMMARY_VERSION,
      harness_id: 'toolcall-h0',
      generation: 0,
      seed: 42,
      canonical_schema_version: CANONICAL_TRAJECTORY_SCHEMA_VERSION,
      logical_view_schema_version: LOGICAL_TRAINING_UNIT_SCHEMA_VERSION,
      source,
      plugins: [{ id: 'toolcall-h0', version: '3' }],
      counts: {
        source_records_read: 100,
        selected_source_records: 100,
        quarantined_source_records: 0,
        duplicate_source_records: 0,
        canonical_records: 100,
        logical_training_units: 236,
        validation_warnings: 0,
      },
      validation_warning_counts: {},
    },
  }
}

function candidateData(data: DataRunResult, pluginId: string, version: string): DataRunResult {
  const logical = data.logical_training_view.slice(0, 10).map((unit, index) => ({
    ...unit,
    selection_rank: index,
    plugin_provenance: [{ plugin_id: pluginId, plugin_version: version, note: `rank-${String(index)}` }],
  }))
  return {
    canonical_records: data.canonical_records,
    logical_training_view: logical,
    summary: {
      ...data.summary,
      harness_id: `${pluginId}-h1`,
      generation: 1,
      plugins: [{ id: pluginId, version }],
      counts: { ...data.summary.counts, logical_training_units: logical.length },
    },
  }
}

async function submitFormalCandidate(
  evolution: EvolutionController,
  baselineData: DataRunResult,
  candidateId: string,
  hostSource: string,
) {
  const profile = evolution.status('bfcl-v4').profile
  const strategyVersion = '1'
  const dataRun = candidateData(baselineData, profile.strategy_plugin_id, strategyVersion)
  const files = dataFiles(dataRun)
  const selectedRecordIds = dataRun.logical_training_view.map(unit => unit.source.record_id)
  const materializationSha256 = hash(canonicalJson({
    schema_version: GENERATION_MATERIALIZATION_VERSION,
    candidate_id: candidateId,
    host_source_sha256: hash(hostSource),
    source_pool_sha256: hash(files.canonical),
    canonical_jsonl_sha256: hash(files.canonical),
    logical_view_jsonl_sha256: hash(files.logical),
    run_summary_json_sha256: hash(files.summary),
    selected_record_ids: selectedRecordIds,
    data_run: dataRun,
  }))
  const binding = createFrozenSelectionRuntimeBinding({
    profile_id: profile.id,
    candidate_id: candidateId,
    generation: 1,
    parent_candidate_id: 'h0',
    plugin_id: profile.strategy_plugin_id,
    strategy_version: strategyVersion,
    host_source_sha256: hash(hostSource),
    source_pool_sha256: hash(files.canonical),
    materialization_sha256: materializationSha256,
    harness_id: dataRun.summary.harness_id,
    seed: dataRun.summary.seed,
    source: dataRun.summary.source,
    source_record_ids: dataRun.canonical_records.map(record => record.source.record_id),
    decisions: dataRun.logical_training_view.map(unit => ({
      record_id: unit.source.record_id,
      ...(unit.plugin_provenance[0]?.note === undefined ? {} : { note: unit.plugin_provenance[0].note }),
    })),
  })
  evolution.submitCandidate(profile.id, {
    candidate_id: candidateId,
    strategy_version: strategyVersion,
    host_source: hostSource,
    metadata: {
      generation_run_id: `generation-${candidateId}`,
      source_sha256: hash(hostSource),
      materialization_sha256: materializationSha256,
      runtime_binding: binding as unknown as JsonObject,
    },
  })
  await evolution.validateCandidate(profile.id, candidateId)
  return Object.freeze({
    dataRun,
    subject: Object.freeze({
      candidate_id: candidateId,
      generation: 1,
      plugin_id: profile.strategy_plugin_id,
      strategy_version: strategyVersion,
      host_source_sha256: hash(hostSource),
      runtime_plan_sha256: binding.runtime_plan_sha256,
      materialization_sha256: binding.materialization_sha256,
    }),
  })
}

function dataFiles(data: DataRunResult) {
  return {
    canonical: `${data.canonical_records.map(record => canonicalJson(record)).join('\n')}\n`,
    logical: `${data.logical_training_view.map(record => canonicalJson(record)).join('\n')}\n`,
    summary: `${canonicalJson(data.summary)}\n`,
  }
}

function caseIds(split: 'search' | 'dev'): string[] {
  return ['simple_python', 'multiple', 'parallel', 'parallel_multiple', 'irrelevance']
    .flatMap(category => Array.from({ length: 5 }, (_, index) => `${category}_${split}_${String(index)}`))
}

async function makeAssets(root: string, data: DataRunResult): Promise<{ assetRoot: string; commonRoot: string }> {
  const assetRoot = resolve(root, 'assets')
  const commonRoot = resolve(root, 'common')
  const files = dataFiles(data)
  const contract = {
    schema_version: EXPERIMENT_CONTRACT_VERSION,
    contract_id: 'stage4b-h0-baseline-1',
    profile: { id: 'bfcl-v4', benchmark: 'bfcl-v4', metric: 'equal_category_accuracy' },
    data: {
      dataset_id: 'nex-agi/agent-sft',
      dataset_subset: 'tool_calling',
      dataset_revision: 'd8d4de5643f9fe9d3fc3f89b3d55b8709ddc35c9',
      harness_id: 'toolcall-h0',
      seed: 42,
      canonical_records: 100,
      logical_training_units: 236,
      historical_training_tokens: 508_114,
      canonical_jsonl_sha256: hash(files.canonical),
      logical_view_jsonl_sha256: hash(files.logical),
      run_summary_json_sha256: hash(files.summary),
    },
    model: {
      id: 'Qwen/Qwen3.5-9B',
      revision: 'c202236235762e1c871ad0ccb60c8ee5ba337b9a',
      path: '/models/c202236235762e1c871ad0ccb60c8ee5ba337b9a',
      thinking: false,
      expected_parameters: 9_409_813_744,
    },
    execution: {
      container_image: 'registry.h.pjlab.org.cn/ailab/pytorch2.7.0-cuda12.8-cudnn9:v5',
      rjob_backoff_limit: 1,
      training_wheelhouse: { path: '/deps/train', manifest_sha256: '1'.repeat(64) },
      vllm_wheelhouse: { path: '/deps/vllm', manifest_sha256: '2'.repeat(64) },
      bfcl_wheelhouse: { path: '/deps/bfcl', manifest_sha256: '3'.repeat(64) },
    },
    training: {
      gpus: 4,
      gpu_family: 'H200',
      max_steps: 16,
      max_length: 8192,
      per_device_train_batch_size: 1,
      gradient_accumulation_steps: 4,
      tuner_type: 'full',
      precision: 'bf16',
      optimizer: 'adafactor',
      deepspeed: 'zero3',
      packing: true,
      padding_free: true,
      gradient_checkpointing: true,
      use_hf: true,
      check_model: false,
      template: 'qwen3_5',
      template_backend: 'swift',
      enable_thinking: false,
      add_non_thinking_prefix: true,
      loss_scale: 'default',
      is_binary_loss_scale: true,
      truncation_strategy: 'delete',
      split_dataset_ratio: 0,
      dataset_num_proc: 4,
      load_from_cache_file: false,
      strict: true,
      freeze_llm: false,
      freeze_vit: false,
      freeze_aligner: false,
      torch_dtype: 'bfloat16',
      bf16: true,
      attention_implementation: 'flash_attn',
      packing_length: 8192,
      packing_num_proc: 1,
      packing_strategy: 'sequential',
      learning_rate: 0.00001,
      lr_scheduler_type: 'cosine',
      warmup_ratio: 0.05,
      weight_decay: 0.1,
      vit_gradient_checkpointing: true,
      save_strategy: 'steps',
      save_steps: 16,
      save_total_limit: 1,
      save_only_model: false,
      logging_strategy: 'steps',
      logging_steps: 1,
      logging_first_step: true,
      report_to: ['none'],
      dataloader_num_workers: 0,
      seed: 42,
      data_seed: 42,
      add_version: false,
    },
    evaluation: {
      gpus: 1,
      gpu_family: 'H200',
      vllm_version: '0.19.1',
      tool_call_parser: 'qwen3_coder',
      bfcl_version: '2026.3.23',
      server: {
        dtype: 'bfloat16', tensor_parallel_size: 1, max_model_len: 8192,
        gpu_memory_utilization: 0.9, generation_config: 'vllm', enable_auto_tool_choice: true,
      },
      generation: {
        tool_choice: 'auto', parallel_tool_calls: true, temperature: 0, top_p: 1,
        max_tokens: 2048, seed: 42, n: 1, stream: false, include_reasoning: false,
        enable_thinking: false,
      },
      checker: { language: 'python', model_config: 'qwen3-8b-FC', underscore_to_dot: true },
      categories: ['simple_python', 'multiple', 'parallel', 'parallel_multiple', 'irrelevance'],
      cases_per_category_per_split: 5,
      case_ids: { B_search: caseIds('search'), B_dev: caseIds('dev') },
      macro: 'equal_category_accuracy',
    },
    retry: { scientific_retries: 0, infrastructure_retries_per_stage: 1 },
  }
  const assetFiles: Record<string, string> = {
    '.rjobignore': 'outputs/\nattempts/*/*/result.json\n',
    'experiment-contract.json': `${JSON.stringify(contract, null, 2)}\n`,
    'train.sh': '#!/bin/bash\n',
    'eval.sh': '#!/bin/bash\n',
    'python/autodata_stage4b/__init__.py': '',
    'python/autodata_stage4b/worker.py': '',
    'python/autodata_stage4b/bfcl_assets.py': '',
    'bfcl/selection.json': '{}\n',
    'bfcl/manifest.json': '{}\n',
    'bfcl/search.jsonl': '{}\n',
    'bfcl/dev.jsonl': '{}\n',
    'bfcl/test.jsonl': 'must-not-be-staged\n',
  }
  for (const [name, content] of Object.entries(assetFiles)) {
    const path = resolve(assetRoot, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  mkdirSync(commonRoot, { recursive: true })
  writeFileSync(resolve(commonRoot, '__init__.py'), '')
  writeFileSync(resolve(commonRoot, 'worker.py'), '')
  return { assetRoot, commonRoot }
}

function command(argv: readonly string[], stdout = ''): ExperimentCommandResult {
  return { argv, exit_code: 0, signal: null, stdout, stderr: '' }
}

class FakeJobs implements ExperimentJobRegistry {
  private sequence = 0
  private readonly hooks = new Map<string, ExperimentJobHooks>()
  private readonly outcomes = new Map<string, Promise<JobOutcome>>()
  attached = 0

  start(spec: Parameters<ExperimentJobRegistry['start']>[0]): JobId {
    if (this.attached === 0) throw new Error('missing experiment controller attachment')
    const id = JobId(`experiment-${String(++this.sequence)}`)
    const hooks = spec.run()
    this.hooks.set(id, hooks)
    this.outcomes.set(id, hooks.done)
    return id
  }

  get(id: JobId): { readonly status: string } {
    if (!this.hooks.has(id)) throw new Error('unknown job')
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
    if (outcome === undefined) throw new Error('unknown job')
    return outcome
  }
}

class Backend implements ExperimentRJobBackend {
  readonly calls: string[] = []
  readonly specs: Stage4ARJobSpec[] = []
  failFirstTrainRemotely = false
  failAllTrainRemotely = false
  failFirstTrainWithWorkerResult = false
  invalidFirstTrainResult = false
  ambiguousFirstTrainSubmit = false
  predictionCorruption?: 'malformed' | 'truncated' | 'divergent'
  evalScore: 0.8 | 1 = 0.8
  private firstTrainInspected = false

  async dryRun(spec: Stage4ARJobSpec): Promise<ExperimentCommandResult> {
    this.calls.push(`dry:${spec.rjob_name}`)
    return command(['rjob', 'submit', '--dry-run', 'true'])
  }

  async predict(spec: Stage4ARJobSpec): Promise<ExperimentCommandResult> {
    this.calls.push(`predict:${spec.rjob_name}`)
    return command(['rjob', 'submit', '--predict-only', 'true'], 'schedulable 1/1')
  }

  async submit(spec: Stage4ARJobSpec): Promise<ExperimentCommandResult> {
    this.calls.push(`submit:${spec.rjob_name}`)
    this.specs.push(spec)
    const failsRemotely = spec.stage === 'train' && (
      this.failAllTrainRemotely
      || (this.failFirstTrainRemotely && !spec.rjob_name.endsWith('-train-retry-2'))
    )
    if (failsRemotely) {
      const request = JSON.parse(readFileSync(spec.request_path, 'utf8')) as { output: { root: string } }
      mkdirSync(resolve(request.output.root, 'partial-checkpoint'), { recursive: true })
      writeFileSync(resolve(request.output.root, 'partial-checkpoint/shard.bin'), 'partial')
    } else {
      this.writeResult(spec)
    }
    if (this.ambiguousFirstTrainSubmit && spec.stage === 'train' && !spec.rjob_name.endsWith('-train-retry-2')) {
      this.ambiguousFirstTrainSubmit = false
      throw new Error('connection lost after create')
    }
    return command(['rjob', 'submit'])
  }

  async inspect(name: string): Promise<Stage4ARJobObservation> {
    this.calls.push(`inspect:${name}`)
    if (this.failAllTrainRemotely && (name.endsWith('-train') || name.endsWith('-train-retry-2'))) {
      return { status: 'failed', command: command(['rjob', 'get', name], 'Failed') }
    }
    if ((this.failFirstTrainRemotely || this.failFirstTrainWithWorkerResult) && name.endsWith('-train') && !this.firstTrainInspected) {
      this.firstTrainInspected = true
      return { status: 'failed', command: command(['rjob', 'get', name], 'Failed') }
    }
    return { status: 'succeeded', command: command(['rjob', 'get', name], 'Succeeded') }
  }

  async logs(name: string): Promise<ExperimentCommandResult> {
    this.calls.push(`logs:${name}`)
    return command(['rjob', 'logs', 'job', name], 'complete')
  }

  async stop(name: string): Promise<ExperimentCommandResult> {
    this.calls.push(`stop:${name}`)
    return command(['rjob', 'stop', name])
  }

  private writeResult(spec: Stage4ARJobSpec): void {
    const request = JSON.parse(readFileSync(spec.request_path, 'utf8')) as Record<string, any>
    const output = request.output as { root: string; result_json: string; checkpoint_dir?: string; predictions_jsonl?: string }
    mkdirSync(output.root, { recursive: true })
    if (spec.stage === 'train') {
      mkdirSync(output.checkpoint_dir as string, { recursive: true })
      writeFileSync(output.result_json, `${JSON.stringify({
        schema_version: EXPERIMENT_TRAIN_RESULT_VERSION,
        contract_id: request.contract_id,
        contract_sha256: request.contract_sha256,
        profile_id: request.profile_id,
        run_id: request.run_id,
        attempt: request.attempt,
        status: this.failFirstTrainWithWorkerResult && request.attempt === 1 ? 'failed' : 'passed',
        checkpoint_path: output.checkpoint_dir,
        checks: {
          gpu_count: 4,
          gpu_family: 'NVIDIA H200',
          model_revision: request.model.revision,
          trainable_parameters: request.model.expected_parameters,
          total_parameters: request.model.expected_parameters,
          global_step: this.invalidFirstTrainResult && request.attempt === 1 ? 15 : 16,
          finite_metrics: true,
          huggingface_weight_shards: 4,
          zero_optimizer_shards: 4,
          zero_model_state_shards: 4,
          fresh_process_reload: true,
          weights_changed: true,
        },
        failure: this.failFirstTrainWithWorkerResult && request.attempt === 1 ? 'worker rejected training output' : null,
      })}\n`, { flag: 'wx' })
      return
    }
    const categories = request.benchmark.categories as string[]
    const cases = ['B_search', 'B_dev'].flatMap(split => (request.benchmark.case_ids[split] as string[]).map(caseId => {
      const category = [...categories].sort((left, right) => right.length - left.length)
        .find(value => caseId.startsWith(`${value}_`)) as string
      const passed = this.evalScore === 1 || !caseId.endsWith('_0')
      return { case_id: caseId, split, category, passed, failure_summary: passed ? null : 'fixture failure' }
    }))
    const categoryScores = Object.fromEntries(['B_search', 'B_dev'].map(split => [split,
      Object.fromEntries(categories.map(category => [category, this.evalScore])),
    ]))
    const predictions = cases.map(value => ({
      schema_version: EXPERIMENT_PREDICTION_VERSION,
      ...value,
      tool_calls: value.category === 'irrelevance' ? [] : [{ fixture: '{"value":"ok"}' }],
    }))
    if (this.predictionCorruption === 'truncated') predictions.pop()
    if (this.predictionCorruption === 'divergent' && predictions[1] !== undefined) {
      predictions[1] = { ...predictions[1], passed: false, failure_summary: 'divergent fixture failure' }
    }
    const predictionLines = predictions.map(value => JSON.stringify(value))
    if (this.predictionCorruption === 'malformed') predictionLines[10] = '{invalid}'
    writeFileSync(output.predictions_jsonl as string, `${predictionLines.join('\n')}\n`, { flag: 'wx' })
    writeFileSync(output.result_json, `${JSON.stringify({
      schema_version: EXPERIMENT_EVAL_RESULT_VERSION,
      contract_id: request.contract_id,
      contract_sha256: request.contract_sha256,
      profile_id: request.profile_id,
      run_id: request.run_id,
      attempt: request.attempt,
      status: 'completed',
      checks: {
        gpu_count: 1,
        gpu_family: 'NVIDIA H200',
        model_revision: request.model.revision,
        vllm_version: request.runtime.vllm_version,
        tool_call_parser: request.runtime.tool_call_parser,
        loaded_weight_shards: 4,
      },
      cases,
      category_scores: categoryScores,
      macro_scores: { B_search: this.evalScore, B_dev: this.evalScore },
      predictions_path: output.predictions_jsonl,
      failure: null,
    })}\n`, { flag: 'wx' })
  }
}

class CandidateRuntime implements EvolutionRuntime {
  readonly activated: string[] = []
  readonly ensured: Array<string | null> = []

  async ensureActive(
    _profile: TaskProfile,
    candidate: CandidatePackage | null,
  ): Promise<void> {
    this.ensured.push(candidate?.manifest.candidate_id ?? null)
  }

  async activate(
    _profile: TaskProfile,
    _current: CandidatePackage | null,
    candidate: CandidatePackage,
  ): Promise<RuntimeActivation> {
    this.activated.push(candidate.manifest.candidate_id)
    return { async rollback() {} }
  }

  async dispose(): Promise<void> {}
}

class CancellationBackend extends Backend {
  inspectMode: 'running' | 'succeeded' | 'throw' = 'running'
  failStop = true

  override async inspect(name: string): Promise<Stage4ARJobObservation> {
    this.calls.push(`inspect:${name}`)
    if (this.inspectMode === 'throw') throw new Error('simulated cancellation inspection failure')
    return { status: this.inspectMode, command: command(['rjob', 'get', name], this.inspectMode) }
  }

  override async stop(name: string): Promise<ExperimentCommandResult> {
    this.calls.push(`stop:${name}`)
    if (this.failStop) throw new Error('simulated cancellation stop failure')
    return command(['rjob', 'stop', name])
  }
}

function sleepUntilAbort(_milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    void resolveSleep
  })
}

async function waitForMonitoring(controller: ExperimentController, runId: string): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (controller.status('bfcl-v4', runId).state.attempts.at(-1)?.status === 'monitoring') return
    await new Promise<void>(resolveTurn => setImmediate(resolveTurn))
  }
  throw new Error(`experiment ${runId} did not reach monitoring`)
}

async function fixture(
  backend = new Backend(),
  options: { readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'autodata-experiment-'))
  const data = fixtureData()
  const assets = await makeAssets(root, data)
  const runtime = new CandidateRuntime()
  const evolution = new EvolutionController({
    store: new MemoryEvolutionStore(),
    validator: {
      async validate(profile, candidate) {
        return {
          schema_version: 'autodata-candidate-validation-1',
          candidate_id: candidate.manifest.candidate_id,
          ok: true,
          plugin_id: profile.strategy_plugin_id,
          plugin_version: candidate.manifest.strategy_version,
        }
      },
    } satisfies CandidateValidator,
    runtime,
  })
  evolution.createProfile({
    id: 'bfcl-v4',
    benchmark: 'bfcl-v4',
    capabilities: ['data-select', 'data-filter', 'data-order'],
    acceptance: { metric: 'equal_category_accuracy' },
  })
  const jobs = new FakeJobs()
  const controller = new ExperimentController(context(), {
    evolution,
    run_root: resolve(root, 'runs'),
    staging_root: resolve(root, 'staging'),
    asset_root: assets.assetRoot,
    common_worker_root: assets.commonRoot,
    poll_interval_ms: 0,
    backend,
    jobs,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  })
  return { root, data, evolution, jobs, controller, backend, assets, runtime }
}

describe('Stage 4B ExperimentController', () => {
  it('uses a Stage 4B namespace and leaves room for the RJob task-name suffix', () => {
    expect(experimentRJobName('baseline-one', 'train', 1)).toBe('autodata-stage4b-baseline-one-train')
    const long = experimentRJobName(`r${'a'.repeat(47)}`, 'train', 2)
    expect(long).toMatch(/^autodata-stage4b-[a-z0-9-]+-train-retry-2$/u)
    expect(long).toHaveLength(57)
    expect(experimentRJobName(`r${'a'.repeat(47)}`, 'train', 2)).toBe(long)
  })

  it('runs train/eval, records B_search feedback, and registers the B_dev H0 baseline', async () => {
    const { controller, jobs, evolution, data, backend, root, assets } = await fixture()
    const started = controller.start({ profile_id: 'bfcl-v4', run_id: 'baseline-one', data_run: data })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('completed')
    const state = controller.status('bfcl-v4', 'baseline-one').state
    expect(state).toMatchObject({ status: 'succeeded', phase: 'complete' })
    expect(state.attempts.map(attempt => [attempt.stage, attempt.status])).toEqual([
      ['train', 'succeeded'], ['eval', 'succeeded'],
    ])
    const snapshot = evolution.status('bfcl-v4')
    expect(snapshot.state.active_evaluation).toMatchObject({ candidate_id: 'h0', split: 'B_dev', score: 0.8 })
    const feedback = evolution.feedback('bfcl-v4')
    expect(feedback).toMatchObject({ candidate_id: 'h0', split: 'B_search' })
    expect(feedback?.artifact_path).toMatch(/b-search-results\.json$/u)
    const feedbackArtifact = JSON.parse(readFileSync(feedback?.artifact_path as string, 'utf8')) as {
      cases: Array<{ split: string }>
    }
    expect(feedbackArtifact.cases).toHaveLength(25)
    expect(feedbackArtifact.cases.every(value => value.split === 'B_search')).toBe(true)
    expect(readFileSync(feedback?.artifact_path as string, 'utf8')).not.toContain('B_dev')
    expect(backend.specs.every(spec =>
      spec.request_environment === 'AUTODATA_EXPERIMENT_REQUEST' && spec.backoff_limit === 1)).toBe(true)
    expect(existsSync(resolve(root, 'staging/baseline-one/bfcl/test.jsonl'))).toBe(false)
    expect(readFileSync(resolve(root, 'runs/bfcl-v4/baseline-one/state.json'), 'utf8')).not.toContain('job_id')

    const disconnectedEvolution = new EvolutionController({
      store: new MemoryEvolutionStore(),
      validator: { async validate() { throw new Error('not used') } } satisfies CandidateValidator,
    })
    disconnectedEvolution.createProfile({
      id: 'bfcl-v4',
      benchmark: 'bfcl-v4',
      capabilities: ['data-select', 'data-filter', 'data-order'],
      acceptance: { metric: 'equal_category_accuracy' },
    })
    const disconnected = new ExperimentController(context(), {
      evolution: disconnectedEvolution,
      run_root: resolve(root, 'runs'),
      staging_root: resolve(root, 'staging'),
      asset_root: assets.assetRoot,
      common_worker_root: assets.commonRoot,
      backend: new Backend(),
      jobs: new FakeJobs(),
    })
    expect(() => disconnected.status('bfcl-v4', 'baseline-one')).toThrowError(/baseline is inconsistent/iu)
    await disconnected.dispose()
    await disconnectedEvolution.dispose()

    expect(() => controller.start({ profile_id: 'bfcl-v4', run_id: 'second-baseline', data_run: data }))
      .toThrowError(/already has a registered H0 baseline/iu)
    await controller.dispose()
  })

  it('freezes and decides one validated H1 without replacing H0 feedback on rejection', async () => {
    const { controller, jobs, evolution, data, root } = await fixture()
    const baseline = controller.start({ profile_id: 'bfcl-v4', run_id: 'baseline-for-h1', data_run: data })
    expect((await jobs.done(baseline.job_id as JobId)).status).toBe('completed')
    const hostSource = 'return { inject: ["autodata"], apply() {} }'
    const { dataRun, subject } = await submitFormalCandidate(
      evolution,
      data,
      'candidate-one',
      hostSource,
    )
    const started = controller.start({
      profile_id: 'bfcl-v4',
      run_id: 'candidate-one-run',
      data_run: dataRun,
      subject,
    }, { id: 'experiment-agent' } as EvolutionRuntimeAgent)
    expect((await jobs.done(started.job_id as JobId)).status).toBe('completed')

    const state = controller.status('bfcl-v4', 'candidate-one-run').state
    expect(state).toMatchObject({
      status: 'succeeded',
      phase: 'complete',
      candidate_id: 'candidate-one',
      candidate_generation: 1,
      decision: { candidate_id: 'candidate-one', accepted: false, reason: 'not_strictly_better' },
    })
    expect(state.feedback_id).toBeUndefined()
    const contract = JSON.parse(readFileSync(resolve(state.run_directory, 'experiment-contract.json'), 'utf8')) as Record<string, any>
    expect(contract).toMatchObject({
      contract_id: 'stage4c-candidate-1',
      subject,
      data: { canonical_records: 100, logical_training_units: 10 },
    })
    expect(contract.data.canonical_jsonl_sha256).toBe(JSON.parse(readFileSync(
      resolve(root, 'runs/bfcl-v4/baseline-for-h1/experiment-contract.json'),
      'utf8',
    )).data.canonical_jsonl_sha256)
    expect(existsSync(resolve(root, 'staging/candidate-one-run/bfcl/test.jsonl'))).toBe(false)
    expect(evolution.status('bfcl-v4').state).toMatchObject({
      active_candidate_id: 'h0',
      open_candidate_id: null,
      current_feedback_id: expect.stringMatching(/^h0-search-/u),
    })
    expect(evolution.status('bfcl-v4').state.candidates.find(value => value.candidate_id === 'candidate-one'))
      .toMatchObject({ status: 'rejected', evaluation: { score: 0.8 } })
    await controller.dispose()
  })

  it.each(['runtime_plan_sha256', 'materialization_sha256'] as const)(
    'rejects an H1 subject whose %s differs from the durable candidate binding',
    async field => {
      const { controller, jobs, evolution, data } = await fixture()
      const baseline = controller.start({
        profile_id: 'bfcl-v4',
        run_id: `baseline-for-bad-${field.replaceAll('_', '-')}`,
        data_run: data,
      })
      expect((await jobs.done(baseline.job_id as JobId)).status).toBe('completed')
      const formal = await submitFormalCandidate(
        evolution,
        data,
        `candidate-bad-${field === 'runtime_plan_sha256' ? 'runtime' : 'materialization'}`,
        'return { inject: ["autodata"], apply() {} }',
      )

      expect(() => controller.start({
        profile_id: 'bfcl-v4',
        run_id: `bad-${field.replaceAll('_', '-')}`,
        data_run: formal.dataRun,
        subject: { ...formal.subject, [field]: '0'.repeat(64) },
      }, { id: 'experiment-agent' } as EvolutionRuntimeAgent)).toThrowError(
        /subject does not match the durable candidate package/iu,
      )
      await controller.dispose()
    },
  )

  it('rejects an H1 data_run that differs from the candidate frozen materialization', async () => {
    const { controller, jobs, evolution, data } = await fixture()
    const baseline = controller.start({
      profile_id: 'bfcl-v4',
      run_id: 'baseline-for-mismatched-materialization',
      data_run: data,
    })
    expect((await jobs.done(baseline.job_id as JobId)).status).toBe('completed')
    const formal = await submitFormalCandidate(
      evolution,
      data,
      'candidate-mismatched-materialization',
      'return { inject: ["autodata"], apply() {} }',
    )
    const replacementLogicalView = data.logical_training_view.slice(10, 20).map((unit, index) => ({
      ...unit,
      selection_rank: index,
      plugin_provenance: [{
        plugin_id: formal.subject.plugin_id,
        plugin_version: formal.subject.strategy_version,
        note: `replacement-${String(index)}`,
      }],
    }))
    const mismatchedDataRun: DataRunResult = {
      ...formal.dataRun,
      logical_training_view: replacementLogicalView,
      summary: {
        ...formal.dataRun.summary,
        counts: {
          ...formal.dataRun.summary.counts,
          logical_training_units: replacementLogicalView.length,
        },
      },
    }

    expect(() => controller.start({
      profile_id: 'bfcl-v4',
      run_id: 'mismatched-materialization',
      data_run: mismatchedDataRun,
      subject: formal.subject,
    }, { id: 'experiment-agent' } as EvolutionRuntimeAgent)).toThrowError(
      /does not match the candidate frozen materialization/iu,
    )
    await controller.dispose()
  })

  it('activates a strictly better H1 and persists the exact acceptance decision', async () => {
    const backend = new Backend()
    const { controller, jobs, evolution, data, runtime } = await fixture(backend)
    const baseline = controller.start({ profile_id: 'bfcl-v4', run_id: 'baseline-for-accepted-h1', data_run: data })
    expect((await jobs.done(baseline.job_id as JobId)).status).toBe('completed')
    const hostSource = 'return { inject: ["autodata"], apply() {} }'
    const formal = await submitFormalCandidate(evolution, data, 'candidate-better', hostSource)
    backend.evalScore = 1
    const started = controller.start({
      profile_id: 'bfcl-v4',
      run_id: 'candidate-better-run',
      data_run: formal.dataRun,
      subject: formal.subject,
    }, { id: 'experiment-agent' } as EvolutionRuntimeAgent)
    expect((await jobs.done(started.job_id as JobId)).status).toBe('completed')

    const state = controller.status('bfcl-v4', 'candidate-better-run').state
    expect(state.decision).toEqual({
      candidate_id: 'candidate-better',
      accepted: true,
      reason: 'accepted_strict_improvement',
      split: 'B_dev',
      metric: 'equal_category_accuracy',
      candidate_score: 1,
      baseline_score: 0.8,
    })
    expect(JSON.parse(readFileSync(state.decision_path as string, 'utf8'))).toEqual(state.decision)
    expect(evolution.status('bfcl-v4').state.active_candidate_id).toBe('candidate-better')
    expect(runtime.activated).toEqual(['candidate-better'])
    expect(() => controller.resume('bfcl-v4', 'candidate-better-run'))
      .toThrowError(/requires a process-local runtime Agent/iu)

    const replayed = controller.resume(
      'bfcl-v4',
      'candidate-better-run',
      { id: 'replacement-experiment-agent' } as EvolutionRuntimeAgent,
    )
    expect(replayed.job_id).toBeDefined()
    expect((await jobs.done(replayed.job_id as JobId)).status).toBe('completed')
    expect(runtime.ensured).toContain('candidate-better')
    expect(controller.status('bfcl-v4', 'candidate-better-run').state.status).toBe('succeeded')
    await controller.dispose()
  })

  it('replays an H1 decision idempotently after a crash at the commit boundary', async () => {
    const { controller, jobs, evolution, data } = await fixture()
    const baseline = controller.start({ profile_id: 'bfcl-v4', run_id: 'baseline-for-h1-replay', data_run: data })
    expect((await jobs.done(baseline.job_id as JobId)).status).toBe('completed')
    const hostSource = 'return { inject: ["autodata"], apply() {} }'
    const formal = await submitFormalCandidate(evolution, data, 'candidate-replay', hostSource)
    const recordEvaluation = evolution.recordEvaluation.bind(evolution)
    Object.defineProperty(evolution, 'recordEvaluation', {
      configurable: true,
      value: async (...args: Parameters<EvolutionController['recordEvaluation']>) => {
        await recordEvaluation(...args)
        throw new Error('simulated crash after H1 decision commit')
      },
    })
    const agent = { id: 'experiment-agent' } as EvolutionRuntimeAgent
    const started = controller.start({
      profile_id: 'bfcl-v4',
      run_id: 'candidate-replay-run',
      data_run: formal.dataRun,
      subject: formal.subject,
    }, agent)
    expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(controller.status('bfcl-v4', 'candidate-replay-run').state).toMatchObject({
      status: 'recovery_required', phase: 'registering',
    })

    Object.defineProperty(evolution, 'recordEvaluation', { configurable: true, value: recordEvaluation })
    const resumed = controller.resume('bfcl-v4', 'candidate-replay-run', agent)
    expect((await jobs.done(resumed.job_id as JobId)).status).toBe('completed')
    expect(controller.status('bfcl-v4', 'candidate-replay-run').state.decision)
      .toMatchObject({ candidate_id: 'candidate-replay', accepted: false, reason: 'not_strictly_better' })
    await controller.dispose()
  })

  it('replays an accepted H1 against the frozen H0 baseline after the active candidate changed', async () => {
    const backend = new Backend()
    const { controller, jobs, evolution, data, runtime } = await fixture(backend)
    const baseline = controller.start({ profile_id: 'bfcl-v4', run_id: 'baseline-for-accepted-replay', data_run: data })
    expect((await jobs.done(baseline.job_id as JobId)).status).toBe('completed')
    const hostSource = 'return { inject: ["autodata"], apply() {} }'
    const formal = await submitFormalCandidate(evolution, data, 'candidate-accepted-replay', hostSource)
    const recordEvaluation = evolution.recordEvaluation.bind(evolution)
    Object.defineProperty(evolution, 'recordEvaluation', {
      configurable: true,
      value: async (...args: Parameters<EvolutionController['recordEvaluation']>) => {
        await recordEvaluation(...args)
        throw new Error('simulated crash after accepted H1 decision commit')
      },
    })
    backend.evalScore = 1
    const agent = { id: 'experiment-agent' } as EvolutionRuntimeAgent
    const started = controller.start({
      profile_id: 'bfcl-v4',
      run_id: 'candidate-accepted-replay-run',
      data_run: formal.dataRun,
      subject: formal.subject,
    }, agent)
    expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(controller.status('bfcl-v4', 'candidate-accepted-replay-run').state).toMatchObject({
      status: 'recovery_required', phase: 'registering',
    })
    expect(evolution.status('bfcl-v4').state).toMatchObject({
      active_candidate_id: 'candidate-accepted-replay',
      active_evaluation: { candidate_id: 'candidate-accepted-replay', score: 1 },
    })

    Object.defineProperty(evolution, 'recordEvaluation', { configurable: true, value: recordEvaluation })
    const resumed = controller.resume('bfcl-v4', 'candidate-accepted-replay-run', agent)
    expect((await jobs.done(resumed.job_id as JobId)).status).toBe('completed')
    const state = controller.status('bfcl-v4', 'candidate-accepted-replay-run').state
    expect(state.decision).toMatchObject({
      candidate_id: 'candidate-accepted-replay',
      accepted: true,
      reason: 'accepted_strict_improvement',
      candidate_score: 1,
      baseline_score: 0.8,
    })
    expect(JSON.parse(readFileSync(resolve(state.run_directory, 'evaluation-report.json'), 'utf8')))
      .toMatchObject({ baseline_candidate_id: 'h0', baseline_score: 0.8 })
    expect(runtime.activated).toEqual(['candidate-accepted-replay'])
    await controller.dispose()
  })

  it('uses the sole retry only for a proven infrastructure failure', async () => {
    const backend = new Backend()
    backend.failFirstTrainRemotely = true
    const { controller, jobs, data, root } = await fixture(backend)
    const started = controller.start({ profile_id: 'bfcl-v4', run_id: 'infra-retry', data_run: data })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('completed')
    expect(controller.status('bfcl-v4', 'infra-retry').state.attempts).toMatchObject([
      {
        stage: 'train',
        attempt: 1,
        status: 'failed',
        failure_code: 'REMOTE_FAILED',
        logs_path: expect.stringMatching(/logs-\d{4}\.json$/u),
        output_cleanup_path: expect.stringMatching(/output-cleanup\.json$/u),
      },
      { stage: 'train', attempt: 2, status: 'succeeded', retry_classification: 'infrastructure' },
      { stage: 'eval', attempt: 1, status: 'succeeded' },
    ])
    expect(backend.calls.filter(value => value.startsWith('submit:') && value.includes('-train'))).toHaveLength(2)
    expect(backend.calls).toContain('logs:autodata-stage4b-infra-retry-train')
    expect(existsSync(resolve(root, 'staging/infra-retry/outputs/train/attempt-1'))).toBe(false)
    expect(JSON.parse(readFileSync(
      resolve(root, 'runs/bfcl-v4/infra-retry/attempts/train/0001/output-cleanup.json'),
      'utf8',
    ))).toMatchObject({
      stage: 'train',
      attempt: 1,
      failure_code: 'REMOTE_FAILED',
    })
    await controller.dispose()
  })

  it('never retries a scientific or result-contract failure', async () => {
    const backend = new Backend()
    backend.invalidFirstTrainResult = true
    const { controller, jobs, data } = await fixture(backend)
    const started = controller.start({ profile_id: 'bfcl-v4', run_id: 'bad-result', data_run: data })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(controller.status('bfcl-v4', 'bad-result').state).toMatchObject({
      status: 'failed',
      attempts: [{ stage: 'train', attempt: 1, status: 'failed' }],
      failure: { code: 'ARTIFACT_INVALID' },
    })
    expect(backend.calls.filter(value => value.startsWith('submit:') && value.includes('-train'))).toHaveLength(1)
    await controller.dispose()
  })

  it.each(['malformed', 'truncated', 'divergent'] as const)(
    'rejects %s predictions without registering a baseline',
    async predictionCorruption => {
      const backend = new Backend()
      backend.predictionCorruption = predictionCorruption
      const { controller, jobs, evolution, data } = await fixture(backend)
      const started = controller.start({
        profile_id: 'bfcl-v4',
        run_id: `bad-predictions-${predictionCorruption}`,
        data_run: data,
      })

      expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
      expect(controller.status('bfcl-v4', `bad-predictions-${predictionCorruption}`).state).toMatchObject({
        status: 'failed',
        attempts: [
          { stage: 'train', status: 'succeeded' },
          { stage: 'eval', status: 'failed' },
        ],
        failure: { code: 'ARTIFACT_INVALID', stage: 'eval' },
      })
      expect(evolution.status('bfcl-v4').state.active_evaluation).toBeUndefined()
      expect(evolution.feedback('bfcl-v4')).toBeUndefined()
      await controller.dispose()
    },
  )

  it('revalidates durable predictions before registration recovery and completed replay', async () => {
    const { controller, jobs, evolution, data } = await fixture()
    const registerBaseline = evolution.registerBaseline.bind(evolution)
    Object.defineProperty(evolution, 'registerBaseline', {
      configurable: true,
      value: () => { throw new Error('pause after evaluation collection') },
    })
    const started = controller.start({
      profile_id: 'bfcl-v4',
      run_id: 'predictions-recovery-integrity',
      data_run: data,
    })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
    const interrupted = controller.status('bfcl-v4', 'predictions-recovery-integrity').state
    const predictionsPath = resolve(dirname(interrupted.eval_result_path as string), 'predictions.jsonl')
    writeFileSync(predictionsPath, '{}\n')
    Object.defineProperty(evolution, 'registerBaseline', { configurable: true, value: registerBaseline })

    const resumed = controller.resume('bfcl-v4', 'predictions-recovery-integrity')
    expect((await jobs.done(resumed.job_id as JobId)).status).toBe('failed')
    expect(controller.status('bfcl-v4', 'predictions-recovery-integrity').state).toMatchObject({
      status: 'recovery_required',
      phase: 'registering',
      failure: { code: 'BASELINE_REGISTRATION_FAILED' },
    })
    await controller.dispose()
  })

  it('rejects a completed ledger whose durable predictions were changed', async () => {
    const { controller, jobs, data } = await fixture()
    const started = controller.start({
      profile_id: 'bfcl-v4',
      run_id: 'completed-predictions-integrity',
      data_run: data,
    })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('completed')
    const state = controller.status('bfcl-v4', 'completed-predictions-integrity').state
    writeFileSync(resolve(dirname(state.eval_result_path as string), 'predictions.jsonl'), '{}\n')

    expect(() => controller.status('bfcl-v4', 'completed-predictions-integrity'))
      .toThrowError(/predictions JSONL must contain exactly/iu)
    await controller.dispose()
  })

  it('does not classify a remote failure with a worker failure result as infrastructure', async () => {
    const backend = new Backend()
    backend.failFirstTrainWithWorkerResult = true
    const { controller, jobs, data } = await fixture(backend)
    const started = controller.start({ profile_id: 'bfcl-v4', run_id: 'worker-failed', data_run: data })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(controller.status('bfcl-v4', 'worker-failed').state).toMatchObject({
      status: 'failed',
      attempts: [{ stage: 'train', attempt: 1, status: 'failed' }],
      failure: { code: 'WORKER_FAILED' },
    })
    expect(controller.status('bfcl-v4', 'worker-failed').state.attempts[0]).toMatchObject({
      failure_code: 'WORKER_FAILED',
      logs_path: expect.stringMatching(/logs-\d{4}\.json$/u),
    })
    expect(backend.calls.filter(value => value.startsWith('submit:') && value.includes('-train'))).toHaveLength(1)
    await controller.dispose()
  })

  it('requires idempotent resume instead of cancelling an ambiguous baseline commit', async () => {
    const { controller, jobs, evolution, data } = await fixture()
    const registerBaseline = evolution.registerBaseline.bind(evolution)
    Object.defineProperty(evolution, 'registerBaseline', {
      configurable: true,
      value: () => { throw new Error('simulated commit ambiguity') },
    })
    const started = controller.start({ profile_id: 'bfcl-v4', run_id: 'register-recovery', data_run: data })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(controller.status('bfcl-v4', 'register-recovery').state).toMatchObject({
      status: 'recovery_required',
      phase: 'registering',
    })
    await expect(controller.cancel('bfcl-v4', 'register-recovery')).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    })

    Object.defineProperty(evolution, 'registerBaseline', { configurable: true, value: registerBaseline })
    const resumed = controller.resume('bfcl-v4', 'register-recovery')
    expect((await jobs.done(resumed.job_id as JobId)).status).toBe('completed')
    expect(controller.status('bfcl-v4', 'register-recovery').state.status).toBe('succeeded')
    await controller.dispose()
  })

  it('reconciles a committed baseline after candidate evolution begins', async () => {
    const { controller, jobs, evolution, data } = await fixture()
    const registerBaseline = evolution.registerBaseline.bind(evolution)
    Object.defineProperty(evolution, 'registerBaseline', {
      configurable: true,
      value: (report: Parameters<EvolutionController['registerBaseline']>[0]) => {
        registerBaseline(report)
        throw new Error('simulated crash after baseline commit')
      },
    })
    const started = controller.start({ profile_id: 'bfcl-v4', run_id: 'post-commit-recovery', data_run: data })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(controller.status('bfcl-v4', 'post-commit-recovery').state).toMatchObject({
      status: 'recovery_required',
      phase: 'registering',
    })

    evolution.submitCandidate('bfcl-v4', {
      candidate_id: 'candidate-one',
      strategy_version: '1',
      host_source: 'export default { id: "candidate-one" }',
    })
    Object.defineProperty(evolution, 'registerBaseline', { configurable: true, value: registerBaseline })
    const resumed = controller.resume('bfcl-v4', 'post-commit-recovery')
    expect((await jobs.done(resumed.job_id as JobId)).status).toBe('completed')
    expect(controller.status('bfcl-v4', 'post-commit-recovery').state.status).toBe('succeeded')
    expect(evolution.status('bfcl-v4').state.open_candidate_id).toBe('candidate-one')
    await controller.dispose()
  })

  it('stops after the single allowed infrastructure retry', async () => {
    const backend = new Backend()
    backend.failAllTrainRemotely = true
    const { controller, jobs, data } = await fixture(backend)
    const started = controller.start({ profile_id: 'bfcl-v4', run_id: 'retry-limit', data_run: data })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(controller.status('bfcl-v4', 'retry-limit').state).toMatchObject({
      status: 'failed',
      attempts: [
        { stage: 'train', attempt: 1, status: 'failed' },
        { stage: 'train', attempt: 2, status: 'failed', retry_classification: 'infrastructure' },
      ],
      failure: { code: 'REMOTE_FAILED' },
    })
    expect(backend.calls.filter(value => value.startsWith('submit:') && value.includes('-train'))).toHaveLength(2)
    await controller.dispose()
  })

  it('inspects an ambiguous submitting boundary on resume without resubmitting train', async () => {
    const firstBackend = new Backend()
    firstBackend.ambiguousFirstTrainSubmit = true
    const first = await fixture(firstBackend)
    const started = first.controller.start({ profile_id: 'bfcl-v4', run_id: 'ambiguous', data_run: first.data })
    expect((await first.jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(first.controller.status('bfcl-v4', 'ambiguous').state).toMatchObject({
      status: 'recovery_required',
      attempts: [{ stage: 'train', status: 'submitting' }],
    })
    await first.controller.dispose()

    const recoveredBackend = new Backend()
    const jobs = new FakeJobs()
    const recovered = new ExperimentController(context(), {
      evolution: first.evolution,
      run_root: resolve(first.root, 'runs'),
      staging_root: resolve(first.root, 'staging'),
      asset_root: first.assets.assetRoot,
      common_worker_root: first.assets.commonRoot,
      poll_interval_ms: 0,
      backend: recoveredBackend,
      jobs,
    })
    const resumed = recovered.resume('bfcl-v4', 'ambiguous')
    expect((await jobs.done(resumed.job_id as JobId)).status).toBe('completed')
    expect(recoveredBackend.calls[0]).toBe('inspect:autodata-stage4b-ambiguous-train')
    expect(recoveredBackend.calls).not.toContain('submit:autodata-stage4b-ambiguous-train')
    expect(recovered.status('bfcl-v4', 'ambiguous').state.status).toBe('succeeded')
    await recovered.dispose()
  })

  it('durably prevents a new H0 run and lets the claimed recovery run resume', async () => {
    const backend = new Backend()
    backend.ambiguousFirstTrainSubmit = true
    const first = await fixture(backend)
    const started = first.controller.start({ profile_id: 'bfcl-v4', run_id: 'durable-owner', data_run: first.data })
    expect((await first.jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(first.controller.status('bfcl-v4', 'durable-owner').state.status).toBe('recovery_required')

    const secondJobs = new FakeJobs()
    const second = new ExperimentController(context(), {
      evolution: first.evolution,
      run_root: resolve(first.root, 'runs'),
      staging_root: resolve(first.root, 'staging'),
      asset_root: first.assets.assetRoot,
      common_worker_root: first.assets.commonRoot,
      poll_interval_ms: 0,
      backend: new Backend(),
      jobs: secondJobs,
    })
    expect(() => second.start({ profile_id: 'bfcl-v4', run_id: 'forbidden-new-run', data_run: first.data }))
      .toThrowError(/durably owned/iu)

    const claimPath = resolve(first.root, 'runs/.h0-owners/bfcl-v4.json')
    unlinkSync(claimPath)
    expect(() => second.start({ profile_id: 'bfcl-v4', run_id: 'still-forbidden', data_run: first.data }))
      .toThrowError(/non-terminal H0 run/iu)
    expect(existsSync(claimPath)).toBe(false)

    const resumed = second.resume('bfcl-v4', 'durable-owner')
    expect((await secondJobs.done(resumed.job_id as JobId)).status).toBe('completed')
    expect(second.status('bfcl-v4', 'durable-owner').state.status).toBe('succeeded')
    expect(existsSync(claimPath)).toBe(true)
    await second.dispose()
    await first.controller.dispose()
  })

  it('releases a newly created profile claim when initialization never publishes a run', async () => {
    const { controller, jobs, data, root } = await fixture()
    const staging = resolve(root, 'staging/initialization-failure')
    mkdirSync(staging, { recursive: true })

    expect(() => controller.start({
      profile_id: 'bfcl-v4',
      run_id: 'initialization-failure',
      data_run: data,
    })).toThrowError(/already exists/iu)
    expect(existsSync(resolve(root, 'runs/.h0-owners/bfcl-v4.json'))).toBe(false)

    rmSync(staging, { recursive: true })
    const started = controller.start({ profile_id: 'bfcl-v4', run_id: 'initialization-failure', data_run: data })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('completed')
    await controller.dispose()
  })

  it.each(['inspect', 'stop'] as const)(
    'keeps an uncertain remote cancellation recoverable after %s failure',
    async failurePoint => {
      const backend = new CancellationBackend()
      const { controller, jobs, data } = await fixture(backend, { sleep: sleepUntilAbort })
      const runId = `cancel-${failurePoint}-recovery`
      const started = controller.start({ profile_id: 'bfcl-v4', run_id: runId, data_run: data })
      await waitForMonitoring(controller, runId)
      if (failurePoint === 'inspect') backend.inspectMode = 'throw'

      const uncertain = await controller.cancel('bfcl-v4', runId)
      expect(uncertain.state).toMatchObject({
        status: 'recovery_required',
        attempts: [{ stage: 'train', status: 'monitoring' }],
        failure: { code: 'RECOVERY_REQUIRED' },
      })

      backend.failStop = false
      backend.inspectMode = 'succeeded'
      const resumed = controller.resume('bfcl-v4', runId)
      expect((await jobs.done(resumed.job_id as JobId)).status).toBe('completed')
      expect(controller.status('bfcl-v4', runId).state.status).toBe('succeeded')
      await controller.dispose()
    },
  )
})

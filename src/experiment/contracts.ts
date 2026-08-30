/** Strict construction and validation for the frozen experiment wire formats. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalJson, immutableJson, isJsonObject, parseStrictJsonObject } from '../core/json.js'
import type { DataRunResult } from '../core/types.js'
import {
  EXPERIMENT_CONTRACT_VERSION,
  EXPERIMENT_EVAL_REQUEST_VERSION,
  EXPERIMENT_EVAL_RESULT_VERSION,
  EXPERIMENT_SPLITS,
  EXPERIMENT_TRAIN_REQUEST_VERSION,
  EXPERIMENT_TRAIN_RESULT_VERSION,
  ExperimentError,
  type ExperimentCandidateSubject,
  type ExperimentContract,
  type ExperimentEvalCaseResult,
  type ExperimentEvalRequest,
  type ExperimentEvalResult,
  type ExperimentMaterializedData,
  type ExperimentSplit,
  type ExperimentStartRequest,
  type ExperimentTrainRequest,
  type ExperimentTrainResult,
} from './types.js'

const ID_PATTERN = /^[a-z][a-z0-9-]*$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_ID_LENGTH = 48
const STAGE4B_CONTRACT_ID = 'stage4b-h0-baseline-1'
export const STAGE4C_CANDIDATE_CONTRACT_ID = 'stage4c-candidate-1'
const STAGE4B_DATASET_ID = 'nex-agi/agent-sft'
const STAGE4B_DATASET_SUBSET = 'tool_calling'
const STAGE4B_DATASET_REVISION = 'd8d4de5643f9fe9d3fc3f89b3d55b8709ddc35c9'
const STAGE4B_MODEL_ID = 'Qwen/Qwen3.5-9B'
const STAGE4B_MODEL_REVISION = 'c202236235762e1c871ad0ccb60c8ee5ba337b9a'
const STAGE4B_CATEGORIES = Object.freeze([
  'simple_python',
  'multiple',
  'parallel',
  'parallel_multiple',
  'irrelevance',
] as const)

function invalid(message: string): never {
  throw new ExperimentError(message, 'ARTIFACT_INVALID')
}

function requestInvalid(message: string): never {
  throw new ExperimentError(message, 'INVALID_REQUEST')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) invalid(`${label} must be an object`)
  return value
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const expected = new Set(fields)
  const missing = fields.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) invalid(`${label} is missing field ${missing}`)
  const extra = Object.keys(value).find(field => !expected.has(field))
  if (extra !== undefined) invalid(`${label} has unsupported field ${extra}`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a non-empty string`)
  return value
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${label} must be a safe integer >= ${String(minimum)}`)
  }
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be finite`)
  return value
}

function score(value: unknown, label: string): number {
  const result = finite(value, label)
  if (result < 0 || result > 1) invalid(`${label} must be between 0 and 1`)
  return result
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`)
  return value
}

function literal<T extends string | number | boolean>(value: unknown, expected: T, label: string): T {
  if (value !== expected) invalid(`${label} must equal ${JSON.stringify(expected)}`)
  return expected
}

function absolute(value: unknown, label: string): string {
  const path = text(value, label)
  if (!path.startsWith('/')) invalid(`${label} must be an absolute path`)
  return path
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    invalid(`${label} must be an array of non-empty strings`)
  }
  return Object.freeze([...value]) as readonly string[]
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeWheelhouse(value: unknown, label: string): { readonly path: string; readonly manifest_sha256: string } {
  const wheelhouse = record(value, label)
  exact(wheelhouse, ['path', 'manifest_sha256'], label)
  const manifestSha256 = text(wheelhouse.manifest_sha256, `${label}.manifest_sha256`)
  if (!SHA256_PATTERN.test(manifestSha256)) invalid(`${label}.manifest_sha256 must be lowercase SHA-256`)
  return Object.freeze({ path: absolute(wheelhouse.path, `${label}.path`), manifest_sha256: manifestSha256 })
}

export function validateExperimentId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    requestInvalid(`${label} must match ${String(ID_PATTERN)} and contain at most ${String(MAX_ID_LENGTH)} characters`)
  }
  return value
}

export function normalizeExperimentStartRequest(input: unknown): ExperimentStartRequest {
  if (!isJsonObject(input)) requestInvalid('experiment start request must be an object')
  const required = ['profile_id', 'run_id', 'data_run'] as const
  const allowed = [...required, 'subject'] as const
  const missing = required.find(field => !Object.hasOwn(input, field))
  if (missing !== undefined) requestInvalid(`experiment start request is missing field ${missing}`)
  const extra = Object.keys(input).find(field => !allowed.includes(field as typeof allowed[number]))
  if (extra !== undefined) requestInvalid(`experiment start request has unsupported field ${extra}`)
  return Object.freeze({
    profile_id: validateExperimentId(input.profile_id, 'profile_id'),
    run_id: validateExperimentId(input.run_id, 'run_id'),
    data_run: input.data_run as unknown as DataRunResult,
    ...(input.subject === undefined ? {} : {
      subject: normalizeCandidateSubject(input.subject, 'experiment start request.subject', requestInvalid),
    }),
  })
}

function normalizeCandidateSubject(
  input: unknown,
  label: string,
  fail: (message: string) => never = invalid,
): ExperimentCandidateSubject {
  if (!isJsonObject(input)) fail(`${label} must be an object`)
  const value = input as Record<string, unknown>
  const fields = [
    'candidate_id', 'generation', 'plugin_id', 'strategy_version', 'host_source_sha256',
    'runtime_plan_sha256', 'materialization_sha256',
  ] as const
  const missing = fields.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) fail(`${label} is missing field ${missing}`)
  const extra = Object.keys(value).find(field => !fields.includes(field as typeof fields[number]))
  if (extra !== undefined) fail(`${label} has unsupported field ${extra}`)
  const candidateId = value.candidate_id
  const pluginId = value.plugin_id
  if (typeof candidateId !== 'string' || candidateId.length > MAX_ID_LENGTH || !ID_PATTERN.test(candidateId)) {
    fail(`${label}.candidate_id must be a valid experiment identifier`)
  }
  if (candidateId === 'h0') fail(`${label}.candidate_id must identify an evolved candidate`)
  if (typeof pluginId !== 'string' || pluginId.length > MAX_ID_LENGTH || !ID_PATTERN.test(pluginId)) {
    fail(`${label}.plugin_id must be a valid experiment identifier`)
  }
  const generation = value.generation
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation !== 1) {
    fail(`${label}.generation must equal 1 for the first evolved candidate`)
  }
  const strategyVersion = value.strategy_version
  if (typeof strategyVersion !== 'string' || strategyVersion.length === 0 || strategyVersion.length > 128) {
    fail(`${label}.strategy_version must be a non-empty string no longer than 128 characters`)
  }
  const hostSourceSha256 = value.host_source_sha256
  if (typeof hostSourceSha256 !== 'string' || !SHA256_PATTERN.test(hostSourceSha256)) {
    fail(`${label}.host_source_sha256 must be lowercase SHA-256`)
  }
  const runtimePlanSha256 = value.runtime_plan_sha256
  if (typeof runtimePlanSha256 !== 'string' || !SHA256_PATTERN.test(runtimePlanSha256)) {
    fail(`${label}.runtime_plan_sha256 must be lowercase SHA-256`)
  }
  const materializationSha256 = value.materialization_sha256
  if (typeof materializationSha256 !== 'string' || !SHA256_PATTERN.test(materializationSha256)) {
    fail(`${label}.materialization_sha256 must be lowercase SHA-256`)
  }
  return Object.freeze({
    candidate_id: candidateId,
    generation,
    plugin_id: pluginId,
    strategy_version: strategyVersion,
    host_source_sha256: hostSourceSha256,
    runtime_plan_sha256: runtimePlanSha256,
    materialization_sha256: materializationSha256,
  })
}

function normalizeCaseIds(value: unknown, categories: readonly string[], perCategory: number): Readonly<Record<ExperimentSplit, readonly string[]>> {
  const splits = record(value, 'experiment contract.evaluation.case_ids')
  exact(splits, [...EXPERIMENT_SPLITS], 'experiment contract.evaluation.case_ids')
  const result = {} as Record<ExperimentSplit, readonly string[]>
  const all = new Set<string>()
  for (const split of EXPERIMENT_SPLITS) {
    const ids = stringArray(splits[split], `experiment contract.evaluation.case_ids.${split}`)
    if (ids.length !== categories.length * perCategory) {
      invalid(`experiment contract.evaluation.case_ids.${split} must contain ${String(categories.length * perCategory)} cases`)
    }
    for (const category of categories) {
      const count = ids.filter(id => id.startsWith(`${category}_`) && (
        !categories.some(other => other.length > category.length && id.startsWith(`${other}_`))
      )).length
      if (count !== perCategory) invalid(`${split}/${category} must contain ${String(perCategory)} cases`)
    }
    for (const id of ids) {
      if (all.has(id)) invalid(`experiment contract contains duplicate case ${id}`)
      all.add(id)
    }
    result[split] = ids
  }
  return Object.freeze(result)
}

/** Load and strictly freeze either the checked-in H0 contract or one derived H1 contract. */
export function loadExperimentContract(pathInput: string): {
  readonly contract: ExperimentContract
  readonly sha256: string
} {
  const path = resolve(pathInput)
  let raw: Buffer
  let parsed: Record<string, unknown>
  try {
    raw = readFileSync(path)
    parsed = parseStrictJsonObject(raw.toString('utf8'), 'experiment contract')
  } catch (error) {
    throw new ExperimentError(`cannot read strict experiment contract: ${path}`, 'ARTIFACT_INVALID', { cause: error })
  }
  const contract = normalizeExperimentContract(parsed)
  return Object.freeze({ contract, sha256: sha256(raw) })
}

export function normalizeExperimentContract(input: unknown): ExperimentContract {
  const value = record(input, 'experiment contract')
  const hasSubject = Object.hasOwn(value, 'subject')
  exact(value, [
    'schema_version', 'contract_id', 'profile', 'data', 'model', 'execution',
    'training', 'evaluation', 'retry', ...(hasSubject ? ['subject'] : []),
  ], 'experiment contract')
  literal(value.schema_version, EXPERIMENT_CONTRACT_VERSION, 'experiment contract.schema_version')
  literal(
    value.contract_id,
    hasSubject ? STAGE4C_CANDIDATE_CONTRACT_ID : STAGE4B_CONTRACT_ID,
    'experiment contract.contract_id',
  )
  const subject = hasSubject
    ? normalizeCandidateSubject(value.subject, 'experiment contract.subject')
    : undefined

  const profile = record(value.profile, 'experiment contract.profile')
  exact(profile, ['id', 'benchmark', 'metric'], 'experiment contract.profile')
  literal(profile.id, 'bfcl-v4', 'experiment contract.profile.id')
  const benchmark = text(profile.benchmark, 'experiment contract.profile.benchmark')
  const metric = text(profile.metric, 'experiment contract.profile.metric')

  const data = record(value.data, 'experiment contract.data')
  exact(data, [
    'dataset_id', 'dataset_subset', 'dataset_revision', 'harness_id', 'seed',
    'canonical_records', 'logical_training_units', 'historical_training_tokens',
    'canonical_jsonl_sha256', 'logical_view_jsonl_sha256', 'run_summary_json_sha256',
  ], 'experiment contract.data')
  literal(data.dataset_id, STAGE4B_DATASET_ID, 'experiment contract.data.dataset_id')
  literal(data.dataset_subset, STAGE4B_DATASET_SUBSET, 'experiment contract.data.dataset_subset')
  literal(data.dataset_revision, STAGE4B_DATASET_REVISION, 'experiment contract.data.dataset_revision')
  const harnessId = subject === undefined
    ? literal(data.harness_id, 'toolcall-h0', 'experiment contract.data.harness_id')
    : text(data.harness_id, 'experiment contract.data.harness_id')
  literal(data.seed, 42, 'experiment contract.data.seed')
  literal(data.canonical_records, 100, 'experiment contract.data.canonical_records')
  const logicalTrainingUnits = subject === undefined
    ? literal(data.logical_training_units, 236, 'experiment contract.data.logical_training_units')
    : integer(data.logical_training_units, 'experiment contract.data.logical_training_units', 1)
  literal(data.historical_training_tokens, 508_114, 'experiment contract.data.historical_training_tokens')
  for (const field of ['canonical_jsonl_sha256', 'logical_view_jsonl_sha256', 'run_summary_json_sha256'] as const) {
    if (!SHA256_PATTERN.test(text(data[field], `experiment contract.data.${field}`))) invalid(`${field} must be lowercase SHA-256`)
  }

  const model = record(value.model, 'experiment contract.model')
  exact(model, ['id', 'revision', 'path', 'thinking', 'expected_parameters'], 'experiment contract.model')
  literal(model.id, STAGE4B_MODEL_ID, 'experiment contract.model.id')
  literal(model.revision, STAGE4B_MODEL_REVISION, 'experiment contract.model.revision')
  const modelPath = absolute(model.path, 'experiment contract.model.path')
  if (!modelPath.endsWith(`/${STAGE4B_MODEL_REVISION}`)) invalid('experiment contract.model.path does not end in the frozen revision')
  literal(model.thinking, false, 'experiment contract.model.thinking')
  literal(model.expected_parameters, 9_409_813_744, 'experiment contract.model.expected_parameters')

  const execution = record(value.execution, 'experiment contract.execution')
  exact(execution, [
    'container_image', 'rjob_backoff_limit', 'training_wheelhouse', 'vllm_wheelhouse',
    'bfcl_wheelhouse',
  ], 'experiment contract.execution')
  literal(
    execution.container_image,
    'registry.h.pjlab.org.cn/ailab/pytorch2.7.0-cuda12.8-cudnn9:v5',
    'experiment contract.execution.container_image',
  )
  literal(execution.rjob_backoff_limit, 1, 'experiment contract.execution.rjob_backoff_limit')
  const trainingWheelhouse = normalizeWheelhouse(execution.training_wheelhouse, 'experiment contract.execution.training_wheelhouse')
  const vllmWheelhouse = normalizeWheelhouse(execution.vllm_wheelhouse, 'experiment contract.execution.vllm_wheelhouse')
  const bfclWheelhouse = normalizeWheelhouse(execution.bfcl_wheelhouse, 'experiment contract.execution.bfcl_wheelhouse')

  const training = record(value.training, 'experiment contract.training')
  exact(training, [
    'gpus', 'gpu_family', 'max_steps', 'max_length', 'per_device_train_batch_size',
    'gradient_accumulation_steps', 'tuner_type', 'precision', 'optimizer', 'deepspeed',
    'packing', 'padding_free', 'gradient_checkpointing', 'use_hf', 'check_model',
    'template', 'template_backend',
    'enable_thinking', 'add_non_thinking_prefix', 'loss_scale', 'is_binary_loss_scale',
    'truncation_strategy', 'split_dataset_ratio', 'dataset_num_proc', 'load_from_cache_file',
    'strict', 'freeze_llm', 'freeze_vit', 'freeze_aligner', 'torch_dtype', 'bf16',
    'attention_implementation', 'packing_length', 'packing_num_proc', 'packing_strategy',
    'learning_rate', 'lr_scheduler_type', 'warmup_ratio', 'weight_decay',
    'vit_gradient_checkpointing', 'save_strategy', 'save_steps', 'save_total_limit',
    'save_only_model', 'logging_strategy', 'logging_steps', 'logging_first_step', 'report_to',
    'dataloader_num_workers', 'seed', 'data_seed', 'add_version',
  ], 'experiment contract.training')
  literal(training.gpus, 4, 'experiment contract.training.gpus')
  literal(training.gpu_family, 'H200', 'experiment contract.training.gpu_family')
  literal(training.max_steps, 16, 'experiment contract.training.max_steps')
  literal(training.max_length, 8192, 'experiment contract.training.max_length')
  literal(training.per_device_train_batch_size, 1, 'experiment contract.training.per_device_train_batch_size')
  literal(training.gradient_accumulation_steps, 4, 'experiment contract.training.gradient_accumulation_steps')
  literal(training.tuner_type, 'full', 'experiment contract.training.tuner_type')
  literal(training.precision, 'bf16', 'experiment contract.training.precision')
  literal(training.optimizer, 'adafactor', 'experiment contract.training.optimizer')
  literal(training.deepspeed, 'zero3', 'experiment contract.training.deepspeed')
  literal(training.packing, true, 'experiment contract.training.packing')
  literal(training.padding_free, true, 'experiment contract.training.padding_free')
  literal(training.gradient_checkpointing, true, 'experiment contract.training.gradient_checkpointing')
  literal(training.use_hf, true, 'experiment contract.training.use_hf')
  literal(training.check_model, false, 'experiment contract.training.check_model')
  literal(training.template, 'qwen3_5', 'experiment contract.training.template')
  literal(training.template_backend, 'swift', 'experiment contract.training.template_backend')
  literal(training.enable_thinking, false, 'experiment contract.training.enable_thinking')
  literal(training.add_non_thinking_prefix, true, 'experiment contract.training.add_non_thinking_prefix')
  literal(training.loss_scale, 'default', 'experiment contract.training.loss_scale')
  literal(training.is_binary_loss_scale, true, 'experiment contract.training.is_binary_loss_scale')
  literal(training.truncation_strategy, 'delete', 'experiment contract.training.truncation_strategy')
  literal(training.split_dataset_ratio, 0, 'experiment contract.training.split_dataset_ratio')
  literal(training.dataset_num_proc, 4, 'experiment contract.training.dataset_num_proc')
  literal(training.load_from_cache_file, false, 'experiment contract.training.load_from_cache_file')
  literal(training.strict, true, 'experiment contract.training.strict')
  literal(training.freeze_llm, false, 'experiment contract.training.freeze_llm')
  literal(training.freeze_vit, false, 'experiment contract.training.freeze_vit')
  literal(training.freeze_aligner, false, 'experiment contract.training.freeze_aligner')
  literal(training.torch_dtype, 'bfloat16', 'experiment contract.training.torch_dtype')
  literal(training.bf16, true, 'experiment contract.training.bf16')
  literal(training.attention_implementation, 'flash_attn', 'experiment contract.training.attention_implementation')
  literal(training.packing_length, 8192, 'experiment contract.training.packing_length')
  literal(training.packing_num_proc, 1, 'experiment contract.training.packing_num_proc')
  literal(training.packing_strategy, 'sequential', 'experiment contract.training.packing_strategy')
  literal(training.learning_rate, 0.00001, 'experiment contract.training.learning_rate')
  literal(training.lr_scheduler_type, 'cosine', 'experiment contract.training.lr_scheduler_type')
  literal(training.warmup_ratio, 0.05, 'experiment contract.training.warmup_ratio')
  literal(training.weight_decay, 0.1, 'experiment contract.training.weight_decay')
  literal(training.vit_gradient_checkpointing, true, 'experiment contract.training.vit_gradient_checkpointing')
  literal(training.save_strategy, 'steps', 'experiment contract.training.save_strategy')
  literal(training.save_steps, 16, 'experiment contract.training.save_steps')
  literal(training.save_total_limit, 1, 'experiment contract.training.save_total_limit')
  literal(training.save_only_model, false, 'experiment contract.training.save_only_model')
  literal(training.logging_strategy, 'steps', 'experiment contract.training.logging_strategy')
  literal(training.logging_steps, 1, 'experiment contract.training.logging_steps')
  literal(training.logging_first_step, true, 'experiment contract.training.logging_first_step')
  const reportTo = stringArray(training.report_to, 'experiment contract.training.report_to')
  if (canonicalJson(reportTo) !== canonicalJson(['none'])) invalid('experiment contract.training.report_to must equal ["none"]')
  literal(training.dataloader_num_workers, 0, 'experiment contract.training.dataloader_num_workers')
  literal(training.seed, 42, 'experiment contract.training.seed')
  literal(training.data_seed, 42, 'experiment contract.training.data_seed')
  literal(training.add_version, false, 'experiment contract.training.add_version')

  const evaluation = record(value.evaluation, 'experiment contract.evaluation')
  exact(evaluation, [
    'gpus', 'gpu_family', 'vllm_version', 'tool_call_parser', 'bfcl_version', 'server',
    'generation', 'checker', 'categories',
    'cases_per_category_per_split', 'case_ids', 'macro',
  ], 'experiment contract.evaluation')
  literal(evaluation.gpus, 1, 'experiment contract.evaluation.gpus')
  literal(evaluation.gpu_family, 'H200', 'experiment contract.evaluation.gpu_family')
  literal(evaluation.bfcl_version, '2026.3.23', 'experiment contract.evaluation.bfcl_version')
  const server = record(evaluation.server, 'experiment contract.evaluation.server')
  exact(server, [
    'dtype', 'tensor_parallel_size', 'max_model_len', 'gpu_memory_utilization', 'generation_config',
    'enable_auto_tool_choice',
  ], 'experiment contract.evaluation.server')
  literal(server.dtype, 'bfloat16', 'experiment contract.evaluation.server.dtype')
  literal(server.tensor_parallel_size, 1, 'experiment contract.evaluation.server.tensor_parallel_size')
  literal(server.max_model_len, 8192, 'experiment contract.evaluation.server.max_model_len')
  literal(server.gpu_memory_utilization, 0.9, 'experiment contract.evaluation.server.gpu_memory_utilization')
  literal(server.generation_config, 'vllm', 'experiment contract.evaluation.server.generation_config')
  literal(server.enable_auto_tool_choice, true, 'experiment contract.evaluation.server.enable_auto_tool_choice')
  const generation = record(evaluation.generation, 'experiment contract.evaluation.generation')
  exact(generation, [
    'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'max_tokens', 'seed', 'n', 'stream',
    'include_reasoning', 'enable_thinking',
  ], 'experiment contract.evaluation.generation')
  literal(generation.tool_choice, 'auto', 'experiment contract.evaluation.generation.tool_choice')
  literal(generation.parallel_tool_calls, true, 'experiment contract.evaluation.generation.parallel_tool_calls')
  literal(generation.temperature, 0, 'experiment contract.evaluation.generation.temperature')
  literal(generation.top_p, 1, 'experiment contract.evaluation.generation.top_p')
  literal(generation.max_tokens, 2048, 'experiment contract.evaluation.generation.max_tokens')
  literal(generation.seed, 42, 'experiment contract.evaluation.generation.seed')
  literal(generation.n, 1, 'experiment contract.evaluation.generation.n')
  literal(generation.stream, false, 'experiment contract.evaluation.generation.stream')
  literal(generation.include_reasoning, false, 'experiment contract.evaluation.generation.include_reasoning')
  literal(generation.enable_thinking, false, 'experiment contract.evaluation.generation.enable_thinking')
  const checker = record(evaluation.checker, 'experiment contract.evaluation.checker')
  exact(checker, ['language', 'model_config', 'underscore_to_dot'], 'experiment contract.evaluation.checker')
  literal(checker.language, 'python', 'experiment contract.evaluation.checker.language')
  literal(checker.model_config, 'qwen3-8b-FC', 'experiment contract.evaluation.checker.model_config')
  literal(checker.underscore_to_dot, true, 'experiment contract.evaluation.checker.underscore_to_dot')
  const categories = stringArray(evaluation.categories, 'experiment contract.evaluation.categories')
  if (canonicalJson(categories) !== canonicalJson(STAGE4B_CATEGORIES)) invalid('experiment contract categories are not the frozen five-category order')
  const perCategory = literal(evaluation.cases_per_category_per_split, 5, 'experiment contract.evaluation.cases_per_category_per_split')
  const caseIds = normalizeCaseIds(evaluation.case_ids, categories, perCategory)
  literal(evaluation.macro, 'equal_category_accuracy', 'experiment contract.evaluation.macro')

  const retry = record(value.retry, 'experiment contract.retry')
  exact(retry, ['scientific_retries', 'infrastructure_retries_per_stage'], 'experiment contract.retry')
  literal(retry.scientific_retries, 0, 'experiment contract.retry.scientific_retries')
  literal(retry.infrastructure_retries_per_stage, 1, 'experiment contract.retry.infrastructure_retries_per_stage')

  return immutableJson({
    schema_version: EXPERIMENT_CONTRACT_VERSION,
    contract_id: subject === undefined ? STAGE4B_CONTRACT_ID : STAGE4C_CANDIDATE_CONTRACT_ID,
    ...(subject === undefined ? {} : { subject }),
    profile: { id: 'bfcl-v4', benchmark, metric },
    data: {
      dataset_id: STAGE4B_DATASET_ID,
      dataset_subset: STAGE4B_DATASET_SUBSET,
      dataset_revision: STAGE4B_DATASET_REVISION,
      harness_id: harnessId,
      seed: 42,
      canonical_records: 100,
      logical_training_units: logicalTrainingUnits,
      historical_training_tokens: 508_114,
      canonical_jsonl_sha256: data.canonical_jsonl_sha256,
      logical_view_jsonl_sha256: data.logical_view_jsonl_sha256,
      run_summary_json_sha256: data.run_summary_json_sha256,
    },
    model: {
      id: STAGE4B_MODEL_ID,
      revision: STAGE4B_MODEL_REVISION,
      path: modelPath,
      thinking: false,
      expected_parameters: 9_409_813_744,
    },
    execution: {
      container_image: 'registry.h.pjlab.org.cn/ailab/pytorch2.7.0-cuda12.8-cudnn9:v5',
      rjob_backoff_limit: 1,
      training_wheelhouse: trainingWheelhouse,
      vllm_wheelhouse: vllmWheelhouse,
      bfcl_wheelhouse: bfclWheelhouse,
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
      report_to: reportTo,
      dataloader_num_workers: 0,
      seed: 42,
      data_seed: 42,
      add_version: false,
    },
    evaluation: {
      gpus: 1,
      gpu_family: 'H200',
      vllm_version: text(evaluation.vllm_version, 'experiment contract.evaluation.vllm_version'),
      tool_call_parser: text(evaluation.tool_call_parser, 'experiment contract.evaluation.tool_call_parser'),
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
      categories,
      cases_per_category_per_split: 5,
      case_ids: caseIds,
      macro: 'equal_category_accuracy',
    },
    retry: { scientific_retries: 0, infrastructure_retries_per_stage: 1 },
  }) as unknown as ExperimentContract
}

/** Derive the immutable H1 run contract from the frozen H0 protocol and materialized view. */
export function createCandidateExperimentContract(input: {
  readonly baseline: ExperimentContract
  readonly subject: ExperimentCandidateSubject
  readonly data_run: DataRunResult
  readonly artifact_hashes: Readonly<Record<'canonical.jsonl' | 'logical-view.jsonl' | 'run-summary.json', string>>
}): ExperimentContract {
  if (input.baseline.subject !== undefined || input.baseline.contract_id !== STAGE4B_CONTRACT_ID) {
    invalid('candidate experiment must derive from the frozen H0 contract')
  }
  return normalizeExperimentContract({
    ...input.baseline,
    contract_id: STAGE4C_CANDIDATE_CONTRACT_ID,
    subject: input.subject,
    data: {
      ...input.baseline.data,
      harness_id: input.data_run.summary.harness_id,
      canonical_records: input.data_run.canonical_records.length,
      logical_training_units: input.data_run.logical_training_view.length,
      canonical_jsonl_sha256: input.artifact_hashes['canonical.jsonl'],
      logical_view_jsonl_sha256: input.artifact_hashes['logical-view.jsonl'],
      run_summary_json_sha256: input.artifact_hashes['run-summary.json'],
    },
  })
}

export function validateExperimentMaterializedData(value: unknown): ExperimentMaterializedData {
  const input = record(value, 'materialized input')
  exact(input, ['canonical_jsonl', 'logical_view_jsonl', 'run_summary_json'], 'materialized input')
  return Object.freeze({
    canonical_jsonl: absolute(input.canonical_jsonl, 'materialized input.canonical_jsonl'),
    logical_view_jsonl: absolute(input.logical_view_jsonl, 'materialized input.logical_view_jsonl'),
    run_summary_json: absolute(input.run_summary_json, 'materialized input.run_summary_json'),
  })
}

export function createExperimentTrainRequest(input: {
  readonly contract: ExperimentContract
  readonly contract_sha256: string
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly materialized: ExperimentMaterializedData
  readonly output_root: string
}): ExperimentTrainRequest {
  const root = absolute(input.output_root, 'training output root')
  return immutableJson({
    schema_version: EXPERIMENT_TRAIN_REQUEST_VERSION,
    contract_id: input.contract.contract_id,
    contract_sha256: input.contract_sha256,
    profile_id: validateExperimentId(input.profile_id, 'profile_id'),
    run_id: validateExperimentId(input.run_id, 'run_id'),
    attempt: integer(input.attempt, 'attempt', 1),
    input: validateExperimentMaterializedData(input.materialized),
    output: {
      root,
      result_json: `${root}/result.json`,
      checkpoint_dir: `${root}/train/checkpoint-${String(input.contract.training.max_steps)}`,
    },
    model: input.contract.model,
    recipe: input.contract.training,
  }) as unknown as ExperimentTrainRequest
}

export function normalizeExperimentTrainRequest(input: unknown, contract: ExperimentContract, contractSha256: string): ExperimentTrainRequest {
  const value = record(input, 'training request')
  exact(value, ['schema_version', 'contract_id', 'contract_sha256', 'profile_id', 'run_id', 'attempt', 'input', 'output', 'model', 'recipe'], 'training request')
  literal(value.schema_version, EXPERIMENT_TRAIN_REQUEST_VERSION, 'training request.schema_version')
  literal(value.contract_id, contract.contract_id, 'training request.contract_id')
  literal(value.contract_sha256, contractSha256, 'training request.contract_sha256')
  const output = record(value.output, 'training request.output')
  exact(output, ['root', 'result_json', 'checkpoint_dir'], 'training request.output')
  const expected = createExperimentTrainRequest({
    contract,
    contract_sha256: contractSha256,
    profile_id: validateExperimentId(value.profile_id, 'profile_id'),
    run_id: validateExperimentId(value.run_id, 'run_id'),
    attempt: integer(value.attempt, 'attempt', 1),
    materialized: validateExperimentMaterializedData(value.input),
    output_root: absolute(output.root, 'training request.output.root'),
  })
  if (canonicalJson(value) !== canonicalJson(expected)) invalid('training request differs from the frozen experiment contract')
  return expected
}

export function createExperimentEvalRequest(input: {
  readonly contract: ExperimentContract
  readonly contract_sha256: string
  readonly profile_id: string
  readonly run_id: string
  readonly attempt: number
  readonly checkpoint_path: string
  readonly output_root: string
}): ExperimentEvalRequest {
  const root = absolute(input.output_root, 'evaluation output root')
  return immutableJson({
    schema_version: EXPERIMENT_EVAL_REQUEST_VERSION,
    contract_id: input.contract.contract_id,
    contract_sha256: input.contract_sha256,
    profile_id: validateExperimentId(input.profile_id, 'profile_id'),
    run_id: validateExperimentId(input.run_id, 'run_id'),
    attempt: integer(input.attempt, 'attempt', 1),
    checkpoint_path: absolute(input.checkpoint_path, 'evaluation checkpoint path'),
    output: {
      root,
      result_json: `${root}/result.json`,
      predictions_jsonl: `${root}/predictions.jsonl`,
    },
    model: input.contract.model,
    runtime: {
      gpus: input.contract.evaluation.gpus,
      gpu_family: input.contract.evaluation.gpu_family,
      vllm_version: input.contract.evaluation.vllm_version,
      tool_call_parser: input.contract.evaluation.tool_call_parser,
    },
    benchmark: {
      id: input.contract.profile.benchmark,
      metric: input.contract.profile.metric,
      categories: input.contract.evaluation.categories,
      case_ids: input.contract.evaluation.case_ids,
      macro: input.contract.evaluation.macro,
    },
  }) as unknown as ExperimentEvalRequest
}

export function normalizeExperimentEvalRequest(input: unknown, contract: ExperimentContract, contractSha256: string): ExperimentEvalRequest {
  const value = record(input, 'evaluation request')
  exact(value, ['schema_version', 'contract_id', 'contract_sha256', 'profile_id', 'run_id', 'attempt', 'checkpoint_path', 'output', 'model', 'runtime', 'benchmark'], 'evaluation request')
  literal(value.schema_version, EXPERIMENT_EVAL_REQUEST_VERSION, 'evaluation request.schema_version')
  literal(value.contract_id, contract.contract_id, 'evaluation request.contract_id')
  literal(value.contract_sha256, contractSha256, 'evaluation request.contract_sha256')
  const output = record(value.output, 'evaluation request.output')
  exact(output, ['root', 'result_json', 'predictions_jsonl'], 'evaluation request.output')
  const expected = createExperimentEvalRequest({
    contract,
    contract_sha256: contractSha256,
    profile_id: validateExperimentId(value.profile_id, 'profile_id'),
    run_id: validateExperimentId(value.run_id, 'run_id'),
    attempt: integer(value.attempt, 'attempt', 1),
    checkpoint_path: absolute(value.checkpoint_path, 'evaluation request.checkpoint_path'),
    output_root: absolute(output.root, 'evaluation request.output.root'),
  })
  if (canonicalJson(value) !== canonicalJson(expected)) invalid('evaluation request differs from the frozen experiment contract')
  return expected
}

export function normalizeExperimentTrainResult(
  input: unknown,
  request: ExperimentTrainRequest,
  contract: ExperimentContract,
  options: { readonly allow_failed?: boolean } = {},
): ExperimentTrainResult {
  const value = record(input, 'training result')
  exact(value, ['schema_version', 'contract_id', 'contract_sha256', 'profile_id', 'run_id', 'attempt', 'status', 'checkpoint_path', 'checks', 'failure'], 'training result')
  literal(value.schema_version, EXPERIMENT_TRAIN_RESULT_VERSION, 'training result.schema_version')
  literal(value.contract_id, request.contract_id, 'training result.contract_id')
  literal(value.contract_sha256, request.contract_sha256, 'training result.contract_sha256')
  literal(value.profile_id, request.profile_id, 'training result.profile_id')
  literal(value.run_id, request.run_id, 'training result.run_id')
  literal(value.attempt, request.attempt, 'training result.attempt')
  const status = text(value.status, 'training result.status')
  if (status !== 'passed' && status !== 'failed') invalid('training result.status must be passed or failed')
  literal(value.checkpoint_path, request.output.checkpoint_dir, 'training result.checkpoint_path')
  const checks = record(value.checks, 'training result.checks')
  exact(checks, [
    'gpu_count', 'gpu_family', 'model_revision', 'trainable_parameters', 'total_parameters',
    'global_step', 'finite_metrics', 'huggingface_weight_shards', 'zero_optimizer_shards',
    'zero_model_state_shards', 'fresh_process_reload', 'weights_changed',
  ], 'training result.checks')
  const result: ExperimentTrainResult = {
    schema_version: EXPERIMENT_TRAIN_RESULT_VERSION,
    contract_id: request.contract_id,
    contract_sha256: request.contract_sha256,
    profile_id: request.profile_id,
    run_id: request.run_id,
    attempt: request.attempt,
    status,
    checkpoint_path: request.output.checkpoint_dir,
    checks: {
      gpu_count: integer(checks.gpu_count, 'training result.checks.gpu_count'),
      gpu_family: text(checks.gpu_family, 'training result.checks.gpu_family'),
      model_revision: text(checks.model_revision, 'training result.checks.model_revision'),
      trainable_parameters: integer(checks.trainable_parameters, 'training result.checks.trainable_parameters'),
      total_parameters: integer(checks.total_parameters, 'training result.checks.total_parameters'),
      global_step: integer(checks.global_step, 'training result.checks.global_step'),
      finite_metrics: boolean(checks.finite_metrics, 'training result.checks.finite_metrics'),
      huggingface_weight_shards: integer(checks.huggingface_weight_shards, 'training result.checks.huggingface_weight_shards'),
      zero_optimizer_shards: integer(checks.zero_optimizer_shards, 'training result.checks.zero_optimizer_shards'),
      zero_model_state_shards: integer(checks.zero_model_state_shards, 'training result.checks.zero_model_state_shards'),
      fresh_process_reload: boolean(checks.fresh_process_reload, 'training result.checks.fresh_process_reload'),
      weights_changed: boolean(checks.weights_changed, 'training result.checks.weights_changed'),
    },
    failure: value.failure === null ? null : text(value.failure, 'training result.failure'),
  }
  if (result.status === 'failed') {
    if (result.failure === null) invalid('failed training result must contain a failure message')
    if (!options.allow_failed) invalid('training result did not satisfy the frozen experiment execution contract')
    return immutableJson(result) as unknown as ExperimentTrainResult
  }
  if (
    result.checks.gpu_count !== contract.training.gpus
    || result.checks.gpu_family !== 'NVIDIA H200'
    || result.checks.model_revision !== contract.model.revision
    || result.checks.trainable_parameters !== contract.model.expected_parameters
    || result.checks.total_parameters !== contract.model.expected_parameters
    || result.checks.global_step !== contract.training.max_steps
    || !result.checks.finite_metrics
    || result.checks.huggingface_weight_shards !== 4
    || result.checks.zero_optimizer_shards !== 4
    || result.checks.zero_model_state_shards !== 4
    || !result.checks.fresh_process_reload
    || !result.checks.weights_changed
    || result.failure !== null
  ) invalid('training result did not satisfy the frozen experiment contract')
  return immutableJson(result) as unknown as ExperimentTrainResult
}

export function normalizeExperimentEvalResult(
  input: unknown,
  request: ExperimentEvalRequest,
  contract: ExperimentContract,
  options: { readonly allow_failed?: boolean } = {},
): ExperimentEvalResult {
  const value = record(input, 'evaluation result')
  exact(value, [
    'schema_version', 'contract_id', 'contract_sha256', 'profile_id', 'run_id', 'attempt',
    'status', 'checks', 'cases', 'category_scores', 'macro_scores', 'predictions_path', 'failure',
  ], 'evaluation result')
  literal(value.schema_version, EXPERIMENT_EVAL_RESULT_VERSION, 'evaluation result.schema_version')
  literal(value.contract_id, request.contract_id, 'evaluation result.contract_id')
  literal(value.contract_sha256, request.contract_sha256, 'evaluation result.contract_sha256')
  literal(value.profile_id, request.profile_id, 'evaluation result.profile_id')
  literal(value.run_id, request.run_id, 'evaluation result.run_id')
  literal(value.attempt, request.attempt, 'evaluation result.attempt')
  const status = text(value.status, 'evaluation result.status')
  if (status !== 'completed' && status !== 'failed') invalid('evaluation result.status must be completed or failed')
  const checks = record(value.checks, 'evaluation result.checks')
  exact(checks, ['gpu_count', 'gpu_family', 'model_revision', 'vllm_version', 'tool_call_parser', 'loaded_weight_shards'], 'evaluation result.checks')
  if (!Array.isArray(value.cases)) invalid('evaluation result.cases must be an array')
  const expectedIds = [...request.benchmark.case_ids.B_search, ...request.benchmark.case_ids.B_dev]
  const identity = new Map<string, { split: ExperimentSplit; category: string }>()
  for (const split of EXPERIMENT_SPLITS) {
    for (const caseId of request.benchmark.case_ids[split]) {
      const category = contract.evaluation.categories.find(name => caseId.startsWith(`${name}_`) && (
        !contract.evaluation.categories.some(other => other.length > name.length && caseId.startsWith(`${other}_`))
      ))
      if (category === undefined) invalid(`cannot infer category for ${caseId}`)
      identity.set(caseId, { split, category })
    }
  }
  const cases = value.cases.map((entry, index): ExperimentEvalCaseResult => {
    const item = record(entry, `evaluation result.cases[${String(index)}]`)
    exact(item, ['case_id', 'split', 'category', 'passed', 'failure_summary'], `evaluation result.cases[${String(index)}]`)
    const caseId = text(item.case_id, `evaluation result.cases[${String(index)}].case_id`)
    const expected = identity.get(caseId)
    if (expected === undefined) invalid(`evaluation result contains unsupported case ${caseId}`)
    literal(item.split, expected.split, `evaluation result case ${caseId}.split`)
    literal(item.category, expected.category, `evaluation result case ${caseId}.category`)
    const passed = boolean(item.passed, `evaluation result case ${caseId}.passed`)
    const failureSummary = item.failure_summary === null ? null : text(item.failure_summary, `evaluation result case ${caseId}.failure_summary`)
    if (passed && failureSummary !== null) invalid(`passed case ${caseId} cannot have failure_summary`)
    return { case_id: caseId, split: expected.split, category: expected.category, passed, failure_summary: failureSummary }
  })
  if (cases.length !== expectedIds.length || cases.some((entry, index) => entry.case_id !== expectedIds[index])) {
    invalid('evaluation result does not contain the exact frozen 50-case order')
  }

  const categoryScoresValue = record(value.category_scores, 'evaluation result.category_scores')
  exact(categoryScoresValue, [...EXPERIMENT_SPLITS], 'evaluation result.category_scores')
  const categoryScores = {} as Record<ExperimentSplit, Readonly<Record<string, number>>>
  for (const split of EXPERIMENT_SPLITS) {
    const values = record(categoryScoresValue[split], `evaluation result.category_scores.${split}`)
    exact(values, contract.evaluation.categories, `evaluation result.category_scores.${split}`)
    const normalized: Record<string, number> = {}
    for (const category of contract.evaluation.categories) {
      const observed = score(values[category], `evaluation result.category_scores.${split}.${category}`)
      const selected = cases.filter(item => item.split === split && item.category === category)
      const expectedScore = selected.filter(item => item.passed).length / selected.length
      if (observed !== expectedScore) invalid(`${split}/${category} score cannot be recomputed from cases`)
      normalized[category] = observed
    }
    categoryScores[split] = Object.freeze(normalized)
  }
  const macroValue = record(value.macro_scores, 'evaluation result.macro_scores')
  exact(macroValue, [...EXPERIMENT_SPLITS], 'evaluation result.macro_scores')
  const macroScores = {} as Record<ExperimentSplit, number>
  for (const split of EXPERIMENT_SPLITS) {
    const observed = score(macroValue[split], `evaluation result.macro_scores.${split}`)
    const expected = contract.evaluation.categories.reduce((sum, category) => sum + (categoryScores[split][category] as number), 0)
      / contract.evaluation.categories.length
    if (Math.abs(observed - expected) > Number.EPSILON * 8) invalid(`${split} macro cannot be recomputed from category scores`)
    macroScores[split] = observed
  }
  const predictionsPath = absolute(value.predictions_path, 'evaluation result.predictions_path')
  literal(predictionsPath, request.output.predictions_jsonl, 'evaluation result.predictions_path')
  const result: ExperimentEvalResult = {
    schema_version: EXPERIMENT_EVAL_RESULT_VERSION,
    contract_id: request.contract_id,
    contract_sha256: request.contract_sha256,
    profile_id: request.profile_id,
    run_id: request.run_id,
    attempt: request.attempt,
    status,
    checks: {
      gpu_count: integer(checks.gpu_count, 'evaluation result.checks.gpu_count'),
      gpu_family: text(checks.gpu_family, 'evaluation result.checks.gpu_family'),
      model_revision: text(checks.model_revision, 'evaluation result.checks.model_revision'),
      vllm_version: text(checks.vllm_version, 'evaluation result.checks.vllm_version'),
      tool_call_parser: text(checks.tool_call_parser, 'evaluation result.checks.tool_call_parser'),
      loaded_weight_shards: integer(checks.loaded_weight_shards, 'evaluation result.checks.loaded_weight_shards'),
    },
    cases,
    category_scores: categoryScores,
    macro_scores: Object.freeze(macroScores),
    predictions_path: predictionsPath,
    failure: value.failure === null ? null : text(value.failure, 'evaluation result.failure'),
  }
  if (result.status === 'failed') {
    if (result.failure === null) invalid('failed evaluation result must contain a failure message')
    if (!options.allow_failed) invalid('evaluation result did not satisfy the frozen experiment execution contract')
    return immutableJson(result) as unknown as ExperimentEvalResult
  }
  if (
    result.checks.gpu_count !== contract.evaluation.gpus
    || result.checks.gpu_family !== 'NVIDIA H200'
    || result.checks.model_revision !== contract.model.revision
    || result.checks.vllm_version !== contract.evaluation.vllm_version
    || result.checks.tool_call_parser !== contract.evaluation.tool_call_parser
    || result.checks.loaded_weight_shards !== 4
    || result.failure !== null
  ) invalid('evaluation result did not satisfy the frozen experiment execution contract')
  return immutableJson(result) as unknown as ExperimentEvalResult
}

export function experimentArtifactHashes(files: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)])))
}

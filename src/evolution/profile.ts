/** Validation and immutable snapshots for Stage 3 evolution records. */

import { immutableJson, isJsonObject } from '../core/json.js'
import { isAbsolute } from 'node:path'
import type { DataSourceIdentity, JsonObject } from '../core/types.js'
import {
  ACCEPTANCE_POLICY_SCHEMA_VERSION,
  CANDIDATE_MANIFEST_SCHEMA_VERSION,
  EVALUATION_REPORT_SCHEMA_VERSION,
  EVOLUTION_FEEDBACK_SCHEMA_VERSION,
  EvolutionError,
  H0_PLUGIN_ID,
  MAX_FEEDBACK_FAILURES,
  STAGE3_CAPABILITIES,
  TASK_PROFILE_SCHEMA_VERSION,
  type AcceptancePolicy,
  type CandidateManifest,
  type CandidateManifestInput,
  type EvaluationReport,
  type EvolutionFailureCase,
  type EvolutionFeedback,
  type EvolutionFeedbackInput,
  type Stage3Capability,
  type TaskProfile,
  type TaskProfileInput,
} from './types.js'

const ID = /^[a-z][a-z0-9-]*$/u
const CAPABILITY = /^[a-z][a-z0-9-]*$/u
const STAGE3_CAPABILITY_SET = new Set<string>(STAGE3_CAPABILITIES)
const DEFAULT_CAPABILITIES = Object.freeze([
  'data-select',
  'data-filter',
  'data-order',
] as const satisfies readonly Stage3Capability[])

function evolutionError(
  message: string,
  code: 'INVALID_PROFILE' | 'INVALID_POLICY' | 'INVALID_CANDIDATE' | 'INVALID_EVALUATION' | 'INVALID_FEEDBACK',
): never {
  throw new EvolutionError(message, code)
}

function requireRecord(value: unknown, label: string, code: Parameters<typeof evolutionError>[1]): Record<string, unknown> {
  if (!isJsonObject(value)) evolutionError(`${label} must be an object`, code)
  return value
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function requireId(value: unknown, label: string, code: Parameters<typeof evolutionError>[1]): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    evolutionError(`${label} must match ${String(ID)}`, code)
  }
  return value
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  code: Parameters<typeof evolutionError>[1],
): string | undefined {
  const value = own(record, key)
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    evolutionError(`${key} must be a non-empty string when present`, code)
  }
  return value
}

function normalizeCapabilities(
  value: unknown,
  defaults: readonly Stage3Capability[],
  code: Parameters<typeof evolutionError>[1],
): readonly Stage3Capability[] {
  if (value === undefined) value = defaults
  if (!Array.isArray(value)) evolutionError('capabilities must be an array', code)
  const seen = new Set<string>()
  const capabilities = value.map((entry, index) => {
    if (typeof entry !== 'string' || !CAPABILITY.test(entry)) {
      evolutionError(`capabilities[${String(index)}] must match ${String(CAPABILITY)}`, code)
    }
    if (!STAGE3_CAPABILITY_SET.has(entry)) {
      evolutionError(`capabilities[${String(index)}] is not available in Stage 3`, code)
    }
    if (seen.has(entry)) evolutionError(`capabilities contains duplicate ${entry}`, code)
    seen.add(entry)
    return entry as Stage3Capability
  })
  return Object.freeze(capabilities)
}

function optionalJsonObject(
  record: Record<string, unknown>,
  key: string,
  code: Parameters<typeof evolutionError>[1],
): JsonObject | undefined {
  const value = own(record, key)
  if (value === undefined) return undefined
  if (!isJsonObject(value)) evolutionError(`${key} must be a JSON object`, code)
  try {
    return immutableJson(value) as JsonObject
  } catch (error) {
    throw new EvolutionError(`${key} must contain only JSON values`, code, { cause: error })
  }
}

function optionalSource(record: Record<string, unknown>): DataSourceIdentity | undefined {
  const sourceValue = own(record, 'source')
  if (sourceValue === undefined) return undefined
  const source = requireRecord(sourceValue, 'source', 'INVALID_PROFILE')
  const allowed = new Set(['adapter_id', 'adapter_version', 'dataset_id', 'dataset_revision'])
  const extra = Object.keys(source).find(key => !allowed.has(key))
  if (extra !== undefined) evolutionError(`source has unsupported field ${extra}`, 'INVALID_PROFILE')
  const result: DataSourceIdentity = {
    adapter_id: requireNonEmptyString(own(source, 'adapter_id'), 'source.adapter_id', 'INVALID_PROFILE'),
    adapter_version: requireNonEmptyString(own(source, 'adapter_version'), 'source.adapter_version', 'INVALID_PROFILE'),
    dataset_id: requireNonEmptyString(own(source, 'dataset_id'), 'source.dataset_id', 'INVALID_PROFILE'),
    dataset_revision: requireNonEmptyString(own(source, 'dataset_revision'), 'source.dataset_revision', 'INVALID_PROFILE'),
  }
  return Object.freeze(result)
}

function requireNonEmptyString(
  value: unknown,
  label: string,
  code: Parameters<typeof evolutionError>[1],
): string {
  if (typeof value !== 'string' || value.trim().length === 0) evolutionError(`${label} must be a non-empty string`, code)
  return value
}

function assertAllowedFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  code: Parameters<typeof evolutionError>[1],
): void {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(record).find(key => !allowedSet.has(key))
  if (extra !== undefined) evolutionError(`${label} has unsupported field ${extra}`, code)
}

/** Build the only Stage 3 acceptance policy: maximize one fixed B_dev metric. */
export function normalizeAcceptancePolicy(value: unknown, defaultMetric = 'score'): AcceptancePolicy {
  const policy = value === undefined ? {} : requireRecord(value, 'acceptance policy', 'INVALID_POLICY')
  assertAllowedFields(policy, ['schema_version', 'rule', 'split', 'metric', 'direction'], 'acceptance policy', 'INVALID_POLICY')
  const schemaVersion = own(policy, 'schema_version') ?? ACCEPTANCE_POLICY_SCHEMA_VERSION
  const rule = own(policy, 'rule') ?? 'strict_improvement'
  const split = own(policy, 'split') ?? 'B_dev'
  const direction = own(policy, 'direction') ?? 'maximize'
  const metric = own(policy, 'metric') ?? defaultMetric
  if (schemaVersion !== ACCEPTANCE_POLICY_SCHEMA_VERSION) {
    evolutionError(`unsupported acceptance policy schema_version ${JSON.stringify(schemaVersion)}`, 'INVALID_POLICY')
  }
  if (rule !== 'strict_improvement' || split !== 'B_dev' || direction !== 'maximize') {
    evolutionError('acceptance policy must strictly maximize one B_dev metric', 'INVALID_POLICY')
  }
  return Object.freeze({
    schema_version: ACCEPTANCE_POLICY_SCHEMA_VERSION,
    rule: 'strict_improvement',
    split: 'B_dev',
    metric: requireNonEmptyString(metric, 'acceptance policy metric', 'INVALID_POLICY'),
    direction: 'maximize',
  })
}

/** Validate, detach, and deeply freeze one TaskProfile. */
export function normalizeTaskProfile(input: TaskProfileInput | TaskProfile): TaskProfile {
  const value = requireRecord(input, 'TaskProfile', 'INVALID_PROFILE')
  assertAllowedFields(value, [
    'schema_version', 'id', 'strategy_plugin_id', 'acceptance_policy', 'acceptance',
    'goal', 'name', 'description', 'source', 'benchmark', 'capabilities', 'metadata',
  ], 'TaskProfile', 'INVALID_PROFILE')
  const schemaVersion = own(value, 'schema_version') ?? TASK_PROFILE_SCHEMA_VERSION
  if (schemaVersion !== TASK_PROFILE_SCHEMA_VERSION) {
    evolutionError(`unsupported TaskProfile schema_version ${JSON.stringify(schemaVersion)}`, 'INVALID_PROFILE')
  }
  const acceptancePolicy = own(value, 'acceptance_policy')
  const acceptanceAlias = own(value, 'acceptance')
  if (acceptancePolicy !== undefined && acceptanceAlias !== undefined) {
    evolutionError('TaskProfile cannot declare both acceptance_policy and acceptance', 'INVALID_PROFILE')
  }
  const id = requireId(own(value, 'id'), 'TaskProfile id', 'INVALID_PROFILE')
  const strategyPluginId = requireId(
    own(value, 'strategy_plugin_id') ?? `${id}-strategy`,
    'strategy_plugin_id',
    'INVALID_PROFILE',
  )
  if (strategyPluginId === H0_PLUGIN_ID) {
    evolutionError(`strategy_plugin_id ${H0_PLUGIN_ID} is reserved for the built-in H0 baseline`, 'INVALID_PROFILE')
  }
  const benchmark = requireNonEmptyString(own(value, 'benchmark'), 'benchmark', 'INVALID_PROFILE')
  const profile: TaskProfile = {
    schema_version: TASK_PROFILE_SCHEMA_VERSION,
    id,
    strategy_plugin_id: strategyPluginId,
    acceptance_policy: normalizeAcceptancePolicy(acceptancePolicy ?? acceptanceAlias),
    benchmark,
    capabilities: normalizeCapabilities(own(value, 'capabilities'), DEFAULT_CAPABILITIES, 'INVALID_PROFILE'),
  }
  const goal = optionalString(value, 'goal', 'INVALID_PROFILE')
  const name = optionalString(value, 'name', 'INVALID_PROFILE')
  const description = optionalString(value, 'description', 'INVALID_PROFILE')
  const source = optionalSource(value)
  const metadata = optionalJsonObject(value, 'metadata', 'INVALID_PROFILE')
  return Object.freeze({
    ...profile,
    ...(goal === undefined ? {} : { goal }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(source === undefined ? {} : { source }),
    ...(metadata === undefined ? {} : { metadata }),
  })
}

/** Compatibility name for callers that prefer validation terminology. */
export const validateTaskProfile = normalizeTaskProfile

/** Validate, detach, and freeze one candidate manifest. */
export function normalizeCandidateManifest(input: CandidateManifestInput | CandidateManifest): CandidateManifest {
  const value = requireRecord(input, 'CandidateManifest', 'INVALID_CANDIDATE')
  assertAllowedFields(value, [
    'schema_version', 'candidate_id', 'profile_id', 'generation', 'parent_candidate_id',
    'strategy_version', 'capabilities', 'description', 'metadata',
  ], 'CandidateManifest', 'INVALID_CANDIDATE')
  const schemaVersion = own(value, 'schema_version') ?? CANDIDATE_MANIFEST_SCHEMA_VERSION
  if (schemaVersion !== CANDIDATE_MANIFEST_SCHEMA_VERSION) {
    evolutionError(`unsupported CandidateManifest schema_version ${JSON.stringify(schemaVersion)}`, 'INVALID_CANDIDATE')
  }
  const generation = own(value, 'generation')
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
    evolutionError('CandidateManifest generation must be a positive safe integer', 'INVALID_CANDIDATE')
  }
  const parentValue = own(value, 'parent_candidate_id')
  const parentCandidateId = parentValue === undefined || parentValue === null
    ? null
    : requireId(parentValue, 'parent_candidate_id', 'INVALID_CANDIDATE')
  const description = optionalString(value, 'description', 'INVALID_CANDIDATE')
  const metadata = optionalJsonObject(value, 'metadata', 'INVALID_CANDIDATE')
  const manifest: CandidateManifest = {
    schema_version: CANDIDATE_MANIFEST_SCHEMA_VERSION,
    candidate_id: requireId(own(value, 'candidate_id'), 'candidate_id', 'INVALID_CANDIDATE'),
    profile_id: requireId(own(value, 'profile_id'), 'profile_id', 'INVALID_CANDIDATE'),
    generation,
    parent_candidate_id: parentCandidateId,
    strategy_version: requireNonEmptyString(own(value, 'strategy_version'), 'strategy_version', 'INVALID_CANDIDATE'),
    capabilities: normalizeCapabilities(own(value, 'capabilities'), [], 'INVALID_CANDIDATE'),
  }
  return Object.freeze({
    ...manifest,
    ...(description === undefined ? {} : { description }),
    ...(metadata === undefined ? {} : { metadata }),
  })
}

/** Compatibility name for callers that prefer validation terminology. */
export const validateCandidateManifest = normalizeCandidateManifest

/** Validate candidate fields that depend on the immutable owning profile. */
export function validateCandidateForProfile(
  profileInput: TaskProfileInput | TaskProfile,
  manifestInput: CandidateManifestInput | CandidateManifest,
): CandidateManifest {
  const profile = normalizeTaskProfile(profileInput)
  const manifest = normalizeCandidateManifest(manifestInput)
  if (manifest.profile_id !== profile.id) {
    evolutionError('CandidateManifest profile_id does not match TaskProfile', 'INVALID_CANDIDATE')
  }
  const allowedCapabilities = new Set<string>(profile.capabilities)
  const unsupported = manifest.capabilities.find(capability => !allowedCapabilities.has(capability))
  if (unsupported !== undefined) {
    evolutionError(`candidate capability ${unsupported} is not enabled by TaskProfile`, 'INVALID_CANDIDATE')
  }
  return manifest
}

/** Validate and freeze one Host-authored B_search feedback record. */
export function normalizeEvolutionFeedback(
  input: EvolutionFeedbackInput | EvolutionFeedback,
): EvolutionFeedback {
  const value = requireRecord(input, 'EvolutionFeedback', 'INVALID_FEEDBACK')
  assertAllowedFields(value, [
    'schema_version', 'feedback_id', 'profile_id', 'candidate_id', 'benchmark',
    'split', 'summary', 'failures', 'metrics', 'artifact_path', 'metadata',
  ], 'EvolutionFeedback', 'INVALID_FEEDBACK')
  const schemaVersion = own(value, 'schema_version') ?? EVOLUTION_FEEDBACK_SCHEMA_VERSION
  if (schemaVersion !== EVOLUTION_FEEDBACK_SCHEMA_VERSION) {
    evolutionError(`unsupported EvolutionFeedback schema_version ${JSON.stringify(schemaVersion)}`, 'INVALID_FEEDBACK')
  }
  const split = own(value, 'split') ?? 'B_search'
  if (split !== 'B_search') evolutionError('EvolutionFeedback split must be B_search', 'INVALID_FEEDBACK')

  const rawFailures = own(value, 'failures') ?? []
  if (!Array.isArray(rawFailures) || rawFailures.length > MAX_FEEDBACK_FAILURES) {
    evolutionError(`failures must be an array with at most ${String(MAX_FEEDBACK_FAILURES)} entries`, 'INVALID_FEEDBACK')
  }
  const seen = new Set<string>()
  const failures: EvolutionFailureCase[] = rawFailures.map((entry, index) => {
    const failure = requireRecord(entry, `failures[${String(index)}]`, 'INVALID_FEEDBACK')
    assertAllowedFields(failure, ['case_id', 'summary', 'category'], `failures[${String(index)}]`, 'INVALID_FEEDBACK')
    const caseId = requireNonEmptyString(own(failure, 'case_id'), `failures[${String(index)}].case_id`, 'INVALID_FEEDBACK')
    if (seen.has(caseId)) evolutionError(`failures contains duplicate case_id ${caseId}`, 'INVALID_FEEDBACK')
    seen.add(caseId)
    const category = optionalString(failure, 'category', 'INVALID_FEEDBACK')
    return Object.freeze({
      case_id: caseId,
      summary: requireNonEmptyString(own(failure, 'summary'), `failures[${String(index)}].summary`, 'INVALID_FEEDBACK'),
      ...(category === undefined ? {} : { category }),
    })
  })

  let metrics: Readonly<Record<string, number>> | undefined
  const rawMetrics = own(value, 'metrics')
  if (rawMetrics !== undefined) {
    const entries = requireRecord(rawMetrics, 'metrics', 'INVALID_FEEDBACK')
    const normalized: Record<string, number> = {}
    for (const [key, metric] of Object.entries(entries)) {
      if (key.length === 0 || typeof metric !== 'number' || !Number.isFinite(metric)) {
        evolutionError('metrics must map non-empty names to finite numbers', 'INVALID_FEEDBACK')
      }
      normalized[key] = metric
    }
    metrics = Object.freeze(normalized)
  }

  const artifactPath = optionalString(value, 'artifact_path', 'INVALID_FEEDBACK')
  if (artifactPath !== undefined && !isAbsolute(artifactPath)) {
    evolutionError('artifact_path must be absolute when present', 'INVALID_FEEDBACK')
  }
  const metadata = optionalJsonObject(value, 'metadata', 'INVALID_FEEDBACK')
  return Object.freeze({
    schema_version: EVOLUTION_FEEDBACK_SCHEMA_VERSION,
    feedback_id: requireId(own(value, 'feedback_id'), 'feedback_id', 'INVALID_FEEDBACK'),
    profile_id: requireId(own(value, 'profile_id'), 'profile_id', 'INVALID_FEEDBACK'),
    candidate_id: requireId(own(value, 'candidate_id'), 'candidate_id', 'INVALID_FEEDBACK'),
    benchmark: requireNonEmptyString(own(value, 'benchmark'), 'benchmark', 'INVALID_FEEDBACK'),
    split: 'B_search',
    summary: requireNonEmptyString(own(value, 'summary'), 'summary', 'INVALID_FEEDBACK'),
    failures: Object.freeze(failures),
    ...(metrics === undefined ? {} : { metrics }),
    ...(artifactPath === undefined ? {} : { artifact_path: artifactPath }),
    ...(metadata === undefined ? {} : { metadata }),
  })
}

/** Validate, detach, and freeze an evaluator report before state transitions. */
export function normalizeEvaluationReport(input: EvaluationReport): EvaluationReport {
  const value = requireRecord(input, 'EvaluationReport', 'INVALID_EVALUATION')
  assertAllowedFields(value, [
    'schema_version', 'report_id', 'profile_id', 'candidate_id', 'benchmark', 'split',
    'metric', 'score', 'complete', 'cases_evaluated', 'cases_expected', 'run_id',
    'baseline_candidate_id', 'baseline_score', 'category_scores', 'metadata',
  ], 'EvaluationReport', 'INVALID_EVALUATION')
  const schemaVersion = own(value, 'schema_version')
  if (schemaVersion !== EVALUATION_REPORT_SCHEMA_VERSION) {
    evolutionError(`unsupported EvaluationReport schema_version ${JSON.stringify(schemaVersion)}`, 'INVALID_EVALUATION')
  }
  const split = own(value, 'split')
  if (split !== 'B_search' && split !== 'B_dev' && split !== 'B_test') {
    evolutionError('EvaluationReport split must be B_search, B_dev, or B_test', 'INVALID_EVALUATION')
  }
  const score = own(value, 'score')
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    evolutionError('EvaluationReport score must be a finite number', 'INVALID_EVALUATION')
  }
  const complete = own(value, 'complete')
  if (typeof complete !== 'boolean') evolutionError('EvaluationReport complete must be boolean', 'INVALID_EVALUATION')
  const casesEvaluated = normalizeCount(value, 'cases_evaluated')
  const casesExpected = normalizeCount(value, 'cases_expected')
  const baselineScoreValue = own(value, 'baseline_score')
  if (baselineScoreValue !== undefined && (typeof baselineScoreValue !== 'number' || !Number.isFinite(baselineScoreValue))) {
    evolutionError('baseline_score must be a finite number', 'INVALID_EVALUATION')
  }
  let categoryScores: Readonly<Record<string, number>> | undefined
  const categoryValue = own(value, 'category_scores')
  if (categoryValue !== undefined) {
    const categories = requireRecord(categoryValue, 'category_scores', 'INVALID_EVALUATION')
    const normalized: Record<string, number> = {}
    for (const [key, entry] of Object.entries(categories)) {
      if (key.length === 0 || typeof entry !== 'number' || !Number.isFinite(entry)) {
        evolutionError('category_scores must map non-empty names to finite numbers', 'INVALID_EVALUATION')
      }
      normalized[key] = entry
    }
    categoryScores = Object.freeze(normalized)
  }
  const metadata = optionalJsonObject(value, 'metadata', 'INVALID_EVALUATION')
  const report: EvaluationReport = {
    schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
    report_id: requireId(own(value, 'report_id'), 'report_id', 'INVALID_EVALUATION'),
    profile_id: requireId(own(value, 'profile_id'), 'profile_id', 'INVALID_EVALUATION'),
    candidate_id: requireId(own(value, 'candidate_id'), 'candidate_id', 'INVALID_EVALUATION'),
    benchmark: requireNonEmptyString(own(value, 'benchmark'), 'benchmark', 'INVALID_EVALUATION'),
    split,
    metric: requireNonEmptyString(own(value, 'metric'), 'metric', 'INVALID_EVALUATION'),
    score,
    complete,
  }
  const runIdValue = own(value, 'run_id')
  const runId = runIdValue === undefined
    ? undefined
    : requireId(runIdValue, 'run_id', 'INVALID_EVALUATION')
  const baselineIdValue = own(value, 'baseline_candidate_id')
  const baselineCandidateId = baselineIdValue === undefined
    ? undefined
    : requireId(baselineIdValue, 'baseline_candidate_id', 'INVALID_EVALUATION')
  return Object.freeze({
    ...report,
    ...(casesEvaluated === undefined ? {} : { cases_evaluated: casesEvaluated }),
    ...(casesExpected === undefined ? {} : { cases_expected: casesExpected }),
    ...(runId === undefined ? {} : { run_id: runId }),
    ...(baselineCandidateId === undefined ? {} : { baseline_candidate_id: baselineCandidateId }),
    ...(baselineScoreValue === undefined ? {} : { baseline_score: baselineScoreValue as number }),
    ...(categoryScores === undefined ? {} : { category_scores: categoryScores }),
    ...(metadata === undefined ? {} : { metadata }),
  })
}

function normalizeCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = own(record, key)
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    evolutionError(`${key} must be a non-negative safe integer`, 'INVALID_EVALUATION')
  }
  return value
}

/** Compatibility name for callers that prefer validation terminology. */
export const validateEvaluationReport = normalizeEvaluationReport

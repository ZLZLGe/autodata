/** Strict validation for the Stage 4B evaluation prediction sidecar. */

import { immutableJson, isJsonObject, parseStrictJsonObject } from '../core/json.js'
import {
  ExperimentError,
  type ExperimentEvalCaseResult,
  type ExperimentSplit,
} from './types.js'

export const EXPERIMENT_PREDICTION_VERSION = 'autodata-experiment-prediction-1'
export const EXPERIMENT_PREDICTION_COUNT = 50

export type ExperimentPredictionToolCall = Readonly<Record<string, string>>

export interface ExperimentPrediction {
  readonly schema_version: typeof EXPERIMENT_PREDICTION_VERSION
  readonly case_id: string
  readonly split: ExperimentSplit
  readonly category: string
  readonly tool_calls: readonly ExperimentPredictionToolCall[]
  readonly passed: boolean
  readonly failure_summary: string | null
}

function invalid(message: string, cause?: unknown): never {
  throw new ExperimentError(message, 'ARTIFACT_INVALID', {
    ...(cause === undefined ? {} : { cause }),
  })
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const expected = new Set(fields)
  const missing = fields.find(field => !Object.hasOwn(value, field))
  if (missing !== undefined) invalid(`${label} is missing field ${missing}`)
  const extra = Object.keys(value).find(field => !expected.has(field))
  if (extra !== undefined) invalid(`${label} has unsupported field ${extra}`)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a non-empty string`)
  return value
}

function literal<T extends string | boolean>(value: unknown, expected: T, label: string): T {
  if (value !== expected) invalid(`${label} must equal ${JSON.stringify(expected)}`)
  return expected
}

function predictionLines(text: string): readonly string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== EXPERIMENT_PREDICTION_COUNT) {
    invalid(`predictions JSONL must contain exactly ${String(EXPERIMENT_PREDICTION_COUNT)} lines`)
  }
  const blank = lines.findIndex(line => line.trim().length === 0)
  if (blank !== -1) invalid(`predictions JSONL line ${String(blank + 1)} must not be blank`)
  return lines
}

function predictionObject(line: string, lineNumber: number): Record<string, unknown> {
  try {
    return parseStrictJsonObject(line, `predictions JSONL:${String(lineNumber)}`)
  } catch (error) {
    return invalid(`predictions JSONL line ${String(lineNumber)} is not a strict JSON object`, error)
  }
}

function normalizeToolCalls(value: unknown, lineNumber: number): readonly ExperimentPredictionToolCall[] {
  const label = `prediction line ${String(lineNumber)}.tool_calls`
  if (!Array.isArray(value)) invalid(`${label} must be an array`)
  return Object.freeze(value.map((entry, index): ExperimentPredictionToolCall => {
    const callLabel = `${label}[${String(index)}]`
    if (!isJsonObject(entry)) invalid(`${callLabel} must be an object`)
    const names = Object.keys(entry)
    if (names.length !== 1) invalid(`${callLabel} must contain exactly one tool name`)
    const name = nonEmptyString(names[0], `${callLabel} tool name`)
    const argumentsJson = nonEmptyString(entry[name], `${callLabel}.${name}`)
    try {
      parseStrictJsonObject(argumentsJson, `${callLabel}.${name} arguments`)
    } catch (error) {
      invalid(`${callLabel}.${name} must be a strict JSON object string`, error)
    }
    return Object.freeze({ [name]: argumentsJson })
  }))
}

/**
 * Parse and validate the exact Stage 4B predictions JSONL sidecar.
 *
 * The result case array is the authority for identity, order, outcome, and
 * failure text. The caller should pass an already normalized evaluation
 * result's `cases` field.
 */
export function normalizeExperimentPredictionsJsonl(
  text: string,
  expectedCases: readonly ExperimentEvalCaseResult[],
): readonly ExperimentPrediction[] {
  if (expectedCases.length !== EXPERIMENT_PREDICTION_COUNT) {
    invalid(`evaluation result must contain exactly ${String(EXPERIMENT_PREDICTION_COUNT)} cases`)
  }

  const seen = new Set<string>()
  const predictions = predictionLines(text).map((line, index): ExperimentPrediction => {
    const lineNumber = index + 1
    const label = `prediction line ${String(lineNumber)}`
    const value = predictionObject(line, lineNumber)
    exact(value, [
      'schema_version',
      'case_id',
      'split',
      'category',
      'tool_calls',
      'passed',
      'failure_summary',
    ], label)

    literal(value.schema_version, EXPERIMENT_PREDICTION_VERSION, `${label}.schema_version`)
    const caseId = nonEmptyString(value.case_id, `${label}.case_id`)
    if (seen.has(caseId)) invalid(`predictions JSONL contains duplicate case ${caseId}`)
    seen.add(caseId)

    const expected = expectedCases[index]
    if (expected === undefined) invalid(`${label} has no corresponding evaluation result case`)
    literal(caseId, expected.case_id, `${label}.case_id`)
    const split = literal(value.split, expected.split, `${label}.split`)
    const category = literal(value.category, expected.category, `${label}.category`)
    const passed = literal(value.passed, expected.passed, `${label}.passed`)
    const failureSummary = value.failure_summary === null
      ? null
      : nonEmptyString(value.failure_summary, `${label}.failure_summary`)
    if (passed && failureSummary !== null) invalid(`${label} passed case must have null failure_summary`)
    if (!passed && failureSummary === null) invalid(`${label} failed case must have a failure_summary`)
    if (failureSummary !== expected.failure_summary) {
      invalid(`${label}.failure_summary must equal the evaluation result case`)
    }

    return {
      schema_version: EXPERIMENT_PREDICTION_VERSION,
      case_id: caseId,
      split,
      category,
      tool_calls: normalizeToolCalls(value.tool_calls, lineNumber),
      passed,
      failure_summary: failureSummary,
    }
  })

  return immutableJson(predictions) as unknown as readonly ExperimentPrediction[]
}

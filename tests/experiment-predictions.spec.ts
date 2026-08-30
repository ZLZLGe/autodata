import { describe, expect, it } from 'vitest'
import {
  EXPERIMENT_PREDICTION_COUNT,
  EXPERIMENT_PREDICTION_VERSION,
  normalizeExperimentPredictionsJsonl,
  type ExperimentPrediction,
} from '../src/experiment/predictions.js'
import type { ExperimentEvalCaseResult } from '../src/experiment/types.js'

const CATEGORIES = ['simple_python', 'multiple', 'parallel', 'parallel_multiple', 'irrelevance'] as const

function cases(): readonly ExperimentEvalCaseResult[] {
  return Array.from({ length: EXPERIMENT_PREDICTION_COUNT }, (_, index) => {
    const split = index < 25 ? 'B_search' : 'B_dev'
    const category = CATEGORIES[Math.floor((index % 25) / 5)] as string
    const passed = index % 7 !== 0
    return {
      case_id: `${category}_${String(index)}`,
      split,
      category,
      passed,
      failure_summary: passed ? null : 'fixture failure',
    }
  })
}

function predictions(expected = cases()): ExperimentPrediction[] {
  return expected.map(value => ({
    schema_version: EXPERIMENT_PREDICTION_VERSION,
    case_id: value.case_id,
    split: value.split,
    category: value.category,
    tool_calls: value.category === 'irrelevance' ? [] : [{ lookup: '{"q":"x"}' }],
    passed: value.passed,
    failure_summary: value.failure_summary,
  }))
}

function jsonl(values: readonly unknown[]): string {
  return `${values.map(value => JSON.stringify(value)).join('\n')}\n`
}

function expectInvalid(content: string, expected = cases()): void {
  expect(() => normalizeExperimentPredictionsJsonl(content, expected)).toThrowError(
    expect.objectContaining({ code: 'ARTIFACT_INVALID' }),
  )
}

describe('normalizeExperimentPredictionsJsonl', () => {
  it('accepts and deeply freezes the exact 50-line worker format', () => {
    const result = normalizeExperimentPredictionsJsonl(jsonl(predictions()), cases())

    expect(result).toHaveLength(50)
    expect(result.map(value => value.case_id)).toEqual(cases().map(value => value.case_id))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0])).toBe(true)
    expect(Object.isFrozen(result[1]?.tool_calls[0])).toBe(true)
  })

  it('accepts JSONL without a final newline and non-canonical argument whitespace', () => {
    const values = predictions()
    values[1] = { ...values[1] as ExperimentPrediction, tool_calls: [{ lookup: '{ "q": "x" }' }] }

    expect(normalizeExperimentPredictionsJsonl(jsonl(values).slice(0, -1), cases())).toHaveLength(50)
  })

  it('rejects truncated, extra, blank, and malformed JSONL', () => {
    const valid = predictions()
    expectInvalid(jsonl(valid.slice(0, -1)))
    expectInvalid(jsonl([...valid, valid[0]]))
    expectInvalid(`${jsonl(valid.slice(0, 25))}\n${jsonl(valid.slice(25))}`)
    expectInvalid(`${jsonl(valid.slice(0, 20))}{invalid}\n${jsonl(valid.slice(21))}`)
  })

  it('rejects duplicate records and identity or outcome divergence', () => {
    const expected = cases()
    const duplicate = predictions(expected)
    duplicate[1] = { ...duplicate[1] as ExperimentPrediction, case_id: duplicate[0]?.case_id as string }
    expectInvalid(jsonl(duplicate), expected)

    const divergences: readonly (readonly [number, Readonly<Record<string, unknown>>])[] = [
      [7, { case_id: 'unexpected_1' }],
      [7, { split: 'B_dev' }],
      [7, { category: 'simple_python' }],
      [7, { schema_version: 'unsupported' }],
      [8, { passed: false, failure_summary: 'fixture failure' }],
      [0, { failure_summary: 'different failure' }],
    ]
    for (const [index, mutation] of divergences) {
      const divergent = predictions(expected)
      divergent[index] = {
        ...divergent[index] as ExperimentPrediction,
        ...mutation,
      } as ExperimentPrediction
      expectInvalid(jsonl(divergent), expected)
    }
  })

  it('requires failure summaries to agree with pass/fail status and result cases', () => {
    const expected = cases()
    const missingFailure = predictions(expected)
    missingFailure[0] = { ...missingFailure[0] as ExperimentPrediction, failure_summary: null }
    expectInvalid(jsonl(missingFailure), expected)

    const passingFailure = predictions(expected)
    passingFailure[1] = { ...passingFailure[1] as ExperimentPrediction, failure_summary: 'unexpected' }
    expectInvalid(jsonl(passingFailure), expected)
  })

  it.each([
    ['non-array tool_calls', {}],
    ['non-object call', ['lookup']],
    ['empty call', [{}]],
    ['multi-name call', [{ lookup: '{}', other: '{}' }]],
    ['non-string arguments', [{ lookup: {} }]],
    ['non-JSON arguments', [{ lookup: '{' }]],
    ['non-object JSON arguments', [{ lookup: '[]' }]],
    ['duplicate argument key', [{ lookup: '{"q":1,"q":2}' }]],
  ])('rejects %s', (_label, toolCalls) => {
    const invalid = predictions()
    invalid[1] = { ...invalid[1] as ExperimentPrediction, tool_calls: toolCalls } as unknown as ExperimentPrediction
    expectInvalid(jsonl(invalid))
  })

  it('rejects missing or unsupported prediction fields', () => {
    const missing = predictions() as unknown as Array<Record<string, unknown>>
    delete missing[1]?.category
    expectInvalid(jsonl(missing))

    const extra = predictions() as unknown as Array<Record<string, unknown>>
    extra[1] = { ...extra[1], raw_response: 'not part of the protocol' }
    expectInvalid(jsonl(extra))
  })

  it('requires the authoritative result to contain the frozen 50 cases', () => {
    expectInvalid(jsonl(predictions()), cases().slice(0, -1))
  })
})

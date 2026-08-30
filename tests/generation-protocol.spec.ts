import { describe, expect, it } from 'vitest'
import {
  GENERATION_B_SEARCH_RESULTS_VERSION,
  normalizeGenerationBSearchResults,
  type GenerationBSearchProtocolExpectation,
} from '../src/generation/protocol.js'

const CATEGORIES = ['simple_python', 'multiple', 'parallel', 'parallel_multiple', 'irrelevance'] as const
const CASE_IDS = CATEGORIES.flatMap(category => [`${category}_1`, `${category}_2`])
const EXPECTED: GenerationBSearchProtocolExpectation = {
  profile_id: 'bfcl-v4',
  run_id: 'h1-run',
  candidate_id: 'candidate-h1',
  contract_id: 'stage4c-candidate-1',
  contract_sha256: 'a'.repeat(64),
  case_ids: CASE_IDS,
  categories: CATEGORIES,
  cases_per_category: 2,
}

function artifact(): Record<string, unknown> {
  return {
    schema_version: GENERATION_B_SEARCH_RESULTS_VERSION,
    contract_id: EXPECTED.contract_id,
    contract_sha256: EXPECTED.contract_sha256,
    profile_id: EXPECTED.profile_id,
    run_id: EXPECTED.run_id,
    candidate_id: EXPECTED.candidate_id,
    cases: CASE_IDS.map((caseId, index) => ({
      case_id: caseId,
      split: 'B_search',
      category: CATEGORIES[Math.floor(index / 2)],
      passed: index % 2 === 0,
      failure_summary: index % 2 === 0 ? null : 'fixture failure',
    })),
    category_scores: Object.fromEntries(CATEGORIES.map(category => [category, 0.5])),
    macro_score: 0.5,
  }
}

function casesOf(value: Record<string, unknown>): Array<Record<string, unknown>> {
  return value.cases as Array<Record<string, unknown>>
}

function scoresOf(value: Record<string, unknown>): Record<string, unknown> {
  return value.category_scores as Record<string, unknown>
}

function expectInvalid(
  value: unknown,
  expected: GenerationBSearchProtocolExpectation = EXPECTED,
): void {
  expect(() => normalizeGenerationBSearchResults(value, expected)).toThrowError(
    expect.objectContaining({ code: 'ARTIFACT_INVALID' }),
  )
}

describe('normalizeGenerationBSearchResults', () => {
  it('accepts, detaches, and deeply freezes the exact B_search sidecar', () => {
    const input = artifact()
    const result = normalizeGenerationBSearchResults(input, EXPECTED)

    expect(result.cases.map(value => value.case_id)).toEqual(CASE_IDS)
    expect(result.category_scores).toEqual(Object.fromEntries(CATEGORIES.map(category => [category, 0.5])))
    expect(result.macro_score).toBe(0.5)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.cases)).toBe(true)
    expect(Object.isFrozen(result.cases[0])).toBe(true)
    expect(Object.isFrozen(result.category_scores)).toBe(true)

    casesOf(input)[0]!.passed = false
    expect(result.cases[0]?.passed).toBe(true)
  })

  it('accepts the historical H0 schema only when candidate_id is absent', () => {
    const input = artifact()
    delete input.candidate_id
    const { candidate_id: _candidateId, ...expected } = EXPECTED

    expect(normalizeGenerationBSearchResults(input, expected).candidate_id).toBeUndefined()
    expectInvalid({ ...input, candidate_id: 'h0' }, expected)
  })

  it.each([
    ['schema_version', 'unsupported'],
    ['contract_id', 'different-contract'],
    ['contract_sha256', 'b'.repeat(64)],
    ['profile_id', 'different-profile'],
    ['run_id', 'different-run'],
    ['candidate_id', 'different-candidate'],
  ] as const)('rejects mismatched %s', (field, replacement) => {
    expectInvalid({ ...artifact(), [field]: replacement })
  })

  it('rejects missing and extra top-level fields', () => {
    const missing = artifact()
    delete missing.contract_id
    expectInvalid(missing)
    expectInvalid({ ...artifact(), unexpected: true })
  })

  it('requires the exact unique frozen case count and order', () => {
    const truncated = artifact()
    truncated.cases = casesOf(truncated).slice(0, -1)
    expectInvalid(truncated)

    const reordered = artifact()
    const rows = casesOf(reordered)
    ;[rows[0], rows[1]] = [rows[1]!, rows[0]!]
    expectInvalid(reordered)

    const duplicate = artifact()
    casesOf(duplicate)[1]!.case_id = casesOf(duplicate)[0]!.case_id
    expectInvalid(duplicate)
  })

  it('rejects case shape, split, category, outcome, and failure-summary mutations', () => {
    const missing = artifact()
    delete casesOf(missing)[0]!.failure_summary
    expectInvalid(missing)

    const extra = artifact()
    casesOf(extra)[0]!.raw = 'unsupported'
    expectInvalid(extra)

    const wrongSplit = artifact()
    casesOf(wrongSplit)[0]!.split = 'B_dev'
    expectInvalid(wrongSplit)

    const wrongCategory = artifact()
    casesOf(wrongCategory)[6]!.category = 'parallel'
    expectInvalid(wrongCategory)

    const wrongPassed = artifact()
    casesOf(wrongPassed)[0]!.passed = 1
    expectInvalid(wrongPassed)

    const wrongFailure = artifact()
    casesOf(wrongFailure)[1]!.failure_summary = false
    expectInvalid(wrongFailure)

    const passingFailure = artifact()
    casesOf(passingFailure)[0]!.failure_summary = 'unexpected'
    expectInvalid(passingFailure)
  })

  it('requires exact category-score keys and recomputes every category', () => {
    const missing = artifact()
    delete scoresOf(missing).irrelevance
    expectInvalid(missing)

    const extra = artifact()
    scoresOf(extra).other = 0.5
    expectInvalid(extra)

    const inconsistent = artifact()
    scoresOf(inconsistent).multiple = 1
    expectInvalid(inconsistent)

    const outOfRange = artifact()
    scoresOf(outOfRange).parallel = 1.1
    expectInvalid(outOfRange)
  })

  it('recomputes the equal-category macro score', () => {
    expectInvalid({ ...artifact(), macro_score: 0.6 })
    expectInvalid({ ...artifact(), macro_score: Number.NaN })
  })

  it('rejects malformed expected identities and case manifests', () => {
    expectInvalid(artifact(), { ...EXPECTED, contract_sha256: 'not-a-sha' })
    expectInvalid(artifact(), { ...EXPECTED, categories: CATEGORIES.slice(0, -1) })
    expectInvalid(artifact(), { ...EXPECTED, case_ids: [...CASE_IDS.slice(0, -1), CASE_IDS[0] as string] })
    expectInvalid(artifact(), { ...EXPECTED, cases_per_category: 3 })
  })
})

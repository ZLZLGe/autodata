import { immutableJson, isJsonObject } from '../core/json.js'
import { GenerationError } from './types.js'

export const GENERATION_B_SEARCH_RESULTS_VERSION = 'autodata-b-search-results-1'

export interface GenerationBSearchProtocolExpectation {
  readonly profile_id: string
  readonly run_id: string
  /** Present for H1; absent for the historical H0 sidecar schema. */
  readonly candidate_id?: string
  readonly contract_id: string
  readonly contract_sha256: string
  readonly case_ids: readonly string[]
  readonly categories: readonly string[]
  readonly cases_per_category: number
}

export interface GenerationBSearchCaseResult {
  readonly case_id: string
  readonly split: 'B_search'
  readonly category: string
  readonly passed: boolean
  readonly failure_summary: string | null
}

export interface GenerationBSearchResults {
  readonly schema_version: typeof GENERATION_B_SEARCH_RESULTS_VERSION
  readonly contract_id: string
  readonly contract_sha256: string
  readonly profile_id: string
  readonly run_id: string
  readonly candidate_id?: string
  readonly cases: readonly GenerationBSearchCaseResult[]
  readonly category_scores: Readonly<Record<string, number>>
  readonly macro_score: number
}

const SHA256 = /^[a-f0-9]{64}$/u

function invalid(message: string): never {
  throw new GenerationError(message, 'ARTIFACT_INVALID')
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

function literal(value: unknown, expected: string, label: string): string {
  if (value !== expected) invalid(`${label} must equal ${JSON.stringify(expected)}`)
  return expected
}

function score(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${label} must be a finite number between 0 and 1`)
  }
  return value
}

function sameScore(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * 8
}

function caseCategory(caseId: string, categories: readonly string[]): string {
  const matches = categories
    .filter(category => caseId.startsWith(`${category}_`))
    .sort((left, right) => right.length - left.length)
  const category = matches[0]
  if (category === undefined) invalid(`cannot infer a frozen category for B_search case ${caseId}`)
  return category
}

function normalizeExpectation(
  input: GenerationBSearchProtocolExpectation,
): GenerationBSearchProtocolExpectation & { readonly category_by_case: ReadonlyMap<string, string> } {
  const profileId = text(input.profile_id, 'expected.profile_id')
  const runId = text(input.run_id, 'expected.run_id')
  const candidateId = input.candidate_id === undefined
    ? undefined
    : text(input.candidate_id, 'expected.candidate_id')
  const contractId = text(input.contract_id, 'expected.contract_id')
  const contractSha256 = text(input.contract_sha256, 'expected.contract_sha256')
  if (!SHA256.test(contractSha256)) invalid('expected.contract_sha256 must be lowercase SHA-256')
  if (!Array.isArray(input.categories) || input.categories.length !== 5) {
    invalid('expected.categories must contain the frozen five categories')
  }
  const categories = input.categories.map((category, index) => text(category, `expected.categories[${String(index)}]`))
  if (new Set(categories).size !== categories.length) invalid('expected.categories must be unique')
  if (!Number.isSafeInteger(input.cases_per_category) || input.cases_per_category < 1) {
    invalid('expected.cases_per_category must be a positive safe integer')
  }
  if (!Array.isArray(input.case_ids)) invalid('expected.case_ids must be an array')
  const caseIds = input.case_ids.map((caseId, index) => text(caseId, `expected.case_ids[${String(index)}]`))
  if (caseIds.length !== categories.length * input.cases_per_category) {
    invalid('expected.case_ids does not contain the frozen category count')
  }
  if (new Set(caseIds).size !== caseIds.length) invalid('expected.case_ids must be unique')

  const categoryByCase = new Map<string, string>()
  const categoryCounts = new Map(categories.map(category => [category, 0]))
  for (const caseId of caseIds) {
    const category = caseCategory(caseId, categories)
    categoryByCase.set(caseId, category)
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
  }
  for (const category of categories) {
    if (categoryCounts.get(category) !== input.cases_per_category) {
      invalid(`expected category ${category} must contain ${String(input.cases_per_category)} cases`)
    }
  }
  return {
    profile_id: profileId,
    run_id: runId,
    ...(candidateId === undefined ? {} : { candidate_id: candidateId }),
    contract_id: contractId,
    contract_sha256: contractSha256,
    case_ids: caseIds,
    categories,
    cases_per_category: input.cases_per_category,
    category_by_case: categoryByCase,
  }
}

/** Validate and detach the exact B_search sidecar consumed by Stage 4C feedback. */
export function normalizeGenerationBSearchResults(
  input: unknown,
  expectedInput: GenerationBSearchProtocolExpectation,
): GenerationBSearchResults {
  const expected = normalizeExpectation(expectedInput)
  const value = record(input, 'B_search results')
  exact(value, [
    'schema_version',
    'contract_id',
    'contract_sha256',
    'profile_id',
    'run_id',
    ...(expected.candidate_id === undefined ? [] : ['candidate_id']),
    'cases',
    'category_scores',
    'macro_score',
  ], 'B_search results')
  literal(value.schema_version, GENERATION_B_SEARCH_RESULTS_VERSION, 'B_search results.schema_version')
  literal(value.contract_id, expected.contract_id, 'B_search results.contract_id')
  literal(value.contract_sha256, expected.contract_sha256, 'B_search results.contract_sha256')
  literal(value.profile_id, expected.profile_id, 'B_search results.profile_id')
  literal(value.run_id, expected.run_id, 'B_search results.run_id')
  if (expected.candidate_id !== undefined) {
    literal(value.candidate_id, expected.candidate_id, 'B_search results.candidate_id')
  }

  if (!Array.isArray(value.cases)) invalid('B_search results.cases must be an array')
  if (value.cases.length !== expected.case_ids.length) {
    invalid(`B_search results.cases must contain exactly ${String(expected.case_ids.length)} cases`)
  }
  const seen = new Set<string>()
  const cases = value.cases.map((entry, index): GenerationBSearchCaseResult => {
    const item = record(entry, `B_search results.cases[${String(index)}]`)
    exact(item, ['case_id', 'split', 'category', 'passed', 'failure_summary'], `B_search results.cases[${String(index)}]`)
    const caseId = text(item.case_id, `B_search results.cases[${String(index)}].case_id`)
    if (seen.has(caseId)) invalid(`B_search results contains duplicate case ${caseId}`)
    seen.add(caseId)
    const expectedCaseId = expected.case_ids[index]
    if (expectedCaseId === undefined || caseId !== expectedCaseId) {
      invalid(`B_search results case ${String(index)} does not match the frozen order`)
    }
    const category = expected.category_by_case.get(caseId)
    if (category === undefined) invalid(`B_search results contains unsupported case ${caseId}`)
    literal(item.split, 'B_search', `B_search results case ${caseId}.split`)
    literal(item.category, category, `B_search results case ${caseId}.category`)
    if (typeof item.passed !== 'boolean') invalid(`B_search results case ${caseId}.passed must be a boolean`)
    if (item.failure_summary !== null && typeof item.failure_summary !== 'string') {
      invalid(`B_search results case ${caseId}.failure_summary must be a string or null`)
    }
    if (item.passed && item.failure_summary !== null) {
      invalid(`passed B_search case ${caseId} cannot have failure_summary`)
    }
    return {
      case_id: caseId,
      split: 'B_search',
      category,
      passed: item.passed,
      failure_summary: item.failure_summary,
    }
  })

  const categoryScoresValue = record(value.category_scores, 'B_search results.category_scores')
  exact(categoryScoresValue, expected.categories, 'B_search results.category_scores')
  const categoryScores: Record<string, number> = {}
  for (const category of expected.categories) {
    const observed = score(categoryScoresValue[category], `B_search results.category_scores.${category}`)
    const selected = cases.filter(item => item.category === category)
    if (selected.length !== expected.cases_per_category) {
      invalid(`B_search results category ${category} does not contain the frozen case count`)
    }
    const recomputed = selected.filter(item => item.passed).length / selected.length
    if (!sameScore(observed, recomputed)) {
      invalid(`B_search results category ${category} score cannot be recomputed from cases`)
    }
    categoryScores[category] = observed
  }

  const macroScore = score(value.macro_score, 'B_search results.macro_score')
  const recomputedMacro = expected.categories.reduce(
    (sum, category) => sum + (categoryScores[category] as number),
    0,
  ) / expected.categories.length
  if (!sameScore(macroScore, recomputedMacro)) {
    invalid('B_search results macro_score cannot be recomputed from the five category scores')
  }

  return immutableJson({
    schema_version: GENERATION_B_SEARCH_RESULTS_VERSION,
    contract_id: expected.contract_id,
    contract_sha256: expected.contract_sha256,
    profile_id: expected.profile_id,
    run_id: expected.run_id,
    ...(expected.candidate_id === undefined ? {} : { candidate_id: expected.candidate_id }),
    cases,
    category_scores: categoryScores,
    macro_score: macroScore,
  }) as unknown as GenerationBSearchResults
}

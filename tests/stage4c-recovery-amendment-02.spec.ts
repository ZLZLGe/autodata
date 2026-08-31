import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface RecoveryOptions {
  readonly originalGenerationRoot: string
  readonly predecessorGenerationRoot: string
  readonly recoveryGenerationRoot: string
  readonly diagnosticRoot: string
  readonly experimentRunRoot: string
  readonly experimentStagingRoot: string
  readonly evolutionRoot: string
  readonly recoveryCommit: string
  readonly provider: string
  readonly model: string
}

interface AmendmentModule {
  readonly STAGE4C_RECOVERY_AMENDMENT_02_FILE: string
  readonly STAGE4C_RECOVERY_02_OWNER_FILE: string
  createStage4CRecovery02Amendment(options: RecoveryOptions): {
    readonly path: string
    readonly created: boolean
    readonly amendment: Record<string, unknown>
  }
  verifyStage4CRecovery02Amendment(options: RecoveryOptions): {
    readonly path: string
    readonly created: boolean
    readonly amendment: Record<string, unknown>
  }
  verifyStage4CRecovery02Source(options: RecoveryOptions): Record<string, unknown>
}

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/stage4c-recovery-amendment-02.mjs')).href
const recovery = await import(moduleUrl) as AmendmentModule
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function json(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function textSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autodata-stage4c-recovery-02-'))
  roots.push(root)
  const originalGenerationRoot = resolve(root, 'original')
  const predecessorGenerationRoot = resolve(root, 'recovery-01')
  const recoveryGenerationRoot = resolve(root, 'recovery-02')
  const diagnosticRoot = resolve(root, 'diagnostic')
  const experimentRunRoot = resolve(root, 'experiments')
  const experimentStagingRoot = resolve(root, 'staging')
  const evolutionRoot = resolve(root, 'evolution')
  for (const path of [
    originalGenerationRoot,
    predecessorGenerationRoot,
    recoveryGenerationRoot,
    diagnosticRoot,
    experimentRunRoot,
    experimentStagingRoot,
    evolutionRoot,
  ]) mkdirSync(path, { recursive: true })

  const profileId = 'bfcl-v4'
  const originalRunId = 'first-h1-aa168525e92f-20260831'
  const originalExperimentId = 'h1-aa168525e92f-20260831'
  const originalCandidateId = 'candidate-h1-aa168525e92f-20260831'
  const originalCommit = 'aa168525e92fdcca297ad13dc4531393130a67d1'
  const predecessorRunId = 'first-h1-recovery-01-c7eb58fe1623-20260831'
  const predecessorExperimentId = 'h1-recovery-01-c7eb58fe1623-20260831'
  const predecessorCandidateId = 'candidate-h1-recovery-01-c7eb58fe1623-20260831'
  const predecessorCommit = 'c7eb58fe16239add34d4dd5bf42ccfc584282d29'
  const recoveryCommit = 'e666c608c20b4e59210d553a613e975ba6364dd3'
  const h0Directory = resolve(experimentRunRoot, profileId, 'h0-f058c05bd893-20260830')
  const predecessorProfile = resolve(predecessorGenerationRoot, profileId)
  const predecessorRun = resolve(predecessorProfile, predecessorRunId)
  const originalProfile = resolve(originalGenerationRoot, profileId)
  const originalRun = resolve(originalProfile, originalRunId)
  mkdirSync(predecessorRun, { recursive: true })
  mkdirSync(originalRun, { recursive: true })
  mkdirSync(h0Directory, { recursive: true })

  const canonicalPath = resolve(h0Directory, 'canonical.jsonl')
  writeFileSync(canonicalPath, '{"fixture":"canonical"}\n')
  const sourcePoolSha256 = sha256(canonicalPath)
  const contractPath = resolve(h0Directory, 'experiment-contract.json')
  copyFileSync(resolve(process.cwd(), 'stage4b/experiment-contract.json'), contractPath)
  json(resolve(h0Directory, 'state.json'), {
    schema_version: 'autodata-experiment-state-1',
    profile_id: profileId,
    run_id: 'h0-f058c05bd893-20260830',
    contract_id: 'stage4b-h0-baseline-1',
    contract_sha256: sha256(contractPath),
    feedback_id: 'h0-search-0f39b730fc5af5a756bc',
    evaluation_report_id: 'h0-dev-0f39b730fc5af5a756bc',
    status: 'succeeded',
    phase: 'complete',
  })
  json(resolve(h0Directory, 'run-summary.json'), { fixture: 'H0 run summary' })
  json(resolve(h0Directory, 'b-search-results.json'), { fixture: 'H0 B_search results' })
  json(resolve(h0Directory, 'feedback.json'), { fixture: 'H0 feedback' })
  json(resolve(h0Directory, 'evaluation-report.json'), { fixture: 'H0 evaluation report' })
  const h0PredictionsPath = resolve(h0Directory, 'attempts', 'eval', '0001', 'predictions.jsonl')
  mkdirSync(resolve(h0PredictionsPath, '..'), { recursive: true })
  writeFileSync(h0PredictionsPath, '{"fixture":"prediction"}\n')
  const evolutionStatePath = resolve(evolutionRoot, 'profiles', profileId, 'state.json')
  json(evolutionStatePath, {
    schema_version: 'autodata-evolution-state-2',
    profile_id: profileId,
    generation: 0,
    active_candidate_id: 'h0',
    open_candidate_id: null,
    candidates: [{ candidate_id: 'h0', generation: 0, status: 'accepted', parent_candidate_id: null }],
  })
  const evolutionProfilePath = resolve(evolutionRoot, 'profiles', profileId, 'profile.json')
  const evolutionFeedbackPath = resolve(evolutionRoot, 'profiles', profileId, 'feedback', 'h0-search-0f39b730fc5af5a756bc.json')
  const evolutionEvaluationPath = resolve(evolutionRoot, 'profiles', profileId, 'runs', 'h0-f058c05bd893-20260830', 'summary.json')
  json(evolutionProfilePath, { fixture: 'Evolution profile' })
  json(evolutionFeedbackPath, { fixture: 'Evolution H0 feedback' })
  json(evolutionEvaluationPath, { fixture: 'Evolution H0 evaluation' })

  const proposalContextPath = resolve(predecessorRun, 'proposal-context.json')
  json(proposalContextPath, {
    profile_id: profileId,
    benchmark: 'bfcl-v4',
    strategy_plugin_id: 'bfcl-v4-strategy',
    strategy_version: '1',
    generation: 1,
    seed: 42,
    allowed_capabilities: ['data-select', 'data-filter', 'data-order'],
    b_search: { summary: 'B_search fixture', metrics: { macro_score: 0.8 }, failures: [] },
    source_pool: {
      canonical_records: 100,
      canonical_jsonl_sha256: sourcePoolSha256,
      records: Array.from({ length: 100 }, (_, index) => ({
        record_id: `record-${String(index + 1)}`,
        user_excerpt: 'fixture',
        assistant_tool_names: [],
        available_tool_names: [],
        assistant_messages: 1,
        no_tool_assistant_messages: 1,
      })),
    },
  })
  const originalProposalContextPath = resolve(originalRun, 'proposal-context.json')
  copyFileSync(proposalContextPath, originalProposalContextPath)
  const originalClaimPath = resolve(originalProfile, 'first-h1-claim.json')
  const originalRequestPath = resolve(originalRun, 'request.json')
  const originalStatePath = resolve(originalRun, 'state.json')
  const originalLineagePath = resolve(originalRun, 'source-lineage.json')
  json(originalClaimPath, {
    schema_version: 'autodata-first-h1-claim-1',
    profile_id: profileId,
    run_id: originalRunId,
    experiment_run_id: originalExperimentId,
    candidate_id: originalCandidateId,
    execution_commit: originalCommit,
  })
  json(originalRequestPath, {
    profile_id: profileId,
    run_id: originalRunId,
    experiment_run_id: originalExperimentId,
    execution_commit: originalCommit,
    baseline_run_directory: h0Directory,
    b_search_cases_jsonl: '/root/autodata/stage4b/bfcl/search.jsonl',
    candidate_id: originalCandidateId,
    strategy_version: '1',
  })
  json(originalLineagePath, {
    schema_version: 'autodata-generation-lineage-1',
    profile_id: profileId,
    parent_candidate_id: 'h0',
    candidate_id: originalCandidateId,
    execution_commit: originalCommit,
    baseline_run_directory: h0Directory,
    baseline_feedback_id: 'h0-search-0f39b730fc5af5a756bc',
    source_pool_sha256: sourcePoolSha256,
  })
  const originalResponsePaths = [1, 2, 3].map(number => (
    resolve(originalRun, 'attempts', `draft-${String(number).padStart(2, '0')}`, 'response.json')
  ))
  for (const responsePath of originalResponsePaths) json(responsePath, { error: 'original proposal failed' })
  json(originalStatePath, {
    schema_version: 'autodata-generation-state-1',
    profile_id: profileId,
    run_id: originalRunId,
    status: 'failed',
    phase: 'proposing',
    formal_candidate_persisted: false,
  })
  json(resolve(predecessorProfile, 'first-h1-claim.json'), {
    schema_version: 'autodata-first-h1-claim-1',
    profile_id: profileId,
    run_id: predecessorRunId,
    experiment_run_id: predecessorExperimentId,
    candidate_id: predecessorCandidateId,
    execution_commit: predecessorCommit,
  })
  json(resolve(predecessorRun, 'request.json'), {
    profile_id: profileId,
    run_id: predecessorRunId,
    experiment_run_id: predecessorExperimentId,
    execution_commit: predecessorCommit,
    baseline_run_directory: h0Directory,
    b_search_cases_jsonl: '/root/autodata/stage4b/bfcl/search.jsonl',
    candidate_id: predecessorCandidateId,
    strategy_version: '1',
  })
  json(resolve(predecessorRun, 'source-lineage.json'), {
    schema_version: 'autodata-generation-lineage-1',
    profile_id: profileId,
    parent_candidate_id: 'h0',
    candidate_id: predecessorCandidateId,
    execution_commit: predecessorCommit,
    baseline_run_directory: h0Directory,
    baseline_feedback_id: 'h0-search-0f39b730fc5af5a756bc',
    source_pool_sha256: sourcePoolSha256,
  })
  const hostSources = ['return { apply() { return "first" } }', 'return { apply() { return "second" } }']
  const responsePaths = [1, 2, 3].map(number => (
    resolve(predecessorRun, 'attempts', `draft-${String(number).padStart(2, '0')}`, 'response.json')
  ))
  json(responsePaths[0]!, { host_source: hostSources[0], description: 'first invalid draft' })
  json(responsePaths[1]!, { host_source: hostSources[1], description: 'second invalid draft' })
  json(responsePaths[2]!, { error: 'proposal Agent turn did not complete (kind=max-tokens)' })
  const validationFailure = 'AutoDataCoreError: plugin pipeline produced no selected records'
  json(resolve(predecessorRun, 'state.json'), {
    schema_version: 'autodata-generation-state-1',
    profile_id: profileId,
    run_id: predecessorRunId,
    experiment_run_id: predecessorExperimentId,
    candidate_id: predecessorCandidateId,
    strategy_version: '1',
    execution_commit: predecessorCommit,
    status: 'failed',
    phase: 'proposing',
    run_directory: predecessorRun,
    baseline_run_directory: h0Directory,
    b_search_cases_jsonl: '/root/autodata/stage4b/bfcl/search.jsonl',
    created_at: '2026-08-30T18:22:53.079Z',
    updated_at: '2026-08-30T18:27:50.001Z',
    attempts: [
      {
        attempt: 1,
        status: 'failed',
        response_path: responsePaths[0],
        created_at: '2026-08-30T18:22:53.502Z',
        host_source_sha256: textSha256(hostSources[0]!),
        validation: {
          schema_version: 'autodata-candidate-validation-1',
          candidate_id: predecessorCandidateId,
          ok: false,
          reason: validationFailure,
        },
        failure: validationFailure,
      },
      {
        attempt: 2,
        status: 'failed',
        response_path: responsePaths[1],
        created_at: '2026-08-30T18:24:05.127Z',
        host_source_sha256: textSha256(hostSources[1]!),
        validation: {
          schema_version: 'autodata-candidate-validation-1',
          candidate_id: predecessorCandidateId,
          ok: false,
          reason: validationFailure,
        },
        failure: validationFailure,
      },
      {
        attempt: 3,
        status: 'failed',
        response_path: responsePaths[2],
        created_at: '2026-08-30T18:25:41.226Z',
        failure: 'proposal Agent turn did not complete (kind=max-tokens)',
      },
    ],
    formal_candidate_persisted: false,
    failure: { code: 'PROPOSAL_FAILED', message: 'all 3 ephemeral drafts failed' },
  })

  const amendment01Path = resolve(predecessorGenerationRoot, 'protocol-amendment-01.json')
  json(amendment01Path, {
    schema_version: 'autodata-stage4c-recovery-amendment-1',
    amendment_id: 'stage4c-recovery-amendment-01',
    same_logical_h1: true,
    recovery_execution: {
      execution_commit: predecessorCommit,
      provider: 'pjlab',
      model: 'glm-5.3-flash',
      generation_root: predecessorGenerationRoot,
      generation_run_id: predecessorRunId,
      experiment_run_id: predecessorExperimentId,
      candidate_id: predecessorCandidateId,
    },
    frozen_h0: {
      profile_id: profileId,
      run_id: 'h0-f058c05bd893-20260830',
      contract_id: 'stage4b-h0-baseline-1',
      contract_sha256: sha256(contractPath),
      feedback_id: 'h0-search-0f39b730fc5af5a756bc',
      evaluation_report_id: 'h0-dev-0f39b730fc5af5a756bc',
      baseline_score: 0.8,
    },
    protocol_guards: {
      max_recovery_amendments: 1,
      max_model_drafts: 3,
      manual_candidate: false,
      b_dev_model_visible: false,
      b_test_touched: false,
    },
    evidence_sha256: {
      first_h1_claim: sha256(originalClaimPath),
      generation_request: sha256(originalRequestPath),
      generation_state: sha256(originalStatePath),
      source_lineage: sha256(originalLineagePath),
      proposal_context: sha256(originalProposalContextPath),
      draft_responses: originalResponsePaths.map((path, index) => ({ attempt: index + 1, sha256: sha256(path) })),
      h0_state: sha256(resolve(h0Directory, 'state.json')),
      h0_contract: sha256(contractPath),
      h0_canonical_jsonl: sha256(canonicalPath),
      h0_run_summary: sha256(resolve(h0Directory, 'run-summary.json')),
      h0_b_search_results: sha256(resolve(h0Directory, 'b-search-results.json')),
      h0_feedback: sha256(resolve(h0Directory, 'feedback.json')),
      h0_evaluation_report: sha256(resolve(h0Directory, 'evaluation-report.json')),
      h0_eval_predictions: sha256(h0PredictionsPath),
      checked_in_b_search_cases: sha256(resolve(process.cwd(), 'stage4b/bfcl/search.jsonl')),
      evolution_profile: sha256(evolutionProfilePath),
      evolution_h0_feedback: sha256(evolutionFeedbackPath),
      evolution_h0_evaluation: sha256(evolutionEvaluationPath),
      evolution_state: sha256(evolutionStatePath),
    },
  })
  const owner01Path = resolve(originalProfile, 'stage4c-recovery-owner.json')
  json(owner01Path, {
    schema_version: 'autodata-stage4c-recovery-owner-1',
    profile_id: profileId,
    amendment_id: 'stage4c-recovery-amendment-01',
    amendment_file: 'protocol-amendment-01.json',
    amendment_sha256: sha256(amendment01Path),
    recovery_generation_root: predecessorGenerationRoot,
    recovery_commit: predecessorCommit,
    generation_run_id: predecessorRunId,
    experiment_run_id: predecessorExperimentId,
    candidate_id: predecessorCandidateId,
  })

  const diagnosticClaimPath = resolve(diagnosticRoot, 'diagnostic-claim.json')
  const diagnosticResultPath = resolve(diagnosticRoot, 'diagnostic-result.json')
  json(diagnosticClaimPath, {
    schema_version: 'autodata-stage4c-freerouter-diagnostic-claim-1',
    diagnostic_id: 'stage4c-freerouter-diagnostic-02',
    execution_commit: recoveryCommit,
    provider: 'free-router',
    model: 'gpt-5.6-sol',
    api: 'openai-responses',
    base_url: 'https://free-router.opendatalab.com/v1',
    session_id: 'autodata-stage4c-freerouter-02-diagnostic',
    max_tokens: 8_192,
    max_provider_requests: 1,
    provider_retry_max: 0,
    tools_enabled: false,
    candidate_capable: false,
    started_at: '2026-08-31T01:00:00.000Z',
  })
  json(diagnosticResultPath, {
    schema_version: 'autodata-stage4c-freerouter-diagnostic-result-1',
    diagnostic_id: 'stage4c-freerouter-diagnostic-02',
    claim_sha256: sha256(diagnosticClaimPath),
    status: 'passed',
    completed_at: '2026-08-31T01:01:00.000Z',
    provider: 'free-router',
    model: 'gpt-5.6-sol',
    response: 'OK',
    provider_attempts: 1,
    provider_retries: 0,
    agent_loop_sse_verified: true,
    token_usage: { input_tokens: 1, output_tokens: 1 },
    b_search_visible: false,
    b_dev_visible: false,
    b_test_touched: false,
    candidate_created: false,
  })

  return {
    root,
    options: {
      originalGenerationRoot,
      predecessorGenerationRoot,
      recoveryGenerationRoot,
      diagnosticRoot,
      experimentRunRoot,
      experimentStagingRoot,
      evolutionRoot,
      recoveryCommit,
      provider: 'free-router',
      model: 'gpt-5.6-sol',
    },
    profileId,
    amendment01Path,
    owner01Path,
    predecessorRun,
    predecessorGenerationRoot,
    recoveryGenerationRoot,
    diagnosticClaimPath,
    diagnosticResultPath,
    evolutionStatePath,
    hostSources,
    responsePaths,
    originalResponsePaths,
  }
}

describe('Stage 4C recovery-02 amendment', () => {
  it('publishes one chained amendment and its successor lock outside the original profile', async () => {
    const value = await fixture()
    const result = recovery.createStage4CRecovery02Amendment(value.options)
    const amendment = result.amendment as Record<string, any>

    expect(result.created).toBe(true)
    expect(result.path).toBe(resolve(value.recoveryGenerationRoot, 'protocol-amendment-02.json'))
    expect(statSync(result.path).mode & 0o777).toBe(0o600)
    expect(amendment).toMatchObject({
      schema_version: 'autodata-stage4c-recovery-amendment-2',
      amendment_id: 'stage4c-recovery-amendment-02',
      predecessor_amendment_id: 'stage4c-recovery-amendment-01',
      same_logical_h1: true,
      classification: 'exploratory_protocol_deviation',
      runtime_contract_repair: {
        commit: 'd666c608c20b4e59210d553a613e975ba6364dd3',
        corrected_runtime_input: 'DataSelection[]',
        record_id_path: 'item.record.source.record_id',
      },
      prerequisite_diagnostic: {
        diagnostic_id: 'stage4c-freerouter-diagnostic-02',
        root: value.options.diagnosticRoot,
        execution_commit: value.options.recoveryCommit,
        status: 'passed',
        response: 'OK',
        provider_attempts: 1,
        provider_retries: 0,
        candidate_created: false,
        b_test_touched: false,
      },
      recovery_execution: {
        execution_commit: value.options.recoveryCommit,
        provider: 'free-router',
        model: 'gpt-5.6-sol',
        generation_root: value.recoveryGenerationRoot,
        generation_run_id: 'first-h1-recovery-02-e666c608c20b-20260831',
        experiment_run_id: 'h1-recovery-02-e666c608c20b-20260831',
        candidate_id: 'candidate-h1-recovery-02-e666c608c20b-20260831',
        session_id: 'autodata-generation-bfcl-v4-first-h1-recovery-02-e666c608c20b-20260831',
        proposal_config: {
          max_tokens: 16_384,
          max_proposal_drafts: 1,
          max_provider_requests: 1,
        },
        provider_config: {
          headers: {
            'x-session-id': 'autodata-generation-bfcl-v4-first-h1-recovery-02-e666c608c20b-20260831',
          },
          retry_policy: { mode: 'normal', max_retries: 0 },
        },
      },
      protocol_guards: {
        protocol_deviation: true,
        provider_switch: true,
        exploratory: true,
        infrastructure_recovery_only: false,
        max_total_proposal_attempts: 7,
        max_complete_draft_payloads: 3,
        max_recovery_02_proposals: 1,
        max_provider_requests: 1,
        max_formal_candidates: 1,
        manual_candidate: false,
        provider_fallback: false,
        draft_selection: false,
        amendment_03_allowed: false,
        b_dev_model_visible: false,
        b_test_touched: false,
      },
      evidence_sha256: {
        predecessor_amendment: sha256(value.amendment01Path),
        predecessor_owner: sha256(value.owner01Path),
        diagnostic_claim: sha256(value.diagnosticClaimPath),
        diagnostic_result: sha256(value.diagnosticResultPath),
        recovery_01_draft_responses: value.responsePaths.map((path, index) => ({
          attempt: index + 1,
          sha256: sha256(path),
        })),
      },
    })
    const serialized = readFileSync(result.path, 'utf8')
    expect(serialized).not.toContain(value.hostSources[0]!)
    expect(serialized).not.toContain(value.hostSources[1]!)

    const ownerPath = resolve(value.predecessorGenerationRoot, recovery.STAGE4C_RECOVERY_02_OWNER_FILE)
    expect(statSync(ownerPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(ownerPath, 'utf8'))).toMatchObject({
      schema_version: 'autodata-stage4c-recovery-owner-2',
      predecessor_amendment_id: 'stage4c-recovery-amendment-01',
      amendment_id: 'stage4c-recovery-amendment-02',
      amendment_sha256: sha256(result.path),
      recovery_generation_root: value.recoveryGenerationRoot,
      amendment_03_allowed: false,
    })
    expect(readdirSync(resolve(value.options.originalGenerationRoot, value.profileId)))
      .toEqual([
        'first-h1-aa168525e92f-20260831',
        'first-h1-claim.json',
        'stage4c-recovery-owner.json',
      ])
  })

  it('is byte-idempotent and remains verifiable after recovery-02 state advances', async () => {
    const value = await fixture()
    const first = recovery.createStage4CRecovery02Amendment(value.options)
    const bytes = readFileSync(first.path)
    expect(recovery.createStage4CRecovery02Amendment(value.options).created).toBe(false)
    expect(readFileSync(first.path)).toEqual(bytes)

    json(value.evolutionStatePath, {
      schema_version: 'autodata-evolution-state-2',
      profile_id: value.profileId,
      generation: 1,
      active_candidate_id: 'h0',
      open_candidate_id: 'candidate-h1-recovery-02-e666c608c20b-20260831',
      candidates: [{ candidate_id: 'h0' }, { candidate_id: 'candidate-h1-recovery-02-e666c608c20b-20260831' }],
    })
    mkdirSync(resolve(value.recoveryGenerationRoot, value.profileId, 'first-h1-recovery-02-e666c608c20b-20260831'), { recursive: true })
    mkdirSync(resolve(value.options.experimentRunRoot, value.profileId, 'h1-recovery-02-e666c608c20b-20260831'), { recursive: true })
    mkdirSync(resolve(value.options.experimentStagingRoot, 'h1-recovery-02-e666c608c20b-20260831'), { recursive: true })
    mkdirSync(resolve(
      value.options.evolutionRoot,
      'profiles',
      value.profileId,
      'candidates',
      'candidate-h1-recovery-02-e666c608c20b-20260831',
    ), { recursive: true })

    expect(recovery.verifyStage4CRecovery02Amendment(value.options)).toMatchObject({ created: false })
    expect(() => recovery.verifyStage4CRecovery02Source(value.options)).toThrow()
  })

  it('rejects predecessor drift, extra history, forbidden evaluation evidence, and a third root', async () => {
    const drift = await fixture()
    writeFileSync(drift.responsePaths[0]!, '{}\n')
    expect(() => recovery.verifyStage4CRecovery02Source(drift.options)).toThrow()

    const originalDrift = await fixture()
    writeFileSync(originalDrift.originalResponsePaths[0]!, '{}\n')
    expect(() => recovery.verifyStage4CRecovery02Source(originalDrift.options)).toThrow(/original draft 1 SHA-256/iu)

    const inventory = await fixture()
    json(resolve(inventory.predecessorRun, 'unexpected.json'), {})
    expect(() => recovery.verifyStage4CRecovery02Source(inventory.options)).toThrow(/unexpected candidate/iu)

    const boundary = await fixture()
    const contextPath = resolve(boundary.predecessorRun, 'proposal-context.json')
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as Record<string, unknown>
    json(contextPath, { ...context, b_test: { score: 1 } })
    expect(() => recovery.verifyStage4CRecovery02Source(boundary.options)).toThrow(/proposal context/iu)

    const locked = await fixture()
    recovery.createStage4CRecovery02Amendment(locked.options)
    const otherRoot = resolve(locked.root, 'other-recovery-02')
    mkdirSync(otherRoot)
    expect(() => recovery.createStage4CRecovery02Amendment({
      ...locked.options,
      recoveryGenerationRoot: otherRoot,
    })).toThrow(/owner conflicts/iu)
  })

  it('uses no network while checking and publishing protocol evidence', async () => {
    const value = await fixture()
    const fetch = vi.fn(() => Promise.reject(new Error('network forbidden')))
    vi.stubGlobal('fetch', fetch)
    recovery.createStage4CRecovery02Amendment(value.options)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed on missing, failed, retried, candidate-producing, or cross-commit diagnostic evidence', async () => {
    const cases: Array<(result: Record<string, unknown>, claim: Record<string, unknown>) => void> = [
      result => { result.status = 'failed' },
      result => { result.provider_attempts = 2 },
      result => { result.provider_retries = 1 },
      result => { result.candidate_created = true },
      result => { result.b_test_touched = true },
      (_result, claim) => { claim.execution_commit = 'f'.repeat(40) },
    ]
    for (const mutate of cases) {
      const value = await fixture()
      const claim = JSON.parse(readFileSync(value.diagnosticClaimPath, 'utf8')) as Record<string, unknown>
      const result = JSON.parse(readFileSync(value.diagnosticResultPath, 'utf8')) as Record<string, unknown>
      mutate(result, claim)
      json(value.diagnosticClaimPath, claim)
      result.claim_sha256 = sha256(value.diagnosticClaimPath)
      json(value.diagnosticResultPath, result)
      expect(() => recovery.verifyStage4CRecovery02Source(value.options)).toThrow()
    }

    const missing = await fixture()
    await rm(missing.options.diagnosticRoot, { recursive: true })
    expect(() => recovery.verifyStage4CRecovery02Source(missing.options)).toThrow(/diagnostic root/iu)
  })
})

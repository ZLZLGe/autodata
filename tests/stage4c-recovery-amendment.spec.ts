import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface RecoveryOptions {
  readonly originalGenerationRoot: string
  readonly recoveryGenerationRoot: string
  readonly experimentRunRoot: string
  readonly experimentStagingRoot: string
  readonly evolutionRoot: string
  readonly recoveryCommit: string
  readonly provider: string
  readonly model: string
}

interface RecoveryModule {
  readonly STAGE4C_RECOVERY_AMENDMENT_SCHEMA_VERSION: string
  readonly STAGE4C_RECOVERY_AMENDMENT_FILE: string
  readonly STAGE4C_ORIGINAL_EXECUTION: Readonly<Record<string, string>>
  readonly STAGE4C_FROZEN_H0: Readonly<Record<string, string | number>>
  verifyStage4CRecoverySource(options: RecoveryOptions): Readonly<Record<string, unknown>>
  verifyStage4CRecoveryAmendment(options: RecoveryOptions): {
    readonly path: string
    readonly created: false
    readonly amendment: Readonly<Record<string, unknown>>
  }
  createStage4CRecoveryAmendment(options: RecoveryOptions): {
    readonly path: string
    readonly created: boolean
    readonly amendment: Readonly<Record<string, unknown>>
  }
}

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'scripts/stage4c-recovery-amendment.mjs')).href
const recovery = await import(moduleUrl) as RecoveryModule
const temporaryRoots: string[] = []
const original = recovery.STAGE4C_ORIGINAL_EXECUTION
const h0 = recovery.STAGE4C_FROZEN_H0
const recoveryCommit = 'bb168525e92fdcca297ad13dc4531393130a67d1'
const responseError = 'proposal Agent turn did not complete'

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

interface Fixture {
  readonly root: string
  readonly options: RecoveryOptions
  readonly profileDirectory: string
  readonly runDirectory: string
  readonly h0Directory: string
  readonly statePath: string
  readonly claimPath: string
  readonly requestPath: string
  readonly lineagePath: string
  readonly proposalContextPath: string
  readonly evolutionStatePath: string
  readonly modelEvidencePaths: Readonly<Record<string, string>>
  readonly responsePaths: readonly string[]
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'autodata-stage4c-recovery-'))
  temporaryRoots.push(root)
  const originalGenerationRoot = resolve(root, 'generations')
  const recoveryGenerationRoot = resolve(root, 'recovery')
  const experimentRunRoot = resolve(root, 'experiments')
  const experimentStagingRoot = resolve(root, 'staging')
  const evolutionRoot = resolve(root, 'evolution')
  for (const path of [originalGenerationRoot, recoveryGenerationRoot, experimentRunRoot, experimentStagingRoot, evolutionRoot]) {
    mkdirSync(path, { recursive: true })
  }
  const profileDirectory = resolve(originalGenerationRoot, String(original.profile_id))
  const runDirectory = resolve(profileDirectory, String(original.generation_run_id))
  const h0Directory = resolve(experimentRunRoot, String(h0.profile_id), String(h0.run_id))
  mkdirSync(runDirectory, { recursive: true })
  mkdirSync(h0Directory, { recursive: true })

  const claimPath = resolve(profileDirectory, 'first-h1-claim.json')
  json(claimPath, {
    schema_version: 'autodata-first-h1-claim-1',
    profile_id: original.profile_id,
    run_id: original.generation_run_id,
    experiment_run_id: original.experiment_run_id,
    candidate_id: original.candidate_id,
    execution_commit: original.execution_commit,
  })
  const requestPath = resolve(runDirectory, 'request.json')
  json(requestPath, {
    profile_id: original.profile_id,
    run_id: original.generation_run_id,
    experiment_run_id: original.experiment_run_id,
    execution_commit: original.execution_commit,
    baseline_run_directory: h0Directory,
    b_search_cases_jsonl: '/root/autodata/stage4b/bfcl/search.jsonl',
    candidate_id: original.candidate_id,
    strategy_version: '1',
  })
  const lineagePath = resolve(runDirectory, 'source-lineage.json')
  json(lineagePath, {
    schema_version: 'autodata-generation-lineage-1',
    profile_id: original.profile_id,
    parent_candidate_id: 'h0',
    candidate_id: original.candidate_id,
    execution_commit: original.execution_commit,
    baseline_run_directory: h0Directory,
    baseline_feedback_id: h0.feedback_id,
    source_pool_sha256: 'c5c57f65bb58ddecf4d83d576a0fc7341153933bab2ce9b9596b20f9496a9db4',
  })
  const proposalContextPath = resolve(runDirectory, 'proposal-context.json')
  json(proposalContextPath, {
    profile_id: original.profile_id,
    benchmark: 'bfcl-v4',
    strategy_plugin_id: 'bfcl-v4-strategy',
    strategy_version: '1',
    generation: 1,
    seed: 42,
    allowed_capabilities: ['data-select', 'data-filter', 'data-order'],
    b_search: {
      summary: 'H0 completed 25 B_search cases; macro 0.8',
      metrics: { macro_score: 0.8 },
      failures: [],
    },
    source_pool: {
      canonical_records: 100,
      canonical_jsonl_sha256: 'c5c57f65bb58ddecf4d83d576a0fc7341153933bab2ce9b9596b20f9496a9db4',
      records: Array.from({ length: 100 }, (_unused, index) => ({ record_id: `record-${String(index)}` })),
    },
  })
  const responsePaths = [1, 2, 3].map(attempt => {
    const path = resolve(runDirectory, 'attempts', `draft-${String(attempt).padStart(2, '0')}`, 'response.json')
    json(path, { error: responseError })
    return path
  })
  const statePath = resolve(runDirectory, 'state.json')
  json(statePath, {
    schema_version: 'autodata-generation-state-1',
    profile_id: original.profile_id,
    run_id: original.generation_run_id,
    experiment_run_id: original.experiment_run_id,
    candidate_id: original.candidate_id,
    strategy_version: '1',
    execution_commit: original.execution_commit,
    status: 'failed',
    phase: 'proposing',
    run_directory: runDirectory,
    baseline_run_directory: h0Directory,
    b_search_cases_jsonl: '/root/autodata/stage4b/bfcl/search.jsonl',
    created_at: '2026-08-30T16:44:34.279Z',
    updated_at: '2026-08-30T16:44:36.583Z',
    attempts: responsePaths.map((response_path, index) => ({
      attempt: index + 1,
      status: 'failed',
      response_path,
      created_at: `2026-08-30T16:44:3${String(4 + index)}.000Z`,
      failure: responseError,
    })),
    formal_candidate_persisted: false,
    failure: { code: 'PROPOSAL_FAILED', message: 'all 3 ephemeral drafts failed' },
  })

  copyFileSync(resolve(process.cwd(), 'stage4b/experiment-contract.json'), resolve(h0Directory, 'experiment-contract.json'))
  json(resolve(h0Directory, 'state.json'), {
    schema_version: 'autodata-experiment-state-1',
    profile_id: h0.profile_id,
    run_id: h0.run_id,
    contract_id: h0.contract_id,
    contract_sha256: h0.contract_sha256,
    feedback_id: h0.feedback_id,
    evaluation_report_id: h0.evaluation_report_id,
    status: 'succeeded',
    phase: 'complete',
    run_directory: h0Directory,
    staging_directory: resolve(experimentStagingRoot, String(h0.run_id)),
  })
  const modelEvidencePaths: Record<string, string> = {
    h0_canonical_jsonl: resolve(h0Directory, 'canonical.jsonl'),
    h0_run_summary: resolve(h0Directory, 'run-summary.json'),
    h0_b_search_results: resolve(h0Directory, 'b-search-results.json'),
    h0_feedback: resolve(h0Directory, 'feedback.json'),
    h0_evaluation_report: resolve(h0Directory, 'evaluation-report.json'),
    h0_eval_predictions: resolve(h0Directory, 'attempts/eval/0001/predictions.jsonl'),
    checked_in_b_search_cases: resolve(process.cwd(), 'stage4b/bfcl/search.jsonl'),
    evolution_profile: resolve(evolutionRoot, 'profiles', String(original.profile_id), 'profile.json'),
    evolution_h0_feedback: resolve(
      evolutionRoot,
      'profiles',
      String(original.profile_id),
      'feedback',
      `${String(h0.feedback_id)}.json`,
    ),
    evolution_h0_evaluation: resolve(
      evolutionRoot,
      'profiles',
      String(original.profile_id),
      'runs',
      String(h0.run_id),
      'summary.json',
    ),
  }
  writeFileSync(modelEvidencePaths.h0_canonical_jsonl!, '{"fixture":"canonical"}\n')
  json(modelEvidencePaths.h0_run_summary!, { fixture: 'run-summary' })
  json(modelEvidencePaths.h0_b_search_results!, { fixture: 'b-search-results' })
  json(modelEvidencePaths.h0_feedback!, { fixture: 'feedback' })
  json(modelEvidencePaths.h0_evaluation_report!, { fixture: 'evaluation-report' })
  json(modelEvidencePaths.h0_eval_predictions!, { fixture: 'prediction' })
  json(modelEvidencePaths.evolution_profile!, { id: original.profile_id, benchmark: 'bfcl-v4' })
  json(modelEvidencePaths.evolution_h0_feedback!, { feedback_id: h0.feedback_id })
  json(modelEvidencePaths.evolution_h0_evaluation!, { report_id: h0.evaluation_report_id })
  const evolutionStatePath = resolve(evolutionRoot, 'profiles', String(original.profile_id), 'state.json')
  json(evolutionStatePath, {
    schema_version: 'autodata-evolution-state-2',
    profile_id: original.profile_id,
    generation: 0,
    active_candidate_id: 'h0',
    open_candidate_id: null,
    candidates: [{
      candidate_id: 'h0',
      generation: 0,
      status: 'accepted',
      parent_candidate_id: null,
    }],
  })

  return {
    root,
    options: {
      originalGenerationRoot,
      recoveryGenerationRoot,
      experimentRunRoot,
      experimentStagingRoot,
      evolutionRoot,
      recoveryCommit,
      provider: 'pjlab',
      model: 'glm-5.3-flash',
    },
    profileDirectory,
    runDirectory,
    h0Directory,
    statePath,
    claimPath,
    requestPath,
    lineagePath,
    proposalContextPath,
    evolutionStatePath,
    modelEvidencePaths,
    responsePaths,
  }
}

function readObject(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('Stage 4C append-only recovery amendment', () => {
  it('creates one deterministic amendment bound to every frozen source hash', async () => {
    const value = await fixture()
    const result = recovery.createStage4CRecoveryAmendment(value.options)
    const h0StatePath = resolve(value.h0Directory, 'state.json')
    const h0ContractPath = resolve(value.h0Directory, 'experiment-contract.json')

    expect(result.created).toBe(true)
    expect(result.path).toBe(resolve(value.options.recoveryGenerationRoot, 'protocol-amendment-01.json'))
    expect(statSync(result.path).mode & 0o777).toBe(0o600)
    expect(result.amendment).toMatchObject({
      schema_version: recovery.STAGE4C_RECOVERY_AMENDMENT_SCHEMA_VERSION,
      amendment_id: 'stage4c-recovery-amendment-01',
      same_logical_h1: true,
      original_execution: {
        execution_commit: original.execution_commit,
        provider: 'free-router',
        model: 'gpt-5.6-sol',
        status: 'failed',
        phase: 'proposing',
        formal_candidate_persisted: false,
        experiment_started: false,
      },
      recovery_execution: {
        execution_commit: recoveryCommit,
        provider: 'pjlab',
        model: 'glm-5.3-flash',
        generation_root: value.options.recoveryGenerationRoot,
        generation_run_id: 'first-h1-recovery-01-bb168525e92f-20260831',
        experiment_run_id: 'h1-recovery-01-bb168525e92f-20260831',
        candidate_id: 'candidate-h1-recovery-01-bb168525e92f-20260831',
      },
      frozen_h0: h0,
      evidence_sha256: {
        first_h1_claim: sha256(value.claimPath),
        generation_request: sha256(value.requestPath),
        generation_state: sha256(value.statePath),
        source_lineage: sha256(value.lineagePath),
        proposal_context: sha256(value.proposalContextPath),
        draft_responses: value.responsePaths.map((path, index) => ({ attempt: index + 1, sha256: sha256(path) })),
        h0_state: sha256(h0StatePath),
        h0_contract: sha256(h0ContractPath),
        ...Object.fromEntries(Object.entries(value.modelEvidencePaths).map(([name, path]) => [name, sha256(path)])),
        evolution_state: sha256(value.evolutionStatePath),
      },
    })
    expect(readObject(result.path)).toEqual(result.amendment)
    const ownerPath = resolve(value.profileDirectory, 'stage4c-recovery-owner.json')
    expect(statSync(ownerPath).mode & 0o777).toBe(0o600)
    expect(readObject(ownerPath)).toMatchObject({
      schema_version: 'autodata-stage4c-recovery-owner-1',
      recovery_generation_root: value.options.recoveryGenerationRoot,
      recovery_commit: recoveryCommit,
      generation_run_id: 'first-h1-recovery-01-bb168525e92f-20260831',
      experiment_run_id: 'h1-recovery-01-bb168525e92f-20260831',
      candidate_id: 'candidate-h1-recovery-01-bb168525e92f-20260831',
      amendment_sha256: sha256(result.path),
    })
    expect(readdirSync(value.options.recoveryGenerationRoot)).toEqual(['protocol-amendment-01.json'])
    expect(readdirSync(value.profileDirectory).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('is byte-idempotent and rejects an existing conflicting amendment', async () => {
    const value = await fixture()
    const first = recovery.createStage4CRecoveryAmendment(value.options)
    const bytes = readFileSync(first.path)
    const replay = recovery.createStage4CRecoveryAmendment(value.options)
    expect(replay.created).toBe(false)
    expect(readFileSync(first.path)).toEqual(bytes)

    const conflicting = await fixture()
    const path = resolve(conflicting.options.recoveryGenerationRoot, recovery.STAGE4C_RECOVERY_AMENDMENT_FILE)
    writeFileSync(path, '{}\n')
    expect(() => recovery.createStage4CRecoveryAmendment(conflicting.options)).toThrow()
  })

  it('validates an existing amendment after recovery state advances', async () => {
    const value = await fixture()
    const first = recovery.createStage4CRecoveryAmendment(value.options)
    const recoveryCandidate = 'candidate-h1-recovery-01-bb168525e92f-20260831'
    const recoveryExperiment = 'h1-recovery-01-bb168525e92f-20260831'
    json(value.evolutionStatePath, {
      schema_version: 'autodata-evolution-state-2',
      profile_id: original.profile_id,
      generation: 1,
      active_candidate_id: 'h0',
      open_candidate_id: recoveryCandidate,
      candidates: [
        { candidate_id: 'h0', generation: 0, status: 'accepted', parent_candidate_id: null },
        { candidate_id: recoveryCandidate, generation: 1, status: 'validated', parent_candidate_id: 'h0' },
      ],
    })
    mkdirSync(resolve(value.options.experimentRunRoot, String(original.profile_id), recoveryExperiment), { recursive: true })
    mkdirSync(resolve(value.options.experimentStagingRoot, recoveryExperiment), { recursive: true })
    mkdirSync(resolve(
      value.options.evolutionRoot,
      'profiles',
      String(original.profile_id),
      'candidates',
      recoveryCandidate,
    ), { recursive: true })
    json(resolve(
      value.options.experimentRunRoot,
      '.candidate-owners',
      String(original.profile_id),
      `${recoveryCandidate}.json`,
    ), { candidate_id: recoveryCandidate })

    expect(() => recovery.verifyStage4CRecoverySource(value.options)).toThrow()
    const verified = recovery.verifyStage4CRecoveryAmendment(value.options)
    expect(verified).toMatchObject({ path: first.path, created: false })
    expect(recovery.createStage4CRecoveryAmendment(value.options)).toMatchObject({ created: false })

    json(value.responsePaths[0]!, { error: 'immutable source drift' })
    expect(() => recovery.verifyStage4CRecoveryAmendment(value.options)).toThrow()
  })

  it('rejects static amendment drift and a second recovery root', async () => {
    const staticDrift = await fixture()
    const created = recovery.createStage4CRecoveryAmendment(staticDrift.options)
    const amendment = readObject(created.path)
    const execution = amendment.recovery_execution as Record<string, unknown>
    json(created.path, { ...amendment, recovery_execution: { ...execution, model: 'tampered-model' } })
    expect(() => recovery.verifyStage4CRecoveryAmendment(staticDrift.options)).toThrow(/conflicts/iu)

    const secondRoot = await fixture()
    recovery.createStage4CRecoveryAmendment(secondRoot.options)
    const otherRecoveryRoot = resolve(secondRoot.root, 'recovery-two')
    mkdirSync(otherRecoveryRoot)
    expect(() => recovery.createStage4CRecoveryAmendment({
      ...secondRoot.options,
      recoveryGenerationRoot: otherRecoveryRoot,
    })).toThrow(/owner conflicts/iu)
    expect(() => statSync(resolve(otherRecoveryRoot, recovery.STAGE4C_RECOVERY_AMENDMENT_FILE))).toThrow()
  })

  it.each([
    'h0_canonical_jsonl',
    'h0_run_summary',
    'h0_b_search_results',
    'h0_feedback',
    'h0_evaluation_report',
    'h0_eval_predictions',
    'evolution_profile',
    'evolution_h0_feedback',
    'evolution_h0_evaluation',
  ])('rejects drift in immutable model-input evidence %s', async (name) => {
    const value = await fixture()
    recovery.createStage4CRecoveryAmendment(value.options)
    const path = value.modelEvidencePaths[name]!
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]))
    expect(() => recovery.verifyStage4CRecoveryAmendment(value.options)).toThrow(/conflicts/iu)
  })

  it.each([
    ['hyphenated boundary', { summary: 'H0 completed 25 B_search cases; forbidden B-test evidence' }],
    ['derived metric key', { metrics: { macro_score: 0.8, B_test_score: 1 } }],
  ])('rejects %s in the model-visible proposal context', async (_label, patch) => {
    const value = await fixture()
    const context = readObject(value.proposalContextPath)
    const search = context.b_search as Record<string, unknown>
    json(value.proposalContextPath, { ...context, b_search: { ...search, ...patch } })
    expect(() => recovery.verifyStage4CRecoverySource(value.options)).toThrow(/B_dev or B_test/iu)
  })

  it('fails closed when claim, state, response, recovery commit, provider, or model drifts', async () => {
    const claimDrift = await fixture()
    json(claimDrift.claimPath, { ...readObject(claimDrift.claimPath), execution_commit: 'c'.repeat(40) })
    expect(() => recovery.verifyStage4CRecoverySource(claimDrift.options)).toThrow(/claim execution_commit/iu)

    const stateDrift = await fixture()
    json(stateDrift.statePath, { ...readObject(stateDrift.statePath), formal_candidate_persisted: true })
    expect(() => recovery.verifyStage4CRecoverySource(stateDrift.options)).toThrow(/formal_candidate_persisted/iu)

    const responseDrift = await fixture()
    json(responseDrift.responsePaths[1]!, { error: 'different' })
    expect(() => recovery.verifyStage4CRecoverySource(responseDrift.options)).toThrow(/response error/iu)

    const configDrift = await fixture()
    expect(() => recovery.verifyStage4CRecoverySource({ ...configDrift.options, recoveryCommit: String(original.execution_commit) }))
      .toThrow(/must differ/iu)
    expect(() => recovery.verifyStage4CRecoverySource({ ...configDrift.options, provider: 'free-router' }))
      .toThrow(/recovery provider/iu)
    expect(() => recovery.verifyStage4CRecoverySource({ ...configDrift.options, model: 'other-model' }))
      .toThrow(/recovery model/iu)

    const contextDrift = await fixture()
    const context = readObject(contextDrift.proposalContextPath)
    json(contextDrift.proposalContextPath, { ...context, b_test: { score: 1 } })
    expect(() => recovery.verifyStage4CRecoverySource(contextDrift.options)).toThrow(/proposal context/iu)

    const evolutionDrift = await fixture()
    const evolutionState = readObject(evolutionDrift.evolutionStatePath)
    json(evolutionDrift.evolutionStatePath, { ...evolutionState, generation: 1 })
    expect(() => recovery.verifyStage4CRecoverySource(evolutionDrift.options)).toThrow(/Evolution state generation/iu)
  })

  it('rejects any evidence that candidate materialization or H1 experimentation began', async () => {
    const localExperiment = await fixture()
    mkdirSync(resolve(
      localExperiment.options.experimentRunRoot,
      String(original.profile_id),
      String(original.experiment_run_id),
    ), { recursive: true })
    expect(() => recovery.verifyStage4CRecoverySource(localExperiment.options)).toThrow(/experiment directory already exists/iu)

    const stagingExperiment = await fixture()
    mkdirSync(resolve(stagingExperiment.options.experimentStagingRoot, String(original.experiment_run_id)), { recursive: true })
    expect(() => recovery.verifyStage4CRecoverySource(stagingExperiment.options)).toThrow(/staging directory already exists/iu)

    const candidate = await fixture()
    mkdirSync(resolve(
      candidate.options.evolutionRoot,
      'profiles',
      String(original.profile_id),
      'candidates',
      String(original.candidate_id),
    ), { recursive: true })
    expect(() => recovery.verifyStage4CRecoverySource(candidate.options)).toThrow(/candidate directory already exists/iu)

    const owner = await fixture()
    json(resolve(
      owner.options.experimentRunRoot,
      '.candidate-owners',
      String(original.profile_id),
      `${String(original.candidate_id)}.json`,
    ), { candidate_id: original.candidate_id })
    expect(() => recovery.verifyStage4CRecoverySource(owner.options)).toThrow(/owner claim already exists/iu)

    const prestartedRecovery = await fixture()
    mkdirSync(resolve(
      prestartedRecovery.options.evolutionRoot,
      'profiles',
      String(original.profile_id),
      'candidates',
      'candidate-h1-recovery-01-bb168525e92f-20260831',
    ), { recursive: true })
    expect(() => recovery.createStage4CRecoveryAmendment(prestartedRecovery.options)).toThrow(/recovery H1 Evolution candidate/iu)
    expect(() => statSync(resolve(prestartedRecovery.profileDirectory, 'stage4c-recovery-owner.json'))).toThrow()
    expect(() => statSync(resolve(
      prestartedRecovery.options.recoveryGenerationRoot,
      recovery.STAGE4C_RECOVERY_AMENDMENT_FILE,
    ))).toThrow()

    const recoveryOwner = await fixture()
    json(resolve(
      recoveryOwner.options.experimentRunRoot,
      '.candidate-owners',
      String(original.profile_id),
      'candidate-h1-recovery-01-bb168525e92f-20260831.json',
    ), { candidate_id: 'candidate-h1-recovery-01-bb168525e92f-20260831' })
    expect(() => recovery.verifyStage4CRecoverySource(recoveryOwner.options)).toThrow(/recovery H1 experiment owner/iu)

    const generationProfile = await fixture()
    mkdirSync(resolve(generationProfile.options.recoveryGenerationRoot, String(original.profile_id)))
    expect(() => recovery.verifyStage4CRecoverySource(generationProfile.options)).toThrow(/generation profile directory/iu)
  })

  it('rejects unexpected run artifacts before authorizing recovery', async () => {
    const value = await fixture()
    json(resolve(value.runDirectory, 'attempts/draft-01/materialization-1.json'), { unexpected: true })
    expect(() => recovery.verifyStage4CRecoverySource(value.options)).toThrow(/unexpected candidate/iu)

    const profileHistory = await fixture()
    mkdirSync(resolve(profileHistory.profileDirectory, 'another-generation'))
    expect(() => recovery.verifyStage4CRecoverySource(profileHistory.options)).toThrow(/unsupported history/iu)
  })

  it('rejects response path escape and symlinks in source paths', async () => {
    const escaped = await fixture()
    const state = readObject(escaped.statePath)
    const attempts = state.attempts as Array<Record<string, unknown>>
    attempts[0] = { ...attempts[0], response_path: resolve(escaped.root, 'outside.json') }
    json(escaped.statePath, state)
    expect(() => recovery.verifyStage4CRecoverySource(escaped.options)).toThrow(/response_path/iu)

    const linked = await fixture()
    const target = resolve(linked.root, 'outside-response.json')
    json(target, { error: responseError })
    unlinkSync(linked.responsePaths[0]!)
    symlinkSync(target, linked.responsePaths[0]!)
    expect(() => recovery.verifyStage4CRecoverySource(linked.options)).toThrow(/symbolic links/iu)
  })

  it('rejects a recovery-output symlink and overlapping recovery roots', async () => {
    const linked = await fixture()
    const outside = resolve(linked.root, 'outside-amendment.json')
    writeFileSync(outside, '{}\n')
    symlinkSync(outside, resolve(linked.options.recoveryGenerationRoot, recovery.STAGE4C_RECOVERY_AMENDMENT_FILE))
    expect(() => recovery.createStage4CRecoveryAmendment(linked.options)).toThrow(/symbolic links/iu)

    const overlap = await fixture()
    expect(() => recovery.verifyStage4CRecoverySource({
      ...overlap.options,
      recoveryGenerationRoot: overlap.runDirectory,
    })).toThrow(/independent/iu)
  })

  it('performs no network request while verifying and creating the amendment', async () => {
    const value = await fixture()
    const fetch = vi.fn(() => Promise.reject(new Error('network forbidden')))
    vi.stubGlobal('fetch', fetch)
    recovery.createStage4CRecoveryAmendment(value.options)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('safely creates a previously absent independent recovery root', async () => {
    const value = await fixture()
    await rm(value.options.recoveryGenerationRoot, { recursive: true })
    const result = recovery.createStage4CRecoveryAmendment(value.options)
    expect(result.created).toBe(true)
    expect(statSync(value.options.recoveryGenerationRoot).isDirectory()).toBe(true)
    expect(statSync(result.path).mode & 0o777).toBe(0o600)
  })

  it('rejects non-absolute roots and a non-regular existing output', async () => {
    const relative = await fixture()
    expect(() => recovery.verifyStage4CRecoverySource({ ...relative.options, evolutionRoot: 'relative' }))
      .toThrow(/absolute/iu)

    const directoryOutput = await fixture()
    const path = resolve(directoryOutput.options.recoveryGenerationRoot, recovery.STAGE4C_RECOVERY_AMENDMENT_FILE)
    mkdirSync(path)
    chmodSync(path, 0o700)
    expect(() => recovery.createStage4CRecoveryAmendment(directoryOutput.options)).toThrow(/regular file/iu)
  })
})

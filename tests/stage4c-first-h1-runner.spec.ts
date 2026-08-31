import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface RunnerModule {
  readonly STAGE4C_GETELUCID_GENERATION_ROOT: string
  createStage4CStartRequest(execution: Record<string, string>): Readonly<Record<string, unknown>>
  assertStage4CCredential(command: string, environment?: NodeJS.ProcessEnv): void
  acquireStage4CExecutionLock(path?: string): { readonly path: string, dispose(): void }
  createStage4CRunManifest(execution: Record<string, string>, context: Record<string, unknown>): Record<string, any>
  assertStage4CRunManifest(manifest: unknown, execution: Record<string, string>): unknown
  persistStage4CRunManifest(manifest: unknown, path?: string): { readonly path: string, readonly sha256: string }
  readStage4CRunManifest(execution: Record<string, string>, path?: string): {
    readonly manifest: Record<string, any>
    readonly path: string
    readonly sha256: string
  } | undefined
  createManifestingProposer(delegate: unknown, execution: Record<string, string>, path?: string): {
    create(profileId: string, runId: string, signal: AbortSignal): Promise<any>
  }
}

const runnerPath = join(process.cwd(), 'scripts/stage4c-first-h1.mjs')
const runner = await import(pathToFileURL(runnerPath).href) as RunnerModule
const execution = Object.freeze({
  commit: 'e'.repeat(40),
  short_commit: 'e'.repeat(12),
  generation_run_id: 'first-h1-eeeeeeeeeeee-20260831',
  experiment_run_id: 'h1-eeeeeeeeeeee-20260831',
  candidate_id: 'candidate-h1-eeeeeeeeeeee-20260831',
})
const sourcePoolSha256 = 'c5c57f65bb58ddecf4d83d576a0fc7341153933bab2ce9b9596b20f9496a9db4'
const proposalContext = Object.freeze({
  profile_id: 'bfcl-v4',
  benchmark: 'bfcl-v4',
  strategy_plugin_id: 'bfcl-v4-strategy',
  strategy_version: '1',
  generation: 1,
  seed: 42,
  allowed_capabilities: ['data-select'],
  b_search: { summary: 'fixture', metrics: {}, failures: [] },
  source_pool: { canonical_records: 100, canonical_jsonl_sha256: sourcePoolSha256, records: [] },
})

describe('Stage 4C GetElucid first-H1 runner', () => {
  it('uses the independent ledger root and one-draft start contract', () => {
    expect(runner.STAGE4C_GETELUCID_GENERATION_ROOT).toBe(
      '/data/codex-work/autodata/runs/generations/stage4c-getelucid-01',
    )
    expect(runner.createStage4CStartRequest(execution)).toEqual({
      profile_id: 'bfcl-v4',
      run_id: execution.generation_run_id,
      experiment_run_id: execution.experiment_run_id,
      execution_commit: execution.commit,
      baseline_run_directory: '/data/codex-work/autodata/runs/experiments/bfcl-v4/h0-f058c05bd893-20260830',
      b_search_cases_jsonl: resolve(process.cwd(), 'stage4b/bfcl/search.jsonl'),
      candidate_id: execution.candidate_id,
      strategy_version: '1',
      max_proposal_drafts: 1,
    })
  })

  it('requires only the named credential for start/resume', () => {
    expect(() => runner.assertStage4CCredential('start', {})).toThrow(/no network request was made/iu)
    expect(() => runner.assertStage4CCredential('resume', {})).toThrow(/GETELUCID_API_KEY/iu)
    expect(() => runner.assertStage4CCredential('status', {})).not.toThrow()
    expect(() => runner.assertStage4CCredential('start', { GETELUCID_API_KEY: 'fixture' })).not.toThrow()
  })

  it('freezes the provider, H0 hashes, one-request budget, and 0.8 acceptance baseline', () => {
    const manifest = runner.createStage4CRunManifest(execution, proposalContext)
    expect(manifest).toMatchObject({
      exploratory: true,
      provider: {
        api: 'openai-responses',
        endpoint: 'https://hk.getelucid.com/v1/responses',
        model: 'gpt-5.6-sol',
        api_key_env: 'GETELUCID_API_KEY',
      },
      h0: {
        contract_sha256: '8d610144f31275f2264e5c959dee1de8dca401d7e50a3425dab0cd2b018c78e0',
        source_pool_sha256: sourcePoolSha256,
      },
      proposal: {
        context_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        max_proposal_drafts: 1,
        max_provider_requests: 1,
        provider_retry_max: 0,
      },
      acceptance: {
        rule: 'strict_improvement',
        split: 'B_dev',
        metric: 'equal_category_accuracy',
        direction: 'maximize',
        baseline_score: 0.8,
      },
    })
    expect(runner.assertStage4CRunManifest(manifest, execution)).toBe(manifest)
  })

  it('persists the canonical manifest before crossing the proposal boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'autodata-getelucid-manifest-'))
    const path = join(directory, 'run-manifest.json')
    let crossedProviderBoundary = false
    const delegate = {
      async create() {
        return {
          agent: {},
          async propose() {
            expect(existsSync(path)).toBe(true)
            crossedProviderBoundary = true
            return { host_source: 'return {}', description: 'fixture' }
          },
          cancel() {},
          async dispose() {},
        }
      },
    }
    try {
      const proposer = runner.createManifestingProposer(delegate, execution, path)
      const session = await proposer.create('bfcl-v4', execution.generation_run_id, new AbortController().signal)
      await session.propose({ attempt: 1, max_attempts: 1, context: proposalContext }, new AbortController().signal)
      expect(crossedProviderBoundary).toBe(true)
      const evidence = runner.readStage4CRunManifest(execution, path)
      expect(evidence?.sha256).toMatch(/^[a-f0-9]{64}$/u)
      const stored = readFileSync(path, 'utf8')
      expect(stored.endsWith('\n')).toBe(true)
      expect(JSON.parse(stored)).toEqual(evidence?.manifest)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('holds one cross-process execution lock until released', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autodata-getelucid-lock-'))
    const lockPath = join(directory, 'runner.lock')
    const lock = runner.acquireStage4CExecutionLock(lockPath)
    try {
      expect(spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', lockPath, 'true']).status).not.toBe(0)
    } finally {
      lock.dispose()
    }
    expect(execFileSync('/usr/bin/flock', ['--exclusive', '--nonblock', lockPath, 'true'])).toHaveLength(0)
    rmSync(directory, { recursive: true, force: true })
  })

  it('contains no recovery protocol, request gate, or retry plugin', () => {
    const source = readFileSync(runnerPath, 'utf8')
    expect(source).not.toMatch(/stage4c-recovery|recovery-amendment|install.*RequestBudget/iu)
    expect(source).not.toMatch(/import\(['"]@deepseek-ai\/dsh-llm-retry['"]\)/u)
    expect(source).toContain("const COMMANDS = new Set(['start', 'resume', 'status'])")
  })
})

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface RunnerModule {
  readonly STAGE4C_RECOVERY_02_LOCK_FILE: string
  createStage4CRecovery02StartRequest(execution: Record<string, string>): Readonly<Record<string, unknown>>
  assertStage4CRecovery02Credential(command: string, environment?: NodeJS.ProcessEnv): void
  assertStage4CRecovery02Contract(amendment: unknown, paths?: {
    readonly baselineContractPath: string
    readonly checkedContractPath: string
  }): { readonly sha256: string }
  acquireStage4CRecovery02Lock(lockPath?: string): { readonly path: string, dispose(): void }
}

const path = join(process.cwd(), 'scripts/stage4c-first-h1-recovery-02.mjs')
const runner = await import(pathToFileURL(path).href) as RunnerModule

describe('Stage 4C recovery-02 runner contract', () => {
  it('constructs the one-draft request under a fresh recovery-02 identity', () => {
    expect(runner.createStage4CRecovery02StartRequest({
      commit: 'e'.repeat(40),
      generation_run_id: 'first-h1-recovery-02-eeeeeeeeeeee-20260831',
      experiment_run_id: 'h1-recovery-02-eeeeeeeeeeee-20260831',
      candidate_id: 'candidate-h1-recovery-02-eeeeeeeeeeee-20260831',
      session_id: 'autodata-generation-bfcl-v4-first-h1-recovery-02-eeeeeeeeeeee-20260831',
    })).toEqual({
      profile_id: 'bfcl-v4',
      run_id: 'first-h1-recovery-02-eeeeeeeeeeee-20260831',
      experiment_run_id: 'h1-recovery-02-eeeeeeeeeeee-20260831',
      execution_commit: 'e'.repeat(40),
      baseline_run_directory: '/data/codex-work/autodata/runs/experiments/bfcl-v4/h0-f058c05bd893-20260830',
      b_search_cases_jsonl: resolveProjectPath('stage4b/bfcl/search.jsonl'),
      candidate_id: 'candidate-h1-recovery-02-eeeeeeeeeeee-20260831',
      strategy_version: '1',
      max_proposal_drafts: 1,
    })
  })

  it('fails before runtime setup when start or resume lacks the named key', () => {
    expect(() => runner.assertStage4CRecovery02Credential('start', {})).toThrow(/no network request was made/iu)
    expect(() => runner.assertStage4CRecovery02Credential('resume', {})).toThrow(/no network request was made/iu)
    expect(() => runner.assertStage4CRecovery02Credential('status', {})).not.toThrow()
    expect(() => runner.assertStage4CRecovery02Credential('start', { FREEROUTER_API_KEY: 'fixture' })).not.toThrow()
  })

  it('binds the checked-in experiment contract byte-for-byte to frozen H0', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autodata-stage4c-contract-'))
    const baselineContractPath = join(directory, 'baseline.json')
    const checkedContractPath = join(directory, 'checked.json')
    const bytes = '{"fixture":"frozen contract"}\n'
    const frozenSha256 = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(baselineContractPath, bytes)
    writeFileSync(checkedContractPath, bytes)
    const paths = { baselineContractPath, checkedContractPath }
    try {
      expect(runner.assertStage4CRecovery02Contract({
        frozen_h0: { contract_sha256: frozenSha256 },
      }, paths)).toEqual({ sha256: frozenSha256 })
      writeFileSync(checkedContractPath, '{"fixture":"drift"}\n')
      expect(() => runner.assertStage4CRecovery02Contract({
        frozen_h0: { contract_sha256: frozenSha256 },
      }, paths)).toThrow(/checked-in experiment contract/iu)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('uses an explicit FreeRouter proposer and never installs the retry plugin', () => {
    const source = readFileSync(path, 'utf8')
    expect(source).toContain('new DshGenerationProposer(ctx')
    expect(source).toContain('provider: FREEROUTER_PROVIDER')
    expect(source).toContain('model: FREEROUTER_MODEL')
    expect(source).toContain('max_tokens: MAX_TOKENS')
    expect(source).toContain('installFreerouterRequestBudget(execution.session_id, 1)')
    expect(source).not.toMatch(/import\(['"]@deepseek-ai\/dsh-llm-retry['"]\)/u)
    expect(source).not.toContain("const COMMANDS = new Set(['prepare', 'auto'")
  })

  it('holds one cross-process execution lock until the runner releases it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autodata-stage4c-runner-lock-'))
    const lockPath = join(directory, 'runner.lock')
    const lock = runner.acquireStage4CRecovery02Lock(lockPath)
    try {
      expect(lock.path).toBe(lockPath)
      const competing = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', lockPath, 'true'])
      expect(competing.status).not.toBe(0)
    } finally {
      lock.dispose()
    }
    expect(execFileSync('/usr/bin/flock', ['--exclusive', '--nonblock', lockPath, 'true'])).toHaveLength(0)
    rmSync(directory, { recursive: true, force: true })
  })
})

function resolveProjectPath(relativePath: string): string {
  return join(process.cwd(), relativePath)
}

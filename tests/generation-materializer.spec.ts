import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { h0DataPlugin, runDataCore } from '../src/core/index.js'
import type { SourceAdapter } from '../src/core/types.js'
import { materializationDigest, ProcessCandidateMaterializer } from '../src/generation/materializer.js'

const adapter: SourceAdapter = Object.freeze({
  id: 'generation-source',
  version: '1',
  identify(value: unknown) {
    return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
      ? (value as { id: string }).id
      : null
  },
  adapt(value: unknown) {
    const row = value as { id: string }
    return {
      messages: [
        { role: 'user' as const, content: `question ${row.id}` },
        { role: 'assistant' as const, content: `answer ${row.id}` },
      ],
      tools: [],
      warnings: [],
    }
  },
})

function baseline() {
  return runDataCore({
    harness_id: 'toolcall-h0',
    generation: 0,
    seed: 42,
    source: {
      dataset_id: 'fixture',
      dataset_revision: '1',
      records: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    },
    source_adapter: adapter,
    selected_record_ids: null,
    quarantine_record_ids: [],
    plugins: [h0DataPlugin],
  })
}

function materializer() {
  return new ProcessCandidateMaterializer({
    timeout_ms: 30_000,
    worker_url: pathToFileURL(join(process.cwd(), 'lib/generation/materializer-worker.js')),
  })
}

const scratchDirectories: string[] = []
const descendantProcessIds: number[] = []

function workerScript(source: string): URL {
  const directory = mkdtempSync(resolve(tmpdir(), 'autodata-materializer-test-'))
  scratchDirectories.push(directory)
  const path = resolve(directory, 'worker.mjs')
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o700 })
  return pathToFileURL(path)
}

function processRequest() {
  const source = baseline()
  return {
    profile_id: 'generation-profile',
    candidate_id: 'candidate-process-test',
    generation: 1,
    strategy_plugin_id: 'generation-strategy',
    strategy_version: '1',
    host_source: 'ignored by process test worker',
    harness_id: 'generation-strategy-h1',
    seed: 42,
    canonical_records: source.canonical_records,
    baseline_summary: source.summary,
  } as const
}

function descendantWorker(markerPath: string, trigger: string): URL {
  return workerScript(`
    import { spawn } from 'node:child_process'
    import { writeFileSync, writeSync } from 'node:fs'
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' })
    if (descendant.pid === undefined) process.exit(91)
    writeFileSync(${JSON.stringify(markerPath)}, String(descendant.pid))
    ${trigger}
    setInterval(() => {}, 1_000)
  `)
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
      return state !== 'Z' && state !== 'X'
    } catch {
      return true
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function expectProcessGroupStopped(markerPath: string): Promise<void> {
  const pid = Number(readFileSync(markerPath, 'utf8'))
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
  descendantProcessIds.push(pid)
  const deadline = Date.now() + 3_000
  while (isLiveProcess(pid) && Date.now() < deadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  expect(isLiveProcess(pid)).toBe(false)
}

afterEach(() => {
  for (const pid of descendantProcessIds.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* process is already gone */ }
  }
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ProcessCandidateMaterializer', () => {
  it('runs a candidate in fresh processes without changing the canonical pool', async () => {
    const source = baseline()
    const request = {
      profile_id: 'generation-profile',
      candidate_id: 'candidate-one',
      generation: 1,
      strategy_plugin_id: 'generation-strategy',
      strategy_version: '1',
      host_source: `return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'generation-strategy',
            version: '1',
            run(input) {
              return [input[2], input[0]].map(item => ({
                record_id: item.record.source.record_id,
                note: 'deterministic selection',
              }))
            },
          })
        },
      }`,
      harness_id: 'generation-strategy-h1',
      seed: 42,
      canonical_records: source.canonical_records,
      baseline_summary: source.summary,
    } as const

    const first = await materializer().materialize(request)
    const second = await materializer().materialize(request)

    expect(materializationDigest(second)).toBe(materializationDigest(first))
    expect(first.selected_record_ids).toEqual(['c', 'a'])
    expect(first.data_run.canonical_records).toEqual(source.canonical_records)
    expect(first.data_run.logical_training_view.map(unit => unit.source.record_id)).toEqual(['c', 'a'])
    expect(first.data_run.logical_training_view[0]?.plugin_provenance).toEqual([{
      plugin_id: 'generation-strategy',
      plugin_version: '1',
      note: 'deterministic selection',
    }])
  })

  it('rejects a candidate that emits an unknown record id', async () => {
    const source = baseline()
    await expect(materializer().materialize({
      profile_id: 'generation-profile',
      candidate_id: 'candidate-bad',
      generation: 1,
      strategy_plugin_id: 'generation-strategy',
      strategy_version: '1',
      host_source: "return { inject: ['autodata'], apply(ctx) { ctx.autodata.register({ id: 'generation-strategy', version: '1', run() { return [{ record_id: 'invented' }] } }) } }",
      harness_id: 'generation-strategy-h1',
      seed: 42,
      canonical_records: source.canonical_records,
      baseline_summary: source.summary,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('does not let a candidate mutate Host-owned materialization inputs', async () => {
    const source = baseline()
    const request = {
      profile_id: 'generation-profile',
      candidate_id: 'candidate-input-mutation',
      generation: 1,
      strategy_plugin_id: 'generation-strategy',
      strategy_version: '1',
      host_source: `return {
        inject: ['autodata'],
        apply(ctx) {
          ctx.autodata.register({
            id: 'generation-strategy',
            version: '1',
            run(input, context) {
              const recordId = input[0].record.source.record_id
              input[0].record.messages[0].content = 'candidate mutation'
              input.splice(1)
              context.seed = -1
              return [{ record_id: recordId, note: 'mutated only the VM copy' }]
            },
          })
        },
      }`,
      harness_id: 'generation-strategy-h1',
      seed: 42,
      canonical_records: source.canonical_records,
      baseline_summary: source.summary,
    } as const
    const before = JSON.stringify(request.canonical_records)

    const result = await materializer().materialize(request)

    expect(JSON.stringify(request.canonical_records)).toBe(before)
    expect(result.data_run.canonical_records).toEqual(source.canonical_records)
    expect(result.selected_record_ids).toEqual(['a'])
    expect(result.data_run.summary.seed).toBe(42)
  })

  it('rejects a candidate that selects no training records', async () => {
    const source = baseline()
    await expect(materializer().materialize({
      profile_id: 'generation-profile',
      candidate_id: 'candidate-empty',
      generation: 1,
      strategy_plugin_id: 'generation-strategy',
      strategy_version: '1',
      host_source: "return { inject: ['autodata'], apply(ctx) { ctx.autodata.register({ id: 'generation-strategy', version: '1', run() { return [] } }) } }",
      harness_id: 'generation-strategy-h1',
      seed: 42,
      canonical_records: source.canonical_records,
      baseline_summary: source.summary,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('starts Node with a fixed old-space ceiling', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'autodata-materializer-argv-test-'))
    scratchDirectories.push(directory)
    const marker = resolve(directory, 'exec-argv.json')
    const probe = new ProcessCandidateMaterializer({
      worker_url: workerScript(`
        import { writeFileSync } from 'node:fs'
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.execArgv))
      `),
    })

    await expect(probe.materialize(processRequest())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toContain('--max-old-space-size=256')
  })

  it.skipIf(process.platform === 'win32')('kills the whole detached process group on timeout', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'autodata-materializer-timeout-test-'))
    scratchDirectories.push(directory)
    const marker = resolve(directory, 'descendant.pid')
    const timed = new ProcessCandidateMaterializer({
      timeout_ms: 1_000,
      worker_url: descendantWorker(marker, ''),
    })

    await expect(timed.materialize(processRequest())).rejects.toThrow(/hard timeout/iu)
    await expectProcessGroupStopped(marker)
  })

  it.skipIf(process.platform === 'win32')('kills the whole detached process group on diagnostic or result overflow', async () => {
    for (const [label, trigger, option] of [
      ['diagnostic', "writeSync(1, 'x'.repeat(2_048))", { max_diagnostic_bytes: 1024 }],
      ['result', "writeSync(3, 'x'.repeat(2_048))", { max_result_bytes: 1024 }],
    ] as const) {
      const directory = mkdtempSync(resolve(tmpdir(), `autodata-materializer-${label}-test-`))
      scratchDirectories.push(directory)
      const marker = resolve(directory, 'descendant.pid')
      const limited = new ProcessCandidateMaterializer({
        ...option,
        timeout_ms: 5_000,
        worker_url: descendantWorker(marker, trigger),
      })

      await expect(limited.materialize(processRequest())).rejects.toThrow(/output limit/iu)
      await expectProcessGroupStopped(marker)
    }
  })
})

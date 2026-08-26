import { Context } from '@deepseek-ai/cordis'
import { writeSync } from 'node:fs'
import DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AutoDataService from '../service.js'
import { runEvolutionFixture } from './fixture.js'
import { MemoryEvolutionStore } from './store.js'
import { MAX_HOST_SOURCE_BYTES } from './types.js'
import { CANDIDATE_VALIDATION_SCHEMA_VERSION, type CandidateValidationResult } from './validator.js'

interface WorkerInput {
  readonly profile_id: string
  readonly candidate_id: string
  readonly generation: number
  readonly plugin_id: string
  readonly plugin_version: string
  readonly host_source: string
}

type RunnerAgent = Parameters<DynamicCordisRunnerService['run']>[0]

let emitted = false

/** Load a single JSON document from stdin; no input file or IPC channel is used. */
async function readInput(): Promise<WorkerInput> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    // The parent enforces the Host source limit. This guard prevents a malformed
    // caller from making the validation worker retain an unbounded stdin body.
    if (bytes > MAX_HOST_SOURCE_BYTES * 8) throw new Error('validation input is unexpectedly large')
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) throw new Error('validation input is empty')
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('validation input must be an object')
  }
  const input = value as Record<string, unknown>
  for (const key of ['profile_id', 'candidate_id', 'plugin_id', 'plugin_version', 'host_source']) {
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      throw new Error(`validation input ${key} is invalid`)
    }
  }
  if (
    typeof input.generation !== 'number'
    || !Number.isSafeInteger(input.generation)
    || input.generation < 1
  ) {
    throw new Error('validation input generation is invalid')
  }
  return input as unknown as WorkerInput
}

async function main(): Promise<void> {
  let input: WorkerInput | undefined
  let ctx: Context | undefined
  let pluginId: string | undefined
  const agent = { id: 'autodata-validator', steer() {}, inject() {} } as unknown as RunnerAgent
  try {
    input = await readInput()
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // The worker has no profile persistence responsibility. A normal AutoData
    // service is still used so the candidate exercises the real DataPlugin API.
    await ctx.plugin(AutoDataService, { store: new MemoryEvolutionStore() })
    await ctx.plugin(DynamicCordisRunnerService, { vmTimeoutMs: 2_000 })

    const baselinePlugins = descriptors(ctx.autodata.plugins())
    const baselineTools = toolSchemas(ctx)
    const receipt = ctx.dynamicCordisRunner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: 'aval' },
      name: input.candidate_id,
      purpose: `Validation for ${input.profile_id}`,
      code: { host: input.host_source },
    })
    pluginId = receipt.pluginId
    if (!receipt.hasHostHalf || receipt.hasClientHalf) throw new Error('candidate must be host-only')

    const run = await ctx.dynamicCordisRunner.run(agent, receipt.pluginId, receipt.packageId, 'run')
    if (!run.ok) throw new Error(run.message)
    if (run.waitingFor.length > 0) {
      throw new Error(`candidate waits for unavailable services: ${run.waitingFor.join(', ')}`)
    }
    const snapshot = ctx.dynamicCordisRunner.snapshot(agent)
      .find(entry => entry.pluginId === receipt.pluginId)
    const inject = snapshot?.activeRun?.fiber === undefined
      ? []
      : Object.keys(snapshot.activeRun.fiber.inject).sort()
    if (inject.length !== 1 || inject[0] !== 'autodata') {
      throw new Error(`candidate inject must be exactly ["autodata"], got ${JSON.stringify(inject)}`)
    }

    const expectedPlugins = [...baselinePlugins, `${input.plugin_id}@${input.plugin_version}`].sort()
    if (JSON.stringify(descriptors(ctx.autodata.plugins())) !== JSON.stringify(expectedPlugins)) {
      throw new Error(`candidate must register exactly ${input.plugin_id}@${input.plugin_version}`)
    }
    if (JSON.stringify(toolSchemas(ctx)) !== JSON.stringify(baselineTools)) {
      throw new Error('candidate must not register model tools')
    }

    runEvolutionFixture(ctx.autodata, input.profile_id, input.generation, input.plugin_id)
    const stopped = await ctx.dynamicCordisRunner.stop(agent, receipt.pluginId)
    if (!stopped.ok) throw new Error(stopped.message)
    if (JSON.stringify(descriptors(ctx.autodata.plugins())) !== JSON.stringify(baselinePlugins)) {
      throw new Error('candidate DataPlugin remained registered after stop')
    }
    if (JSON.stringify(toolSchemas(ctx)) !== JSON.stringify(baselineTools)) {
      throw new Error('candidate tool side effects remained after stop')
    }
    const undefinedResult = await ctx.dynamicCordisRunner.undefine(agent, receipt.pluginId)
    if (!undefinedResult.ok) throw new Error(undefinedResult.message)
    pluginId = undefined
    emit({
      schema_version: CANDIDATE_VALIDATION_SCHEMA_VERSION,
      candidate_id: input.candidate_id,
      ok: true,
      plugin_id: input.plugin_id,
      plugin_version: input.plugin_version,
    })
  } catch (error) {
    if (ctx !== undefined && pluginId !== undefined) {
      try { await ctx.dynamicCordisRunner.stop(agent, pluginId as never) } catch { /* report original failure */ }
      try { await ctx.dynamicCordisRunner.undefine(agent, pluginId as never) } catch { /* report original failure */ }
    }
    emit({
      schema_version: CANDIDATE_VALIDATION_SCHEMA_VERSION,
      candidate_id: input?.candidate_id ?? 'unknown',
      ok: false,
      reason: diagnostic(error),
    })
  } finally {
    if (ctx !== undefined) {
      try { await ctx.fiber.dispose() } catch { /* preserve the validation result */ }
    }
  }
}

function descriptors(values: readonly { readonly id: string; readonly version: string }[]): string[] {
  return values.map(value => `${value.id}@${value.version}`).sort()
}

function toolSchemas(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => JSON.stringify(schema)).sort()
}

function emit(result: CandidateValidationResult): void {
  if (emitted) return
  emitted = true
  const line = `${JSON.stringify(result)}\n`
  // FD 3 is reserved for the machine-readable result. stdout/stderr remain
  // diagnostics and are counted by the parent output budget.
  try {
    writeSync(3, line, undefined, 'utf8')
  } catch {
    // A closed result descriptor is a worker failure; there is no safe channel
    // left to report it. The parent will classify the missing result.
  }
}

function diagnostic(error: unknown): string {
  const value = error instanceof Error ? error.stack ?? error.message : String(error)
  return value.length <= 4096 ? value : `${value.slice(0, 4093)}...`
}

void main().catch(error => {
  emit({
    schema_version: CANDIDATE_VALIDATION_SCHEMA_VERSION,
    candidate_id: 'unknown',
    ok: false,
    reason: diagnostic(error),
  })
})

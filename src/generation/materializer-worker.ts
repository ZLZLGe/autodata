import { Context } from '@deepseek-ai/cordis'
import DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { canonicalJson, isJsonObject } from '../core/json.js'
import type { CanonicalTrajectory, DataRunResult, SourceAdapter } from '../core/types.js'
import AutoDataService from '../service.js'
import { restrictedDataPluginHostSource } from '../evolution/candidate-sandbox.js'
import { MemoryEvolutionStore } from '../evolution/store.js'
import {
  GENERATION_MATERIALIZATION_VERSION,
  type GenerationMaterialization,
  type GenerationMaterializationRequest,
} from './types.js'

const MAX_INPUT_BYTES = 16 * 1024 * 1024
let emitted = false

type RunnerAgent = Parameters<DynamicCordisRunnerService['run']>[0]

async function readInput(): Promise<GenerationMaterializationRequest> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > MAX_INPUT_BYTES) throw new Error('materialization input exceeds 16 MiB')
    chunks.push(value)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) throw new Error('materialization input is empty')
  return normalizeInput(JSON.parse(raw) as unknown)
}

function normalizeInput(value: unknown): GenerationMaterializationRequest {
  if (!isJsonObject(value)) throw new Error('materialization input must be an object')
  const expected = new Set([
    'profile_id', 'candidate_id', 'generation', 'strategy_plugin_id', 'strategy_version',
    'host_source', 'harness_id', 'seed', 'canonical_records', 'baseline_summary',
  ])
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`materialization input is missing ${key}`)
  }
  const extra = Object.keys(value).find(key => !expected.has(key))
  if (extra !== undefined) throw new Error(`materialization input has unsupported field ${extra}`)
  for (const key of [
    'profile_id', 'candidate_id', 'strategy_plugin_id', 'strategy_version', 'host_source', 'harness_id',
  ] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`materialization input ${key} must be a non-empty string`)
    }
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    throw new Error('materialization input generation must be a positive safe integer')
  }
  if (!Number.isSafeInteger(value.seed)) throw new Error('materialization input seed must be a safe integer')
  if (!Array.isArray(value.canonical_records) || value.canonical_records.length === 0) {
    throw new Error('materialization input canonical_records must be a non-empty array')
  }
  if (!isJsonObject(value.baseline_summary)) throw new Error('materialization input baseline_summary must be an object')
  return value as unknown as GenerationMaterializationRequest
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function jsonLines(records: readonly unknown[]): string {
  return `${records.map(record => canonicalJson(record)).join('\n')}\n`
}

function sourceAdapter(summary: Record<string, unknown>): SourceAdapter {
  const source = summary.source
  if (!isJsonObject(source) || typeof source.adapter_id !== 'string' || typeof source.adapter_version !== 'string') {
    throw new Error('baseline summary source identity is invalid')
  }
  return Object.freeze({
    id: source.adapter_id,
    version: source.adapter_version,
    identify(value: unknown): string | null {
      if (!isJsonObject(value) || !isJsonObject(value.source) || typeof value.source.record_id !== 'string') {
        throw new Error('canonical source record is missing source.record_id')
      }
      return value.source.record_id
    },
    adapt(value: unknown) {
      if (!isJsonObject(value) || !Array.isArray(value.messages) || !Array.isArray(value.tools)) {
        throw new Error('canonical source record is malformed')
      }
      return {
        messages: value.messages as CanonicalTrajectory['messages'],
        tools: value.tools as CanonicalTrajectory['tools'],
        warnings: [],
      }
    },
  })
}

function selectedRecordIds(run: DataRunResult): readonly string[] {
  const byRank = new Map<number, string>()
  for (const unit of run.logical_training_view) {
    const current = byRank.get(unit.selection_rank)
    if (current !== undefined && current !== unit.source.record_id) {
      throw new Error(`selection rank ${String(unit.selection_rank)} refers to multiple records`)
    }
    byRank.set(unit.selection_rank, unit.source.record_id)
  }
  const ranks = [...byRank.keys()].sort((left, right) => left - right)
  if (ranks.some((rank, index) => rank !== index)) throw new Error('selection ranks are not contiguous')
  return Object.freeze(ranks.map(rank => byRank.get(rank) as string))
}

async function main(): Promise<void> {
  let input: GenerationMaterializationRequest | undefined
  let ctx: Context | undefined
  let dynamicPluginId: Parameters<DynamicCordisRunnerService['stop']>[1] | undefined
  const agent = { id: 'autodata-generation-materializer', steer() {}, inject() {} } as unknown as RunnerAgent
  try {
    input = await readInput()
    const baselineSummary = input.baseline_summary as Record<string, unknown>
    const source = baselineSummary.source
    if (!isJsonObject(source) || typeof source.dataset_id !== 'string' || typeof source.dataset_revision !== 'string') {
      throw new Error('baseline summary dataset identity is invalid')
    }

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AutoDataService, { store: new MemoryEvolutionStore() })
    await ctx.plugin(DynamicCordisRunnerService, { vmTimeoutMs: 10_000 })

    const baselineTools = ctx.tools.schemas().map(schema => JSON.stringify(schema)).sort()
    const baselinePlugins = ctx.autodata.plugins().map(plugin => `${plugin.id}@${plugin.version}`).sort()
    const receipt = ctx.dynamicCordisRunner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: 'amat' },
      name: input.candidate_id,
      purpose: `Data materialization for ${input.profile_id}`,
      code: { host: restrictedDataPluginHostSource(input.host_source) },
    })
    dynamicPluginId = receipt.pluginId
    if (!receipt.hasHostHalf || receipt.hasClientHalf) throw new Error('candidate must be host-only')
    const loaded = await ctx.dynamicCordisRunner.run(agent, receipt.pluginId, receipt.packageId, 'run')
    if (!loaded.ok) throw new Error(loaded.message)
    if (loaded.waitingFor.length > 0) throw new Error(`candidate waits for unavailable services: ${loaded.waitingFor.join(', ')}`)
    const active = ctx.dynamicCordisRunner.snapshot(agent).find(entry => entry.pluginId === receipt.pluginId)
    const inject = active?.activeRun?.fiber === undefined
      ? []
      : Object.keys(active.activeRun.fiber.inject).sort()
    if (inject.length !== 1 || inject[0] !== 'autodata') {
      throw new Error(`candidate inject must be exactly ["autodata"], got ${JSON.stringify(inject)}`)
    }
    const expectedPlugins = [...baselinePlugins, `${input.strategy_plugin_id}@${input.strategy_version}`].sort()
    const actualPlugins = ctx.autodata.plugins().map(plugin => `${plugin.id}@${plugin.version}`).sort()
    if (canonicalJson(actualPlugins) !== canonicalJson(expectedPlugins)) {
      throw new Error(`candidate must register exactly ${input.strategy_plugin_id}@${input.strategy_version}`)
    }
    if (canonicalJson(ctx.tools.schemas().map(schema => JSON.stringify(schema)).sort()) !== canonicalJson(baselineTools)) {
      throw new Error('candidate changed the model tool schema surface')
    }

    const run = ctx.autodata.run({
      harness_id: input.harness_id,
      generation: input.generation,
      seed: input.seed,
      source: {
        dataset_id: source.dataset_id,
        dataset_revision: source.dataset_revision,
        records: input.canonical_records,
      },
      source_adapter: sourceAdapter(baselineSummary),
      selected_record_ids: null,
      quarantine_record_ids: [],
      plugin_ids: [input.strategy_plugin_id],
    })

    const sourceCanonical = jsonLines(input.canonical_records)
    const canonicalJsonl = jsonLines(run.canonical_records)
    if (canonicalJsonl !== sourceCanonical) {
      throw new Error('candidate materialization changed the frozen canonical source pool')
    }
    const logicalJsonl = jsonLines(run.logical_training_view)
    const summaryJson = `${canonicalJson(run.summary)}\n`
    const result: GenerationMaterialization = Object.freeze({
      schema_version: GENERATION_MATERIALIZATION_VERSION,
      candidate_id: input.candidate_id,
      host_source_sha256: sha256(input.host_source),
      source_pool_sha256: sha256(sourceCanonical),
      canonical_jsonl_sha256: sha256(canonicalJsonl),
      logical_view_jsonl_sha256: sha256(logicalJsonl),
      run_summary_json_sha256: sha256(summaryJson),
      selected_record_ids: selectedRecordIds(run),
      data_run: run,
    })

    const stopped = await ctx.dynamicCordisRunner.stop(agent, receipt.pluginId)
    if (!stopped.ok) throw new Error(stopped.message)
    if (canonicalJson(ctx.autodata.plugins().map(plugin => `${plugin.id}@${plugin.version}`).sort()) !== canonicalJson(baselinePlugins)) {
      throw new Error('candidate DataPlugin remained registered after materialization')
    }
    if (canonicalJson(ctx.tools.schemas().map(schema => JSON.stringify(schema)).sort()) !== canonicalJson(baselineTools)) {
      throw new Error('candidate tool side effects remained after materialization')
    }
    const removed = await ctx.dynamicCordisRunner.undefine(agent, receipt.pluginId)
    if (!removed.ok) throw new Error(removed.message)
    dynamicPluginId = undefined
    emit({ ok: true, result })
  } catch (error) {
    if (ctx !== undefined && dynamicPluginId !== undefined) {
      try { await ctx.dynamicCordisRunner.stop(agent, dynamicPluginId) } catch { /* preserve original error */ }
      try { await ctx.dynamicCordisRunner.undefine(agent, dynamicPluginId) } catch { /* preserve original error */ }
    }
    emit({ ok: false, error: diagnostic(error) })
  } finally {
    if (ctx !== undefined) {
      try { await ctx.fiber.dispose() } catch { /* preserve emitted result */ }
    }
  }
}

function emit(value: { readonly ok: true; readonly result: GenerationMaterialization } | { readonly ok: false; readonly error: string }): void {
  if (emitted) return
  emitted = true
  const payload = Buffer.from(`${canonicalJson(value)}\n`, 'utf8')
  let offset = 0
  while (offset < payload.byteLength) offset += writeSync(3, payload, offset, payload.byteLength - offset)
}

function diagnostic(error: unknown): string {
  const value = error instanceof Error ? error.stack ?? error.message : String(error)
  return value.length <= 8192 ? value : `${value.slice(0, 8189)}...`
}

void main().catch(error => emit({ ok: false, error: diagnostic(error) }))

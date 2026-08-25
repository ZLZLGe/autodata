/** Closed, deterministic DataPlugin execution over canonical record references. */

import { AutoDataCoreError } from './errors.js'
import type {
  DataPlugin,
  DataPluginContext,
  DataPluginDecision,
  DataPluginSummaryEntry,
  DataSelection,
  PluginSelectionProvenance,
} from './types.js'

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/

/** Built-in baseline plugin: retain every eligible record in current order. */
export const h0DataPlugin: DataPlugin = Object.freeze({
  id: 'toolcall-h0',
  version: '3',
  run: (input: readonly DataSelection[]): readonly DataPluginDecision[] => input.map(selection => ({
    record_id: selection.record.source.record_id,
  })),
})

/**
 * Describe a plugin by its declared identity.
 * @param plugin - registered plugin.
 * @returns immutable summary entry.
 */
export function dataPluginIdentity(plugin: DataPlugin): DataPluginSummaryEntry {
  validatePluginIdentity(plugin)
  return Object.freeze({
    id: plugin.id,
    version: plugin.version,
  })
}

/** Validate plugin metadata at registration and direct-run boundaries. */
function validatePluginIdentity(plugin: unknown): asserts plugin is DataPlugin {
  if (typeof plugin !== 'object' || plugin === null || Array.isArray(plugin)) {
    throw new AutoDataCoreError('plugin must be an object', 'INVALID_PLUGIN')
  }
  const candidate = plugin as Record<string, unknown>
  const id = candidate.id
  if (typeof id !== 'string' || !PLUGIN_NAME.test(id)) {
    throw new AutoDataCoreError(`plugin id ${JSON.stringify(id)} must match ${String(PLUGIN_NAME)}`, 'INVALID_PLUGIN')
  }
  const version = candidate.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new AutoDataCoreError(`plugin ${id} must declare a non-empty version`, 'INVALID_PLUGIN')
  }
  if (typeof candidate.run !== 'function') {
    throw new AutoDataCoreError(`plugin ${id} must declare a run function`, 'INVALID_PLUGIN')
  }
}

/**
 * Capture immutable plugin authority while preserving the executable's original receiver.
 * @param plugin - caller-owned plugin declaration.
 * @returns a frozen identity and executable snapshot.
 */
export function snapshotDataPlugin(plugin: DataPlugin): DataPlugin {
  const identity = dataPluginIdentity(plugin)
  // Capture the method before caller mutation; invocation below supplies the frozen receiver.
  const run = plugin.run
  const snapshot: DataPlugin = {
    ...identity,
    run: (input: readonly DataSelection[], context: DataPluginContext): readonly DataPluginDecision[] =>
      run.call(snapshot, input, context),
  }
  return Object.freeze(snapshot)
}

/** Convert and validate one untrusted plugin result. */
function normalizeDecisions(value: unknown, available: ReadonlySet<string>, plugin: DataPlugin): DataPluginDecision[] {
  if (!Array.isArray(value)) {
    throw new AutoDataCoreError(`plugin ${plugin.id} must return an array`, 'INVALID_PLUGIN')
  }
  const emitted = new Set<string>()
  return value.map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new AutoDataCoreError(`plugin ${plugin.id} decision ${String(index)} must be an object`, 'INVALID_PLUGIN')
    }
    const decision = candidate as Record<string, unknown>
    const extra = Object.keys(decision).filter(key => key !== 'record_id' && key !== 'note')
    if (extra.length > 0) {
      throw new AutoDataCoreError(`plugin ${plugin.id} decision ${String(index)} has unsupported field ${extra[0]}`, 'INVALID_PLUGIN')
    }
    const recordId = decision.record_id
    if (typeof recordId !== 'string' || !available.has(recordId)) {
      throw new AutoDataCoreError(`plugin ${plugin.id} selected unknown record_id ${JSON.stringify(recordId)}`, 'INVALID_PLUGIN')
    }
    if (emitted.has(recordId)) {
      throw new AutoDataCoreError(`plugin ${plugin.id} selected record_id ${recordId} more than once`, 'INVALID_PLUGIN')
    }
    emitted.add(recordId)
    const note = decision.note
    if (note !== undefined && typeof note !== 'string') {
      throw new AutoDataCoreError(`plugin ${plugin.id} decision ${String(index)} note must be a string`, 'INVALID_PLUGIN')
    }
    return Object.freeze({
      record_id: recordId,
      ...(note === undefined ? {} : { note }),
    })
  })
}

/**
 * Execute one versioned plugin.
 * Canonical records and plugin context are deeply frozen before this function is called.
 * @param plugin - plugin to execute.
 * @param input - immutable current selections.
 * @param context - immutable run context.
 * @returns validated next selections and appended provenance.
 */
export function runDataPlugin(
  plugin: DataPlugin,
  input: readonly DataSelection[],
  context: DataPluginContext,
): readonly DataSelection[] {
  plugin = snapshotDataPlugin(plugin)
  const identity = dataPluginIdentity(plugin)
  const byId = new Map<string, DataSelection>()
  for (const selection of input) {
    const recordId = selection.record.source.record_id
    if (byId.has(recordId)) {
      throw new AutoDataCoreError(`plugin ${plugin.id} input contains duplicate record_id ${recordId}`, 'INVALID_PLUGIN', {
        plugin_id: plugin.id,
      })
    }
    byId.set(recordId, selection)
  }
  const available = new Set(byId.keys())
  let rawDecisions: unknown
  try {
    rawDecisions = plugin.run(input, context)
  } catch (error) {
    throw new AutoDataCoreError(`plugin ${plugin.id} failed: ${String(error)}`, 'PLUGIN_FAILED', {
      plugin_id: plugin.id,
      cause: error,
    })
  }
  let decisions: DataPluginDecision[]
  try {
    decisions = normalizeDecisions(rawDecisions, available, plugin)
  } catch (error) {
    if (error instanceof AutoDataCoreError && error.plugin_id === undefined) {
      throw new AutoDataCoreError(error.message, error.code, { plugin_id: plugin.id, cause: error })
    }
    throw error
  }
  return Object.freeze(decisions.map((decision) => {
    const previous = byId.get(decision.record_id) as DataSelection
    const provenance: PluginSelectionProvenance = Object.freeze({
      plugin_id: identity.id,
      plugin_version: identity.version,
      ...(decision.note === undefined ? {} : { note: decision.note }),
    })
    return Object.freeze({
      record: previous.record,
      provenance: Object.freeze([...previous.provenance, provenance]),
    })
  }))
}

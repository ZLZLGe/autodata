/** Deterministic batch runner from external records to versioned logical training data. */

import { CANONICAL_TRAJECTORY_SCHEMA_VERSION } from './canonical.js'
import { AutoDataCoreError } from './errors.js'
import { canonicalJson, cloneJson, immutableJson, isJsonObject, parseStrictJsonObject } from './json.js'
import { buildLogicalTrainingView, LOGICAL_TRAINING_UNIT_SCHEMA_VERSION } from './logical-view.js'
import { dataPluginIdentity, runDataPlugin, snapshotDataPlugin } from './plugins.js'
import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalTrajectory,
  DataRunRequest,
  DataRunResult,
  DataRunSummary,
  DataPlugin,
  DataPluginContext,
  DataSelection,
  JsonObject,
  JsonValue,
  SourceAdapter,
  ValidationIssue,
} from './types.js'

/** Version of the ordinary data-core run summary. */
export const AUTODATA_RUN_SUMMARY_VERSION = 'autodata-run-summary-1'
/** Compatibility name for migration callers. */
export const DATA_HARNESS_RUN_SUMMARY_VERSION = AUTODATA_RUN_SUMMARY_VERSION

/** Whether an untrusted JS boundary value is a plain record-like object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate unique, non-empty record ids supplied by one run request. */
function validateRecordIds(values: unknown, label: string): void {
  if (!Array.isArray(values)) throw new AutoDataCoreError(`${label} must be an array`, 'INVALID_RUN_REQUEST')
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new AutoDataCoreError(`${label} contains an empty record id or non-string value`, 'INVALID_RUN_REQUEST')
    }
    if (seen.has(value)) throw new AutoDataCoreError(`${label} contains duplicate record id ${value}`, 'INVALID_RUN_REQUEST')
    seen.add(value)
  }
}

/** Validate immutable run metadata before consuming the source iterable. */
function validateRunRequest(request: DataRunRequest): void {
  const requestValue: unknown = request
  if (!isRecord(requestValue)) throw new AutoDataCoreError('run request must be an object', 'INVALID_RUN_REQUEST')
  const source = requestValue.source
  if (!isRecord(source)) {
    throw new AutoDataCoreError('source snapshot must be an object', 'INVALID_RUN_REQUEST')
  }
  const harnessId = requestValue.harness_id
  const datasetId = source.dataset_id
  const datasetRevision = source.dataset_revision
  if (
    typeof harnessId !== 'string'
    || harnessId.length === 0
    || typeof datasetId !== 'string'
    || datasetId.length === 0
    || typeof datasetRevision !== 'string'
    || datasetRevision.length === 0
  ) {
    throw new AutoDataCoreError('harness_id and source dataset identity must be non-empty strings', 'INVALID_RUN_REQUEST')
  }
  const generation = requestValue.generation
  const seed = requestValue.seed
  if (
    typeof generation !== 'number'
    || !Number.isSafeInteger(generation)
    || generation < 0
    || typeof seed !== 'number'
    || !Number.isSafeInteger(seed)
  ) {
    throw new AutoDataCoreError('generation must be non-negative and seed must be a safe integer', 'INVALID_RUN_REQUEST')
  }
  const sourceRecords = source.records
  if (
    sourceRecords === null
    || sourceRecords === undefined
    || typeof (sourceRecords as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
  ) {
    throw new AutoDataCoreError('source records must be iterable', 'INVALID_RUN_REQUEST')
  }
  const sourceAdapter = requestValue.source_adapter
  if (!isRecord(sourceAdapter)) {
    throw new AutoDataCoreError('source adapter must be an object', 'INVALID_RUN_REQUEST')
  }
  if (
    typeof sourceAdapter.id !== 'string'
    || sourceAdapter.id.length === 0
    || typeof sourceAdapter.version !== 'string'
    || sourceAdapter.version.length === 0
  ) {
    throw new AutoDataCoreError('source adapter id and version must be non-empty strings', 'INVALID_RUN_REQUEST')
  }
  if (typeof sourceAdapter.identify !== 'function' || typeof sourceAdapter.adapt !== 'function') {
    throw new AutoDataCoreError('source adapter must declare identify and adapt functions', 'INVALID_RUN_REQUEST')
  }
  const selectedRecordIds = requestValue.selected_record_ids
  if (selectedRecordIds !== null) {
    if (!Array.isArray(selectedRecordIds) || selectedRecordIds.length === 0) {
      throw new AutoDataCoreError('selected_record_ids must be null or non-empty array', 'INVALID_RUN_REQUEST')
    }
    validateRecordIds(selectedRecordIds, 'selected_record_ids')
  }
  validateRecordIds(requestValue.quarantine_record_ids, 'quarantine_record_ids')
  const plugins = requestValue.plugins
  if (!Array.isArray(plugins)) {
    throw new AutoDataCoreError('plugins must be an array', 'INVALID_RUN_REQUEST')
  }
  const pluginIds = plugins.map(plugin => dataPluginIdentity(plugin as DataPlugin).id)
  if (new Set(pluginIds).size !== pluginIds.length) {
    throw new AutoDataCoreError('plugins must not repeat an id in one pipeline', 'INVALID_RUN_REQUEST')
  }
}

/** Freeze adapter authority while preserving the implementation's original receiver. */
function snapshotSourceAdapter(adapter: SourceAdapter): SourceAdapter {
  const identify = adapter.identify.bind(adapter)
  const adapt = adapter.adapt.bind(adapter)
  return Object.freeze({
    id: adapter.id,
    version: adapter.version,
    identify,
    adapt,
  })
}

/** Capture every authority field that must agree with the emitted summary. */
function snapshotRunRequest(request: DataRunRequest): DataRunRequest {
  return Object.freeze({
    harness_id: request.harness_id,
    generation: request.generation,
    seed: request.seed,
    source: Object.freeze({
      dataset_id: request.source.dataset_id,
      dataset_revision: request.source.dataset_revision,
      records: request.source.records,
    }),
    source_adapter: snapshotSourceAdapter(request.source_adapter),
    selected_record_ids: request.selected_record_ids === null
      ? null
      : Object.freeze([...request.selected_record_ids]),
    quarantine_record_ids: Object.freeze([...request.quarantine_record_ids]),
    plugins: Object.freeze(request.plugins.map(snapshotDataPlugin)),
  })
}

interface LocatedRecord {
  readonly id: string
  readonly index: number
  readonly value: unknown
}

/** Locate requested rows without validating unselected data. */
function locateRecords(request: DataRunRequest): { records: readonly LocatedRecord[]; read: number } {
  const requested = request.selected_record_ids
  const requestedSet = requested === null ? null : new Set(requested)
  const located = new Map<string, LocatedRecord>()
  let read = 0
  let index = 0
  for (const value of request.source.records) {
    const recordIndex = index
    index += 1
    read = index
    let id: string | null
    try {
      id = request.source_adapter.identify(value)
    } catch (error) {
      if (error instanceof AutoDataCoreError) throw error
      throw new AutoDataCoreError(
        `source adapter ${request.source_adapter.id} failed to identify row ${String(recordIndex + 1)}: ${String(error)}`,
        'INVALID_RECORD',
        { cause: error },
      )
    }
    if (id !== null && typeof id !== 'string') {
      throw new AutoDataCoreError(
        `source adapter ${request.source_adapter.id} identify() must return a string or null for row ${String(recordIndex + 1)}`,
        'INVALID_RECORD',
      )
    }
    if (requestedSet !== null && (id === null || !requestedSet.has(id))) continue
    if (id === null || id.length === 0) {
      throw new AutoDataCoreError(`source row ${String(recordIndex + 1)} has no stable record id`, 'INVALID_RECORD')
    }
    if (located.has(id)) throw new AutoDataCoreError(`source record id ${id} occurs more than once`, 'DUPLICATE_RECORD_ID')
    located.set(id, { id, index: recordIndex, value })
    if (requestedSet !== null && located.size === requestedSet.size) break
  }
  if (requested === null) return { records: [...located.values()], read }
  const missing = requested.filter(id => !located.has(id))
  if (missing.length > 0) {
    throw new AutoDataCoreError(`selected record ids were not found: ${missing.join(', ')}`, 'MISSING_SELECTED_RECORD')
  }
  return { records: requested.map(id => located.get(id) as LocatedRecord), read }
}

/** Count warning codes without retaining source content in the summary. */
function warningCounts(warnings: readonly ValidationIssue[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const warning of warnings) counts[warning.code] = (counts[warning.code] ?? 0) + 1
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left < right ? -1 : 1)))
}

/** Remove source-local call linkage before exact trajectory deduplication. */
function deduplicationPayload(messages: readonly CanonicalMessage[], tools: readonly CanonicalTool[]): JsonObject {
  const normalizedMessages = messages.map((messageValue) => {
    const message = cloneJson(messageValue) as Record<string, JsonValue>
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      message.tool_calls = message.tool_calls.map((callValue) => {
        const call = cloneJson(callValue) as Record<string, JsonValue>
        delete call.id
        return call
      })
    } else if (message.role === 'tool') {
      delete message.tool_call_id
    }
    return message
  })
  return { messages: normalizedMessages, tools }
}

interface AdaptedContent {
  readonly messages: readonly CanonicalMessage[]
  readonly tools: readonly CanonicalTool[]
  readonly warnings: readonly ValidationIssue[]
}

/** Accept only adapter-owned content fields and detach them from caller mutation. */
function normalizeAdapterResult(value: unknown, adapterId: string, recordId: string): AdaptedContent {
  if (!isJsonObject(value)) {
    throw new AutoDataCoreError(`source adapter ${adapterId} must return an object for record ${recordId}`, 'INVALID_RECORD')
  }
  const extra = Object.keys(value).filter(key => key !== 'messages' && key !== 'tools' && key !== 'warnings')
  if (extra.length > 0) {
    throw new AutoDataCoreError(`source adapter ${adapterId} returned unsupported field ${extra[0]} for record ${recordId}`, 'INVALID_RECORD')
  }
  if (!Array.isArray(value.messages) || !Array.isArray(value.tools) || !Array.isArray(value.warnings)) {
    throw new AutoDataCoreError(`source adapter ${adapterId} must return messages, tools, and warnings arrays for record ${recordId}`, 'INVALID_RECORD')
  }
  const content = immutableJson({ messages: value.messages, tools: value.tools }) as unknown as {
    readonly messages: readonly CanonicalMessage[]
    readonly tools: readonly CanonicalTool[]
  }
  const warnings = immutableJson(value.warnings) as unknown as readonly ValidationIssue[]
  return { messages: content.messages, tools: content.tools, warnings }
}

/** Construct and freeze the runner-owned canonical envelope for one adapted row. */
function canonicalRecord(
  request: DataRunRequest,
  located: LocatedRecord,
  adaptedValue: unknown,
): { readonly record: CanonicalTrajectory; readonly warnings: readonly ValidationIssue[] } {
  const adapted = normalizeAdapterResult(adaptedValue, request.source_adapter.id, located.id)
  const source = {
    adapter_id: request.source_adapter.id,
    adapter_version: request.source_adapter.version,
    dataset_id: request.source.dataset_id,
    dataset_revision: request.source.dataset_revision,
    record_id: located.id,
    record_index: located.index,
    record_line: located.index + 1,
  }
  const record = immutableJson({
    schema_version: CANONICAL_TRAJECTORY_SCHEMA_VERSION,
    source,
    messages: adapted.messages,
    tools: adapted.tools,
  }) as unknown as CanonicalTrajectory
  return { record, warnings: adapted.warnings }
}

/**
 * Run the model-independent AutoData pipeline in memory.
 * @param request - frozen source, selection, quarantine, plugin, and seed inputs.
 * @returns canonical records, logical units, and an in-memory summary.
 */
export function runDataCore(request: DataRunRequest): DataRunResult {
  validateRunRequest(request)
  const authority = snapshotRunRequest(request)
  validateRunRequest(authority)
  const located = locateRecords(authority)
  const quarantine = new Set(authority.quarantine_record_ids)
  const warnings: ValidationIssue[] = []
  const canonicalRecords: CanonicalTrajectory[] = []
  const normalizedContents = new Set<string>()
  let quarantined = 0
  let duplicates = 0

  for (const sourceRecord of located.records) {
    if (quarantine.has(sourceRecord.id)) {
      quarantined += 1
      continue
    }
    let adaptedValue: unknown
    try {
      adaptedValue = authority.source_adapter.adapt(sourceRecord.value, {
        record_id: sourceRecord.id,
        record_index: sourceRecord.index,
        record_line: sourceRecord.index + 1,
      })
    } catch (error) {
      if (error instanceof AutoDataCoreError) throw error
      throw new AutoDataCoreError(
        `source adapter ${authority.source_adapter.id} failed for record ${sourceRecord.id}: ${String(error)}`,
        'INVALID_RECORD',
        { cause: error },
      )
    }
    const adapted = canonicalRecord(authority, sourceRecord, adaptedValue)
    warnings.push(...adapted.warnings)
    const normalizedContent = canonicalJson(deduplicationPayload(adapted.record.messages, adapted.record.tools))
    if (normalizedContents.has(normalizedContent)) {
      duplicates += 1
      continue
    }
    normalizedContents.add(normalizedContent)
    canonicalRecords.push(adapted.record)
  }
  if (canonicalRecords.length === 0) {
    throw new AutoDataCoreError('selection produced no canonical records', 'EMPTY_TRAINING_VIEW')
  }

  let selections: readonly DataSelection[] = Object.freeze(canonicalRecords.map(record => Object.freeze({
    record,
    provenance: Object.freeze([]),
  })))
  const pluginContext: DataPluginContext = Object.freeze({
    harness_id: authority.harness_id,
    generation: authority.generation,
    seed: authority.seed,
    source: Object.freeze({
      adapter_id: authority.source_adapter.id,
      adapter_version: authority.source_adapter.version,
      dataset_id: authority.source.dataset_id,
      dataset_revision: authority.source.dataset_revision,
    }),
  })
  for (const plugin of authority.plugins) selections = runDataPlugin(plugin, selections, pluginContext)
  if (selections.length === 0) throw new AutoDataCoreError('plugin pipeline produced no selected records', 'EMPTY_TRAINING_VIEW')

  const logicalTrainingView = buildLogicalTrainingView(selections)
  const summary: DataRunSummary = Object.freeze({
    summary_version: AUTODATA_RUN_SUMMARY_VERSION,
    harness_id: authority.harness_id,
    generation: authority.generation,
    seed: authority.seed,
    canonical_schema_version: CANONICAL_TRAJECTORY_SCHEMA_VERSION,
    logical_view_schema_version: LOGICAL_TRAINING_UNIT_SCHEMA_VERSION,
    source: Object.freeze({
      adapter_id: authority.source_adapter.id,
      adapter_version: authority.source_adapter.version,
      dataset_id: authority.source.dataset_id,
      dataset_revision: authority.source.dataset_revision,
    }),
    plugins: Object.freeze(authority.plugins.map(dataPluginIdentity)),
    counts: Object.freeze({
      source_records_read: located.read,
      selected_source_records: located.records.length,
      quarantined_source_records: quarantined,
      duplicate_source_records: duplicates,
      canonical_records: canonicalRecords.length,
      logical_training_units: logicalTrainingView.length,
      validation_warnings: warnings.length,
    }),
    validation_warning_counts: warningCounts(warnings),
  })
  return Object.freeze({
    canonical_records: Object.freeze(canonicalRecords),
    logical_training_view: logicalTrainingView,
    summary,
  })
}

/** Migration alias; the Stage 2 public name is {@link runDataCore}. */
export const runDataHarness = runDataCore

/**
 * Read one strict JSONL document into source-order records.
 * @param text - newline-delimited JSON objects; blank lines are ignored.
 * @param label - source name included in parse failures.
 * @returns parsed records in physical line order.
 */
export function parseJsonLines(text: string, label = 'JSONL'): readonly JsonObject[] {
  const records: JsonObject[] = []
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue
    records.push(parseStrictJsonObject(line, `${label}:${String(index + 1)}`))
  }
  return records
}

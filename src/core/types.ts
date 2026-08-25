/** Public, model-independent types for the AutoData in-memory Core. */

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export type CanonicalMessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'
export type CanonicalMessage = JsonObject & { readonly role: CanonicalMessageRole }
export type CanonicalTool = JsonObject

export interface DataSourceIdentity {
  readonly adapter_id: string
  readonly adapter_version: string
  readonly dataset_id: string
  readonly dataset_revision: string
}
export interface CanonicalSourceReference extends DataSourceIdentity {
  readonly record_id: string
  readonly record_index: number
  readonly record_line: number
}
export interface CanonicalTrajectory {
  readonly schema_version: string
  readonly source: CanonicalSourceReference
  readonly messages: readonly CanonicalMessage[]
  readonly tools: readonly CanonicalTool[]
}

export type ValidationSeverity = 'error' | 'warning'
export interface ValidationIssue {
  readonly line: number
  readonly code: string
  readonly message: string
  readonly path: string
  readonly severity: ValidationSeverity
}
export interface SerializedToolCallAnalysis {
  readonly detected: boolean
  readonly function_names: readonly string[]
  readonly malformed: boolean
}

export interface SourceSnapshot {
  readonly dataset_id: string
  readonly dataset_revision: string
  readonly records: Iterable<unknown>
}
export interface SourceAdapterContext {
  readonly record_id: string
  readonly record_index: number
  readonly record_line: number
}
export interface SourceAdapterResult {
  readonly messages: readonly CanonicalMessage[]
  readonly tools: readonly CanonicalTool[]
  readonly warnings: readonly ValidationIssue[]
}
export interface SourceAdapter {
  readonly id: string
  readonly version: string
  readonly identify: (value: unknown) => string | null
  readonly adapt: (value: unknown, context: SourceAdapterContext) => SourceAdapterResult
}

export interface PluginSelectionProvenance {
  readonly plugin_id: string
  readonly plugin_version: string
  readonly note?: string
}
export interface DataSelection {
  readonly record: CanonicalTrajectory
  readonly provenance: readonly PluginSelectionProvenance[]
}
export interface DataPluginDecision {
  readonly record_id: string
  readonly note?: string
}
/** Explicit run inputs; no ambient session, wall-clock, or persistence state. */
export interface DataPluginContext {
  readonly harness_id: string
  readonly generation: number
  readonly seed: number
  readonly source: DataSourceIdentity
}
export interface DataPlugin {
  readonly id: string
  readonly version: string
  readonly run: (
    input: readonly DataSelection[],
    context: DataPluginContext,
  ) => readonly DataPluginDecision[]
}
export interface DataPluginDescriptor {
  readonly id: string
  readonly version: string
}
export type DataPluginSummaryEntry = DataPluginDescriptor

export interface LogicalTrainingUnit {
  readonly schema_version: string
  readonly id: string
  readonly source: CanonicalSourceReference
  readonly assistant_message_index: number
  readonly messages: readonly CanonicalMessage[]
  readonly tools: readonly CanonicalTool[]
  readonly selection_rank: number
  readonly plugin_provenance: readonly PluginSelectionProvenance[]
}

/** A complete explicit run, resolved against executable plugin snapshots. */
export interface DataRunRequest {
  readonly harness_id: string
  readonly generation: number
  readonly seed: number
  readonly source: SourceSnapshot
  readonly source_adapter: SourceAdapter
  readonly selected_record_ids: readonly string[] | null
  readonly quarantine_record_ids: readonly string[]
  readonly plugins: readonly DataPlugin[]
}
/** Request accepted by the service registry before plugin IDs are resolved. */
export interface RegisteredDataRunRequest {
  readonly harness_id: string
  readonly generation: number
  readonly seed: number
  readonly source: SourceSnapshot
  readonly source_adapter: SourceAdapter
  readonly selected_record_ids: readonly string[] | null
  readonly quarantine_record_ids: readonly string[]
  readonly plugin_ids: readonly string[]
}

export interface DataRunSummary {
  readonly summary_version: string
  readonly harness_id: string
  readonly generation: number
  readonly seed: number
  readonly canonical_schema_version: string
  readonly logical_view_schema_version: string
  readonly source: DataSourceIdentity
  readonly plugins: readonly DataPluginDescriptor[]
  readonly counts: {
    readonly source_records_read: number
    readonly selected_source_records: number
    readonly quarantined_source_records: number
    readonly duplicate_source_records: number
    readonly canonical_records: number
    readonly logical_training_units: number
    readonly validation_warnings: number
  }
  readonly validation_warning_counts: Readonly<Record<string, number>>
}
export interface DataRunResult {
  readonly canonical_records: readonly CanonicalTrajectory[]
  readonly logical_training_view: readonly LogicalTrainingUnit[]
  readonly summary: DataRunSummary
}
/** Compatibility aliases for migration callers; no persistence is implied. */
export type DataHarnessRunRequest = DataRunRequest
export type DataHarnessRunResult = DataRunResult
export type DataHarnessRunSummary = DataRunSummary
export type RegisteredDataHarnessRunRequest = RegisteredDataRunRequest

export interface DataSessionSnapshot { readonly id: string; readonly seq: number }
export type DataAgentStatus = 'idle' | 'running' | 'unknown'
export interface DataAgentSnapshot { readonly id: string; readonly status: DataAgentStatus }
export interface DataWorkspaceSnapshot { readonly id?: string; readonly title?: string; readonly cwd?: string }
export interface DataToolSchema {
  readonly name: string
  readonly description?: string
  readonly parameters: JsonObject
}
export interface DataContext {
  readonly schema_version: string
  readonly plugins: readonly DataPluginDescriptor[]
  readonly session?: DataSessionSnapshot
  readonly agent?: DataAgentSnapshot
  readonly workspace?: DataWorkspaceSnapshot
  readonly tools?: readonly DataToolSchema[]
}
/** Host-only lookup hint; the optional agent is consumed only to scope schemas. */
export interface DataContextRequest {
  readonly agent_id?: string
  readonly agent?: unknown
}
export type AutoDataDisposer = () => void | Promise<void>
export interface AutoDataCore {
  readonly register: (plugin: DataPlugin) => AutoDataDisposer
  readonly plugins: () => readonly DataPluginDescriptor[]
  readonly run: (request: RegisteredDataRunRequest) => DataRunResult
  readonly context: (request?: DataContextRequest) => DataContext
}

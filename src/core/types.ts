/** Public, model-independent type skeleton for the Stage 2 Core. */

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

/** Explicit deterministic inputs. No ambient session or wall-clock state. */
export interface DataPluginContext {
  readonly harness_id: string
  readonly generation: number
  readonly seed: number
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

export interface DataSessionSnapshot {
  readonly id: string
  readonly seq: number
}

export type DataAgentStatus = 'idle' | 'running'

export interface DataAgentSnapshot {
  readonly id: string
  readonly status: DataAgentStatus
}

export interface DataWorkspaceSnapshot {
  readonly id?: string
  readonly title?: string
  readonly cwd?: string
}

/** A schema projection; it intentionally has no executable callback. */
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

/** Explicit lookup input; omitted means use the caller-bound DSH scope. */
export interface DataContextRequest {
  readonly agent_id?: string
}

export type AutoDataDisposer = () => void | Promise<void>

/** Service-facing contract to be wired after the pure skeleton is approved. */
export interface AutoDataCore {
  readonly register: (plugin: DataPlugin) => AutoDataDisposer
  readonly plugins: () => readonly DataPluginDescriptor[]
  readonly run: (request: RegisteredDataRunRequest) => DataRunResult
  readonly context: (request?: DataContextRequest) => DataContext
}

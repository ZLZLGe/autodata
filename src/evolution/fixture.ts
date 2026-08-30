import type {
  DataPluginDescriptor,
  DataRunResult,
  RegisteredDataRunRequest,
  SourceAdapter,
  SourceAdapterContext,
} from '../core/types.js'
import type { FrozenSelectionRuntimeBinding } from './candidate-sandbox.js'

/** The narrow AutoData surface used by runtime and isolated candidate checks. */
export interface EvolutionDataHost {
  plugins(): readonly DataPluginDescriptor[]
  run(request: RegisteredDataRunRequest): DataRunResult
}

const fixtureAdapter: SourceAdapter = Object.freeze({
  id: 'autodata-evolution-fixture',
  version: '1',
  identify(value: unknown) {
    return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
      ? (value as { id: string }).id
      : null
  },
  adapt(value: unknown) {
    const record = value as { text: string; tool: string }
    return {
      messages: [
        { role: 'user' as const, content: record.text },
        { role: 'assistant' as const, content: `Selected ${record.tool}.` },
      ],
      tools: [{ function: { name: record.tool, description: `Fixture ${record.tool}`, parameters: {} } }],
      warnings: [],
    }
  },
})

/** Run the fixed Stage 3 structural fixture through one registered strategy. */
export function runEvolutionFixture(
  host: EvolutionDataHost,
  profileId: string,
  generation: number,
  pluginId: string,
): void {
  host.run({
    harness_id: `${profileId}-candidate-fixture`,
    generation,
    seed: 0,
    source: {
      dataset_id: 'autodata-evolution-fixture',
      dataset_revision: '1',
      records: [
        { id: 'fixture-one', text: 'Find a city forecast.', tool: 'weather' },
        { id: 'fixture-two', text: 'Look up a document.', tool: 'search' },
      ],
    },
    source_adapter: fixtureAdapter,
    selected_record_ids: null,
    quarantine_record_ids: [],
    plugin_ids: [pluginId],
  })
}

/**
 * Exercise a formal frozen-selection plugin through its one allowed public
 * input. The records are synthetic because the plugin is bound only to source
 * identity and ordered record IDs; no model-authored source runs here.
 */
export function runFrozenSelectionRuntimeSelfCheck(
  host: EvolutionDataHost,
  binding: FrozenSelectionRuntimeBinding,
): void {
  const adapter: SourceAdapter = Object.freeze({
    id: binding.source.adapter_id,
    version: binding.source.adapter_version,
    identify(value: unknown) {
      return typeof value === 'object'
        && value !== null
        && typeof (value as { record_id?: unknown }).record_id === 'string'
        ? (value as { record_id: string }).record_id
        : null
    },
    adapt(_value: unknown, context: SourceAdapterContext) {
      return {
        messages: [
          { role: 'user' as const, content: `AutoData frozen-selection runtime self-check: ${context.record_id}` },
          { role: 'assistant' as const, content: 'Validated.' },
        ],
        tools: [],
        warnings: [],
      }
    },
  })
  const result = host.run({
    harness_id: binding.harness_id,
    generation: binding.generation,
    seed: binding.seed,
    source: {
      dataset_id: binding.source.dataset_id,
      dataset_revision: binding.source.dataset_revision,
      records: binding.source_record_ids.map(record_id => Object.freeze({ record_id })),
    },
    source_adapter: adapter,
    selected_record_ids: null,
    quarantine_record_ids: [],
    plugin_ids: [binding.plugin_id],
  })

  if (result.logical_training_view.length !== binding.decisions.length) {
    throw new Error('frozen-selection runtime self-check returned a different number of decisions')
  }
  for (const [index, decision] of binding.decisions.entries()) {
    const unit = result.logical_training_view[index]
    const provenance = unit?.plugin_provenance
    const expectedProvenance = {
      plugin_id: binding.plugin_id,
      plugin_version: binding.strategy_version,
      ...(decision.note === undefined ? {} : { note: decision.note }),
    }
    if (
      unit?.source.record_id !== decision.record_id
      || provenance?.length !== 1
      || JSON.stringify(provenance[0]) !== JSON.stringify(expectedProvenance)
    ) throw new Error('frozen-selection runtime self-check output differs from its binding')
  }
}

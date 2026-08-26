import type { DataPluginDescriptor, RegisteredDataRunRequest, SourceAdapter } from '../core/types.js'

/** The narrow AutoData surface used by runtime and isolated candidate checks. */
export interface EvolutionDataHost {
  plugins(): readonly DataPluginDescriptor[]
  run(request: RegisteredDataRunRequest): unknown
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

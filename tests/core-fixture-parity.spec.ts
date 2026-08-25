import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  h0DataPlugin,
  openAiToolTrajectoryAdapter,
  parseJsonLines,
  runDataCore,
  type DataPlugin,
  type DataRunRequest,
  type JsonObject,
} from '../src/index.js'

const fixtureDirectory = fileURLToPath(new URL('./fixtures/data-core/', import.meta.url))
const sourceText = readFileSync(resolve(fixtureDirectory, 'source.jsonl'), 'utf8')
const selection = JSON.parse(readFileSync(resolve(fixtureDirectory, 'selection.json'), 'utf8')) as {
  dataset_id: string
  dataset_revision: string
  selected_record_ids: string[]
  quarantine_record_ids: string[]
}

function fixtureRequest(overrides: Partial<DataRunRequest> = {}): DataRunRequest {
  return {
    harness_id: 'toolcall-h0',
    generation: 0,
    seed: 42,
    source: {
      dataset_id: selection.dataset_id,
      dataset_revision: selection.dataset_revision,
      records: parseJsonLines(sourceText, 'fixture/source.jsonl'),
    },
    source_adapter: openAiToolTrajectoryAdapter,
    selected_record_ids: selection.selected_record_ids,
    quarantine_record_ids: selection.quarantine_record_ids,
    plugins: [h0DataPlugin],
    ...overrides,
  }
}

describe('legacy DataHarness fixture parity', () => {
  it('keeps canonical, quarantine, dedupe, warning, and logical-view semantics', () => {
    const result = runDataCore(fixtureRequest())

    expect(result.summary).toMatchObject({
      summary_version: 'autodata-run-summary-1',
      harness_id: 'toolcall-h0',
      generation: 0,
      seed: 42,
      canonical_schema_version: 'dataharness-canonical-tool-trajectory-3',
      logical_view_schema_version: 'dataharness-logical-training-unit-4',
      source: {
        adapter_id: 'openai-tool-trajectory',
        adapter_version: '2',
        dataset_id: 'fixture-agent-sft',
        dataset_revision: 'fixture-v1',
      },
      plugins: [{ id: 'toolcall-h0', version: '3' }],
      counts: {
        source_records_read: 4,
        selected_source_records: 4,
        quarantined_source_records: 1,
        duplicate_source_records: 1,
        canonical_records: 2,
        logical_training_units: 3,
        validation_warnings: 1,
      },
      validation_warning_counts: { missing_tool_response: 1 },
    })
    expect(result.canonical_records.map(record => record.source.record_id))
      .toEqual(['trace-a', 'trace-warning'])
    expect(result.logical_training_view.map(unit => unit.id))
      .toEqual(['trace-a:assistant:2', 'trace-a:assistant:5', 'trace-warning:assistant:1'])
    expect(result.logical_training_view[0]?.messages.map(message => message.loss))
      .toEqual([undefined, undefined, true])
    expect(result.logical_training_view[1]?.messages.filter(message => message.role === 'assistant').map(message => message.loss))
      .toEqual([false, true])
    expect((result.canonical_records[0]?.messages[2]?.tool_calls as readonly JsonObject[])[0]?.function)
      .toMatchObject({ arguments: { city: 'Hong Kong' } })

    // The Stage 2 result is memory-only: no output paths, byte counts, or ID lists.
    expect(Object.keys(result.summary)).toEqual([
      'summary_version', 'harness_id', 'generation', 'seed',
      'canonical_schema_version', 'logical_view_schema_version', 'source',
      'plugins', 'counts', 'validation_warning_counts',
    ])
    expect(JSON.stringify(result.summary)).not.toMatch(/selected_record_ids|quarantine_record_ids|hash|lock/iu)
  })

  it('preserves declared plugin order and provenance on the shared fixture', () => {
    const reverse: DataPlugin = {
      id: 'reverse-selection',
      version: '1',
      run: input => [...input].reverse().map((selection, index) => ({
        record_id: selection.record.source.record_id,
        note: `rank-${String(index)}`,
      })),
    }
    const result = runDataCore(fixtureRequest({ plugins: [h0DataPlugin, reverse] }))

    expect(result.logical_training_view.map(unit => unit.source.record_id))
      .toEqual(['trace-warning', 'trace-a', 'trace-a'])
    expect(result.logical_training_view[0]?.plugin_provenance).toEqual([
      { plugin_id: 'toolcall-h0', plugin_version: '3' },
      { plugin_id: 'reverse-selection', plugin_version: '1', note: 'rank-0' },
    ])
    expect(result.summary.plugins).toEqual([
      { id: 'toolcall-h0', version: '3' },
      { id: 'reverse-selection', version: '1' },
    ])
  })

  it('does not adapt an unselected invalid source row', () => {
    const result = runDataCore(fixtureRequest())
    expect(result.summary.counts.source_records_read).toBe(4)
    expect(result.canonical_records.some(record => record.source.record_id === 'trace-unselected-invalid')).toBe(false)
  })
})

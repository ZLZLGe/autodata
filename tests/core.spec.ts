import { describe, expect, it } from 'vitest'
import {
  AutoDataCoreError,
  analyzeSerializedToolCalls,
  canonicalJson,
  cloneJson,
  h0DataPlugin,
  immutableJson,
  openAiToolTrajectoryAdapter,
  parseStrictJson,
  parseStrictJsonObject,
  parseToolArguments,
  runDataCore,
  validateOpenAiToolTrajectory,
  type DataPlugin,
  type DataRunRequest,
} from '../src/index.js'

function request(overrides: Partial<DataRunRequest> = {}): DataRunRequest {
  return {
    harness_id: 'fixture-harness',
    generation: 0,
    seed: 7,
    source: {
      dataset_id: 'fixture',
      dataset_revision: 'v1',
      records: [
        { uuid: 'a', tools: [], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'yes' }] },
        { uuid: 'b', tools: [], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'yes' }] },
        { uuid: 'c', tools: [], messages: [{ role: 'user', content: 'other' }, { role: 'assistant', content: 'no' }] },
      ],
    },
    source_adapter: openAiToolTrajectoryAdapter,
    selected_record_ids: null,
    quarantine_record_ids: [],
    plugins: [h0DataPlugin],
    ...overrides,
  }
}

describe('AutoData pure Core', () => {
  it('keeps strict JSON boundaries detached and deeply frozen', () => {
    const parsed = parseStrictJsonObject('{"z":1,"a":{"y":2,"x":3}}')
    expect(Object.keys(parsed)).toEqual(['z', 'a'])
    expect(canonicalJson(parsed)).toBe('{"a":{"x":3,"y":2},"z":1}')
    expect(parseStrictJson('false')).toBe(false)
    expect(parseToolArguments('{"x":1}')).toEqual({ x: 1 })
    expect(() => parseStrictJson('{"x":1,"x":2}')).toThrow(AutoDataCoreError)
    const source = { nested: [{ value: 1 }] }
    const frozen = immutableJson(source) as { nested: readonly [{ value: number }] }
    expect(frozen).not.toBe(source)
    expect(Object.isFrozen(frozen.nested[0])).toBe(true)
    expect(() => cloneJson(new Date())).toThrow(/plain JSON object/)
  })

  it('validates and normalizes an OpenAI tool trajectory', () => {
    const source = {
      uuid: 'openai-1',
      tools: [{ function: { name: 'lookup', parameters: {} } }],
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"x":1}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
        { role: 'assistant', content: 'done' },
      ],
    }
    expect(validateOpenAiToolTrajectory(source, 1)).toEqual([])
    const adapted = openAiToolTrajectoryAdapter.adapt(source, {
      record_id: 'openai-1', record_index: 0, record_line: 1,
    })
    expect((adapted.messages[1]?.tool_calls as Array<{ function: { arguments: unknown }}>)[0]?.function.arguments)
      .toEqual({ x: 1 })
    expect(analyzeSerializedToolCalls('<function=lookup></function>')).toMatchObject({ detected: true, malformed: true })
    expect(() => openAiToolTrajectoryAdapter.adapt({ uuid: 'bad', tools: [], messages: [] }, {
      record_id: 'bad', record_index: 0, record_line: 1,
    })).toThrow(/failed validation/)
  })

  it('quarantines and exactly deduplicates source content in memory', () => {
    const result = runDataCore(request({ quarantine_record_ids: ['c'] }))
    expect(result.canonical_records.map(record => record.source.record_id)).toEqual(['a'])
    expect(result.summary.counts).toMatchObject({
      source_records_read: 3,
      selected_source_records: 3,
      quarantined_source_records: 1,
      duplicate_source_records: 1,
      canonical_records: 1,
      logical_training_units: 1,
    })
    expect(Object.isFrozen(result.canonical_records[0])).toBe(true)
    expect(Object.isFrozen(result.logical_training_view[0])).toBe(true)
  })

  it('preserves explicit plugin order and provenance without exposing mutable input', () => {
    let frozen = false
    const reverse: DataPlugin = {
      id: 'reverse-selection',
      version: '1',
      run(input) {
        frozen = Object.isFrozen(input) && Object.isFrozen(input[0])
        return [...input].reverse().map((selection, index) => ({
          record_id: selection.record.source.record_id,
          note: `rank-${String(index)}`,
        }))
      },
    }
    const result = runDataCore(request({ plugins: [h0DataPlugin, reverse], quarantine_record_ids: ['c'] }))
    expect(frozen).toBe(true)
    expect(result.logical_training_view[0]?.source.record_id).toBe('a')
    expect(result.logical_training_view[0]?.plugin_provenance).toEqual([
      { plugin_id: 'toolcall-h0', plugin_version: '3' },
      { plugin_id: 'reverse-selection', plugin_version: '1', note: 'rank-0' },
    ])
  })

  it('turns plugin exceptions into stable failures and leaves no persistence artifacts', () => {
    const failing: DataPlugin = {
      id: 'failing-plugin',
      version: '1',
      run: () => { throw new Error('fixture failure') },
    }
    let error: unknown
    try {
      runDataCore(request({ plugins: [failing] }))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AutoDataCoreError)
    expect((error as AutoDataCoreError).code).toBe('PLUGIN_FAILED')
    expect(JSON.stringify(error)).not.toMatch(/hash|lock|path|timestamp/iu)
  })

  it('rejects invalid plugin output, duplicate IDs, and empty selection', () => {
    const invalid: DataPlugin = {
      id: 'invalid-selection',
      version: '1',
      run: () => [{ record_id: 'missing' }],
    }
    expect(() => runDataCore(request({ plugins: [invalid] }))).toThrow(/unknown record_id/)
    const duplicate: DataPlugin = {
      id: 'duplicate-selection',
      version: '1',
      run: input => [{ record_id: input[0]!.record.source.record_id }, { record_id: input[0]!.record.source.record_id }],
    }
    expect(() => runDataCore(request({ plugins: [duplicate] }))).toThrow(/more than once/)
    const empty: DataPlugin = { id: 'empty-selection', version: '1', run: () => [] }
    expect(() => runDataCore(request({ plugins: [empty] }))).toThrow(/no selected records/)
  })
})

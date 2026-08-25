/** Model-independent expansion from selected trajectories to assistant-target prefixes. */

import { AutoDataCoreError } from './errors.js'
import { cloneJson, immutableJson } from './json.js'
import type { CanonicalMessage, DataSelection, JsonValue, LogicalTrainingUnit } from './types.js'

/** Version of each in-memory logical training unit. */
export const LOGICAL_TRAINING_UNIT_SCHEMA_VERSION = 'dataharness-logical-training-unit-4'

/** Whether one canonical assistant message contains a trainable target. */
function hasAssistantTarget(message: CanonicalMessage): boolean {
  const content = message.content
  const calls = message.tool_calls
  return (content !== null && content !== undefined && content !== '') || (Array.isArray(calls) && calls.length > 0)
}

/** Build one prefix and mark only its final assistant message for loss. */
function prefixWithLoss(messages: readonly CanonicalMessage[], targetIndex: number): CanonicalMessage[] {
  return messages.slice(0, targetIndex + 1).map((messageValue, messageIndex) => {
    const message = cloneJson(messageValue) as Record<string, JsonValue>
    if (message.role === 'assistant') message.loss = messageIndex === targetIndex
    return message as CanonicalMessage
  })
}

/**
 * Expand selected trajectories into one model-independent unit per assistant turn.
 * @param selections - final ordered record selection.
 * @returns immutable logical units in selection and message order.
 * @throws AutoDataCoreError when a selected record has no non-empty assistant target.
 */
export function buildLogicalTrainingView(selections: readonly DataSelection[]): readonly LogicalTrainingUnit[] {
  const units: LogicalTrainingUnit[] = []
  for (const [selectionRank, selection] of selections.entries()) {
    const record = selection.record
    let targetCount = 0
    for (const [messageIndex, message] of record.messages.entries()) {
      if (message.role !== 'assistant') continue
      if (!hasAssistantTarget(message)) {
        throw new AutoDataCoreError(
          `record ${record.source.record_id} messages[${String(messageIndex)}] is an empty assistant target`,
          'INVALID_RECORD',
        )
      }
      targetCount += 1
      units.push(immutableJson({
        schema_version: LOGICAL_TRAINING_UNIT_SCHEMA_VERSION,
        id: `${record.source.record_id}:assistant:${String(messageIndex)}`,
        source: record.source,
        assistant_message_index: messageIndex,
        messages: prefixWithLoss(record.messages, messageIndex),
        tools: record.tools,
        selection_rank: selectionRank,
        plugin_provenance: selection.provenance,
      }) as unknown as LogicalTrainingUnit)
    }
    if (targetCount === 0) {
      throw new AutoDataCoreError(
        `record ${record.source.record_id} has no assistant target`,
        'INVALID_RECORD',
      )
    }
  }
  return Object.freeze(units)
}

/**
 * Project a logical unit to the independent Python stage-0 message-view format.
 * This reference projection is only for migration verification; Python's
 * production bridge consumes the versioned logical unit directly.
 * @param unit - one logical training unit.
 * @returns the reference fields in their frozen object-key order.
 */

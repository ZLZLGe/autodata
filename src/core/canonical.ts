/** OpenAI-style source adaptation and model-independent trajectory validation. */

import { AutoDataCoreError } from './errors.js'
import {
  canonicalJson,
  cloneJson,
  isJsonObject,
  parseStrictJsonObject,
} from './json.js'
import type {
  CanonicalMessage,
  CanonicalTool,
  JsonObject,
  JsonValue,
  SerializedToolCallAnalysis,
  SourceAdapter,
  SourceAdapterContext,
  SourceAdapterResult,
  ValidationIssue,
  ValidationSeverity,
} from './types.js'

/** Version of the canonical model-independent tool-trajectory record. */
export const CANONICAL_TRAJECTORY_SCHEMA_VERSION = 'dataharness-canonical-tool-trajectory-3'

/** Identifier for the initial OpenAI-style agent-sft source adapter. */
export const OPENAI_TOOL_TRAJECTORY_ADAPTER_ID = 'openai-tool-trajectory'

/** Version of the initial OpenAI-style agent-sft source adapter. */
export const OPENAI_TOOL_TRAJECTORY_ADAPTER_VERSION = '2'

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer'])

/** Read one own property without accepting an inherited value. */
function field(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined
}

/** Add one finding in deterministic traversal order. */
function issue(
  issues: ValidationIssue[],
  line: number,
  code: string,
  message: string,
  path: string,
  severity: ValidationSeverity = 'error',
): void {
  issues.push({ line, code, message, path, severity })
}

/**
 * Normalize text for conservative duplicate indexes.
 * @param value - source text.
 * @param caseFold - whether to apply locale-independent lowercase folding.
 * @returns NFKC text with collapsed whitespace.
 */
export function normalizeText(value: string, caseFold = true): string {
  const normalized = value.normalize('NFKC').replaceAll('\u00a0', ' ').replace(/\s+/gu, ' ').trim()
  return caseFold ? normalized.toLowerCase() : normalized
}

/**
 * Unwrap an OpenAI function tool while preserving the definition.
 * @param tool - one tool object.
 * @returns the nested function object when present, otherwise the input.
 */
export function canonicalToolDefinition(tool: Record<string, unknown>): Record<string, unknown> {
  const definition = field(tool, 'function')
  return isJsonObject(definition) ? definition : tool
}

/**
 * Canonically serialize a tool set independent of offered-tool order.
 * @param tools - tool definitions.
 * @returns sorted canonical JSON.
 */
export function canonicalToolSet(tools: readonly Record<string, unknown>[]): string {
  const definitions = tools.map(tool => cloneJson(canonicalToolDefinition(tool)) as JsonObject)
  definitions.sort((left, right) => {
    const leftName = typeof left.name === 'string' ? left.name : ''
    const rightName = typeof right.name === 'string' ? right.name : ''
    if (leftName !== rightName) return leftName < rightName ? -1 : 1
    const leftJson = canonicalJson(left)
    const rightJson = canonicalJson(right)
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0
  })
  return canonicalJson(definitions)
}

/** Count non-overlapping occurrences of one fixed marker. */
function countMarker(content: string, marker: string): number {
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(marker, offset)) !== -1) {
    count += 1
    offset += marker.length
  }
  return count
}

/**
 * Detect Qwen control markup embedded directly in assistant content.
 * @param content - message content.
 * @returns detection, function names, and balance classification.
 */
export function analyzeSerializedToolCalls(content: unknown): SerializedToolCallAnalysis {
  if (typeof content !== 'string') return { detected: false, function_names: [], malformed: false }
  const toolOpen = countMarker(content, '<tool_call>')
  const toolClose = countMarker(content, '</tool_call>')
  const functionNames = [...content.matchAll(/<function=([^>\r\n]+)>/g)].map(match => match[1] as string)
  const functionClose = countMarker(content, '</function>')
  const parameterOpen = [...content.matchAll(/<parameter=[^>\r\n]+>/g)].length
  const parameterClose = countMarker(content, '</parameter>')
  const detected = toolOpen + toolClose + functionNames.length + functionClose + parameterOpen + parameterClose > 0
  return {
    detected,
    function_names: functionNames,
    malformed: detected && (
      toolOpen !== toolClose
      || toolOpen !== functionNames.length
      || functionNames.length !== functionClose
      || parameterOpen !== parameterClose
    ),
  }
}

/**
 * Parse one tool-call argument payload and require a strict JSON object.
 * @param value - source argument string or parsed value.
 * @returns a detached argument object.
 */
export function parseToolArguments(value: unknown): JsonObject {
  const parsed = typeof value === 'string' ? parseStrictJsonObject(value, 'arguments') : cloneJson(value, 'arguments')
  if (!isJsonObject(parsed)) {
    throw new AutoDataCoreError('arguments must resolve to a JSON object', 'INVALID_JSON')
  }
  return parsed
}

/**
 * Validate one OpenAI-style source record without modifying it.
 * @param record - parsed source value.
 * @param line - one-based source line.
 * @returns findings in deterministic source traversal order.
 */
export function validateOpenAiToolTrajectory(record: unknown, line: number): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!isJsonObject(record)) {
    issue(issues, line, 'record_not_object', 'top-level record must be a JSON object', '$')
    return issues
  }

  const recordId = field(record, 'uuid')
  if (typeof recordId !== 'string' || recordId.length === 0) {
    issue(issues, line, 'missing_record_id', 'record must contain a non-empty uuid', 'uuid')
  }

  const messagesValue = field(record, 'messages')
  if (!Array.isArray(messagesValue) || messagesValue.length === 0) {
    issue(issues, line, 'invalid_messages', 'messages must be a non-empty array', 'messages')
    return issues
  }

  const toolsValue = field(record, 'tools')
  const tools = Array.isArray(toolsValue) ? toolsValue : []
  if (!Array.isArray(toolsValue)) issue(issues, line, 'invalid_tools', 'tools must be an array', 'tools')

  const toolNames = new Set<string>()
  for (const [index, tool] of tools.entries()) {
    const path = `tools[${String(index)}]`
    if (!isJsonObject(tool)) {
      issue(issues, line, 'invalid_tool', 'tool definition must be an object', path)
      continue
    }
    const definition = canonicalToolDefinition(tool)
    const name = field(definition, 'name')
    if (typeof name !== 'string' || name.length === 0) {
      issue(issues, line, 'missing_tool_name', 'tool definition must contain a name', path)
    } else if (toolNames.has(name)) {
      issue(issues, line, 'duplicate_tool_name', `duplicate tool name: ${name}`, path)
    } else {
      toolNames.add(name)
    }
    const parameters = field(definition, 'parameters')
    if (parameters !== undefined && !isJsonObject(parameters)) {
      issue(issues, line, 'invalid_parameters', 'tool parameters must be an object', `${path}.parameters`)
    }
  }

  const callIds = new Set<string>()
  const callGroups: Array<{ messageIndex: number; ids: string[] }> = []
  const responseIds = new Set<string>()
  for (const [index, message] of messagesValue.entries()) {
    const path = `messages[${String(index)}]`
    if (!isJsonObject(message)) {
      issue(issues, line, 'invalid_message', 'message must be an object', path)
      continue
    }
    const role = field(message, 'role')
    if (typeof role !== 'string' || !ALLOWED_ROLES.has(role)) {
      issue(issues, line, 'invalid_role', `unsupported role: ${JSON.stringify(role)}`, `${path}.role`)
      continue
    }
    if (role === 'assistant') {
      const serialized = analyzeSerializedToolCalls(field(message, 'content'))
      if (serialized.detected) {
        issue(
          issues,
          line,
          'serialized_tool_call_in_content',
          'assistant content contains unstructured Qwen tool-call control markup',
          `${path}.content`,
        )
      }
      const callsValue = field(message, 'tool_calls')
      const calls = callsValue === null || callsValue === undefined ? [] : callsValue
      if (!Array.isArray(calls)) {
        issue(issues, line, 'invalid_tool_calls', 'tool_calls must be an array', `${path}.tool_calls`)
        continue
      }
      const groupIds: string[] = []
      for (const [callIndex, call] of calls.entries()) {
        const callPath = `${path}.tool_calls[${String(callIndex)}]`
        if (!isJsonObject(call)) {
          issue(issues, line, 'invalid_tool_call', 'tool call must be an object', callPath)
          continue
        }
        const callId = field(call, 'id')
        if (typeof callId !== 'string' || callId.length === 0) {
          issue(issues, line, 'missing_tool_call_id', 'tool call must contain an id', callPath)
        } else if (callIds.has(callId)) {
          issue(issues, line, 'duplicate_tool_call_id', `duplicate tool call id: ${callId}`, callPath)
        } else {
          callIds.add(callId)
          groupIds.push(callId)
        }
        const functionValue = field(call, 'function')
        if (!isJsonObject(functionValue)) {
          issue(issues, line, 'missing_function', 'tool call must contain a function object', callPath)
          continue
        }
        const name = field(functionValue, 'name')
        if (typeof name !== 'string' || name.length === 0) {
          issue(issues, line, 'missing_called_tool_name', 'tool call must contain function.name', callPath)
        } else if (!toolNames.has(name)) {
          issue(issues, line, 'called_tool_not_offered', `called tool was not offered: ${name}`, callPath)
        }
        try {
          parseToolArguments(field(functionValue, 'arguments'))
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error)
          issue(issues, line, 'invalid_arguments', messageText, `${callPath}.function.arguments`)
        }
      }
      if (groupIds.length > 0) callGroups.push({ messageIndex: index, ids: groupIds })
    } else if (role === 'tool') {
      const callId = field(message, 'tool_call_id')
      if (typeof callId !== 'string' || callId.length === 0) {
        issue(issues, line, 'missing_response_id', 'tool message must contain tool_call_id', `${path}.tool_call_id`)
      } else if (!callIds.has(callId)) {
        issue(issues, line, 'orphan_tool_response', `tool response has no matching call: ${callId}`, path)
      } else if (responseIds.has(callId)) {
        issue(issues, line, 'duplicate_tool_response', `duplicate tool response: ${callId}`, path)
      } else {
        responseIds.add(callId)
      }
    }
  }

  for (const group of callGroups) {
    const contiguousIds: string[] = []
    for (const message of messagesValue.slice(group.messageIndex + 1, group.messageIndex + 1 + group.ids.length)) {
      if (!isJsonObject(message) || field(message, 'role') !== 'tool') break
      const callId = field(message, 'tool_call_id')
      if (typeof callId === 'string' && callId.length > 0) contiguousIds.push(callId)
    }
    if (contiguousIds.some((callId, index) => callId !== group.ids[index])) {
      issue(
        issues,
        line,
        'tool_response_order_mismatch',
        'parallel tool responses must follow tool-call order',
        `messages[${String(group.messageIndex + 1)}]`,
      )
    }
    const delayedIds = group.ids.filter(callId => responseIds.has(callId) && !contiguousIds.includes(callId))
    if (delayedIds.length > 0) {
      issue(
        issues,
        line,
        'noncontiguous_tool_response',
        `tool responses do not immediately follow their calls: ${delayedIds.join(', ')}`,
        `messages[${String(group.messageIndex)}]`,
      )
    }
  }

  const groupById = new Map<string, { messageIndex: number; ids: readonly string[] }>()
  for (const group of callGroups) {
    for (const callId of group.ids) groupById.set(callId, group)
  }
  for (const callId of [...callIds].filter(value => !responseIds.has(value)).sort()) {
    const group = groupById.get(callId) as { messageIndex: number; ids: readonly string[] }
    const trailingMessages = messagesValue.slice(group.messageIndex + 1)
    const terminalIncomplete = trailingMessages.every(message =>
      isJsonObject(message)
      && field(message, 'role') === 'tool'
      && typeof field(message, 'tool_call_id') === 'string'
      && group.ids.includes(field(message, 'tool_call_id') as string))
    issue(
      issues,
      line,
      'missing_tool_response',
      `tool call has no later response: ${callId}`,
      'messages',
      terminalIncomplete ? 'warning' : 'error',
    )
  }
  return issues
}

/** Normalize all tool-call arguments while retaining source field order. */
function normalizeMessages(messages: readonly unknown[]): CanonicalMessage[] {
  return messages.map((messageValue, messageIndex) => {
    const message = cloneJson(messageValue, `messages[${String(messageIndex)}]`) as JsonObject
    if (message.role !== 'assistant') return message as CanonicalMessage
    const callsValue = message.tool_calls ?? []
    const calls = (callsValue as readonly JsonValue[]).map((callValue) => {
      const call = callValue as JsonObject
      const functionValue = call.function as JsonObject
      const normalizedFunction: Record<string, JsonValue> = { ...functionValue }
      normalizedFunction.arguments = parseToolArguments(functionValue.arguments)
      return { ...call, function: normalizedFunction }
    })
    return { ...message, tool_calls: calls } as unknown as CanonicalMessage
  })
}

/** Require a non-empty string field in adapter metadata. */
function requireContextText(value: string, name: string): void {
  if (value.length === 0) throw new AutoDataCoreError(`${name} must be non-empty`, 'INVALID_RUN_REQUEST')
}

/** Adapt one validated OpenAI-style trajectory to normalized canonical content. */
function adaptOpenAiToolTrajectory(value: unknown, context: SourceAdapterContext): SourceAdapterResult {
  requireContextText(context.record_id, 'record_id')
  if (!Number.isSafeInteger(context.record_index) || context.record_index < 0 || context.record_line !== context.record_index + 1) {
    throw new AutoDataCoreError('record_index must be zero-based and record_line must equal record_index + 1', 'INVALID_RUN_REQUEST')
  }

  const findings = validateOpenAiToolTrajectory(value, context.record_line)
  const errors = findings.filter(finding => finding.severity === 'error')
  if (errors.length > 0) {
    const detail = errors.slice(0, 5).map(finding => `${finding.path}: ${finding.code}`).join('; ')
    throw new AutoDataCoreError(`source row ${String(context.record_line)} failed validation: ${detail}`, 'INVALID_RECORD')
  }
  const sourceValue = value as Record<string, unknown>
  if (sourceValue.uuid !== context.record_id) {
    throw new AutoDataCoreError(`source row ${String(context.record_line)} id changed during adaptation`, 'INVALID_RECORD')
  }
  const messages = normalizeMessages(sourceValue.messages as readonly unknown[])
  const tools = (cloneJson(sourceValue.tools, 'tools') as readonly JsonValue[]).map(tool => tool as CanonicalTool)
  return {
    messages,
    tools,
    warnings: findings.filter(finding => finding.severity === 'warning'),
  }
}

/** Built-in adapter for the frozen agent-sft OpenAI-style JSONL source. */
export const openAiToolTrajectoryAdapter: SourceAdapter = Object.freeze({
  id: OPENAI_TOOL_TRAJECTORY_ADAPTER_ID,
  version: OPENAI_TOOL_TRAJECTORY_ADAPTER_VERSION,
  identify: (value: unknown): string | null => {
    if (!isJsonObject(value)) return null
    const recordId = field(value, 'uuid')
    return typeof recordId === 'string' && recordId.length > 0 ? recordId : null
  },
  adapt: adaptOpenAiToolTrajectory,
})

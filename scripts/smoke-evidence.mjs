/** Sum the terminal usage report from every provider attempt, including failed retries. */
export function summarizeTokenUsage(events) {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
  }
  let reports = 0
  for (const event of events) {
    if (event.type !== 'assistant/chunk' || event.data.chunk.type !== 'usage') continue
    reports += 1
    usage.input_tokens += event.data.chunk.usage.inputTokens
    usage.output_tokens += event.data.chunk.usage.outputTokens
    usage.cache_read_tokens += event.data.chunk.usage.cacheReadTokens ?? 0
    usage.cache_write_tokens += event.data.chunk.usage.cacheWriteTokens ?? 0
    usage.reasoning_tokens += event.data.chunk.usage.reasoningTokens ?? 0
  }
  return Object.freeze({ reports, usage: Object.freeze(usage) })
}

/** Count retries whose backoff completed and whose provider attempt actually started. */
export function countStartedRetries(events) {
  return events.filter(event => event.type === 'llm/retry-started').length
}

/** Return only the rendered text for the last result of a named tool call. */
export function findToolResultText(events, toolName) {
  const call = events.findLast(event => event.type === 'tool/call' && event.data.name === toolName)
  if (call === undefined) return undefined
  const result = events.findLast(event => event.type === 'tool/result'
    && event.data.message.content.some(block => block.type === 'tool-result' && block.toolCallId === call.data.callId))
  const resultBlock = result?.data.message.content
    .find(block => block.type === 'tool-result' && block.toolCallId === call.data.callId)
  if (resultBlock?.type !== 'tool-result') return undefined
  const text = resultBlock.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
  return text.length === 0 ? undefined : text
}

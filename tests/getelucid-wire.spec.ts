import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

type PiAiConfig = Parameters<typeof LlmPiAi.apply>[1]

interface GetElucidConfigModule {
  readonly GETELUCID_PROVIDER: string
  readonly GETELUCID_BASE_URL: string
  readonly GETELUCID_MODEL: string
  readonly GETELUCID_API_KEY_ENV: string
  createGetElucidLlmConfig(): PiAiConfig
}

interface CapturedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

const configModuleUrl = pathToFileURL(join(process.cwd(), 'scripts/getelucid-config.mjs')).href
const configModule = await import(configModuleUrl) as GetElucidConfigModule
const contexts: Context[] = []
const previousApiKey = process.env[configModule.GETELUCID_API_KEY_ENV]

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (previousApiKey === undefined) delete process.env[configModule.GETELUCID_API_KEY_ENV]
  else process.env[configModule.GETELUCID_API_KEY_ENV] = previousApiKey
})

function responseShape(status: 'in_progress' | 'completed', output: readonly unknown[] = []): Record<string, unknown> {
  return {
    id: 'resp_autodata_wire_test',
    object: 'response',
    created_at: 1_788_134_400,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 1024,
    model: configModule.GETELUCID_MODEL,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt_cache_key: null,
    reasoning: { effort: null, summary: null },
    safety_identifier: null,
    service_tier: 'default',
    store: false,
    temperature: 1,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: 1,
    truncation: 'disabled',
    usage: status === 'completed'
      ? {
          input_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 4,
        }
      : null,
  }
}

function successfulResponsesSse(): Response {
  const message = {
    id: 'msg_autodata_wire_test',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'ok', annotations: [], logprobs: [] }],
  }
  const events = [
    { type: 'response.created', sequence_number: 0, response: responseShape('in_progress') },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 2,
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: 'ok',
      logprobs: [],
    },
    { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: message },
    { type: 'response.completed', sequence_number: 4, response: responseShape('completed', [message]) },
  ]
  const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function captureRequest(input: string | URL | Request, init?: RequestInit): Promise<CapturedRequest> {
  const request = input instanceof Request ? input : new Request(input, init)
  return {
    method: request.method,
    url: request.url,
    headers: new Headers(request.headers),
    body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
  }
}

async function streamOnce(): Promise<readonly unknown[]> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, configModule.createGetElucidLlmConfig())
  const chunks: unknown[] = []
  for await (const chunk of ctx.llm.stream({
    provider: configModule.GETELUCID_PROVIDER,
    model: configModule.GETELUCID_MODEL,
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'offline Responses wire check' }],
      source: { kind: 'user' },
    })],
    maxTokens: 1024,
    sessionId: SessionId('autodata-getelucid-wire-test'),
  })) chunks.push(chunk)
  return chunks
}

describe('GetElucid Responses wire contract', () => {
  it('uses only one POST /v1/responses request through the real DSH/pi-ai path', async () => {
    process.env[configModule.GETELUCID_API_KEY_ENV] = 'getelucid-offline-test-key'
    const originalFetch = globalThis.fetch
    const requests: CapturedRequest[] = []
    globalThis.fetch = (async (input, init) => {
      requests.push(await captureRequest(input, init))
      return successfulResponsesSse()
    }) as typeof fetch
    try {
      const chunks = await streamOnce()
      expect(chunks).toContainEqual(expect.objectContaining({
        type: 'finish',
        reason: expect.objectContaining({ kind: 'stop' }),
      }))
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requests).toHaveLength(1)
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      `POST ${configModule.GETELUCID_BASE_URL}/responses`,
    ])
    expect(requests.some(request => request.url.endsWith('/models'))).toBe(false)
    expect(requests.some(request => request.url.endsWith('/chat/completions'))).toBe(false)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer getelucid-offline-test-key')
    expect(requests[0]?.body).toMatchObject({
      model: configModule.GETELUCID_MODEL,
      stream: true,
      store: false,
      max_output_tokens: 1024,
    })
    expect(requests[0]?.body.input).toEqual([{
      role: 'user',
      content: [{ type: 'input_text', text: 'offline Responses wire check' }],
    }])
  })

  it('does not retry a retryable provider failure inside the SDK adapter', async () => {
    process.env[configModule.GETELUCID_API_KEY_ENV] = 'getelucid-offline-test-key'
    const originalFetch = globalThis.fetch
    const requests: CapturedRequest[] = []
    globalThis.fetch = (async (input, init) => {
      requests.push(await captureRequest(input, init))
      return new Response(JSON.stringify({
        error: { message: 'offline retry sentinel', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      })
    }) as typeof fetch
    try {
      const chunks = await streamOnce()
      expect(chunks).toContainEqual(expect.objectContaining({
        type: 'finish',
        reason: expect.objectContaining({ kind: 'error' }),
      }))
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: `${configModule.GETELUCID_BASE_URL}/responses`,
    })
  })
})

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

type PiAiConfig = Parameters<typeof LlmPiAi.apply>[1]
interface FreeRouterConfigModule {
  readonly FREEROUTER_PROVIDER: string
  readonly FREEROUTER_API: string
  readonly FREEROUTER_BASE_URL: string
  readonly FREEROUTER_MODEL: string
  readonly FREEROUTER_API_KEY_ENV: string
  readonly FREEROUTER_DEFAULT_SESSION_ID: string
  readonly FREEROUTER_LLM_CONFIG: PiAiConfig
  createFreerouterLlmConfig(sessionId?: string): PiAiConfig
  hasFreerouterApiKey(environment?: NodeJS.ProcessEnv): boolean
  assertFreerouterConfig(config?: unknown, expectedSessionId?: string): unknown
  assertFreerouterSmokeConfig(config?: unknown, expectedSessionId?: string): unknown
}

const configModuleUrl = pathToFileURL(join(process.cwd(), 'scripts/freerouter-config.mjs')).href
const configModule = await import(configModuleUrl) as FreeRouterConfigModule

describe('FreeRouter real-model smoke configuration', () => {
  it('pins the approved provider route without embedding a credential or auth-file path', () => {
    expect(configModule.FREEROUTER_LLM_CONFIG).toEqual({
      providers: {
        'free-router': {
          apiKeyEnv: 'FREEROUTER_API_KEY',
          api: 'openai-responses',
          baseURL: 'https://free-router.opendatalab.com/v1',
          reasoning: 'high',
          headers: { 'x-session-id': 'autodata-freerouter-smoke-agent' },
          retryPolicy: { mode: 'normal', maxRetries: 0 },
          models: [{
            id: 'gpt-5.6-sol',
            reasoningEfforts: { high: 'high' },
          }],
        },
      },
    })
    expect(configModule.assertFreerouterSmokeConfig()).toBe(configModule.FREEROUTER_LLM_CONFIG)
    const serialized = JSON.stringify(configModule.FREEROUTER_LLM_CONFIG)
    expect(serialized).not.toMatch(/auth\.json|apiKey["']?\s*:/iu)
  })

  it('binds one validated run-scoped session header and disables provider retries', () => {
    const sessionId = 'autodata-generation-bfcl-v4-run-01'
    const config = configModule.createFreerouterLlmConfig(sessionId)
    expect(configModule.assertFreerouterConfig(config, sessionId)).toBe(config)
    expect(config.providers?.['free-router']).toMatchObject({
      headers: { 'x-session-id': sessionId },
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    })
    expect(() => configModule.createFreerouterLlmConfig('bad\r\nsession')).toThrow(/session id/iu)
    expect(() => configModule.assertFreerouterConfig(config, 'another-session')).toThrow(/x-session-id/iu)
  })

  it('rejects route drift and inline credential fields', () => {
    const approvedRoute = configModule.FREEROUTER_LLM_CONFIG.providers?.['free-router']
    expect(approvedRoute).toBeDefined()
    expect(() => configModule.assertFreerouterSmokeConfig({
      providers: {
        'free-router': {
          ...approvedRoute,
          apiKey: 'must-not-be-inline',
        },
      },
    })).toThrow(/exactly/iu)
    expect(() => configModule.assertFreerouterSmokeConfig({
      providers: {
        'free-router': {
          ...approvedRoute,
          baseURL: 'https://example.invalid/v1',
        },
      },
    })).toThrow(/baseURL/iu)
  })

  it('treats a missing or blank environment value as unavailable', () => {
    expect(configModule.hasFreerouterApiKey({})).toBe(false)
    expect(configModule.hasFreerouterApiKey({ FREEROUTER_API_KEY: '   ' })).toBe(false)
    expect(configModule.hasFreerouterApiKey({ FREEROUTER_API_KEY: 'present' })).toBe(true)
  })

  it('is accepted by the DSH pi-ai adapter without making a network request', async () => {
    const ctx = new Context()
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      throw new Error('offline config test attempted a network request')
    }) as typeof fetch
    try {
      await ctx.plugin(LlmRuntime)
      const llmConfig = configModule.createFreerouterLlmConfig()
      expect(configModule.assertFreerouterSmokeConfig(llmConfig)).toBe(llmConfig)
      await ctx.plugin(LlmPiAi, llmConfig)
      expect(ctx.llm.listProviders()).toEqual([{ id: 'free-router', name: 'free-router' }])
    } finally {
      try {
        await ctx.fiber.dispose()
      } finally {
        globalThis.fetch = originalFetch
      }
    }
    expect(requests).toBe(0)
  })

  it('sends the run-scoped x-session-id on the Responses wire request', async () => {
    const ctx = new Context()
    const sessionId = 'autodata-generation-bfcl-v4-wire-test'
    const originalFetch = globalThis.fetch
    const previousKey = process.env.FREEROUTER_API_KEY
    let request: Request | undefined
    process.env.FREEROUTER_API_KEY = 'freerouter-test-secret'
    const captureFetch: typeof fetch = async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init)
      return new Response(JSON.stringify({ error: { message: 'offline wire test' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    globalThis.fetch = captureFetch
    try {
      await ctx.plugin(LlmRuntime)
      const config = configModule.createFreerouterLlmConfig(sessionId)
      expect(configModule.assertFreerouterConfig(config, sessionId)).toBe(config)
      await ctx.plugin(LlmPiAi, config)
      for await (const _chunk of ctx.llm.stream({
        provider: 'free-router',
        model: 'gpt-5.6-sol',
        reasoningEffort: ReasoningEffortId('high'),
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'offline header check' }],
          source: { kind: 'user' },
        })],
        maxTokens: 1024,
        sessionId: SessionId(sessionId),
      })) { /* drain the terminal error chunk */ }
    } finally {
      try {
        await ctx.fiber.dispose()
      } finally {
        globalThis.fetch = originalFetch
        if (previousKey === undefined) delete process.env.FREEROUTER_API_KEY
        else process.env.FREEROUTER_API_KEY = previousKey
      }
    }
    expect(request).toBeDefined()
    expect(request?.url).toBe('https://free-router.opendatalab.com/v1/responses')
    expect(request?.headers.get('x-session-id')).toBe(sessionId)
    const body = JSON.parse(await request!.clone().text()) as Record<string, unknown>
    expect(body.prompt_cache_key).toBe(sessionId)
  })

  it('skips before loading the Agent stack when the key is absent', () => {
    const environment = { ...process.env }
    delete environment.FREEROUTER_API_KEY
    const output = execFileSync(process.execPath, ['scripts/freerouter-agent-smoke.mjs'], {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
    })
    expect(output).toBe('FreeRouter smoke skipped: FREEROUTER_API_KEY is not set; no network request was made.\n')
  })
})

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

type PiAiConfig = Parameters<typeof LlmPiAi.apply>[1]
interface GetElucidConfigModule {
  readonly GETELUCID_LLM_CONFIG: PiAiConfig
  createGetElucidLlmConfig(): PiAiConfig
  hasGetElucidApiKey(environment?: NodeJS.ProcessEnv): boolean
  assertGetElucidConfig(config?: unknown): unknown
}

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/getelucid-config.mjs')).href
const configModule = await import(moduleUrl) as GetElucidConfigModule

describe('GetElucid Stage 4C configuration', () => {
  it('pins the one Responses route without embedding a credential', () => {
    expect(configModule.GETELUCID_LLM_CONFIG).toEqual({
      providers: {
        getelucid: {
          apiKeyEnv: 'GETELUCID_API_KEY',
          api: 'openai-responses',
          baseURL: 'https://hk.getelucid.com/v1',
          retryPolicy: { mode: 'normal', maxRetries: 0 },
          models: [{ id: 'gpt-5.6-sol' }],
        },
      },
    })
    expect(configModule.assertGetElucidConfig()).toBe(configModule.GETELUCID_LLM_CONFIG)
    expect(JSON.stringify(configModule.GETELUCID_LLM_CONFIG)).not.toMatch(/apiKey["']?\s*:/u)
  })

  it('rejects route drift and resolves only the named environment credential', () => {
    const route = configModule.GETELUCID_LLM_CONFIG.providers?.getelucid
    expect(() => configModule.assertGetElucidConfig({
      providers: { getelucid: { ...route, baseURL: 'https://example.invalid/v1' } },
    })).toThrow(/baseURL/iu)
    expect(configModule.hasGetElucidApiKey({})).toBe(false)
    expect(configModule.hasGetElucidApiKey({ GETELUCID_API_KEY: '  ' })).toBe(false)
    expect(configModule.hasGetElucidApiKey({ GETELUCID_API_KEY: 'fixture' })).toBe(true)
  })

  it('loads into the DSH adapter without model discovery or any network request', async () => {
    const ctx = new Context()
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      throw new Error('offline configuration test attempted network access')
    }) as typeof fetch
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, configModule.createGetElucidLlmConfig())
      expect(ctx.llm.listProviders()).toEqual([{ id: 'getelucid', name: 'getelucid' }])
    } finally {
      try { await ctx.fiber.dispose() } finally { globalThis.fetch = originalFetch }
    }
    expect(requests).toBe(0)
  })
})

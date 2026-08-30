import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

type PiAiConfig = Parameters<typeof LlmPiAi.apply>[1]
interface PjlabConfigModule {
  readonly PJLAB_PROVIDER: string
  readonly PJLAB_API: string
  readonly PJLAB_BASE_URL: string
  readonly PJLAB_MODEL: string
  readonly PJLAB_API_KEY_ENV: string
  readonly PJLAB_LLM_CONFIG: PiAiConfig
  createPjlabLlmConfig(): PiAiConfig
  hasPjlabApiKey(environment?: NodeJS.ProcessEnv): boolean
  assertPjlabConfig(config?: unknown): unknown
}

const configModuleUrl = pathToFileURL(join(process.cwd(), 'scripts/pjlab-config.mjs')).href
const configModule = await import(configModuleUrl) as PjlabConfigModule

describe('PJLAB Stage 4C model configuration', () => {
  it('pins the approved OpenAI-compatible route without embedding a credential', () => {
    expect(configModule.PJLAB_LLM_CONFIG).toEqual({
      providers: {
        pjlab: {
          apiKeyEnv: 'PJLAB_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://token.pjlab.org.cn/v1',
          defaultContextWindow: 1_048_576,
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsUsageInStreaming: false,
            maxTokensField: 'max_tokens',
            supportsStrictMode: false,
          },
          models: [{ id: 'glm-5.3-flash' }],
        },
      },
    })
    expect(configModule.assertPjlabConfig()).toBe(configModule.PJLAB_LLM_CONFIG)
    expect(JSON.stringify(configModule.PJLAB_LLM_CONFIG)).not.toMatch(/apiKey["']?\s*:/u)
  })

  it('rejects route drift and inline credentials', () => {
    const approvedRoute = configModule.PJLAB_LLM_CONFIG.providers?.pjlab
    expect(approvedRoute).toBeDefined()
    expect(() => configModule.assertPjlabConfig({
      providers: { pjlab: { ...approvedRoute, apiKey: 'must-not-be-inline' } },
    })).toThrow(/exactly/iu)
    expect(() => configModule.assertPjlabConfig({
      providers: { pjlab: { ...approvedRoute, baseURL: 'https://example.invalid/v1' } },
    })).toThrow(/baseURL/iu)
  })

  it('treats a missing or blank environment value as unavailable', () => {
    expect(configModule.hasPjlabApiKey({})).toBe(false)
    expect(configModule.hasPjlabApiKey({ PJLAB_API_KEY: '   ' })).toBe(false)
    expect(configModule.hasPjlabApiKey({ PJLAB_API_KEY: 'present' })).toBe(true)
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
      const llmConfig = configModule.createPjlabLlmConfig()
      expect(configModule.assertPjlabConfig(llmConfig)).toBe(llmConfig)
      await ctx.plugin(LlmPiAi, llmConfig)
      expect(ctx.llm.listProviders()).toEqual([{ id: 'pjlab', name: 'pjlab' }])
      expect(await ctx.llm.resolveModelInfo('pjlab', 'glm-5.3-flash')).toMatchObject({
        context: { contextWindow: 1_048_576 },
      })
    } finally {
      try {
        await ctx.fiber.dispose()
      } finally {
        globalThis.fetch = originalFetch
      }
    }
    expect(requests).toBe(0)
  })

  it('skips before loading the Agent stack when the key is absent', () => {
    const environment = { ...process.env }
    delete environment.PJLAB_API_KEY
    const output = execFileSync(process.execPath, ['scripts/pjlab-agent-smoke.mjs'], {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
    })
    expect(output).toBe('PJLAB smoke skipped: PJLAB_API_KEY is not set; no network request was made.\n')
  })
})

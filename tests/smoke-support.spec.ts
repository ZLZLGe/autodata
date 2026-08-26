import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const scripts = (name: string) => pathToFileURL(join(process.cwd(), 'scripts', name)).href

interface EvidenceModule {
  countStartedRetries(events: readonly unknown[]): number
  findToolResultText(events: readonly unknown[], toolName: string): string | undefined
  summarizeTokenUsage(events: readonly unknown[]): {
    reports: number
    usage: Record<string, number>
  }
}

interface ProxyModule {
  hasEnvironmentProxy(environment?: Record<string, string | undefined>): boolean
  installEnvironmentProxy(
    environment?: Record<string, string | undefined>,
    loadUndici?: () => Promise<unknown>,
  ): Promise<undefined | (() => Promise<void>)>
}

const evidence = await import(scripts('smoke-evidence.mjs')) as EvidenceModule
const proxy = await import(scripts('smoke-proxy.mjs')) as ProxyModule

describe('FreeRouter smoke evidence', () => {
  it('sums usage across successful and failed provider attempts', () => {
    const events = [
      { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } } },
      { type: 'llm/retry', data: {} },
      { type: 'llm/retry-started', data: {} },
      { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 4,
        reasoningTokens: 1,
      } } } },
    ]
    expect(evidence.summarizeTokenUsage(events)).toEqual({
      reports: 2,
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        cache_read_tokens: 2,
        cache_write_tokens: 4,
        reasoning_tokens: 1,
      },
    })
    expect(evidence.countStartedRetries(events)).toBe(1)
  })

  it('extracts only the rendered text for the selected tool result', () => {
    const events = [
      { type: 'tool/call', data: { callId: 'call-status', name: 'status', arguments: '{}' } },
      { type: 'tool/call', data: { callId: 'call-submit', name: 'submit', arguments: '{"secret":"ignored"}' } },
      { type: 'tool/result', data: { message: { content: [{
        type: 'tool-result',
        toolCallId: 'call-submit',
        content: [{ type: 'text', text: 'candidate rejected: wrong plugin id' }],
      }] } } },
    ]
    expect(evidence.findToolResultText(events, 'submit')).toBe('candidate rejected: wrong plugin id')
    expect(evidence.findToolResultText(events, 'missing')).toBeUndefined()
  })
})

describe('FreeRouter smoke environment proxy', () => {
  it('does not load undici when no proxy is configured', async () => {
    const load = vi.fn()
    expect(proxy.hasEnvironmentProxy({ HTTPS_PROXY: '  ' })).toBe(false)
    expect(proxy.hasEnvironmentProxy({ HTTPS_PROXY: 'https://ignored', https_proxy: '' })).toBe(false)
    await expect(proxy.installEnvironmentProxy({}, load)).resolves.toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })

  it('installs, restores, closes, and only disposes once', async () => {
    const previous = { id: 'previous' }
    const close = vi.fn(async () => undefined)
    const dispatcher = { close }
    const EnvHttpProxyAgent = vi.fn(function (this: unknown) { return dispatcher })
    const getGlobalDispatcher = vi.fn(() => previous)
    const setGlobalDispatcher = vi.fn()
    const dispose = await proxy.installEnvironmentProxy({
      http_proxy: 'http://proxy.invalid',
      NO_PROXY: 'localhost',
    }, async () => ({ EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher }))

    expect(EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://proxy.invalid',
      noProxy: 'localhost',
    })
    expect(setGlobalDispatcher).toHaveBeenNthCalledWith(1, dispatcher)
    await dispose?.()
    await dispose?.()
    expect(setGlobalDispatcher).toHaveBeenNthCalledWith(2, previous)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

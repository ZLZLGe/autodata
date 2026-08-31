import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const scriptUrl = (name: string) => pathToFileURL(join(process.cwd(), 'scripts', name)).href

interface ProxyModule {
  hasEnvironmentProxy(environment?: Record<string, string | undefined>): boolean
  installEnvironmentProxy(
    environment?: Record<string, string | undefined>,
    loadUndici?: () => Promise<unknown>,
  ): Promise<undefined | (() => Promise<void>)>
}

const proxy = await import(scriptUrl('provider-proxy.mjs')) as ProxyModule

describe('provider environment proxy', () => {
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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface DiagnosticModule {
  readonly STAGE4C_FREEROUTER_DIAGNOSTIC_CLAIM: string
  readonly STAGE4C_FREEROUTER_DIAGNOSTIC_RESULT: string
  runOneShotDiagnostic(options: {
    readonly root: string
    readonly executionCommit: string
    readonly perform: () => Promise<Record<string, unknown>>
    readonly now?: () => Date
  }): Promise<Readonly<Record<string, unknown>>>
  readOneShotDiagnostic(root: string): Readonly<Record<string, unknown>>
  installOneShotProviderFetchGate(): {
    attempts(): number
    calls(): number
    dispose(): void
  }
}

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/stage4c-freerouter-diagnostic.mjs')).href
const diagnostic = await import(moduleUrl) as DiagnosticModule
const roots: string[] = []
const commit = 'a'.repeat(40)

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'autodata-freerouter-diagnostic-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('Stage 4C one-shot FreeRouter diagnostic', () => {
  it('transmits at most one request on the exact approved route', async () => {
    const originalFetch = globalThis.fetch
    let transmitted = 0
    globalThis.fetch = (async (input) => {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.redirect).toBe('error')
      transmitted += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const gate = diagnostic.installOneShotProviderFetchGate()
    const request = new Request('https://free-router.opendatalab.com/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': 'autodata-stage4c-freerouter-02-diagnostic' },
      body: '{}',
    })
    try {
      await globalThis.fetch(request.clone())
      await expect(globalThis.fetch(request.clone())).rejects.toThrow(/excess provider request/iu)
      expect(transmitted).toBe(1)
      expect(gate.attempts()).toBe(1)
      expect(gate.calls()).toBe(2)
    } finally {
      gate.dispose()
      globalThis.fetch = originalFetch
    }
  })

  it('publishes one immutable claim and one successful result', async () => {
    const directory = root()
    let calls = 0
    const result = await diagnostic.runOneShotDiagnostic({
      root: directory,
      executionCommit: commit,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
      perform: async () => {
        calls += 1
        return {
          status: 'passed',
          response: 'OK',
          provider_attempts: 1,
          provider_retries: 0,
          agent_loop_sse_verified: true,
          token_usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
    })
    expect(calls).toBe(1)
    expect(result).toMatchObject({
      claim: { execution_commit: commit, max_provider_requests: 1, provider_retry_max: 0 },
      result: { status: 'passed', provider_attempts: 1, provider_retries: 0, candidate_created: false },
    })
    expect(diagnostic.readOneShotDiagnostic(directory)).toEqual(result)

    await expect(diagnostic.runOneShotDiagnostic({
      root: directory,
      executionCommit: commit,
      perform: async () => {
        calls += 1
        return { status: 'passed' }
      },
    })).rejects.toThrow(/already consumed/iu)
    expect(calls).toBe(1)
  })

  it('consumes the slot and stores a redacted terminal result on failure', async () => {
    const directory = root()
    const previous = process.env.FREEROUTER_API_KEY
    process.env.FREEROUTER_API_KEY = 'freerouter-test-secret'
    try {
      await expect(diagnostic.runOneShotDiagnostic({
        root: directory,
        executionCommit: commit,
        perform: async () => { throw new Error('Bearer freerouter-test-secret failed') },
      })).rejects.toThrow()
    } finally {
      if (previous === undefined) delete process.env.FREEROUTER_API_KEY
      else process.env.FREEROUTER_API_KEY = previous
    }
    const status = diagnostic.readOneShotDiagnostic(directory) as {
      result: { status: string, error: string }
    }
    expect(status.result.status).toBe('failed')
    expect(status.result.error).toContain('[REDACTED]')
    expect(status.result.error).not.toContain('freerouter-test-secret')
  })

  it('rejects a result whose immutable claim hash was changed', async () => {
    const directory = root()
    await diagnostic.runOneShotDiagnostic({
      root: directory,
      executionCommit: commit,
      perform: async () => ({
        status: 'passed',
        response: 'OK',
        provider_attempts: 1,
        provider_retries: 0,
        agent_loop_sse_verified: true,
        token_usage: {},
      }),
    })
    const resultPath = join(directory, diagnostic.STAGE4C_FREEROUTER_DIAGNOSTIC_RESULT)
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
    writeFileSync(resultPath, `${JSON.stringify({ ...result, claim_sha256: '0'.repeat(64) }, null, 2)}\n`)
    expect(() => diagnostic.readOneShotDiagnostic(directory)).toThrow(/does not match/iu)
  })
})

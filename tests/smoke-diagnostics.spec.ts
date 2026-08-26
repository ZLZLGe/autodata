import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface SmokeDiagnosticsModule {
  diagnostic(error: unknown, secrets?: readonly unknown[]): string
  formatTurnEndReason(reason: unknown, secrets?: readonly unknown[]): string
  sanitizeDiagnosticText(value: unknown, secrets?: readonly unknown[]): string
}

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/smoke-diagnostics.mjs')).href
const diagnostics = await import(moduleUrl) as SmokeDiagnosticsModule

describe('FreeRouter smoke diagnostics', () => {
  it('reports completed and missing turn outcomes without inspecting other event data', () => {
    expect(diagnostics.formatTurnEndReason({ kind: 'completed' })).toBe('completed')
    expect(diagnostics.formatTurnEndReason(undefined)).toBe('missing')
    expect(diagnostics.formatTurnEndReason({})).toBe('missing')
  })

  it('reports only the structured failure code and message', () => {
    expect(diagnostics.formatTurnEndReason({
      kind: 'error',
      error: {
        code: 'RATE_LIMIT',
        message: 'Too many requests; retry later',
        status: 429,
        requestId: 'must-not-be-printed',
      },
      headers: { authorization: 'must-not-be-printed' },
    })).toBe('error(code=RATE_LIMIT, message=Too many requests; retry later)')
    expect(diagnostics.formatTurnEndReason({ kind: 'error' })).toBe(
      'error(code=UNKNOWN, message=LLM request failed without a message)',
    )
  })

  it('redacts configured and conventionally formatted credentials', () => {
    const secret = 'freerouter-test-secret'
    const text = diagnostics.formatTurnEndReason({
      kind: 'error',
      error: {
        code: 'AUTH',
        message: `request used ${secret}\nAuthorization: Bearer another-secret`,
      },
    }, [secret])
    expect(text).toBe('error(code=AUTH, message=request used [REDACTED] Authorization: [REDACTED])')
    expect(text).not.toContain(secret)
    expect(text).not.toContain('another-secret')
    expect(diagnostics.sanitizeDiagnosticText(
      '{"authorization":"Bearer json-secret","x-api-key":"other-secret"}',
    )).toBe('{"authorization":[REDACTED],"x-api-key":[REDACTED]}')
  })

  it('does not read unrelated error or event metadata', () => {
    const reason = {
      kind: 'error',
      error: { code: 'BAD\nCODE', message: '\u001B[31mnetwork failed\u001B[0m' },
      get headers(): never { throw new Error('headers getter must not run') },
      get config(): never { throw new Error('config getter must not run') },
    }
    expect(diagnostics.formatTurnEndReason(reason)).toBe(
      'error(code=UNKNOWN, message=network failed)',
    )
  })

  it('applies the same redaction to caught and aggregate errors', () => {
    const error = new AggregateError([
      new Error('api_key=first-secret'),
      new Error('failed with Bearer second-secret'),
    ], 'combined')
    expect(diagnostics.diagnostic(error)).toBe(
      'api_key=[REDACTED]; failed with Bearer [REDACTED]',
    )
    expect(diagnostics.diagnostic(new AggregateError([
      new Error('x'.repeat(2_000)),
      new Error('y'.repeat(2_000)),
    ]))).toHaveLength(2_003)
  })
})

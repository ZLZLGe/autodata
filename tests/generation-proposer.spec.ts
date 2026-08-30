import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DshGenerationProposer,
  GENERATION_MODEL,
  GENERATION_PROVIDER,
  formatProposalTurnEndFailure,
} from '../src/generation/proposer.js'

afterEach(() => vi.unstubAllEnvs())

describe('generation proposal Agent diagnostics', () => {
  it('pins the formal Stage 4C proposer to the approved PJLAB route', () => {
    expect(GENERATION_PROVIDER).toBe('pjlab')
    expect(GENERATION_MODEL).toBe('glm-5.3-flash')
  })

  it('preserves the bounded provider code and message needed for infrastructure diagnosis', () => {
    expect(formatProposalTurnEndFailure({
      kind: 'error',
      error: {
        code: 'PI_AI_ERROR',
        message: 'OpenAI API error (456): session_id_required',
      },
    })).toBe('kind=error, code=PI_AI_ERROR, message=OpenAI API error (456): session_id_required')
  })

  it('redacts credentials and handles non-error terminal reasons', () => {
    expect(formatProposalTurnEndFailure({
      kind: 'error',
      error: {
        code: 'BAD KEY!',
        message: 'Authorization: Bearer secret-value\napi_key=other-secret',
      },
    })).toBe('kind=error, code=UNKNOWN, message=Authorization: [REDACTED] api_key=[REDACTED]')
    expect(formatProposalTurnEndFailure({ kind: 'aborted' })).toBe('kind=aborted')
    expect(formatProposalTurnEndFailure(undefined)).toBe('kind=missing')
  })

  it('redacts exact environment credentials even when the provider echoes them without a label', () => {
    expect(formatProposalTurnEndFailure({
      kind: 'error',
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: 'Incorrect API key provided: opaque-provider-secret',
      },
    }, ['opaque-provider-secret'])).toBe(
      'kind=error, code=AUTHENTICATION_ERROR, message=Incorrect API key provided: [REDACTED]',
    )
    expect(formatProposalTurnEndFailure({
      kind: 'error',
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: 'Incorrect API key provided: sk-example12345678',
      },
    }, [])).toContain('provided: [REDACTED]')
    expect(formatProposalTurnEndFailure({
      kind: 'error',
      error: {
        code: 'opaque-provider-secret',
        message: 'Authentication failed',
      },
    }, ['opaque-provider-secret'])).toContain('code=REDACTED')
    expect(formatProposalTurnEndFailure({
      kind: 'error',
      error: {
        code: 'sk-example12345678',
        message: 'Authentication failed',
      },
    }, [])).toContain('code=REDACTED')
  })

  it('redacts trimmed API keys and decoded proxy credentials derived from the environment', () => {
    vi.stubEnv('PJLAB_API_KEY', '  opaque-trimmed-provider-secret  ')
    vi.stubEnv('HTTPS_PROXY', 'http://proxy-user:proxy%2Dpassword@example.invalid:8080')
    const result = formatProposalTurnEndFailure({
      kind: 'error',
      error: {
        code: 'UPSTREAM',
        message: 'key=opaque-trimmed-provider-secret password=proxy-password user=proxy-user',
      },
    })
    expect(result).toBe('kind=error, code=UPSTREAM, message=key=[REDACTED] password=[REDACTED] user=[REDACTED]')
  })

  it('bounds untrusted provider messages', () => {
    const result = formatProposalTurnEndFailure({
      kind: 'error',
      error: { code: 'UPSTREAM', message: 'x'.repeat(2_000) },
    })
    expect(result).toHaveLength('kind=error, code=UPSTREAM, message='.length + 1_003)
    expect(result).toMatch(/\.\.\.$/u)
  })

  it('redacts provider credentials from Agent creation and turn promise rejections', async () => {
    const credential = 'sk-example-provider-secret'
    const providerError = () => Object.assign(new Error(`upstream echoed ${credential}`), { code: credential })
    const abort = new AbortController()
    const rejectingCreate = new DshGenerationProposer({
      get: () => ({ create: async () => { throw providerError() } }),
    } as unknown as Context)
    await expect(rejectingCreate.create('bfcl-v4', 'run-create', abort.signal)).rejects.toSatisfy((error: unknown) => (
      error instanceof Error
      && error.message.includes('code=REDACTED')
      && error.message.includes('[REDACTED]')
      && !error.message.includes(credential)
      && error.cause === undefined
    ))

    const rejectingTurn = new DshGenerationProposer({
      get: () => ({
        create: async () => ({
          agent: {
            status: 'idle',
            session: { events: [] },
            followup: () => undefined,
            whenIdle: async () => { throw providerError() },
            cancel: () => undefined,
          },
          dispose: async () => undefined,
        }),
      }),
    } as unknown as Context)
    const session = await rejectingTurn.create('bfcl-v4', 'run-turn', abort.signal)
    await expect(session.propose({
      attempt: 1,
      max_attempts: 3,
      context: {
        profile_id: 'bfcl-v4',
        benchmark: 'bfcl-v4',
        strategy_plugin_id: 'bfcl-v4-strategy',
        strategy_version: '1',
        generation: 1,
        seed: 42,
        allowed_capabilities: ['data-select'],
        b_search: { summary: 'fixture', metrics: {}, failures: [] },
        source_pool: { canonical_records: 0, canonical_jsonl_sha256: '0'.repeat(64), records: [] },
      },
    }, abort.signal)).rejects.toSatisfy((error: unknown) => (
      error instanceof Error
      && error.message.includes('code=REDACTED')
      && error.message.includes('[REDACTED]')
      && !error.message.includes(credential)
      && error.cause === undefined
    ))
  })
})

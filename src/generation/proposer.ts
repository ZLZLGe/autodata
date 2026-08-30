import type { Context } from '@deepseek-ai/cordis'
import { MAX_HOST_SOURCE_BYTES } from '../evolution/types.js'
import type { EvolutionRuntimeAgent } from '../evolution/runtime.js'
import { isJsonObject, parseStrictJsonObject } from '../core/json.js'
import {
  GenerationError,
  type GenerationDraft,
  type GenerationDraftRequest,
  type GenerationProposalSession,
  type GenerationProposer,
} from './types.js'

export const GENERATION_PROVIDER = 'pjlab'
export const GENERATION_MODEL = 'glm-5.3-flash'
const DEFAULT_MAX_TOKENS = 16_384
const MAX_PROVIDER_DIAGNOSTIC_CHARS = 1_000

interface DshAgentHandle {
  readonly agent: EvolutionRuntimeAgent & {
    readonly status: string
    readonly session: { readonly events: readonly unknown[] }
    followup(message: unknown): void
    whenIdle(): Promise<void>
    cancel(cause: { readonly kind: 'hook'; readonly reason: string }): void
  }
  dispose(): Promise<void>
}

interface DshAgentRegistry {
  create(options: {
    readonly sessionId: unknown
    readonly agentOptions: {
      readonly provider: string
      readonly model: string
      readonly maxTokens: number
    }
    readonly setup?: (agentContext: Context) => void
  }): Promise<DshAgentHandle>
}

export interface DshGenerationProposerOptions {
  readonly provider?: string
  readonly model?: string
  readonly max_tokens?: number
}

/** Real DSH Agent proposal driver. Drafts remain process-local until the Host accepts one. */
export class DshGenerationProposer implements GenerationProposer {
  private readonly provider: string
  private readonly model: string
  private readonly maxTokens: number

  constructor(private readonly ctx: Context, options: DshGenerationProposerOptions = {}) {
    this.provider = options.provider ?? GENERATION_PROVIDER
    this.model = options.model ?? GENERATION_MODEL
    this.maxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS
    if (!Number.isSafeInteger(this.maxTokens) || this.maxTokens < 1024) {
      throw new GenerationError('generation proposer max_tokens must be a safe integer >= 1024', 'INVALID_REQUEST')
    }
  }

  async create(profileId: string, runId: string, signal: AbortSignal): Promise<GenerationProposalSession> {
    if (signal.aborted) throw new GenerationError('candidate proposal was cancelled', 'CANCEL_FAILED')
    const registry = this.ctx.get('agents', false) as DshAgentRegistry | undefined
    if (registry === undefined || typeof registry.create !== 'function') {
      throw new GenerationError('DSH Agent registry/loop is unavailable', 'DEPENDENCY_UNAVAILABLE')
    }
    let createUserMessage: (input: unknown) => unknown
    let SessionId: (value: string) => unknown
    try {
      const llm = await import('@deepseek-ai/dsh-llm')
      createUserMessage = input => llm.createUserMessage(input as never)
      ;({ SessionId } = await import('@deepseek-ai/dsh-session'))
    } catch (error) {
      throw new GenerationError('DSH Agent message runtime is unavailable', 'DEPENDENCY_UNAVAILABLE', { cause: error })
    }
    const sessionId = SessionId(`autodata-generation-${profileId}-${runId}`)
    let handle: DshAgentHandle
    try {
      handle = await registry.create({
        sessionId,
        agentOptions: {
          provider: this.provider,
          model: this.model,
          maxTokens: this.maxTokens,
        },
        setup: agentContext => {
          // The proposal turn is deliberately tool-free. It receives only the
          // frozen B_search evidence embedded by the Host below.
          const tools = agentContext.get('tools', false) as {
            schemas(scope?: unknown): readonly { readonly name: string }[]
            restrict(filter: { readonly deny: readonly string[] }): () => void
          } | undefined
          const names = tools?.schemas().map(schema => schema.name) ?? []
          if (names.length > 0) tools?.restrict({ deny: names })
          const prompt = agentContext.get('systemPrompt', false) as {
            section(value: { readonly name: string; readonly order: number; readonly text: string }): () => void
          } | undefined
          prompt?.section({
            name: 'autodata:generation',
            order: 1,
            text: 'You are the AutoData Evolver. Produce only the requested strict JSON object. Never call tools and never reveal or infer B_dev/B_test information.',
          })
        },
      })
    } catch (error) {
      if (signal.aborted) throw new GenerationError('candidate proposal was cancelled', 'CANCEL_FAILED')
      throw providerBoundaryError('proposal Agent creation failed', error)
    }
    return new DshProposalSession(handle, createUserMessage)
  }
}

class DshProposalSession implements GenerationProposalSession {
  readonly agent: EvolutionRuntimeAgent
  private disposed = false
  private lastEventCount = 0

  constructor(
    private readonly handle: DshAgentHandle,
    private readonly createUserMessage: (input: unknown) => unknown,
  ) {
    this.agent = handle.agent
  }

  async propose(request: GenerationDraftRequest, signal: AbortSignal): Promise<GenerationDraft> {
    if (this.disposed) throw new GenerationError('candidate proposal session is disposed', 'DEPENDENCY_UNAVAILABLE')
    if (signal.aborted) throw new GenerationError('candidate proposal was cancelled', 'CANCEL_FAILED')
    const start = this.handle.agent.session.events.length
    const prompt = proposalPrompt(request)
    const abort = () => this.handle.agent.cancel({ kind: 'hook', reason: 'AutoData generation cancelled' })
    signal.addEventListener('abort', abort, { once: true })
    try {
      try {
        this.handle.agent.followup(this.createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        }))
        await this.handle.agent.whenIdle()
      } catch (error) {
        if (signal.aborted) throw new GenerationError('candidate proposal was cancelled', 'CANCEL_FAILED')
        throw providerBoundaryError('proposal Agent turn failed', error)
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
    if (signal.aborted) throw new GenerationError('candidate proposal was cancelled', 'CANCEL_FAILED')
    const events = this.handle.agent.session.events.slice(Math.max(start, this.lastEventCount))
    this.lastEventCount = this.handle.agent.session.events.length
    return parseAgentDraft(events)
  }

  cancel(reason = 'AutoData generation cancelled'): void {
    if (!this.disposed) this.handle.agent.cancel({ kind: 'hook', reason })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.handle.dispose()
  }
}

function proposalPrompt(request: GenerationDraftRequest): string {
  const repair = request.previous_failure === undefined
    ? 'This is the first draft.'
    : `The previous ephemeral draft failed this Host gate:\n${request.previous_failure}\nRepair that issue; do not repeat it.`
  return [
    `Create ephemeral AutoData DataPlugin draft ${String(request.attempt)} of at most ${String(request.max_attempts)}.`,
    repair,
    'The only evidence you may use is the following Host-provided B_search diagnosis and frozen H0 training-pool inventory. There is deliberately no B_dev or B_test evidence:',
    JSON.stringify(request.context),
    '',
    'Return exactly one JSON object with exactly two string fields: {"host_source":"...","description":"..."}. No Markdown fence, commentary, tool call, or extra key.',
    `host_source must be a synchronous JavaScript function body returning a plain Cordis Host plugin with only inject, apply, and optional name fields. It must declare inject: ['autodata']; apply(ctx) may use only ctx.autodata.register, must call it exactly once, and must register a plain DataPlugin containing exactly id ${JSON.stringify(request.context.strategy_plugin_id)}, version ${JSON.stringify(request.context.strategy_version)}, and run.`,
    'The DataPlugin run(input, context) must deterministically return an array of {record_id,note?} decisions selecting, filtering, or ordering only IDs already present in input. It must not generate or modify records, register tools, access files/network/environment/time/randomness, retain mutable state, or depend on anything outside its arguments.',
    'Use the B_search failures to choose a defensible training-data selection/order strategy. Keep at least one record. Keep source concise and self-contained.',
  ].join('\n')
}

function parseAgentDraft(events: readonly unknown[]): GenerationDraft {
  const eventObjects = events.filter(isJsonObject)
  const turnEnd = [...eventObjects].reverse().find(event => event.type === 'turn/end')
  if (!isJsonObject(turnEnd) || !isJsonObject(turnEnd.data) || !isJsonObject(turnEnd.data.reason) || turnEnd.data.reason.kind !== 'completed') {
    const reason = isJsonObject(turnEnd) && isJsonObject(turnEnd.data) ? turnEnd.data.reason : undefined
    throw new GenerationError(
      `proposal Agent turn did not complete (${formatProposalTurnEndFailure(reason)})`,
      'PROPOSAL_FAILED',
    )
  }
  const turn = turnEnd.data.turn
  if (eventObjects.some(event => event.type === 'tool/call' && isJsonObject(event.data) && event.data.turn === turn)) {
    throw new GenerationError('proposal Agent attempted a tool call', 'PROPOSAL_FAILED')
  }
  const messageEvent = [...eventObjects].reverse().find(event =>
    event.type === 'assistant/message'
    && isJsonObject(event.data)
    && event.data.turn === turn)
  if (!isJsonObject(messageEvent) || !isJsonObject(messageEvent.data) || !isJsonObject(messageEvent.data.message)) {
    throw new GenerationError('proposal Agent produced no assistant message', 'PROPOSAL_FAILED')
  }
  const content = messageEvent.data.message.content
  if (!Array.isArray(content)) throw new GenerationError('proposal Agent message content is invalid', 'PROPOSAL_FAILED')
  const text = content.filter(isJsonObject)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
    .trim()
  let value: Record<string, unknown>
  try {
    value = parseStrictJsonObject(text, 'proposal Agent response')
  } catch (error) {
    throw new GenerationError('proposal Agent response is not one strict JSON object', 'PROPOSAL_FAILED', { cause: error })
  }
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'host_source') || !Object.hasOwn(value, 'description')) {
    throw new GenerationError('proposal Agent response must contain exactly host_source and description', 'PROPOSAL_FAILED')
  }
  if (typeof value.host_source !== 'string' || value.host_source.trim().length === 0) {
    throw new GenerationError('proposal Agent host_source must be a non-empty string', 'PROPOSAL_FAILED')
  }
  if (Buffer.byteLength(value.host_source, 'utf8') > MAX_HOST_SOURCE_BYTES) {
    throw new GenerationError('proposal Agent host_source exceeds 256 KiB', 'PROPOSAL_FAILED')
  }
  if (typeof value.description !== 'string' || value.description.trim().length === 0 || value.description.length > 2_000) {
    throw new GenerationError('proposal Agent description must contain 1-2000 characters', 'PROPOSAL_FAILED')
  }
  return Object.freeze({ host_source: value.host_source, description: value.description })
}

/** Render only the bounded, credential-redacted reason needed to diagnose a failed proposal turn. */
export function formatProposalTurnEndFailure(
  reason: unknown,
  sensitiveValues: readonly string[] = providerDiagnosticSecrets(),
): string {
  if (!isJsonObject(reason) || typeof reason.kind !== 'string' || reason.kind.length === 0) return 'kind=missing'
  const kind = safeDiagnosticToken(reason.kind, sensitiveValues)
  if (reason.kind !== 'error') return `kind=${kind}`
  const failure = isJsonObject(reason.error) ? reason.error : undefined
  const code = typeof failure?.code === 'string' ? safeDiagnosticToken(failure.code, sensitiveValues) : 'UNKNOWN'
  const message = typeof failure?.message === 'string' && failure.message.length > 0
    ? sanitizeProviderDiagnostic(failure.message, sensitiveValues)
    : 'LLM request failed without a message'
  return `kind=error, code=${code}, message=${message}`
}

function safeDiagnosticToken(value: string, sensitiveValues: readonly string[]): string {
  const sanitized = sanitizeProviderDiagnostic(value, sensitiveValues)
  if (sanitized.includes('[REDACTED]')) return 'REDACTED'
  return /^[a-z0-9_.-]{1,64}$/iu.test(sanitized) ? sanitized : 'UNKNOWN'
}

function providerBoundaryError(stage: string, error: unknown): GenerationError {
  const failure = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined
  const code = typeof failure?.code === 'string' ? failure.code : 'UNKNOWN'
  const message = error instanceof Error
    ? error.message
    : typeof failure?.message === 'string'
      ? failure.message
      : 'LLM request failed without a message'
  return new GenerationError(
    `${stage} (${formatProposalTurnEndFailure({ kind: 'error', error: { code, message } })})`,
    'PROPOSAL_FAILED',
  )
}

function sanitizeProviderDiagnostic(value: string, sensitiveValues: readonly string[]): string {
  let sanitized = value
  for (const secret of [...new Set(sensitiveValues)].filter(secret => secret.length >= 8).sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.split(secret).join('[REDACTED]')
  }
  sanitized = sanitized
    .replace(/((?:"|')?(?:x[-_]?api[-_]?key|api[_-]?key|authorization|access[_-]?token|token)(?:"|')?\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}]*)/giu, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/\bsk-[a-z0-9._-]{8,}\b/giu, '[REDACTED]')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .trim()
  return sanitized.length <= MAX_PROVIDER_DIAGNOSTIC_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_PROVIDER_DIAGNOSTIC_CHARS)}...`
}

function providerDiagnosticSecrets(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  const secrets = new Set<string>()
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== 'string') continue
    if (/(?:api[_-]?key|token|secret|password|credential)/iu.test(name)) {
      secrets.add(value)
      secrets.add(value.trim())
    }
    if (/^(?:https?|all)_proxy$/iu.test(name)) {
      secrets.add(value)
      secrets.add(value.trim())
      try {
        const proxy = new URL(value)
        for (const component of [proxy.username, proxy.password]) {
          if (component.length === 0) continue
          secrets.add(component)
          try { secrets.add(decodeURIComponent(component)) } catch { /* retain encoded component */ }
        }
      } catch { /* a malformed proxy still has its exact value redacted */ }
    }
  }
  return [...secrets]
}

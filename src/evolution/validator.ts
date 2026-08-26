import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EvolutionError,
  MAX_HOST_SOURCE_BYTES,
  type CandidatePackage,
  type TaskProfile,
} from './types.js'

export const CANDIDATE_VALIDATION_SCHEMA_VERSION = 'autodata-candidate-validation-1'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const VALIDATOR_OLD_SPACE_MIB = 128

export interface CandidateValidationResult {
  readonly schema_version: typeof CANDIDATE_VALIDATION_SCHEMA_VERSION
  readonly candidate_id: string
  readonly ok: boolean
  readonly plugin_id?: string
  readonly plugin_version?: string
  readonly reason?: string
}

export interface CandidateValidator {
  validate(profile: TaskProfile, candidate: CandidatePackage): Promise<CandidateValidationResult>
}

export interface ProcessCandidateValidatorOptions {
  readonly timeout_ms?: number
  readonly max_output_bytes?: number
  readonly worker_url?: URL
  /** Test seam for classifying a Node startup failure. */
  readonly node_path?: string
}

interface WorkerInput {
  readonly profile_id: string
  readonly candidate_id: string
  readonly generation: number
  readonly plugin_id: string
  readonly plugin_version: string
  readonly host_source: string
}

interface ProcessOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error
  readonly started: boolean
}

/** Validate trusted Host code away from the Controller's process and lifecycle. */
export class ProcessCandidateValidator implements CandidateValidator {
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly workerUrl: URL
  private readonly nodePath: string

  constructor(options: ProcessCandidateValidatorOptions = {}) {
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.workerUrl = options.worker_url ?? new URL('./validator-worker.js', import.meta.url)
    this.nodePath = options.node_path ?? process.execPath
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new EvolutionError('candidate validation timeout must be a positive integer', 'VALIDATION_UNAVAILABLE')
    }
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1024) {
      throw new EvolutionError('candidate validation output limit must be at least 1024 bytes', 'VALIDATION_UNAVAILABLE')
    }
  }

  async validate(profile: TaskProfile, candidate: CandidatePackage): Promise<CandidateValidationResult> {
    if (Buffer.byteLength(candidate.host_source, 'utf8') > MAX_HOST_SOURCE_BYTES) {
      return failed(candidate.manifest.candidate_id, 'candidate host source exceeds 256 KiB')
    }
    const workerPath = this.requireWorker()
    const input: WorkerInput = {
      profile_id: profile.id,
      candidate_id: candidate.manifest.candidate_id,
      generation: candidate.manifest.generation,
      plugin_id: profile.strategy_plugin_id,
      plugin_version: candidate.manifest.strategy_version,
      host_source: candidate.host_source,
    }
    return this.runWorker(workerPath, input)
  }

  private requireWorker(): string {
    try {
      const workerPath = fileURLToPath(this.workerUrl)
      accessSync(this.nodePath, constants.X_OK)
      accessSync(workerPath, constants.R_OK)
      return workerPath
    } catch (error) {
      throw new EvolutionError('Node or the built candidate validation worker is unavailable', 'VALIDATION_UNAVAILABLE', {
        cause: error,
      })
    }
  }

  private async runWorker(workerPath: string, input: WorkerInput): Promise<CandidateValidationResult> {
    const detached = process.platform !== 'win32'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.nodePath, [
        `--max-old-space-size=${String(VALIDATOR_OLD_SPACE_MIB)}`,
        workerPath,
      ], {
        cwd: dirname(workerPath),
        detached,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new EvolutionError('failed to start candidate validation worker', 'VALIDATION_UNAVAILABLE', { cause: error })
    }

    const stdin = child.stdin
    const stdoutPipe = child.stdout
    const stderrPipe = child.stderr
    const resultPipe = child.stdio[3]
    if (
      stdin === null
      || stdoutPipe === null
      || stderrPipe === null
      || resultPipe === undefined
      || resultPipe === null
      || typeof resultPipe === 'number'
      || !('on' in resultPipe)
    ) {
      killProcess(child.pid, detached)
      throw new EvolutionError('candidate validation worker pipes are unavailable', 'VALIDATION_UNAVAILABLE')
    }

    let stdout = ''
    let stderr = ''
    let resultOutput = ''
    let outputBytes = 0
    let exceeded = false
    let streamError: Error | undefined
    const collect = (kind: 'stdout' | 'stderr' | 'result', chunk: Buffer | string) => {
      if (exceeded) return
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength
      outputBytes += bytes
      if (outputBytes > this.maxOutputBytes) {
        exceeded = true
        killProcess(child.pid, detached)
        return
      }
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (kind === 'stdout') stdout += text
      else if (kind === 'stderr') stderr += text
      else resultOutput += text
    }
    const failStream = (error: Error) => {
      streamError ??= error
      killProcess(child.pid, detached)
    }
    stdoutPipe.on('data', (chunk: Buffer) => collect('stdout', chunk))
    stderrPipe.on('data', (chunk: Buffer) => collect('stderr', chunk))
    resultPipe.on('data', (chunk: Buffer) => collect('result', chunk))
    stdoutPipe.on('error', failStream)
    stderrPipe.on('error', failStream)
    resultPipe.on('error', failStream)
    // A worker that exits before consuming input is diagnosed from its exit/result.
    stdin.on('error', () => undefined)

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      killProcess(child.pid, detached)
    }, this.timeoutMs)

    const outcomePromise = new Promise<ProcessOutcome>((resolveOutcome) => {
      let settled = false
      let started = false
      const finish = (outcome: Omit<ProcessOutcome, 'started'>) => {
        if (settled) return
        settled = true
        resolveOutcome({ ...outcome, started })
      }
      child.once('spawn', () => { started = true })
      child.once('error', error => finish({ code: null, signal: null, error }))
      child.once('close', (code, signal) => finish({ code, signal }))
    })
    stdin.end(JSON.stringify(input), 'utf8')
    const outcome = await outcomePromise
    clearTimeout(timeout)

    if (!outcome.started && outcome.error !== undefined) {
      throw new EvolutionError(`failed to start candidate validation worker: ${outcome.error.message}`, 'VALIDATION_UNAVAILABLE', {
        cause: outcome.error,
      })
    }
    if (timedOut) return failed(input.candidate_id, 'candidate validation exceeded the hard timeout')
    if (exceeded) return failed(input.candidate_id, 'candidate validation exceeded the output limit')
    if (streamError !== undefined) {
      return failed(input.candidate_id, `candidate validation worker stream failed: ${streamError.message}`)
    }
    if (outcome.error !== undefined) {
      return failed(input.candidate_id, `candidate validation worker failed: ${outcome.error.message}`)
    }

    const logs = trimDiagnostic([stderr, stdout].filter(value => value.trim().length > 0).join('\n'))
    const outOfMemory = /heap out of memory|allocation failed|javascript heap/iu.test(logs)
    if (outcome.signal !== null) {
      return failed(
        input.candidate_id,
        outOfMemory
          ? `candidate validation worker reached its memory limit (${outcome.signal})`
          : withDiagnostic(`candidate validation worker terminated by signal ${outcome.signal}`, logs),
      )
    }
    if (outcome.code !== 0) {
      return failed(
        input.candidate_id,
        outOfMemory
          ? `candidate validation worker reached its memory limit (exit ${String(outcome.code)})`
          : withDiagnostic(`candidate validation worker exited with code ${String(outcome.code)}`, logs),
      )
    }
    if (resultOutput.trim().length === 0) {
      return failed(input.candidate_id, withDiagnostic('candidate validation worker returned no result', logs))
    }
    try {
      return normalizeWorkerResult(JSON.parse(resultOutput.trim()), input.candidate_id)
    } catch {
      return failed(input.candidate_id, 'candidate validation worker returned a malformed result')
    }
  }
}

function normalizeWorkerResult(value: unknown, candidateId: string): CandidateValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('result must be an object')
  const result = value as Record<string, unknown>
  if (
    result.schema_version !== CANDIDATE_VALIDATION_SCHEMA_VERSION
    || result.candidate_id !== candidateId
    || typeof result.ok !== 'boolean'
  ) throw new Error('invalid validation result')
  if (result.plugin_id !== undefined && (typeof result.plugin_id !== 'string' || result.plugin_id.length === 0)) {
    throw new Error('invalid validation plugin_id')
  }
  if (result.plugin_version !== undefined && (typeof result.plugin_version !== 'string' || result.plugin_version.length === 0)) {
    throw new Error('invalid validation plugin_version')
  }
  if (result.reason !== undefined && (typeof result.reason !== 'string' || result.reason.trim().length === 0)) {
    throw new Error('invalid validation reason')
  }
  if (result.ok && (result.plugin_id === undefined || result.plugin_version === undefined)) {
    throw new Error('successful validation result has no plugin identity')
  }
  if (!result.ok && result.reason === undefined) throw new Error('failed validation result has no reason')

  return Object.freeze({
    schema_version: CANDIDATE_VALIDATION_SCHEMA_VERSION,
    candidate_id: candidateId,
    ok: result.ok,
    ...(result.plugin_id === undefined ? {} : { plugin_id: result.plugin_id }),
    ...(result.plugin_version === undefined ? {} : { plugin_version: result.plugin_version }),
    ...(result.reason === undefined ? {} : { reason: trimDiagnostic(result.reason as string) }),
  })
}

function killProcess(pid: number | undefined, detached: boolean): void {
  if (pid === undefined) return
  if (detached) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* process group may already be gone */ }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* process may already be gone */ }
}

function failed(candidateId: string, reason: string): CandidateValidationResult {
  return Object.freeze({
    schema_version: CANDIDATE_VALIDATION_SCHEMA_VERSION,
    candidate_id: candidateId,
    ok: false,
    reason: trimDiagnostic(reason),
  })
}

function withDiagnostic(reason: string, diagnostic: string): string {
  return diagnostic.length === 0 ? reason : `${reason}: ${diagnostic}`
}

function trimDiagnostic(value: string): string {
  const text = value.trim()
  return text.length <= 4096 ? text : `${text.slice(0, 4093)}...`
}

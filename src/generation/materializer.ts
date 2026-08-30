import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, immutableJson, isJsonObject, parseStrictJsonObject } from '../core/json.js'
import type { DataRunResult } from '../core/types.js'
import {
  GENERATION_MATERIALIZATION_VERSION,
  GenerationError,
  type GenerationMaterialization,
  type GenerationMaterializationRequest,
  type GenerationMaterializer,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 1024 * 1024
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024 * 1024
const MATERIALIZER_OLD_SPACE_MIB = 256
const SHA256 = /^[a-f0-9]{64}$/u
const WORKER_ENVIRONMENT_KEYS = new Set([
  'APPDATA', 'COMSPEC', 'DYLD_LIBRARY_PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'LD_LIBRARY_PATH', 'LOCALAPPDATA', 'NODE_PATH', 'PATH', 'PATHEXT', 'SYSTEMROOT',
  'TEMP', 'TMP', 'TMPDIR', 'TZ', 'USERPROFILE', 'WINDIR',
])

export interface ProcessCandidateMaterializerOptions {
  readonly timeout_ms?: number
  readonly max_diagnostic_bytes?: number
  readonly max_result_bytes?: number
  readonly worker_url?: URL
  readonly node_path?: string
}

interface ProcessOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error
  readonly started: boolean
}

/** Execute one candidate against the frozen canonical pool in a fresh child process. */
export class ProcessCandidateMaterializer implements GenerationMaterializer {
  private readonly timeoutMs: number
  private readonly maxDiagnosticBytes: number
  private readonly maxResultBytes: number
  private readonly workerUrl: URL
  private readonly nodePath: string

  constructor(options: ProcessCandidateMaterializerOptions = {}) {
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS
    this.maxDiagnosticBytes = options.max_diagnostic_bytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES
    this.maxResultBytes = options.max_result_bytes ?? DEFAULT_MAX_RESULT_BYTES
    this.workerUrl = options.worker_url ?? new URL('./materializer-worker.js', import.meta.url)
    this.nodePath = options.node_path ?? process.execPath
    for (const [value, label, minimum] of [
      [this.timeoutMs, 'timeout_ms', 1],
      [this.maxDiagnosticBytes, 'max_diagnostic_bytes', 1024],
      [this.maxResultBytes, 'max_result_bytes', 1024],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new GenerationError(`${label} must be a safe integer >= ${String(minimum)}`, 'INVALID_REQUEST')
      }
    }
  }

  async materialize(
    request: GenerationMaterializationRequest,
    signal?: AbortSignal,
  ): Promise<GenerationMaterialization> {
    const worker = this.requireWorker()
    let input: string
    try {
      input = `${canonicalJson(request)}\n`
    } catch (error) {
      throw new GenerationError('candidate materialization request is not JSON-compatible', 'INVALID_REQUEST', { cause: error })
    }
    return this.runWorker(worker, input, request.candidate_id, signal)
  }

  private requireWorker(): string {
    try {
      const worker = fileURLToPath(this.workerUrl)
      accessSync(this.nodePath, constants.X_OK)
      accessSync(worker, constants.R_OK)
      return worker
    } catch (error) {
      throw new GenerationError('Node or the candidate materialization worker is unavailable', 'DEPENDENCY_UNAVAILABLE', {
        cause: error,
      })
    }
  }

  private async runWorker(
    worker: string,
    input: string,
    candidateId: string,
    signal?: AbortSignal,
  ): Promise<GenerationMaterialization> {
    if (signal?.aborted) throw new GenerationError('candidate materialization was cancelled', 'CANCEL_FAILED')
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([key, value]) => WORKER_ENVIRONMENT_KEYS.has(key) && value !== undefined)) as NodeJS.ProcessEnv
    const detached = process.platform !== 'win32'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.nodePath, [
        `--max-old-space-size=${String(MATERIALIZER_OLD_SPACE_MIB)}`,
        worker,
      ], {
        cwd: dirname(worker),
        detached,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: environment,
      })
    } catch (error) {
      throw new GenerationError('candidate materialization worker could not start', 'DEPENDENCY_UNAVAILABLE', {
        cause: error,
      })
    }
    const stdin = child.stdin
    const stdout = child.stdout
    const stderr = child.stderr
    const resultStream = child.stdio[3]
    if (
      stdin === null
      || stdout === null
      || stderr === null
      || resultStream === null
      || resultStream === undefined
      || typeof resultStream === 'number'
      || !('on' in resultStream)
    ) {
      killProcess(child.pid, detached)
      throw new GenerationError('candidate materializer process channels are unavailable', 'DEPENDENCY_UNAVAILABLE')
    }
    const diagnostics: Buffer[] = []
    const results: Buffer[] = []
    let diagnosticBytes = 0
    let resultBytes = 0
    let killedForLimit = false
    let streamError: Error | undefined
    const collectDiagnostic = (chunk: Buffer | string) => {
      if (killedForLimit) return
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      diagnosticBytes += value.byteLength
      if (diagnosticBytes <= this.maxDiagnosticBytes) diagnostics.push(value)
      else {
        killedForLimit = true
        killProcess(child.pid, detached)
      }
    }
    const failStream = (error: Error) => {
      streamError ??= error
      killProcess(child.pid, detached)
    }
    stdout.on('data', collectDiagnostic)
    stderr.on('data', collectDiagnostic)
    resultStream.on('data', (chunk: Buffer | string) => {
      if (killedForLimit) return
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      resultBytes += value.byteLength
      if (resultBytes <= this.maxResultBytes) results.push(value)
      else {
        killedForLimit = true
        killProcess(child.pid, detached)
      }
    })
    stdout.on('error', failStream)
    stderr.on('error', failStream)
    resultStream.on('error', failStream)
    // A worker killed for a limit or timeout can close before consuming input.
    stdin.on('error', () => undefined)
    const outcome = new Promise<ProcessOutcome>(resolve => {
      let settled = false
      let started = false
      child.once('spawn', () => { started = true })
      child.once('error', error => {
        if (settled) return
        settled = true
        resolve({ code: null, signal: null, error, started })
      })
      child.once('close', (code, processSignal) => {
        if (settled) return
        settled = true
        resolve({ code, signal: processSignal, started })
      })
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcess(child.pid, detached)
    }, this.timeoutMs)
    timer.unref()
    const abort = () => killProcess(child.pid, detached)
    signal?.addEventListener('abort', abort, { once: true })
    stdin.end(input)
    let completed: ProcessOutcome
    try {
      completed = await outcome
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    if (signal?.aborted) throw new GenerationError('candidate materialization was cancelled', 'CANCEL_FAILED')
    if (timedOut) throw new GenerationError('candidate materialization exceeded the hard timeout', 'VALIDATION_FAILED')
    if (killedForLimit) throw new GenerationError('candidate materialization exceeded its output limit', 'VALIDATION_FAILED')
    if (!completed.started || completed.error !== undefined) {
      throw new GenerationError('candidate materialization worker could not start', 'DEPENDENCY_UNAVAILABLE', {
        cause: completed.error,
      })
    }
    if (streamError !== undefined) {
      throw new GenerationError(`candidate materialization worker stream failed: ${streamError.message}`, 'VALIDATION_FAILED', {
        cause: streamError,
      })
    }
    const resultText = Buffer.concat(results).toString('utf8').trim()
    const diagnosticText = Buffer.concat(diagnostics).toString('utf8').trim()
    if (resultText.length === 0) {
      throw new GenerationError(
        `candidate materialization worker produced no result${diagnosticText.length === 0 ? '' : `: ${diagnosticText}`}`,
        'VALIDATION_FAILED',
      )
    }
    let envelope: Record<string, unknown>
    try {
      envelope = parseStrictJsonObject(resultText, 'candidate materialization result')
    } catch (error) {
      throw new GenerationError('candidate materialization worker returned malformed JSON', 'VALIDATION_FAILED', { cause: error })
    }
    if (envelope.ok !== true) {
      const reason = typeof envelope.error === 'string' ? envelope.error : diagnosticText || 'unknown worker failure'
      throw new GenerationError(`candidate materialization failed: ${reason}`, 'VALIDATION_FAILED')
    }
    if (completed.code !== 0 || completed.signal !== null) {
      throw new GenerationError('candidate materialization worker exited unsuccessfully after reporting a result', 'VALIDATION_FAILED')
    }
    return normalizeMaterialization(envelope.result, candidateId)
  }
}

function killProcess(pid: number | undefined, detached: boolean): void {
  if (pid === undefined) return
  if (detached) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* process group may already be gone */ }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* process may already be gone */ }
}

export function normalizeMaterialization(value: unknown, candidateId: string): GenerationMaterialization {
  if (!isJsonObject(value)) throw new GenerationError('candidate materialization result must be an object', 'ARTIFACT_INVALID')
  const fields = [
    'schema_version', 'candidate_id', 'host_source_sha256', 'source_pool_sha256',
    'canonical_jsonl_sha256', 'logical_view_jsonl_sha256', 'run_summary_json_sha256',
    'selected_record_ids', 'data_run',
  ] as const
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new GenerationError('candidate materialization result has an invalid shape', 'ARTIFACT_INVALID')
  }
  if (value.schema_version !== GENERATION_MATERIALIZATION_VERSION || value.candidate_id !== candidateId) {
    throw new GenerationError('candidate materialization identity does not match the request', 'ARTIFACT_INVALID')
  }
  for (const field of [
    'host_source_sha256', 'source_pool_sha256', 'canonical_jsonl_sha256',
    'logical_view_jsonl_sha256', 'run_summary_json_sha256',
  ] as const) {
    if (typeof value[field] !== 'string' || !SHA256.test(value[field])) {
      throw new GenerationError(`candidate materialization ${field} is invalid`, 'ARTIFACT_INVALID')
    }
  }
  if (
    !Array.isArray(value.selected_record_ids)
    || value.selected_record_ids.length === 0
    || value.selected_record_ids.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(value.selected_record_ids).size !== value.selected_record_ids.length
  ) throw new GenerationError('candidate materialization must select at least one unique record id', 'ARTIFACT_INVALID')
  if (!isJsonObject(value.data_run)) throw new GenerationError('candidate materialization data_run is invalid', 'ARTIFACT_INVALID')
  return immutableJson(value) as unknown as GenerationMaterialization & { readonly data_run: DataRunResult }
}

/** Stable digest used to prove the two child-process materializations are byte-identical. */
export function materializationDigest(value: GenerationMaterialization): string {
  return canonicalJson(value)
}

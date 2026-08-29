/** RJob CLI adapter implemented exclusively through the DSH subprocess seam. */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  STAGE4A_CONTAINER_IMAGE,
  Stage4AError,
  type Stage4ACommandResult,
  type Stage4ARJobBackend,
  type Stage4ARJobObservation,
  type Stage4ARJobSpec,
  type Stage4AStage,
} from './types.js'

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024
const STAGE4A_CHARGED_GROUP = 'cl4mind_gpu'
const STAGE4A_PRIVATE_MACHINE = 'group'
const STAGE4A_MOUNTS = Object.freeze([
  'gpfs://gpfs1/gezhilong:/mnt/shared-storage-user/gezhilong',
  'gpfs://gpfs2/gpfs2-shared-public:/mnt/shared-storage-gpfs2/gpfs2-shared-public',
] as const)

export interface Stage4ACommandRunner {
  run(argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<Stage4ACommandResult>
}

/** Managed local process runner. No command is ever passed through a shell. */
export class DshStage4ACommandRunner implements Stage4ACommandRunner {
  constructor(private readonly subprocess: SubprocessRuntime) {}

  async run(argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<Stage4ACommandResult> {
    if (argv.length === 0) throw new Stage4AError('cannot spawn an empty argv', 'INVALID_REQUEST')
    const executable = await this.subprocess.resolveExecutable(argv[0] as string, {}, signal)
    const handle = this.subprocess.spawn({
      argv: [executable, ...argv.slice(1)],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_COMMAND_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_COMMAND_OUTPUT_BYTES },
      },
      graceMs: 5_000,
      ...(signal === undefined ? {} : { signal }),
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout?.lossy || stderr?.lossy) {
      throw new Stage4AError('RJob CLI output exceeded the 2 MiB diagnostic limit', 'ARTIFACT_INVALID')
    }
    return Object.freeze({
      argv: Object.freeze([...argv]),
      exit_code: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout?.text ?? '',
      stderr: stderr?.text ?? '',
    })
  }
}

function resources(stage: Stage4AStage): readonly string[] {
  return stage === 'train'
    ? ['--replicas', '1', '--gpu', '4', '--cpu', '64', '--memory', '327680']
    : ['--replicas', '1', '--gpu', '1', '--cpu', '16', '--memory', '81920']
}

function submissionArgv(spec: Stage4ARJobSpec, mode?: 'dry-run' | 'predict-only'): readonly string[] {
  return Object.freeze([
    'rjob', 'submit',
    '--name', spec.rjob_name,
    '--folder', spec.staging_directory,
    '--metadata-name', spec.rjob_name,
    '--task_name', spec.stage,
    '--charged-group', STAGE4A_CHARGED_GROUP,
    '--restart-policy', 'never',
    '--backoff_limit', '1',
    '--preemptible', 'no',
    '--private-machine', STAGE4A_PRIVATE_MACHINE,
    '--image', STAGE4A_CONTAINER_IMAGE,
    ...resources(spec.stage),
    '--mount', ...STAGE4A_MOUNTS,
    '--set-env', `AUTODATA_STAGE4A_REQUEST=${spec.request_path}`,
    ...(mode === undefined ? [] : [`--${mode}`, 'true']),
    '--', '/bin/bash', spec.script_path,
  ])
}

function assertSuccess(result: Stage4ACommandResult, code: 'DRY_RUN_FAILED' | 'UNSCHEDULABLE' | 'SUBMIT_FAILED', label: string): void {
  if (result.exit_code !== 0 || result.signal !== null) {
    throw new Stage4AError(`${label} failed with exit ${String(result.exit_code)}${result.signal === null ? '' : `/${result.signal}`}`, code)
  }
}

function isFullySchedulable(output: string): boolean {
  if (/(?:^|\D)1\s*\/\s*1(?:\D|$)/u.test(output)) return true
  const count = (label: string): number | undefined => {
    const match = output.match(new RegExp(`^\\s*-\\s*${label}\\s*[:：]\\s*(\\d+)\\s*$`, 'mu'))
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
  return count('总副本数量') === 1
    && count('可调度数量') === 1
    && count('不可调度数量') === 0
}

function remoteStatus(output: string): Stage4ARJobObservation['status'] {
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const summary = lines
    .map(line => line.match(/\brjob\s+\S+(?:\s+\(showname=[^)]*\))?\s*:\s*([A-Za-z]+)\s*$/iu)?.[1])
    .find(value => value !== undefined)
  const lone = lines.length === 1
    ? lines[0]?.match(/^(succeeded|completed|success|failed|error|stopped|cancelled|canceled|killed|running|pending|inqueue|starting)$/iu)?.[1]
    : undefined
  switch ((summary ?? lone)?.toLowerCase()) {
    case 'succeeded':
    case 'completed':
    case 'success': return 'succeeded'
    case 'failed':
    case 'error': return 'failed'
    case 'stopped':
    case 'cancelled':
    case 'canceled':
    case 'killed': return 'stopped'
    case 'running': return 'running'
    default: return 'pending'
  }
}

/** Concrete backend for the installed `rjob` CLI. */
export class Stage4ARJobClient implements Stage4ARJobBackend {
  constructor(private readonly runner: Stage4ACommandRunner) {}

  static fromContext(ctx: Context): Stage4ARJobClient {
    const subprocess = ctx.get('subprocess', false) as SubprocessRuntime | undefined
    if (subprocess === undefined) {
      throw new Stage4AError('DSH subprocess service is unavailable', 'DEPENDENCY_UNAVAILABLE')
    }
    return new Stage4ARJobClient(new DshStage4ACommandRunner(subprocess))
  }

  async dryRun(spec: Stage4ARJobSpec, signal: AbortSignal): Promise<Stage4ACommandResult> {
    const result = await this.runner.run(submissionArgv(spec, 'dry-run'), spec.staging_directory, signal)
    assertSuccess(result, 'DRY_RUN_FAILED', `${spec.stage} RJob dry-run`)
    return result
  }

  async predict(spec: Stage4ARJobSpec, signal: AbortSignal): Promise<Stage4ACommandResult> {
    const result = await this.runner.run(submissionArgv(spec, 'predict-only'), spec.staging_directory, signal)
    assertSuccess(result, 'UNSCHEDULABLE', `${spec.stage} RJob prediction`)
    const combined = `${result.stdout}\n${result.stderr}`
    if (!isFullySchedulable(combined)) {
      throw new Stage4AError(`${spec.stage} RJob prediction was not schedulable 1/1`, 'UNSCHEDULABLE')
    }
    return result
  }

  async submit(spec: Stage4ARJobSpec, signal: AbortSignal): Promise<Stage4ACommandResult> {
    const result = await this.runner.run(submissionArgv(spec), spec.staging_directory, signal)
    assertSuccess(result, 'SUBMIT_FAILED', `${spec.stage} RJob submission`)
    return result
  }

  async inspect(rjobName: string, signal: AbortSignal): Promise<Stage4ARJobObservation> {
    const result = await this.runner.run(['rjob', 'get', rjobName], '/', signal)
    const output = `${result.stdout}\n${result.stderr}`
    if (result.exit_code !== 0) {
      if (/not[ -]?found|does not exist|no resources found/iu.test(output)) {
        return Object.freeze({ status: 'missing', command: result })
      }
      throw new Stage4AError(`rjob get failed for ${rjobName}`, 'REMOTE_FAILED')
    }
    if (output.trim() === '') return Object.freeze({ status: 'missing', command: result })
    return Object.freeze({ status: remoteStatus(output), command: result })
  }

  async logs(rjobName: string, signal: AbortSignal): Promise<Stage4ACommandResult> {
    return this.runner.run(['rjob', 'logs', 'job', rjobName, '--tail-lines', '10000'], '/', signal)
  }

  async stop(rjobName: string): Promise<Stage4ACommandResult> {
    const result = await this.runner.run(['rjob', 'stop', rjobName], '/')
    if (result.exit_code !== 0 || result.signal !== null) {
      throw new Stage4AError(`rjob stop failed for ${rjobName}`, 'CANCEL_FAILED')
    }
    return result
  }
}

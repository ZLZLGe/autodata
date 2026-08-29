import { Context } from '@deepseek-ai/cordis'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDataCore } from '../src/core/runner.js'
import type { DataRunResult, SourceAdapter } from '../src/core/types.js'
import {
  STAGE4A_BFCL_CASES,
  STAGE4A_EVAL_RESULT_VERSION,
  STAGE4A_EXPECTED_PARAMETERS,
  STAGE4A_CONTAINER_IMAGE,
  STAGE4A_MODEL_REVISION,
  STAGE4A_TOOL_CALL_PARSER,
  STAGE4A_TRAIN_RESULT_VERSION,
  STAGE4A_VLLM_VERSION,
  Stage4AController,
  Stage4AError,
  Stage4ALedger,
  Stage4ARJobClient,
  type Stage4ACommandResult,
  type Stage4AJobHooks,
  type Stage4AJobRegistry,
  type Stage4ARJobBackend,
  type Stage4ARJobObservation,
  type Stage4ARJobSpec,
  type Stage4AState,
} from '../src/stage4a/index.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

const adapter: SourceAdapter = {
  id: 'fixture-adapter',
  version: '1',
  identify(value) { return (value as { id: string }).id },
  adapt(value) {
    return {
      messages: [
        { role: 'user', content: 'call a tool' },
        { role: 'assistant', content: (value as { answer: string }).answer },
      ],
      tools: [],
      warnings: [],
    }
  },
}

function dataRun(): DataRunResult {
  return runDataCore({
    harness_id: 'stage4a-fixture',
    generation: 0,
    seed: 42,
    source: { dataset_id: 'fixture', dataset_revision: '1', records: [{ id: 'one', answer: 'done' }] },
    source_adapter: adapter,
    selected_record_ids: null,
    quarantine_record_ids: [],
    plugins: [],
  })
}

function command(argv: readonly string[], stdout = ''): Stage4ACommandResult {
  return { argv, exit_code: 0, signal: null, stdout, stderr: '' }
}

class FakeJobs implements Stage4AJobRegistry {
  private sequence = 0
  private readonly hooks = new Map<string, Stage4AJobHooks>()
  private readonly outcomes = new Map<string, Promise<JobOutcome>>()
  attached = 0

  start(spec: Parameters<Stage4AJobRegistry['start']>[0]): JobId {
    if (this.attached === 0) throw new Error('missing controller')
    const id = JobId(`autodata-stage4a-${String(++this.sequence)}`)
    const hooks = spec.run()
    this.hooks.set(id, hooks)
    this.outcomes.set(id, hooks.done)
    return id
  }

  get(id: JobId): { readonly status: string } {
    if (!this.hooks.has(id)) throw new Error('unknown job')
    return { status: 'running' }
  }

  kill(id: JobId, _caller?: undefined, reason?: string): 'requested' | 'already-finished' {
    const hooks = this.hooks.get(id)
    if (hooks === undefined) return 'already-finished'
    hooks.cancel(reason)
    return 'requested'
  }

  attachController(): () => void {
    this.attached += 1
    return () => { this.attached -= 1 }
  }

  async done(id: JobId): Promise<JobOutcome> {
    const outcome = this.outcomes.get(id)
    if (outcome === undefined) throw new Error('unknown job')
    return outcome
  }
}

class PassingBackend implements Stage4ARJobBackend {
  readonly calls: string[] = []
  corruptResult = false
  submitError: Error | undefined
  inspectStatus: Stage4ARJobObservation['status'] = 'succeeded'

  async dryRun(spec: Stage4ARJobSpec, _signal: AbortSignal): Promise<Stage4ACommandResult> {
    this.calls.push(`dry:${spec.stage}`)
    return command(['rjob', 'submit', '--dry-run', 'true'])
  }

  async predict(spec: Stage4ARJobSpec, _signal: AbortSignal): Promise<Stage4ACommandResult> {
    this.calls.push(`predict:${spec.stage}`)
    return command(['rjob', 'submit', '--predict-only', 'true'], 'schedulable replicas 1/1')
  }

  async submit(spec: Stage4ARJobSpec, _signal: AbortSignal): Promise<Stage4ACommandResult> {
    this.calls.push(`submit:${spec.stage}`)
    this.writeResult(spec)
    if (this.submitError !== undefined) throw this.submitError
    return command(['rjob', 'submit'])
  }

  async inspect(specName: string, _signal: AbortSignal): Promise<Stage4ARJobObservation> {
    this.calls.push(`inspect:${specName}`)
    return { status: this.inspectStatus, command: command(['rjob', 'get', specName], this.inspectStatus) }
  }

  async logs(specName: string, _signal: AbortSignal): Promise<Stage4ACommandResult> {
    this.calls.push(`logs:${specName}`)
    return command(['rjob', 'logs', 'job', specName], 'complete')
  }

  async stop(specName: string): Promise<Stage4ACommandResult> {
    this.calls.push(`stop:${specName}`)
    return command(['rjob', 'stop', specName])
  }

  writeResult(spec: Stage4ARJobSpec): void {
    const request = JSON.parse(readFileSync(spec.request_path, 'utf8')) as Record<string, any>
    const output = request.output as { root: string; result_json: string; checkpoint_dir?: string }
    mkdirSync(output.root, { recursive: true })
    if (spec.stage === 'train') {
      mkdirSync(output.checkpoint_dir as string, { recursive: true })
      writeFileSync(output.result_json, `${JSON.stringify({
        schema_version: STAGE4A_TRAIN_RESULT_VERSION,
        profile_id: request.profile_id,
        run_id: request.run_id,
        attempt: request.attempt,
        status: 'passed',
        checkpoint_path: output.checkpoint_dir,
        checks: {
          gpu_count: 4,
          gpu_family: 'NVIDIA H200',
          model_revision: STAGE4A_MODEL_REVISION,
          trainable_parameters: STAGE4A_EXPECTED_PARAMETERS,
          total_parameters: STAGE4A_EXPECTED_PARAMETERS,
          global_step: 2,
          finite_metrics: true,
          huggingface_weight_shards: 4,
          zero_optimizer_shards: 4,
          zero_model_state_shards: 4,
          fresh_process_reload: true,
          weights_changed: true,
        },
        failure: null,
        ...(this.corruptResult ? { injected: true } : {}),
      })}\n`, { flag: 'wx' })
    } else {
      writeFileSync(output.result_json, `${JSON.stringify({
        schema_version: STAGE4A_EVAL_RESULT_VERSION,
        profile_id: request.profile_id,
        run_id: request.run_id,
        attempt: request.attempt,
        status: 'passed',
        checks: {
          gpu_count: 1,
          gpu_family: 'NVIDIA H200',
          model_revision: STAGE4A_MODEL_REVISION,
          vllm_version: STAGE4A_VLLM_VERSION,
          tool_call_parser: STAGE4A_TOOL_CALL_PARSER,
          loaded_weight_shards: 4,
        },
        cases: STAGE4A_BFCL_CASES.map(caseId => ({ case_id: caseId, passed: true })),
        failure: null,
        ...(this.corruptResult ? { injected: true } : {}),
      })}\n`, { flag: 'wx' })
    }
  }
}

async function fixture(backend: Stage4ARJobBackend = new PassingBackend()) {
  const root = await mkdtemp(join(tmpdir(), 'autodata-stage4a-'))
  const jobs = new FakeJobs()
  const controller = new Stage4AController(context(), {
    run_root: resolve(root, 'runs'),
    staging_root: resolve(root, 'staging'),
    asset_root: resolve('stage4a'),
    poll_interval_ms: 0,
    backend,
    jobs,
    profile_exists: id => id === 'bfcl',
  })
  return { root, jobs, controller, backend }
}

describe('Stage 4A Host controller', () => {
  it('materializes data and completes train then eval without exposing a durable JobId', async () => {
    const { root, jobs, controller, backend } = await fixture()
    const started = controller.start({ profile_id: 'bfcl', run_id: 'gate-one', data_run: dataRun() })
    expect(started.job_id).toBeDefined()
    await jobs.done(started.job_id as JobId)
    const status = controller.status('bfcl', 'gate-one')
    expect(status.state.status).toBe('succeeded')
    expect(status.job_id).toBeUndefined()
    expect(status.state.attempts.map(attempt => [attempt.stage, attempt.status])).toEqual([
      ['train', 'succeeded'], ['eval', 'succeeded'],
    ])
    expect((backend as PassingBackend).calls.filter(value => value.startsWith('submit:'))).toEqual(['submit:train', 'submit:eval'])
    expect(existsSync(resolve(root, 'runs/bfcl/gate-one/canonical.jsonl'))).toBe(true)
    expect(existsSync(resolve(root, 'runs/bfcl/gate-one/logical-view.jsonl'))).toBe(true)
    expect(existsSync(resolve(root, 'runs/bfcl/gate-one/run-summary.json'))).toBe(true)
    expect(readFileSync(resolve(root, 'runs/bfcl/gate-one/state.json'), 'utf8')).not.toContain('job_id')
    await controller.dispose()
  })

  it('publishes an initializing state atomically and rebuilds interrupted staging on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autodata-stage4a-init-'))
    const emptyAssets = resolve(root, 'empty-assets')
    mkdirSync(emptyAssets)
    const first = new Stage4AController(context(), {
      run_root: resolve(root, 'runs'),
      staging_root: resolve(root, 'staging'),
      asset_root: emptyAssets,
      backend: new PassingBackend(),
      jobs: new FakeJobs(),
      profile_exists: () => true,
    })
    expect(() => first.start({ profile_id: 'bfcl', run_id: 'init-recovery', data_run: dataRun() }))
      .toThrowError(/required Stage 4A asset is missing/iu)
    expect(first.status('bfcl', 'init-recovery').state).toMatchObject({
      status: 'queued',
      phase: 'initializing',
      attempts: [],
    })
    await first.dispose()

    const jobs = new FakeJobs()
    const recovered = new Stage4AController(context(), {
      run_root: resolve(root, 'runs'),
      staging_root: resolve(root, 'staging'),
      asset_root: resolve('stage4a'),
      poll_interval_ms: 0,
      backend: new PassingBackend(),
      jobs,
      profile_exists: () => true,
    })
    const resumed = recovered.resume('bfcl', 'init-recovery')
    expect((await jobs.done(resumed.job_id as JobId)).status).toBe('completed')
    expect(recovered.status('bfcl', 'init-recovery').state.status).toBe('succeeded')
    await recovered.dispose()
  })

  it('commits each successful attempt and its result pointer in one state write', async () => {
    const { jobs, controller } = await fixture()
    const ledger = (controller as unknown as { ledger: Stage4ALedger }).ledger
    const saveState = ledger.saveState.bind(ledger)
    const snapshots: Stage4AState[] = []
    ledger.saveState = state => {
      snapshots.push(state)
      return saveState(state)
    }
    const started = controller.start({ profile_id: 'bfcl', run_id: 'atomic-result', data_run: dataRun() })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('completed')
    for (const state of snapshots) {
      const trainSucceeded = state.attempts.some(attempt => attempt.stage === 'train' && attempt.status === 'succeeded')
      const evalSucceeded = state.attempts.some(attempt => attempt.stage === 'eval' && attempt.status === 'succeeded')
      if (trainSucceeded) expect(state.train_result_path).toBeDefined()
      if (evalSucceeded) expect(state.eval_result_path).toBeDefined()
    }
    await controller.dispose()
  })

  it('keeps an ambiguous submit recoverable and never repeats that GPU submission', async () => {
    const firstBackend = new PassingBackend()
    firstBackend.submitError = new Error('connection lost after create')
    const first = await fixture(firstBackend)
    const started = first.controller.start({ profile_id: 'bfcl', run_id: 'crash-window', data_run: dataRun() })
    await first.jobs.done(started.job_id as JobId)
    expect(first.controller.status('bfcl', 'crash-window').state).toMatchObject({
      status: 'recovery_required',
      attempts: [{ stage: 'train', status: 'submitting' }],
    })
    await first.controller.dispose()

    const recoveryBackend = new PassingBackend()
    const jobs = new FakeJobs()
    const recovered = new Stage4AController(context(), {
      run_root: resolve(first.root, 'runs'),
      staging_root: resolve(first.root, 'staging'),
      asset_root: resolve('stage4a'),
      poll_interval_ms: 0,
      backend: recoveryBackend,
      jobs,
      profile_exists: () => true,
    })
    const resumed = recovered.resume('bfcl', 'crash-window')
    await jobs.done(resumed.job_id as JobId)
    expect(recoveryBackend.calls).not.toContain('submit:train')
    expect(recoveryBackend.calls).toContain('submit:eval')
    expect(recovered.status('bfcl', 'crash-window').state.status).toBe('succeeded')
    await recovered.dispose()
  })

  it('rejects extra fields in a worker artifact and leaves active/champion concerns untouched', async () => {
    const backend = new PassingBackend()
    backend.corruptResult = true
    const { jobs, controller } = await fixture(backend)
    const started = controller.start({ profile_id: 'bfcl', run_id: 'bad-artifact', data_run: dataRun() })
    const outcome = await jobs.done(started.job_id as JobId)
    expect(outcome.status).toBe('failed')
    expect(controller.status('bfcl', 'bad-artifact').state).toMatchObject({
      status: 'failed',
      failure: { code: 'ARTIFACT_INVALID' },
    })
    await controller.dispose()
  })

  it('cancels a live remote run through both DSH jobs and deterministic RJob identity', async () => {
    let inspected!: () => void
    const reachedInspect = new Promise<void>(resolvePromise => { inspected = resolvePromise })
    class RunningBackend extends PassingBackend {
      override async inspect(name: string): Promise<Stage4ARJobObservation> {
        this.calls.push(`inspect:${name}`)
        inspected()
        return { status: 'running', command: command(['rjob', 'get', name], 'Running') }
      }
    }
    const backend = new RunningBackend()
    const { jobs, controller } = await fixture(backend)
    const started = controller.start({ profile_id: 'bfcl', run_id: 'cancel-run', data_run: dataRun() })
    await reachedInspect
    const cancelled = await controller.cancel('bfcl', 'cancel-run')
    expect(cancelled.state.status).toBe('cancelled')
    expect(backend.calls.some(value => value === 'stop:autodata-cancel-run-train')).toBe(true)
    expect((await jobs.done(started.job_id as JobId)).status).toBe('killed')
    await controller.dispose()
  })

  it('keeps cancellation during an ambiguous submit recoverable without stopping or resubmitting blindly', async () => {
    let enteredSubmit!: () => void
    const submitStarted = new Promise<void>(resolvePromise => { enteredSubmit = resolvePromise })
    class AmbiguousSubmitBackend extends PassingBackend {
      override async submit(spec: Stage4ARJobSpec, signal: AbortSignal): Promise<Stage4ACommandResult> {
        this.calls.push(`submit:${spec.stage}`)
        enteredSubmit()
        return new Promise((_, reject) => {
          const abort = () => { reject(signal.reason) }
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      }
    }
    const backend = new AmbiguousSubmitBackend()
    backend.inspectStatus = 'missing'
    const { jobs, controller } = await fixture(backend)
    const started = controller.start({ profile_id: 'bfcl', run_id: 'cancel-submit', data_run: dataRun() })
    await submitStarted
    const cancelled = await controller.cancel('bfcl', 'cancel-submit')
    expect(cancelled.state).toMatchObject({
      status: 'recovery_required',
      attempts: [{ stage: 'train', status: 'submitting' }],
      failure: { code: 'RECOVERY_REQUIRED' },
    })
    expect((await jobs.done(started.job_id as JobId)).status).toBe('failed')
    expect(backend.calls.filter(call => call === 'submit:train')).toHaveLength(1)
    expect(backend.calls.some(call => call.startsWith('stop:'))).toBe(false)

    const resumed = controller.resume('bfcl', 'cancel-submit')
    expect((await jobs.done(resumed.job_id as JobId)).status).toBe('failed')
    expect(backend.calls.filter(call => call === 'submit:train')).toHaveLength(1)
    await controller.dispose()
  })

  it('rejects traversal identifiers and symlinked profile directories', async () => {
    const { root, controller } = await fixture()
    expect(() => controller.start({ profile_id: '../bfcl', run_id: 'bad', data_run: dataRun() })).toThrow(Stage4AError)
    const outside = resolve(root, 'outside')
    mkdirSync(outside)
    const runRoot = resolve(root, 'linked-runs')
    mkdirSync(runRoot)
    symlinkSync(outside, resolve(runRoot, 'bfcl'))
    const linked = new Stage4ALedger(runRoot, resolve(root, 'linked-staging'))
    expect(() => linked.createRunDirectories('bfcl', 'safe-run')).toThrowError(/symbolic link/iu)
    await controller.dispose()
  })
})

describe('Stage 4A RJob CLI adapter', () => {
  it('treats the real CLI empty successful lookup as a missing RJob', async () => {
    const client = new Stage4ARJobClient({
      async run(argv) { return command(argv) },
    })
    await expect(client.inspect('autodata-missing-train', new AbortController().signal)).resolves.toMatchObject({
      status: 'missing',
      command: { argv: ['rjob', 'get', 'autodata-missing-train'] },
    })
  })

  it('reads only the RJob summary status and ignores zero-valued task counters', async () => {
    const outputs = [
      "08-30 04:28:02 [INFO] rjob autodata-gate-train (showname=): Inqueue\n08-30 04:28:02 [INFO]   |- task train: 1 replicas {'active': 0, 'succeeded': 0, 'failed': 0}",
      "08-30 04:29:02 [INFO] rjob autodata-gate-train (showname=gate): Running\n08-30 04:29:02 [INFO]   |- task train: 1 replicas {'active': 1, 'succeeded': 0, 'failed': 0}",
      "08-30 04:30:02 [INFO] rjob autodata-gate-train (showname=gate): Succeeded\n08-30 04:30:02 [INFO]   |- task train: 1 replicas {'active': 0, 'succeeded': 1, 'failed': 0}",
    ]
    let call = 0
    const client = new Stage4ARJobClient({
      async run(argv) { return command(argv, outputs[call++] as string) },
    })
    await expect(client.inspect('autodata-gate-train', new AbortController().signal)).resolves.toMatchObject({ status: 'pending' })
    await expect(client.inspect('autodata-gate-train', new AbortController().signal)).resolves.toMatchObject({ status: 'running' })
    await expect(client.inspect('autodata-gate-train', new AbortController().signal)).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('uses argv execution, fixed bash entry, and requires predict-only 1/1', async () => {
    const calls: readonly string[][] = []
    const mutable = calls as string[][]
    const client = new Stage4ARJobClient({
      async run(argv) {
        mutable.push([...argv])
        return command(argv, argv.includes('--predict-only') ? 'schedulable 1/1' : 'ok')
      },
    })
    const spec: Stage4ARJobSpec = {
      stage: 'train',
      rjob_name: 'autodata-gate-train',
      staging_directory: '/gpfs/gate',
      script_path: '/gpfs/gate/train.sh',
      request_path: '/gpfs/gate/attempts/train/0001/request.json',
    }
    await client.dryRun(spec, new AbortController().signal)
    await client.predict(spec, new AbortController().signal)
    await client.submit(spec, new AbortController().signal)
    const base = [
      'rjob', 'submit',
      '--name', 'autodata-gate-train',
      '--folder', '/gpfs/gate',
      '--metadata-name', 'autodata-gate-train',
      '--task_name', 'train',
      '--charged-group', 'cl4mind_gpu',
      '--restart-policy', 'never',
      '--backoff_limit', '1',
      '--preemptible', 'no',
      '--private-machine', 'group',
      '--image', STAGE4A_CONTAINER_IMAGE,
      '--replicas', '1', '--gpu', '4', '--cpu', '64', '--memory', '327680',
      '--mount',
      'gpfs://gpfs1/gezhilong:/mnt/shared-storage-user/gezhilong',
      'gpfs://gpfs2/gpfs2-shared-public:/mnt/shared-storage-gpfs2/gpfs2-shared-public',
      '--set-env', 'AUTODATA_STAGE4A_REQUEST=/gpfs/gate/attempts/train/0001/request.json',
    ]
    const entrypoint = ['--', '/bin/bash', '/gpfs/gate/train.sh']
    expect(calls).toEqual([
      [...base, '--dry-run', 'true', ...entrypoint],
      [...base, '--predict-only', 'true', ...entrypoint],
      [...base, ...entrypoint],
    ])
    expect(calls[0]).not.toContain('-c')

    const unschedulable = new Stage4ARJobClient({
      async run(argv) { return command(argv, 'schedulable 0/1') },
    })
    await expect(unschedulable.predict(spec, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSCHEDULABLE' })

    const currentCli = new Stage4ARJobClient({
      async run(argv) {
        return command(argv, [
          '📊 任务数量统计：',
          '  - 总副本数量：1',
          '  - 可调度数量：1',
          '  - 不可调度数量：0',
        ].join('\n'))
      },
    })
    await expect(currentCli.predict(spec, new AbortController().signal)).resolves.toBeDefined()

    const currentCliUnschedulable = new Stage4ARJobClient({
      async run(argv) {
        return command(argv, [
          '  - 总副本数量：1',
          '  - 可调度数量：0',
          '  - 不可调度数量：1',
        ].join('\n'))
      },
    })
    await expect(currentCliUnschedulable.predict(spec, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSCHEDULABLE' })
  })

  it('uses the frozen single-H200 resources for evaluation', async () => {
    let captured: readonly string[] = []
    const client = new Stage4ARJobClient({
      async run(argv) {
        captured = argv
        return command(argv)
      },
    })
    await client.dryRun({
      stage: 'eval',
      rjob_name: 'autodata-gate-eval',
      staging_directory: '/gpfs/gate',
      script_path: '/gpfs/gate/eval.sh',
      request_path: '/gpfs/gate/attempts/eval/0001/request.json',
    }, new AbortController().signal)
    expect(captured).toContain('eval')
    expect(captured.slice(captured.indexOf('--replicas'), captured.indexOf('--mount'))).toEqual([
      '--replicas', '1', '--gpu', '1', '--cpu', '16', '--memory', '81920',
    ])
  })
})

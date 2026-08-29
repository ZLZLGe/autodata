import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDataCore } from '../src/core/runner.js'
import type { SourceAdapter } from '../src/core/types.js'
import AutoDataService, {
  DEFAULT_TASK_PROFILE,
  startStage4A,
  statusStage4A,
} from '../src/service.js'
import { MemoryEvolutionStore } from '../src/evolution/store.js'

const adapter: SourceAdapter = {
  id: 'stage4a-local-provider-fixture',
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

function dataRun() {
  return runDataCore({
    harness_id: 'stage4a-local-provider-fixture',
    generation: 0,
    seed: 42,
    source: { dataset_id: 'fixture', dataset_revision: '1', records: [{ id: 'one', answer: 'done' }] },
    source_adapter: adapter,
    selected_record_ids: null,
    quarantine_record_ids: [],
    plugins: [],
  })
}

function fakeRjobSource(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'submit' && args.includes('--dry-run')) process.exit(0)
if (args[0] === 'submit' && args.includes('--predict-only')) {
  process.stdout.write('schedulable replicas 1/1\\n')
  process.exit(0)
}
if (args[0] === 'submit') {
  const setting = args[args.indexOf('--set-env') + 1]
  const requestPath = setting.slice('AUTODATA_STAGE4A_REQUEST='.length)
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
  fs.mkdirSync(request.output.root, { recursive: true })
  let result
  if (request.recipe) {
    fs.mkdirSync(request.output.checkpoint_dir, { recursive: true })
    result = {
      schema_version: 'autodata-stage4a-train-result-1',
      profile_id: request.profile_id,
      run_id: request.run_id,
      attempt: request.attempt,
      status: 'passed',
      checkpoint_path: request.output.checkpoint_dir,
      checks: {
        gpu_count: 4,
        gpu_family: 'NVIDIA H200',
        model_revision: request.model.revision,
        trainable_parameters: request.recipe.expected_parameters,
        total_parameters: request.recipe.expected_parameters,
        global_step: 2,
        finite_metrics: true,
        huggingface_weight_shards: 4,
        zero_optimizer_shards: 4,
        zero_model_state_shards: 4,
        fresh_process_reload: true,
        weights_changed: true
      },
      failure: null
    }
  } else {
    result = {
      schema_version: 'autodata-stage4a-eval-result-1',
      profile_id: request.profile_id,
      run_id: request.run_id,
      attempt: request.attempt,
      status: 'passed',
      checks: {
        gpu_count: 1,
        gpu_family: 'NVIDIA H200',
        model_revision: request.runtime.model_revision,
        vllm_version: request.runtime.vllm_version,
        tool_call_parser: request.runtime.tool_call_parser,
        loaded_weight_shards: 4
      },
      cases: request.case_ids.map(case_id => ({ case_id, passed: true })),
      failure: null
    }
  }
  fs.writeFileSync(request.output.result_json, JSON.stringify(result) + '\\n', { flag: 'wx' })
  process.stdout.write('submitted\\n')
  process.exit(0)
}
if (args[0] === 'get') {
  process.stdout.write('Succeeded\\n')
  process.exit(0)
}
if (args[0] === 'logs') {
  process.stdout.write('complete\\n')
  process.exit(0)
}
if (args[0] === 'stop') process.exit(0)
process.stderr.write('unsupported fake rjob invocation\\n')
process.exit(2)
`
}

describe('Stage 4A with DSH local providers', () => {
  it('runs through the real jobs and subprocess seams against a fake rjob executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autodata-stage4a-local-'))
    const bin = resolve(root, 'bin')
    mkdirSync(bin)
    const executable = resolve(bin, 'rjob')
    writeFileSync(executable, fakeRjobSource(), { mode: 0o700 })
    chmodSync(executable, 0o700)
    const previousPath = process.env.PATH
    process.env.PATH = previousPath === undefined ? bin : `${bin}${delimiter}${previousPath}`
    const ctx = new Context()
    try {
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(AutoDataService, {
        store: new MemoryEvolutionStore(),
        stage4a: {
          run_root: resolve(root, 'runs'),
          staging_root: resolve(root, 'staging'),
          asset_root: resolve('stage4a'),
          poll_interval_ms: 0,
        },
      })
      const started = startStage4A(ctx, {
        profile_id: DEFAULT_TASK_PROFILE.id,
        run_id: 'local-provider-gate',
        data_run: dataRun(),
      })
      expect(started.job_id).toBeDefined()
      const settled = await ctx.jobs.wait(started.job_id!, 10_000)
      expect(settled.status).toBe('completed')
      expect(statusStage4A(ctx, DEFAULT_TASK_PROFILE.id, 'local-provider-gate')).toMatchObject({
        state: { status: 'succeeded', phase: 'complete' },
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      await ctx.fiber.dispose()
    }
  })
})

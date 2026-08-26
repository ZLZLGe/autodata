import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import AutoDataService, { getEvolutionController } from '../src/service.js'
import {
  EVALUATION_REPORT_SCHEMA_VERSION,
  FileEvolutionStore,
  ProcessCandidateValidator,
  type EvolutionRuntimeAgent,
} from '../src/evolution/index.js'

const contexts: Context[] = []
const directories: string[] = []
const agent = { id: 'integration-agent', steer() {}, inject() {} } as unknown as EvolutionRuntimeAgent
const validator = () => new ProcessCandidateValidator({
  worker_url: pathToFileURL(join(process.cwd(), 'lib/evolution/validator-worker.js')),
})

const strategySource = `
  return {
    inject: ['autodata'],
    apply(ctx) {
      ctx.autodata.register({
        id: 'bfcl-strategy',
        version: '1',
        run(input) {
          return input.map(item => ({ record_id: item.record.source.record_id }))
        },
      })
    },
  }
`

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Stage 3A full lifecycle', () => {
  it('validates, activates, unloads, restarts, resumes, and rolls back from File Store state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autodata-stage3a-'))
    directories.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    const firstFiber = await ctx.plugin(AutoDataService, {
      store: new FileEvolutionStore(root),
      validator: validator(),
    })
    expect('evolution' in ctx.autodata).toBe(false)
    const first = getEvolutionController(ctx)
    first.createProfile({ id: 'bfcl', benchmark: 'bfcl-v3', acceptance: { metric: 'accuracy' } })

    const validated = await first.submitAndValidateCandidate('bfcl', {
      candidate_id: 'candidate-one',
      strategy_version: '1',
      host_source: strategySource,
    })
    expect(validated.validation.ok).toBe(true)

    const accepted = await first.recordEvaluation({
      schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
      report_id: 'report-one',
      profile_id: 'bfcl',
      candidate_id: 'candidate-one',
      benchmark: 'bfcl-v3',
      split: 'B_dev',
      metric: 'accuracy',
      score: 0.6,
      complete: true,
      cases_evaluated: 10,
      cases_expected: 10,
      baseline_candidate_id: 'h0',
      baseline_score: 0.5,
    }, agent)
    expect(accepted.decision.accepted).toBe(true)
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'bfcl-strategy', version: '1' })

    const profileDirectory = join(root, 'profiles', 'bfcl')
    expect(existsSync(join(profileDirectory, 'active.json'))).toBe(false)
    const persisted = JSON.parse(readFileSync(join(profileDirectory, 'state.json'), 'utf8')) as {
      active_candidate_id: string
    }
    expect(persisted.active_candidate_id).toBe('candidate-one')

    await firstFiber.dispose()
    expect(ctx.get('autodata', false)).toBeUndefined()
    expect(ctx.get('dynamicCordisRunner', true)).toBeUndefined()

    await ctx.plugin(AutoDataService, {
      store: new FileEvolutionStore(root),
      validator: validator(),
    })
    const resumed = getEvolutionController(ctx)
    expect(resumed.status('bfcl').state.active_candidate_id).toBe('candidate-one')
    expect(ctx.autodata.plugins()).not.toContainEqual(expect.objectContaining({ id: 'bfcl-strategy' }))

    await resumed.resume('bfcl', agent)
    expect(ctx.autodata.plugins()).toContainEqual({ id: 'bfcl-strategy', version: '1' })
    expect((await resumed.rollback('bfcl', 'h0', agent)).state.active_candidate_id).toBe('h0')
    expect(ctx.autodata.plugins()).toEqual([{ id: 'toolcall-h0', version: '3' }])
  })

  it('requires a configured production state home', () => {
    expect(() => new FileEvolutionStore({ env: {} })).toThrow(/AUTODATA_HOME.*DSH_HOME/)
  })
})

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AutoDataService, { DEFAULT_TASK_PROFILE, getEvolutionController } from '../src/service.js'
import {
  ACCEPTANCE_POLICY_SCHEMA_VERSION,
  CANDIDATE_VALIDATION_SCHEMA_VERSION,
  H0_CANDIDATE_ID,
  MemoryEvolutionStore,
  TASK_PROFILE_SCHEMA_VERSION,
  type CandidatePackage,
  type CandidateValidationResult,
  type CandidateValidator,
  type EvolutionRuntime,
  type TaskProfile,
} from '../src/evolution/index.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

const acceptingValidator: CandidateValidator = {
  async validate(profile: TaskProfile, candidate: CandidatePackage): Promise<CandidateValidationResult> {
    return Object.freeze({
      schema_version: CANDIDATE_VALIDATION_SCHEMA_VERSION,
      candidate_id: candidate.manifest.candidate_id,
      ok: true,
      plugin_id: profile.strategy_plugin_id,
      plugin_version: candidate.manifest.strategy_version,
    })
  },
}

describe('AutoDataService profile initialization', () => {
  it('creates the default Profile and H0 state when config and Store are empty', async () => {
    const store = new MemoryEvolutionStore()
    const ctx = context()

    await ctx.plugin(AutoDataService, { store })

    expect(store.listProfiles()).toEqual([DEFAULT_TASK_PROFILE])
    expect(getEvolutionController(ctx).status('default').state).toMatchObject({
      profile_id: 'default',
      generation: 0,
      active_candidate_id: H0_CANDIDATE_ID,
      open_candidate_id: null,
    })
  })

  it('uses configured Profiles instead of adding default', async () => {
    const store = new MemoryEvolutionStore()
    const ctx = context()

    await ctx.plugin(AutoDataService, {
      store,
      profiles: [
        {
          id: 'bfcl',
          name: 'Berkeley Function Calling',
          benchmark: 'bfcl-v3',
          acceptance: { metric: 'accuracy' },
          metadata: { owner: 'autodata-test' },
        },
        {
          id: 'toolbench',
          benchmark: 'toolbench-v2',
          acceptance_policy: {
            schema_version: ACCEPTANCE_POLICY_SCHEMA_VERSION,
            metric: 'pass_rate',
          },
          capabilities: ['data-select'],
        },
      ],
    })

    expect(store.listProfiles()).toEqual([
      expect.objectContaining({
        schema_version: TASK_PROFILE_SCHEMA_VERSION,
        id: 'bfcl',
        strategy_plugin_id: 'bfcl-strategy',
        benchmark: 'bfcl-v3',
        acceptance_policy: {
          schema_version: ACCEPTANCE_POLICY_SCHEMA_VERSION,
          rule: 'strict_improvement',
          split: 'B_dev',
          metric: 'accuracy',
          direction: 'maximize',
        },
        capabilities: ['data-select', 'data-filter', 'data-order'],
        metadata: { owner: 'autodata-test' },
      }),
      expect.objectContaining({
        id: 'toolbench',
        strategy_plugin_id: 'toolbench-strategy',
        benchmark: 'toolbench-v2',
        capabilities: ['data-select'],
      }),
    ])
    expect(store.getProfile('default')).toBeUndefined()
  })

  it('reuses equivalent config on restart and preserves candidate history', async () => {
    const store = new MemoryEvolutionStore()
    const first = context()
    const profile = {
      id: 'bfcl',
      benchmark: 'bfcl-v3',
      acceptance: { metric: 'accuracy' },
      metadata: { second: 2, first: 1 },
    }
    const firstFiber = await first.plugin(AutoDataService, { store, profiles: [profile] })
    getEvolutionController(first).submitCandidate('bfcl', {
      candidate_id: 'candidate-one',
      strategy_version: '1',
      host_source: 'return {}',
    })
    await firstFiber.dispose()

    const second = context()
    await second.plugin(AutoDataService, {
      store,
      profiles: [{ ...profile, metadata: { first: 1, second: 2 } }],
    })

    expect(getEvolutionController(second).status('bfcl').state).toMatchObject({
      active_candidate_id: 'h0',
      open_candidate_id: 'candidate-one',
      candidates: expect.arrayContaining([
        expect.objectContaining({ candidate_id: 'candidate-one', status: 'proposed' }),
      ]),
    })
  })

  it('does not add default when an unconfigured Store already has a Profile', async () => {
    const store = new MemoryEvolutionStore()
    store.createProfile({
      schema_version: TASK_PROFILE_SCHEMA_VERSION,
      id: 'existing',
      strategy_plugin_id: 'existing-strategy',
      acceptance_policy: {
        schema_version: ACCEPTANCE_POLICY_SCHEMA_VERSION,
        rule: 'strict_improvement',
        split: 'B_dev',
        metric: 'accuracy',
        direction: 'maximize',
      },
      benchmark: 'existing-benchmark',
      capabilities: ['data-select'],
    })

    await context().plugin(AutoDataService, { store })

    expect(store.listProfiles().map(profile => profile.id)).toEqual(['existing'])
  })

  it('fails immutable config conflicts before creating any earlier entry', async () => {
    const store = new MemoryEvolutionStore()
    const first = context()
    const firstFiber = await first.plugin(AutoDataService, {
      store,
      profiles: [{ id: 'bfcl', benchmark: 'bfcl-v3', acceptance: { metric: 'accuracy' } }],
    })
    await firstFiber.dispose()

    await expect(context().plugin(AutoDataService, {
      store,
      profiles: [
        { id: 'new-profile', benchmark: 'new-benchmark' },
        { id: 'bfcl', benchmark: 'changed-benchmark', acceptance: { metric: 'accuracy' } },
      ],
    })).rejects.toMatchObject({ code: 'PROFILE_EXISTS' })

    expect(store.getProfile('new-profile')).toBeUndefined()
    expect(store.getProfile('bfcl')?.benchmark).toBe('bfcl-v3')
  })

  it('cleans the Service, Controller, and Runtime after initialization fails', async () => {
    const store = new MemoryEvolutionStore()
    const seeded = context()
    const seededFiber = await seeded.plugin(AutoDataService, {
      store,
      profiles: [{ id: 'bfcl', benchmark: 'bfcl-v3' }],
    })
    await seededFiber.dispose()

    let disposeCalls = 0
    const runtime: EvolutionRuntime = {
      async ensureActive() {},
      async activate() {
        return { async rollback() {} }
      },
      async dispose() {
        disposeCalls += 1
      },
    }
    const failed = context()
    await expect(failed.plugin(AutoDataService, {
      store,
      runtime,
      profiles: [{ id: 'bfcl', benchmark: 'changed-benchmark' }],
    })).rejects.toMatchObject({ code: 'PROFILE_EXISTS' })

    expect(failed.get('autodata', false)).toBeUndefined()
    expect(() => getEvolutionController(failed)).toThrow(/unavailable/iu)
    expect(disposeCalls).toBe(1)
  })

  it('rejects duplicate Profile and strategy IDs before writing', async () => {
    const duplicateIdStore = new MemoryEvolutionStore()
    await expect(context().plugin(AutoDataService, {
      store: duplicateIdStore,
      profiles: [
        { id: 'duplicate', benchmark: 'one' },
        { id: 'duplicate', benchmark: 'two' },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_PROFILE' })
    expect(duplicateIdStore.listProfiles()).toEqual([])

    const duplicateStrategyStore = new MemoryEvolutionStore()
    await expect(context().plugin(AutoDataService, {
      store: duplicateStrategyStore,
      profiles: [
        { id: 'one', strategy_plugin_id: 'shared-strategy', benchmark: 'one' },
        { id: 'two', strategy_plugin_id: 'shared-strategy', benchmark: 'two' },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_PROFILE' })
    expect(duplicateStrategyStore.listProfiles()).toEqual([])
  })

  it('keeps multiple Profiles isolated and leaves a validated default candidate open', async () => {
    const store = new MemoryEvolutionStore()
    const ctx = context()
    await ctx.plugin(AutoDataService, { store, validator: acceptingValidator })
    const controller = getEvolutionController(ctx)
    controller.createProfile({ id: 'other', benchmark: 'other-fixture' })

    const outcome = await controller.submitAndValidateCandidate('default', {
      candidate_id: 'candidate-one',
      strategy_version: '1',
      host_source: 'return {}',
    })

    expect(outcome.status.state).toMatchObject({
      active_candidate_id: 'h0',
      open_candidate_id: 'candidate-one',
      candidates: expect.arrayContaining([
        expect.objectContaining({ candidate_id: 'candidate-one', status: 'validated' }),
      ]),
    })
    expect(controller.status('other').state).toMatchObject({
      active_candidate_id: 'h0',
      open_candidate_id: null,
      generation: 0,
    })
  })

  it('uses Cordis config validation for malformed profile config', async () => {
    const store = new MemoryEvolutionStore()
    await expect(context().plugin(AutoDataService, {
      store,
      profiles: 'not-an-array',
    } as never)).rejects.toThrow(/invalid config.*profiles must be a non-empty array/isu)
    expect(store.listProfiles()).toEqual([])
  })
})

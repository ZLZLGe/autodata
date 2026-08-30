import type { Context, Fiber } from '@deepseek-ai/cordis'
import type DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'
import { canonicalJson } from '../core/json.js'
import {
  candidateFrozenSelectionRuntimeBinding,
  candidateRuntimeHostSource,
} from './candidate-sandbox.js'
import {
  runEvolutionFixture,
  runFrozenSelectionRuntimeSelfCheck,
  type EvolutionDataHost,
} from './fixture.js'
import {
  EvolutionError,
  H0_CANDIDATE_ID,
  H0_PLUGIN_ID,
  H0_PLUGIN_VERSION,
  type CandidatePackage,
  type TaskProfile,
} from './types.js'

export type EvolutionRuntimeAgent = Parameters<DynamicCordisRunnerService['run']>[0]
type DynamicPluginId = Parameters<DynamicCordisRunnerService['run']>[1]
type DynamicPackageId = Parameters<DynamicCordisRunnerService['run']>[2]
type DynamicRunResponse = Awaited<ReturnType<DynamicCordisRunnerService['run']>>

export interface RuntimeActivation {
  rollback(): Promise<void>
}

/** A candidate-local failure reported only after the previous active runtime is restored. */
export class CandidateActivationError extends EvolutionError {
  constructor(
    message: string,
    options: { readonly profile_id?: string; readonly candidate_id?: string; readonly cause?: unknown } = {},
  ) {
    super(message, 'RUNTIME_FAILED', options)
    this.name = 'CandidateActivationError'
  }
}

export interface EvolutionRuntime {
  ensureActive(profile: TaskProfile, candidate: CandidatePackage | null, agent: EvolutionRuntimeAgent): Promise<void>
  activate(
    profile: TaskProfile,
    current: CandidatePackage | null,
    candidate: CandidatePackage,
    agent: EvolutionRuntimeAgent,
  ): Promise<RuntimeActivation>
  dispose(): Promise<void>
}

interface RuntimeSlot {
  readonly profile: TaskProfile
  readonly runner: DynamicCordisRunnerService
  readonly agent: EvolutionRuntimeAgent
  readonly pluginId: DynamicPluginId
  readonly packages: Map<string, DynamicPackageId>
  activeCandidate: CandidatePackage
}

interface OwnedRunner {
  readonly fiber: Fiber
  runner: DynamicCordisRunnerService
}

interface RuntimeSurface {
  readonly plugins: readonly Readonly<{ id: string; version: string }>[]
  readonly toolSchemas: readonly string[]
}

/** DSH-backed process-local activation. Durable truth remains in EvolutionStore. */
export class DshEvolutionRuntime implements EvolutionRuntime {
  private readonly slots = new Map<string, RuntimeSlot>()
  private ownedRunner: OwnedRunner | undefined
  private runnerLoad: Promise<DynamicCordisRunnerService> | undefined
  private disposal: Promise<void> | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly host: EvolutionDataHost,
  ) {}

  async ensureActive(
    profile: TaskProfile,
    candidate: CandidatePackage | null,
    agent: EvolutionRuntimeAgent,
  ): Promise<void> {
    this.assertUsable()
    try {
      await this.ensureActiveInternal(profile, candidate, agent)
    } catch (error) {
      if (
        candidate !== null
        && (
          error instanceof CandidateActivationError
          || (error instanceof EvolutionError && (error.code === 'RUNTIME_FAILED' || error.code === 'RUNTIME_STATE'))
        )
      ) {
        throw new EvolutionError('failed to establish the durable active candidate', 'RUNTIME_DEGRADED', {
          profile_id: profile.id,
          candidate_id: candidate.manifest.candidate_id,
          cause: error,
        })
      }
      throw error
    }
  }

  private async ensureActiveInternal(
    profile: TaskProfile,
    candidate: CandidatePackage | null,
    agent: EvolutionRuntimeAgent,
  ): Promise<void> {
    if (candidate === null) {
      await this.ensureH0(profile)
      return
    }

    const runner = await this.requireRunner()
    const current = this.slots.get(profile.id)
    if (
      current !== undefined
      && current.runner === runner
      && current.agent === agent
      && current.activeCandidate.manifest.candidate_id === candidate.manifest.candidate_id
      && current.activeCandidate.host_source === candidate.host_source
      && canonicalJson(current.activeCandidate.manifest) === canonicalJson(candidate.manifest)
      && this.isSlotActive(current)
      && this.hasExpectedStrategy(profile, candidate)
    ) {
      this.runFixture(profile, candidate)
      return
    }

    if (current !== undefined) {
      await this.deactivate(profile, current)
      this.slots.delete(profile.id)
    }
    this.assertStrategyAbsent(profile)
    const slot = await this.startNew(profile, candidate, agent, runner)
    this.slots.set(profile.id, slot)
  }

  async activate(
    profile: TaskProfile,
    current: CandidatePackage | null,
    candidate: CandidatePackage,
    agent: EvolutionRuntimeAgent,
  ): Promise<RuntimeActivation> {
    this.assertUsable()
    if (current?.manifest.candidate_id === candidate.manifest.candidate_id) {
      throw new EvolutionError('candidate is already active', 'RUNTIME_STATE', {
        profile_id: profile.id,
        candidate_id: candidate.manifest.candidate_id,
      })
    }

    await this.ensureActive(profile, current, agent)
    const runner = await this.requireRunner()
    const before = this.captureSurface()
    this.assertBaseline(profile, current, before)

    if (current === null) {
      const slot = await this.startNew(profile, candidate, agent, runner, before)
      this.slots.set(profile.id, slot)
      return this.rollbackToH0(profile, candidate, slot, before)
    }

    const slot = this.slots.get(profile.id)
    if (
      slot === undefined
      || slot.runner !== runner
      || slot.agent !== agent
      || slot.activeCandidate.manifest.candidate_id !== current.manifest.candidate_id
    ) {
      throw new EvolutionError(`runtime is not loaded at active candidate ${current.manifest.candidate_id}`, 'RUNTIME_STATE', {
        profile_id: profile.id,
        candidate_id: current.manifest.candidate_id,
      })
    }
    const oldPackageId = slot.packages.get(current.manifest.candidate_id)
    if (oldPackageId === undefined) {
      throw new EvolutionError(`runtime package for ${current.manifest.candidate_id} is missing`, 'RUNTIME_STATE', {
        profile_id: profile.id,
        candidate_id: current.manifest.candidate_id,
      })
    }

    let packageId: DynamicPackageId
    try {
      const receipt = runner.define({
        sessionId: agent.id,
        plugin: { kind: 'existing', pluginId: slot.pluginId },
        name: candidate.manifest.candidate_id,
        purpose: candidate.manifest.description ?? `AutoData candidate for ${profile.id}`,
        code: { host: candidateRuntimeHostSource(profile, candidate) },
      })
      packageId = receipt.packageId
      slot.packages.set(candidate.manifest.candidate_id, packageId)
    } catch (error) {
      throw this.activationError(profile, candidate, runner, error)
    }

    try {
      await this.runPackage(profile, candidate, slot, packageId, 'update', before, current)
      slot.activeCandidate = candidate
    } catch (error) {
      try {
        await this.restorePrevious(profile, slot, oldPackageId, current, before)
      } catch (recoveryError) {
        throw new EvolutionError('candidate activation failed and the previous active candidate could not be restored', 'RUNTIME_DEGRADED', {
          profile_id: profile.id,
          candidate_id: candidate.manifest.candidate_id,
          cause: new AggregateError([error, recoveryError]),
        })
      }
      throw this.activationError(profile, candidate, runner, error)
    }

    let rolledBack = false
    return Object.freeze({
      rollback: async () => {
        if (rolledBack) return
        this.assertRollbackSlot(profile, candidate, slot)
        try {
          await this.restorePrevious(profile, slot, oldPackageId, current, before)
        } catch (error) {
          throw new EvolutionError('failed to roll back the active candidate', 'RUNTIME_DEGRADED', {
            profile_id: profile.id,
            candidate_id: candidate.manifest.candidate_id,
            cause: error,
          })
        }
        rolledBack = true
      },
    })
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = this.disposeRuntime()
    return this.disposal
  }

  private async disposeRuntime(): Promise<void> {
    const failures: unknown[] = []
    for (const [profileId, slot] of [...this.slots]) {
      try {
        await this.deactivate(slot.profile, slot)
      } catch (error) {
        failures.push(error)
      } finally {
        this.slots.delete(profileId)
      }
    }

    const owned = this.ownedRunner
    this.ownedRunner = undefined
    if (owned !== undefined && owned.fiber.uid !== null) {
      try {
        await owned.fiber.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new EvolutionError('failed to dispose the DSH evolution runtime cleanly', 'RUNTIME_DEGRADED', {
        cause: new AggregateError(failures),
      })
    }
  }

  private async startNew(
    profile: TaskProfile,
    candidate: CandidatePackage,
    agent: EvolutionRuntimeAgent,
    runner: DynamicCordisRunnerService,
    suppliedBefore?: RuntimeSurface,
  ): Promise<RuntimeSlot> {
    const before = suppliedBefore ?? this.captureSurface()
    this.assertBaseline(profile, null, before)
    let slot: RuntimeSlot | undefined
    try {
      const receipt = runner.define({
        sessionId: agent.id,
        plugin: { kind: 'new', idPrefix: 'auto' },
        name: candidate.manifest.candidate_id,
        purpose: candidate.manifest.description ?? `AutoData candidate for ${profile.id}`,
        code: { host: candidateRuntimeHostSource(profile, candidate) },
      })
      slot = {
        profile,
        runner,
        agent,
        pluginId: receipt.pluginId,
        packages: new Map([[candidate.manifest.candidate_id, receipt.packageId]]),
        activeCandidate: candidate,
      }
      await this.runPackage(profile, candidate, slot, receipt.packageId, 'run', before, null)
      return slot
    } catch (error) {
      try {
        if (slot !== undefined) {
          await this.cleanupSlot(slot)
        }
        this.assertSurface(before)
      } catch (cleanupError) {
        throw new EvolutionError('candidate activation failed and its runtime could not be cleaned up', 'RUNTIME_DEGRADED', {
          profile_id: profile.id,
          candidate_id: candidate.manifest.candidate_id,
          cause: new AggregateError([error, cleanupError]),
        })
      }
      throw this.activationError(profile, candidate, runner, error)
    }
  }

  private async runPackage(
    profile: TaskProfile,
    candidate: CandidatePackage,
    slot: RuntimeSlot,
    packageId: DynamicPackageId,
    mode: 'run' | 'update',
    before: RuntimeSurface,
    previous: CandidatePackage | null,
  ): Promise<void> {
    let result: DynamicRunResponse
    try {
      result = await slot.runner.run(slot.agent, slot.pluginId, packageId, mode)
    } catch (error) {
      throw this.activationError(profile, candidate, slot.runner, error)
    }
    if (!result.ok) {
      const code = result.reason === 'host-half-failed' ? 'RUNTIME_FAILED' : 'RUNTIME_DEGRADED'
      throw new EvolutionError(`candidate activation failed: ${result.message}`, code, {
        profile_id: profile.id,
        candidate_id: candidate.manifest.candidate_id,
      })
    }
    if (result.waitingFor.length > 0) {
      throw new EvolutionError(`candidate is waiting for unavailable services: ${result.waitingFor.join(', ')}`, 'RUNTIME_FAILED', {
        profile_id: profile.id,
        candidate_id: candidate.manifest.candidate_id,
      })
    }
    this.assertActivated(profile, candidate, slot, packageId, before, previous)
  }

  private assertActivated(
    profile: TaskProfile,
    candidate: CandidatePackage,
    slot: RuntimeSlot,
    packageId: DynamicPackageId,
    before: RuntimeSurface,
    previous: CandidatePackage | null,
  ): void {
    const row = slot.runner.snapshot(slot.agent).find(entry => entry.pluginId === slot.pluginId)
    const active = row?.activeRun
    if (row === undefined || active === undefined || active.packageId !== packageId || row.currentPackageId !== packageId || active.fiber === undefined) {
      throw new EvolutionError('DSH Runner did not retain the exact activated host package', 'RUNTIME_FAILED', {
        profile_id: profile.id,
        candidate_id: candidate.manifest.candidate_id,
      })
    }
    const inject = Object.keys(active.fiber.inject).sort()
    if (inject.length !== 1 || inject[0] !== 'autodata') {
      throw new EvolutionError(`candidate inject must be exactly ["autodata"], got ${JSON.stringify(inject)}`, 'RUNTIME_FAILED', {
        profile_id: profile.id,
        candidate_id: candidate.manifest.candidate_id,
      })
    }

    const expected = this.replaceStrategy(before, profile, previous, candidate)
    this.assertSurface(expected)
    this.runFixture(profile, candidate)
  }

  private async restorePrevious(
    profile: TaskProfile,
    slot: RuntimeSlot,
    oldPackageId: DynamicPackageId,
    oldCandidate: CandidatePackage,
    expectedSurface: RuntimeSurface,
  ): Promise<void> {
    const stopped = await slot.runner.stop(slot.agent, slot.pluginId)
    if (!stopped.ok && stopped.reason !== 'not-running') {
      throw new EvolutionError(`failed to stop candidate during recovery: ${stopped.message}`, 'RUNTIME_DEGRADED')
    }
    let snapshot
    try {
      snapshot = slot.runner.inspectPlugin(slot.agent, slot.pluginId)
    } catch (error) {
      throw new EvolutionError('failed to inspect the previous candidate during recovery', 'RUNTIME_DEGRADED', { cause: error })
    }
    const mode = snapshot.currentPackageId === undefined || snapshot.currentPackageId === oldPackageId ? 'run' : 'update'
    const restored = await slot.runner.run(slot.agent, slot.pluginId, oldPackageId, mode)
    if (!restored.ok || restored.waitingFor.length > 0) {
      const message = restored.ok ? `waiting for ${restored.waitingFor.join(', ')}` : restored.message
      throw new EvolutionError(`failed to restore previous active candidate: ${message}`, 'RUNTIME_DEGRADED')
    }
    const row = slot.runner.snapshot(slot.agent).find(entry => entry.pluginId === slot.pluginId)
    if (row === undefined || row.activeRun === undefined || row.activeRun.packageId !== oldPackageId || row.currentPackageId !== oldPackageId) {
      throw new EvolutionError('previous active package was not restored exactly', 'RUNTIME_DEGRADED')
    }
    const inject = row.activeRun.fiber === undefined ? [] : Object.keys(row.activeRun.fiber.inject).sort()
    if (inject.length !== 1 || inject[0] !== 'autodata') {
      throw new EvolutionError('previous active package restored with an invalid service surface', 'RUNTIME_DEGRADED')
    }
    this.assertSurface(expectedSurface)
    try {
      this.runFixture(profile, oldCandidate)
    } catch (error) {
      throw new EvolutionError('previous active candidate failed its fixture after recovery', 'RUNTIME_DEGRADED', { cause: error })
    }
    slot.activeCandidate = oldCandidate
  }

  private rollbackToH0(
    profile: TaskProfile,
    candidate: CandidatePackage,
    slot: RuntimeSlot,
    expectedSurface: RuntimeSurface,
  ): RuntimeActivation {
    let rolledBack = false
    return Object.freeze({
      rollback: async () => {
        if (rolledBack) return
        this.assertRollbackSlot(profile, candidate, slot)
        try {
          await this.cleanupSlot(slot)
          this.slots.delete(profile.id)
          this.assertSurface(expectedSurface)
          this.assertH0(profile)
        } catch (error) {
          throw new EvolutionError('failed to return the runtime to H0', 'RUNTIME_DEGRADED', {
            profile_id: profile.id,
            candidate_id: candidate.manifest.candidate_id,
            cause: error,
          })
        }
        rolledBack = true
      },
    })
  }

  private assertRollbackSlot(profile: TaskProfile, candidate: CandidatePackage, slot: RuntimeSlot): void {
    if (
      this.slots.get(profile.id) !== slot
      || slot.activeCandidate.manifest.candidate_id !== candidate.manifest.candidate_id
      || !this.isSlotActive(slot)
    ) {
      throw new EvolutionError('runtime changed before the activation could be rolled back', 'RUNTIME_DEGRADED', {
        profile_id: profile.id,
        candidate_id: candidate.manifest.candidate_id,
      })
    }
  }

  private async ensureH0(profile: TaskProfile): Promise<void> {
    const slot = this.slots.get(profile.id)
    if (slot !== undefined) {
      await this.deactivate(profile, slot)
      this.slots.delete(profile.id)
    }
    this.assertH0(profile)
  }

  private async deactivate(profile: TaskProfile, slot: RuntimeSlot): Promise<void> {
    const before = this.captureSurface()
    const expected = this.removeStrategy(before, profile)
    await this.cleanupSlot(slot)
    try {
      this.assertSurface(expected)
      this.assertStrategyAbsent(profile)
    } catch (error) {
      throw new EvolutionError('active strategy cleanup left the runtime in an unexpected state', 'RUNTIME_DEGRADED', {
        profile_id: profile.id,
        candidate_id: slot.activeCandidate.manifest.candidate_id,
        cause: error,
      })
    }
  }

  private async cleanupSlot(slot: RuntimeSlot): Promise<void> {
    let stopError: unknown
    try {
      const stopped = await slot.runner.stop(slot.agent, slot.pluginId)
      if (!stopped.ok && stopped.reason !== 'not-running' && stopped.reason !== 'plugin-missing') {
        stopError = new Error(stopped.message)
      }
    } catch (error) {
      stopError = error
    }

    try {
      const undefinedResult = await slot.runner.undefine(slot.agent, slot.pluginId)
      if (!undefinedResult.ok && undefinedResult.reason !== 'plugin-missing') {
        throw new Error('failed to remove active strategy runtime')
      }
    } catch (error) {
      throw new EvolutionError('failed to remove active strategy runtime', 'RUNTIME_DEGRADED', {
        cause: stopError === undefined ? error : new AggregateError([stopError, error]),
      })
    }
  }

  private async requireRunner(): Promise<DynamicCordisRunnerService> {
    this.assertUsable()
    const current = this.currentRunner()
    if (current !== undefined) {
      this.refreshOwnedRunner(current)
      return current
    }
    if (this.runnerLoad !== undefined) return this.runnerLoad
    this.runnerLoad = this.loadRunner().finally(() => {
      this.runnerLoad = undefined
    })
    return this.runnerLoad
  }

  private async loadRunner(): Promise<DynamicCordisRunnerService> {
    let fiber: Fiber | undefined
    try {
      const module = await import('@deepseek-ai/dsh-cordis-host-runner')
      const appeared = this.currentRunner()
      if (appeared !== undefined) return appeared
      fiber = this.ctx.plugin(module.default)
      await fiber
      const runner = this.currentRunner()
      if (runner === undefined) {
        await fiber.dispose()
        throw new EvolutionError('DSH dynamicCordisRunner could not start; its required services are unavailable', 'RUNTIME_UNAVAILABLE')
      }
      this.ownedRunner = { fiber, runner }
      return runner
    } catch (error) {
      if (fiber !== undefined && fiber.uid !== null) {
        try { await fiber.dispose() } catch { /* availability error remains primary */ }
      }
      const appeared = this.currentRunner()
      if (appeared !== undefined) return appeared
      if (error instanceof EvolutionError) throw error
      throw new EvolutionError('DSH dynamicCordisRunner is unavailable', 'RUNTIME_UNAVAILABLE', { cause: error })
    }
  }

  private currentRunner(): DynamicCordisRunnerService | undefined {
    try {
      const value = this.ctx.get('dynamicCordisRunner', true) as DynamicCordisRunnerService | undefined
      if (value === undefined) return undefined
      const original = (value as unknown as Record<symbol, unknown>)[Symbol.for('cordis.original')]
      return (original ?? value) as DynamicCordisRunnerService
    } catch {
      return undefined
    }
  }

  private refreshOwnedRunner(current: DynamicCordisRunnerService): void {
    if (this.ownedRunner?.fiber.uid === null) this.ownedRunner = undefined
    else if (this.ownedRunner !== undefined && this.ownedRunner.runner !== current) {
      // A service provider may be hot-reloaded. Slots retain their own runner;
      // this handle now follows the provider only when no stale slot owns it.
      if (this.slots.size === 0) this.ownedRunner.runner = current
    }
  }

  private captureSurface(): RuntimeSurface {
    const tools = this.ctx.get('tools', true) as { schemas(): readonly unknown[] } | undefined
    if (tools === undefined) throw new EvolutionError('DSH tool runtime is unavailable', 'RUNTIME_UNAVAILABLE')
    return Object.freeze({
      plugins: this.pluginDescriptors(),
      toolSchemas: Object.freeze(tools.schemas().map(schema => JSON.stringify(schema)).sort()),
    })
  }

  private pluginDescriptors(): readonly Readonly<{ id: string; version: string }>[] {
    return Object.freeze(this.host.plugins()
      .map(plugin => Object.freeze({ id: plugin.id, version: plugin.version }))
      .sort(compareDescriptors))
  }

  private assertSurface(expected: RuntimeSurface): void {
    const actual = this.captureSurface()
    if (JSON.stringify(actual.plugins) !== JSON.stringify(expected.plugins)) {
      throw new EvolutionError('candidate changed the DataPlugin registry outside its one strategy slot', 'RUNTIME_FAILED')
    }
    if (JSON.stringify(actual.toolSchemas) !== JSON.stringify(expected.toolSchemas)) {
      throw new EvolutionError('candidate changed the DSH model tool schema surface', 'RUNTIME_FAILED')
    }
  }

  private assertBaseline(profile: TaskProfile, candidate: CandidatePackage | null, surface: RuntimeSurface): void {
    const matches = surface.plugins.filter(plugin => plugin.id === profile.strategy_plugin_id)
    if (candidate === null) {
      if (matches.length !== 0) {
        throw new EvolutionError(`strategy ${profile.strategy_plugin_id} is registered without an owned runtime`, 'RUNTIME_STATE')
      }
      return
    }
    if (matches.length !== 1 || matches[0]?.version !== candidate.manifest.strategy_version) {
      throw new EvolutionError(
        `runtime does not contain exactly ${profile.strategy_plugin_id}@${candidate.manifest.strategy_version}`,
        'RUNTIME_STATE',
      )
    }
  }

  private replaceStrategy(
    before: RuntimeSurface,
    profile: TaskProfile,
    previous: CandidatePackage | null,
    candidate: CandidatePackage,
  ): RuntimeSurface {
    this.assertBaseline(profile, previous, before)
    return Object.freeze({
      plugins: Object.freeze([
        ...before.plugins.filter(plugin => plugin.id !== profile.strategy_plugin_id),
        Object.freeze({ id: profile.strategy_plugin_id, version: candidate.manifest.strategy_version }),
      ].sort(compareDescriptors)),
      toolSchemas: before.toolSchemas,
    })
  }

  private removeStrategy(before: RuntimeSurface, profile: TaskProfile): RuntimeSurface {
    return Object.freeze({
      plugins: Object.freeze(before.plugins.filter(plugin => plugin.id !== profile.strategy_plugin_id)),
      toolSchemas: before.toolSchemas,
    })
  }

  private isSlotActive(slot: RuntimeSlot): boolean {
    const packageId = slot.packages.get(slot.activeCandidate.manifest.candidate_id)
    if (packageId === undefined) return false
    try {
      const row = slot.runner.snapshot(slot.agent).find(entry => entry.pluginId === slot.pluginId)
      return row !== undefined && row.activeRun?.packageId === packageId && row.currentPackageId === packageId
    } catch {
      return false
    }
  }

  private hasExpectedStrategy(profile: TaskProfile, candidate: CandidatePackage): boolean {
    const matches = this.host.plugins().filter(plugin => plugin.id === profile.strategy_plugin_id)
    return matches.length === 1 && matches[0]?.version === candidate.manifest.strategy_version
  }

  private runFixture(profile: TaskProfile, candidate: CandidatePackage): void {
    try {
      const binding = candidateFrozenSelectionRuntimeBinding(profile, candidate)
      if (binding === null) {
        runEvolutionFixture(this.host, profile.id, candidate.manifest.generation, profile.strategy_plugin_id)
      } else {
        runFrozenSelectionRuntimeSelfCheck(this.host, binding)
      }
    } catch (error) {
      throw new EvolutionError('candidate failed its bounded runtime self-check', 'RUNTIME_FAILED', {
        profile_id: profile.id,
        candidate_id: candidate.manifest.candidate_id,
        cause: error,
      })
    }
  }

  private assertStrategyAbsent(profile: TaskProfile): void {
    if (this.host.plugins().some(plugin => plugin.id === profile.strategy_plugin_id)) {
      throw new EvolutionError(`strategy ${profile.strategy_plugin_id} is registered without an owned runtime`, 'RUNTIME_STATE')
    }
  }

  private assertH0(profile: TaskProfile): void {
    this.assertStrategyAbsent(profile)
    const matches = this.host.plugins().filter(plugin => plugin.id === H0_PLUGIN_ID)
    if (matches.length !== 1 || matches[0]?.version !== H0_PLUGIN_VERSION) {
      throw new EvolutionError('built-in H0 strategy is unavailable', 'RUNTIME_DEGRADED', {
        profile_id: profile.id,
        candidate_id: H0_CANDIDATE_ID,
      })
    }
  }

  private activationError(
    profile: TaskProfile,
    candidate: CandidatePackage,
    runner: DynamicCordisRunnerService,
    error: unknown,
  ): EvolutionError {
    if (error instanceof CandidateActivationError) return error
    if (error instanceof EvolutionError) {
      if (error.code !== 'RUNTIME_FAILED') return error
      return new CandidateActivationError(error.message, {
        profile_id: profile.id,
        candidate_id: candidate.manifest.candidate_id,
        cause: error,
      })
    }
    if (this.currentRunner() !== runner) {
      return new EvolutionError('DSH dynamicCordisRunner changed during candidate activation', 'RUNTIME_UNAVAILABLE', {
        profile_id: profile.id,
        candidate_id: candidate.manifest.candidate_id,
        cause: error,
      })
    }
    return new CandidateActivationError('candidate activation failed', {
      profile_id: profile.id,
      candidate_id: candidate.manifest.candidate_id,
      cause: error,
    })
  }

  private assertUsable(): void {
    if (this.disposed) throw new EvolutionError('DSH evolution runtime is disposed', 'RUNTIME_UNAVAILABLE')
  }

}

function compareDescriptors(
  left: Readonly<{ id: string; version: string }>,
  right: Readonly<{ id: string; version: string }>,
): number {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1
  return left.version < right.version ? -1 : left.version > right.version ? 1 : 0
}

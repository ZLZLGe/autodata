import { Service, type Context } from '@deepseek-ai/cordis'
import {
  AutoDataCoreError,
  h0DataPlugin,
  runDataCore,
  type DataContext,
  type DataContextRequest,
  type DataPlugin,
  type DataPluginDescriptor,
  type DataRunResult,
  type RegisteredDataRunRequest,
} from './core/index.js'
import { EvolutionController } from './evolution/controller.js'
import { normalizeTaskProfile } from './evolution/profile.js'
import { DshEvolutionRuntime, type EvolutionRuntime } from './evolution/runtime.js'
import { FileEvolutionStore } from './evolution/store.js'
import { ProcessCandidateValidator, type CandidateValidator } from './evolution/validator.js'
import {
  EvolutionError,
  type EvolutionStore,
  type TaskProfile,
  type TaskProfileInput,
} from './evolution/types.js'
import { ExperimentController } from './experiment/controller.js'
import {
  ExperimentError,
  type ExperimentControllerOptions,
} from './experiment/types.js'
import { Stage4AController } from './stage4a/controller.js'
import type {
  Stage4AControllerOptions,
  Stage4AStartRequest,
  Stage4AStatus,
} from './stage4a/types.js'

/** AutoData package version exposed by the Stage 1 service contract. */
export const AUTODATA_VERSION = '0.1.0-rc.1'

/** The capabilities currently exposed by the AutoData bundle. */
export const AUTODATA_CAPABILITIES = Object.freeze([
  'autodata_status',
  'autodata_plugins',
  'autodata_context',
  'autodata_evolution_status',
  'autodata_evolution_feedback',
  'autodata_submit_candidate',
] as const)

/** A read-only snapshot of the live AutoData service. */
export interface AutoDataStatus {
  readonly version: string
  readonly ready: boolean
  readonly capabilities: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autodata: AutoDataService
  }
  interface Events {
    'autodata/plugin-registered': (descriptor: DataPluginDescriptor) => void
    'autodata/plugin-unregistered': (descriptor: DataPluginDescriptor) => void
    'autodata/run-started': (summary: { readonly harness_id: string; readonly generation: number }) => void
    'autodata/run-completed': (summary: { readonly harness_id: string; readonly generation: number; readonly canonical_records: number; readonly logical_training_units: number }) => void
    'autodata/run-failed': (summary: { readonly harness_id: string; readonly generation: number; readonly code: string }) => void
  }
}

interface RegisteredPlugin {
  readonly descriptor: DataPluginDescriptor
  readonly plugin: DataPlugin
}

export interface AutoDataServiceOptions {
  /** Immutable TaskProfiles owned by the Host configuration. */
  readonly profiles?: readonly TaskProfileInput[]
  /** Explicit test seam. Production Bundle startup always uses FileEvolutionStore. */
  readonly store?: EvolutionStore
  readonly validator?: CandidateValidator
  readonly runtime?: EvolutionRuntime
  /** Host-only Stage 4A paths and test seams; never exposed through ctx.autodata. */
  readonly stage4a?: Stage4AControllerOptions
  /** Host-only Stage 4B paths and test seams; the Evolution controller is always injected here. */
  readonly experiment?: Omit<ExperimentControllerOptions, 'evolution'>
}

/** The zero-configuration profile used only when the Store is initially empty. */
export const DEFAULT_TASK_PROFILE: TaskProfile = normalizeTaskProfile({
  id: 'default',
  benchmark: 'autodata-fixture',
  acceptance: { metric: 'score' },
  capabilities: ['data-select', 'data-filter', 'data-order'],
})

interface ConfigValidationIssue {
  readonly message: string
  readonly path?: readonly PropertyKey[]
}

const AUTO_DATA_SERVICE_CONFIG = {
  '~standard': {
    version: 1 as const,
    vendor: '@zlzlge/autodata',
    validate(value: unknown): { value: AutoDataServiceOptions } | { issues: readonly ConfigValidationIssue[] } {
      try {
        return { value: normalizeServiceOptions(value) }
      } catch (error) {
        return { issues: [{ message: errorMessage(error) }] }
      }
    },
  },
}

const evolutionControllers = new WeakMap<AutoDataService, EvolutionController>()
const stage4AControllers = new WeakMap<AutoDataService, Stage4AController>()
const experimentControllers = new WeakMap<AutoDataService, ExperimentController>()
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function originalAutoDataService(service: AutoDataService): AutoDataService {
  const original = (service as unknown as Record<symbol, unknown>)[CORDIS_ORIGINAL]
  return (original ?? service) as AutoDataService
}

/** Trusted Host accessor. The Controller is deliberately absent from ctx.autodata. */
export function getEvolutionController(ctx: Context): EvolutionController {
  const service = ctx.get('autodata', false) as AutoDataService | undefined
  const controller = service === undefined
    ? undefined
    : evolutionControllers.get(originalAutoDataService(service))
  if (controller === undefined) {
    throw new EvolutionError('AutoData evolution controller is unavailable', 'RUNTIME_UNAVAILABLE')
  }
  return controller
}

/** Trusted Host accessor. Stage 4A is deliberately absent from ctx.autodata and model tools. */
export function getStage4AController(ctx: Context): Stage4AController {
  const service = ctx.get('autodata', false) as AutoDataService | undefined
  const controller = service === undefined
    ? undefined
    : stage4AControllers.get(originalAutoDataService(service))
  if (controller === undefined) {
    throw new EvolutionError('AutoData Stage 4A controller is unavailable', 'RUNTIME_UNAVAILABLE')
  }
  return controller
}

/** Trusted Host accessor. Experiments are deliberately absent from ctx.autodata and model tools. */
export function getExperimentController(ctx: Context): ExperimentController {
  const service = ctx.get('autodata', false) as AutoDataService | undefined
  const controller = service === undefined
    ? undefined
    : experimentControllers.get(originalAutoDataService(service))
  if (controller === undefined) {
    throw new ExperimentError('AutoData experiment controller is unavailable', 'DEPENDENCY_UNAVAILABLE')
  }
  return controller
}

/** Start a new Host-owned compatibility run. */
export function startStage4A(ctx: Context, request: Stage4AStartRequest): Stage4AStatus {
  return getStage4AController(ctx).start(request)
}

/** Read durable Stage 4A status without consuming DSH job output. */
export function statusStage4A(ctx: Context, profileId: string, runId: string): Stage4AStatus {
  return getStage4AController(ctx).status(profileId, runId)
}

/** Cancel the live or remotely recoverable RJob for one run. */
export function cancelStage4A(ctx: Context, profileId: string, runId: string): Promise<Stage4AStatus> {
  return getStage4AController(ctx).cancel(profileId, runId)
}

/** Resume monitoring from durable state without blindly repeating a submission. */
export function resumeStage4A(ctx: Context, profileId: string, runId: string): Stage4AStatus {
  return getStage4AController(ctx).resume(profileId, runId)
}

/** AutoData's in-memory data Core mounted into the shared DSH Cordis context. */
export class AutoDataService extends Service {
  static Config = AUTO_DATA_SERVICE_CONFIG

  private readonly registry = new Map<string, RegisteredPlugin>()

  constructor(ctx: Context, options: AutoDataServiceOptions = {}) {
    options = normalizeServiceOptions(options)
    super(ctx, 'autodata')
    const h0 = snapshotPlugin(h0DataPlugin)
    this.registry.set(h0.descriptor.id, h0)
    const controller = new EvolutionController({
      store: options.store ?? new FileEvolutionStore(),
      validator: options.validator ?? new ProcessCandidateValidator(),
      runtime: options.runtime ?? new DshEvolutionRuntime(ctx, this),
    })
    evolutionControllers.set(originalAutoDataService(this), controller)
    this.ctx.effect(() => async () => {
      try {
        await controller.dispose()
      } finally {
        evolutionControllers.delete(originalAutoDataService(this))
      }
    }, 'autodata.evolution-controller')

    const existingProfiles = controller.profiles()
    const configuredProfiles = options.profiles
      ?? (existingProfiles.length === 0 ? [DEFAULT_TASK_PROFILE] : existingProfiles)
    controller.ensureProfiles(configuredProfiles)

    const stage4a = new Stage4AController(ctx, {
      ...options.stage4a,
      profile_exists: profileId => controller.profiles().some(profile => profile.id === profileId),
    })
    stage4AControllers.set(originalAutoDataService(this), stage4a)
    this.ctx.effect(() => async () => {
      try {
        await stage4a.dispose()
      } finally {
        stage4AControllers.delete(originalAutoDataService(this))
      }
    }, 'autodata.stage4a-controller')

    const experiment = new ExperimentController(ctx, {
      ...options.experiment,
      evolution: controller,
    })
    experimentControllers.set(originalAutoDataService(this), experiment)
    this.ctx.effect(() => async () => {
      try {
        await experiment.dispose()
      } finally {
        experimentControllers.delete(originalAutoDataService(this))
      }
    }, 'autodata.experiment-controller')
  }

  /** Return deterministic in-memory status without reading project or run data. */
  status(): AutoDataStatus {
    return Object.freeze({
      version: AUTODATA_VERSION,
      ready: true,
      capabilities: AUTODATA_CAPABILITIES,
    })
  }

  /** Register a trusted host plugin and return an exact, idempotent disposer. */
  register(plugin: DataPlugin): () => void {
    if (hasAgentScope(this.ctx)) {
      throw new AutoDataCoreError(
        'DataPlugin registration is only available from the host scope',
        'HOST_SCOPE_REQUIRED',
      )
    }
    const registered = snapshotPlugin(plugin)
    if (this.registry.has(registered.descriptor.id)) {
      throw new AutoDataCoreError(
        `DataPlugin ${registered.descriptor.id} is already registered`,
        'PLUGIN_ALREADY_REGISTERED',
        { plugin_id: registered.descriptor.id },
      )
    }

    // Register through Cordis' effect mechanism so the caller's Bundle/fiber
    // owns the exact plugin snapshot. Service construction itself owns H0.
    let active = true
    const remove = () => {
      if (!active) return
      active = false
      const current = this.registry.get(registered.descriptor.id)
      if (current !== registered) return
      this.registry.delete(registered.descriptor.id)
      emitContained(this.ctx, 'autodata/plugin-unregistered', registered.descriptor)
    }
    this.registry.set(registered.descriptor.id, registered)
    emitContained(this.ctx, 'autodata/plugin-registered', registered.descriptor)
    try {
      const effect = this.ctx.effect(() => remove, 'autodata.register()')
      // The public disposer tears down the effect; its return value may be a
      // promise, but the Core registry itself remains synchronous.
      return effect
    } catch (error) {
      remove()
      throw error
    }
  }

  /** Return sorted immutable plugin descriptors without executable callbacks. */
  plugins(): readonly DataPluginDescriptor[] {
    return Object.freeze([...this.registry.values()]
      .map(entry => entry.descriptor)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  /** Run an explicit in-memory source pipeline against a plugin snapshot. */
  run(request: RegisteredDataRunRequest): DataRunResult {
    const requestValue: unknown = request
    if (typeof requestValue !== 'object' || requestValue === null || Array.isArray(requestValue)) {
      throw new AutoDataCoreError('run request must be an object', 'INVALID_RUN_REQUEST')
    }
    const value = requestValue as Record<string, unknown>
    const pluginIds = value.plugin_ids
    if (!Array.isArray(pluginIds)) {
      throw new AutoDataCoreError('plugin_ids must be an array', 'INVALID_RUN_REQUEST')
    }
    const seen = new Set<string>()
    const plugins: DataPlugin[] = []
    for (const id of pluginIds) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new AutoDataCoreError('plugin_ids must contain non-empty strings', 'INVALID_RUN_REQUEST')
      }
      if (seen.has(id)) {
        throw new AutoDataCoreError(`plugin_ids contains duplicate id ${id}`, 'INVALID_RUN_REQUEST', { plugin_id: id })
      }
      seen.add(id)
      const registered = this.registry.get(id)
      if (!registered) {
        throw new AutoDataCoreError(`DataPlugin ${id} is not registered`, 'PLUGIN_NOT_FOUND', { plugin_id: id })
      }
      plugins.push(registered.plugin)
    }

    const started = Object.freeze({
      harness_id: typeof value.harness_id === 'string' ? value.harness_id : '',
      generation: typeof value.generation === 'number' && Number.isSafeInteger(value.generation)
        ? value.generation
        : 0,
    })
    emitContained(this.ctx, 'autodata/run-started', started)
    try {
      const result = runDataCore({ ...value, plugins } as RegisteredDataRunRequest & { plugins: DataPlugin[] })
      emitContained(this.ctx, 'autodata/run-completed', Object.freeze({
        ...started,
        canonical_records: result.summary.counts.canonical_records,
        logical_training_units: result.summary.counts.logical_training_units,
      }))
      return result
    } catch (error) {
      const code = error instanceof AutoDataCoreError ? error.code : 'PLUGIN_FAILED'
      emitContained(this.ctx, 'autodata/run-failed', Object.freeze({ ...started, code }))
      throw error
    }
  }

  /** Build a deep-frozen structural snapshot of the current DSH scope. */
  context(request?: DataContextRequest): DataContext {
    const agent = resolveAgent(this.ctx, request)
    return buildDataContext(this.ctx, agent, this.plugins())
  }
}

function normalizeServiceOptions(value: unknown): AutoDataServiceOptions {
  if (value === undefined) value = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('AutoData service config must be an object')
  }
  const input = value as Record<string, unknown>
  const allowed = new Set(['profiles', 'store', 'validator', 'runtime', 'stage4a', 'experiment'])
  const extra = Object.keys(input).find(key => !allowed.has(key))
  if (extra !== undefined) throw new TypeError(`AutoData service config has unsupported field ${extra}`)

  let profiles: readonly TaskProfile[] | undefined
  if (input.profiles !== undefined) {
    if (!Array.isArray(input.profiles) || input.profiles.length === 0) {
      throw new TypeError('AutoData service config profiles must be a non-empty array')
    }
    profiles = Object.freeze(input.profiles.map((profile, index) => {
      try {
        return normalizeTaskProfile(profile as TaskProfileInput)
      } catch (error) {
        throw new TypeError(`AutoData service config profiles[${String(index)}]: ${errorMessage(error)}`, {
          cause: error,
        })
      }
    }))
  }

  return {
    ...(profiles === undefined ? {} : { profiles }),
    ...(input.store === undefined ? {} : { store: input.store as EvolutionStore }),
    ...(input.validator === undefined ? {} : { validator: input.validator as CandidateValidator }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime as EvolutionRuntime }),
    ...(input.stage4a === undefined ? {} : { stage4a: input.stage4a as Stage4AControllerOptions }),
    ...(input.experiment === undefined
      ? {}
      : { experiment: input.experiment as Omit<ExperimentControllerOptions, 'evolution'> }),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function snapshotPlugin(plugin: DataPlugin): RegisteredPlugin {
  const value: unknown = plugin
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutoDataCoreError('DataPlugin must be an object', 'INVALID_PLUGIN')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(candidate.id)) {
    throw new AutoDataCoreError('DataPlugin id must match /^[a-z][a-z0-9-]*$/', 'INVALID_PLUGIN')
  }
  if (typeof candidate.version !== 'string' || candidate.version.length === 0) {
    throw new AutoDataCoreError(`DataPlugin ${candidate.id} must declare a version`, 'INVALID_PLUGIN', { plugin_id: candidate.id })
  }
  if (typeof candidate.run !== 'function') {
    throw new AutoDataCoreError(`DataPlugin ${candidate.id} must declare run()`, 'INVALID_PLUGIN', { plugin_id: candidate.id })
  }
  const descriptor = Object.freeze({ id: candidate.id, version: candidate.version })
  const run = candidate.run as DataPlugin['run']
  const snapshot = Object.freeze({
    id: descriptor.id,
    version: descriptor.version,
    run(input: Parameters<DataPlugin['run']>[0], context: Parameters<DataPlugin['run']>[1]) {
      return run.call(snapshot, input, context)
    },
  }) as DataPlugin
  return { descriptor, plugin: snapshot }
}

function hasAgentScope(ctx: Context): boolean {
  return readAgentAssociation(ctx) !== undefined
}

/**
 * Read the optional DSH agent association without requiring the dsh-agent
 * package as a runtime dependency. Agent contexts expose `agent` as an own
 * (inherited by child contexts) property; plain Cordis contexts may throw when
 * an undeclared property is read through the proxy, so keep this probe safe.
 */
function readAgentAssociation(ctx: Context): unknown {
  try {
    return (ctx as unknown as { readonly agent?: unknown }).agent
  } catch {
    return undefined
  }
}

function emitContained<K extends keyof import('@deepseek-ai/cordis').Events>(
  ctx: Context,
  event: K,
  ...args: Parameters<import('@deepseek-ai/cordis').Events[K]>
): void {
  try {
    void ctx.parallel(event, ...args).catch(error => {
      // Events are notifications only. A listener cannot undo a committed Core
      // state change or make a successful run fail.
      try { ctx.logger.error(error) } catch { /* host logger is optional in tests */ }
    })
  } catch (error) {
    try { ctx.logger.error(error) } catch { /* host logger is optional in tests */ }
  }
}

function resolveAgent(ctx: Context, request: DataContextRequest | undefined): unknown {
  if (request && typeof request === 'object' && 'agent' in request) {
    return (request as { readonly agent?: unknown }).agent
  }
  if (request?.agent_id !== undefined) {
    const agents = ctx.get('agents', false) as { get?: (id: string) => unknown } | undefined
    return typeof agents?.get === 'function' ? agents.get(request.agent_id) : undefined
  }
  return readAgentAssociation(ctx)
}

function buildDataContext(ctx: Context, agent: unknown, plugins: readonly DataPluginDescriptor[]): DataContext {
  const agentSession = agent && typeof agent === 'object'
    ? (agent as Record<string, unknown>).session
    : undefined
  const sessionValue = agentSession ?? ctx.get('session', false)
  const sessionProjection = readSession(sessionValue)
  const session = sessionProjection?.snapshot
  const agentSnapshot = readAgent(agent)
  const tools = readTools(ctx, agent)
  const workspace = readWorkspace(ctx, sessionProjection?.cwd)
  const result: Record<string, unknown> = {
    schema_version: 'autodata-context-1',
    plugins: plugins.map(plugin => Object.freeze({ ...plugin })),
  }
  if (session) result.session = session
  if (agentSnapshot) result.agent = agentSnapshot
  if (workspace) result.workspace = workspace
  if (tools) result.tools = tools
  return deepFreeze(result) as unknown as DataContext
}

interface SessionProjection {
  readonly snapshot: NonNullable<DataContext['session']>
  readonly cwd?: string
}

function readSession(value: unknown): SessionProjection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const id = candidate.id
  const seqValue = candidate.seq
  if (typeof id !== 'string' || typeof seqValue !== 'number' || !Number.isSafeInteger(seqValue)) return undefined
  const seq = seqValue
  const header = candidate.header
  const headerCwd = header && typeof header === 'object' && typeof (header as Record<string, unknown>).cwd === 'string'
    ? (header as Record<string, unknown>).cwd as string
    : undefined
  const cwd = headerCwd ?? (typeof candidate.cwd === 'string' ? candidate.cwd : undefined)
  return Object.freeze({
    snapshot: Object.freeze({ id, seq }),
    ...(cwd === undefined ? {} : { cwd }),
  })
}

/** Project optional DSH workspace metadata without retaining the live service. */
function readWorkspace(ctx: Context, sessionCwd: string | undefined): DataContext['workspace'] | undefined {
  let value: unknown
  try {
    value = ctx.get('workspace', false) ?? ctx.get('workspaceRegistry', false)
  } catch {
    value = undefined
  }
  const result: Record<string, unknown> = {}
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>
    if (typeof candidate.id === 'string') result.id = candidate.id
    if (typeof candidate.title === 'string') result.title = candidate.title
    if (typeof candidate.cwd === 'string') result.cwd = candidate.cwd
    if (typeof candidate.path === 'string' && result.cwd === undefined) result.cwd = candidate.path
  }
  if (result.cwd === undefined && sessionCwd !== undefined) result.cwd = sessionCwd
  return Object.keys(result).length === 0 ? undefined : deepFreeze(result) as DataContext['workspace']
}

function readAgent(value: unknown): DataContext['agent'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string') return undefined
  const status = candidate.status === 'running' || candidate.status === 'idle'
    ? candidate.status
    : 'unknown'
  return Object.freeze({ id: candidate.id, status })
}

function readTools(ctx: Context, agent: unknown): DataContext['tools'] | undefined {
  const tools = ctx.get('tools', false) as { schemas?: (scope?: unknown) => unknown } | undefined
  if (!tools || typeof tools.schemas !== 'function') return undefined
  const schemas = tools.schemas(agent)
  if (!Array.isArray(schemas)) return undefined
  return Object.freeze(schemas.map((schema: unknown) => {
    if (!schema || typeof schema !== 'object') return Object.freeze({ name: '', parameters: {} })
    const value = schema as Record<string, unknown>
    const result: Record<string, unknown> = {
      name: typeof value.name === 'string' ? value.name : '',
      parameters: cloneJson(value.parameters ?? {}),
    }
    if (typeof value.description === 'string') result.description = value.description
    return deepFreeze(result) as unknown as NonNullable<DataContext['tools']>[number]
  }))
}

function cloneJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneJson)
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) result[key] = cloneJson(entry)
  return result
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export default AutoDataService

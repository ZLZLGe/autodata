/**
 * Build the only Host source that AutoData gives to Dynamic Cordis Runner.
 *
 * The upstream Runner intentionally exposes a general-purpose Context facade.
 * Stage 4C candidates need a much smaller authority: one synchronous call to
 * `ctx.autodata.register()`.  Keeping this wrapper in AutoData also makes the
 * validation, materialization, and accepted-runtime environments identical.
 * This is capability minimization, not an OS sandbox: node:vm still requires
 * the process validation and deterministic materialization gates around it.
 */

import { createHash } from 'node:crypto'
import { canonicalJson, immutableJson, isJsonObject } from '../core/json.js'
import type { JsonObject } from '../core/types.js'
import {
  EvolutionError,
  MAX_HOST_SOURCE_BYTES,
  type CandidatePackage,
  type TaskProfile,
} from './types.js'

const WRAPPER_VERSION = 'autodata-restricted-data-plugin-1'
export const FROZEN_SELECTION_RUNTIME_VERSION = 'autodata-frozen-selection-runtime-1'
const SHA256 = /^[a-f0-9]{64}$/u
const MAX_RUNTIME_RECORDS = 10_000
const MAX_RUNTIME_TEXT_LENGTH = 8_192
const MAX_RUNTIME_BINDING_BYTES = 8 * 1024 * 1024

export interface FrozenSelectionDecision {
  readonly record_id: string
  readonly note?: string
}

export interface FrozenSelectionRuntimeBinding {
  readonly schema_version: typeof FROZEN_SELECTION_RUNTIME_VERSION
  readonly profile_id: string
  readonly candidate_id: string
  readonly generation: number
  readonly parent_candidate_id: string
  readonly plugin_id: string
  readonly strategy_version: string
  readonly host_source_sha256: string
  readonly source_pool_sha256: string
  readonly materialization_sha256: string
  readonly harness_id: string
  readonly seed: number
  readonly source: {
    readonly adapter_id: string
    readonly adapter_version: string
    readonly dataset_id: string
    readonly dataset_revision: string
  }
  readonly source_record_ids: readonly string[]
  readonly decisions: readonly FrozenSelectionDecision[]
  readonly runtime_plan_sha256: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RUNTIME_TEXT_LENGTH) {
    throw new EvolutionError(`${label} must be a non-empty string`, 'INVALID_CANDIDATE')
  }
  return value
}

function sha(value: unknown, label: string): string {
  const result = nonEmptyText(value, label)
  if (!SHA256.test(result)) throw new EvolutionError(`${label} must be lowercase SHA-256`, 'INVALID_CANDIDATE')
  return result
}

function normalizeStringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RUNTIME_RECORDS) {
    throw new EvolutionError(`${label} must be a non-empty array`, 'INVALID_CANDIDATE')
  }
  const result = value.map((entry, index) => nonEmptyText(entry, `${label}[${String(index)}]`))
  if (new Set(result).size !== result.length) {
    throw new EvolutionError(`${label} must contain unique values`, 'INVALID_CANDIDATE')
  }
  return Object.freeze(result)
}

function normalizeSourceIdentity(value: unknown): FrozenSelectionRuntimeBinding['source'] {
  if (!isJsonObject(value)) {
    throw new EvolutionError('runtime binding source must be an object', 'INVALID_CANDIDATE')
  }
  const fields = ['adapter_id', 'adapter_version', 'dataset_id', 'dataset_revision'] as const
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) {
    throw new EvolutionError('runtime binding source has an invalid shape', 'INVALID_CANDIDATE')
  }
  return Object.freeze({
    adapter_id: nonEmptyText(value.adapter_id, 'runtime binding source.adapter_id'),
    adapter_version: nonEmptyText(value.adapter_version, 'runtime binding source.adapter_version'),
    dataset_id: nonEmptyText(value.dataset_id, 'runtime binding source.dataset_id'),
    dataset_revision: nonEmptyText(value.dataset_revision, 'runtime binding source.dataset_revision'),
  })
}

function runtimePlan(binding: Omit<FrozenSelectionRuntimeBinding, 'runtime_plan_sha256'>): JsonObject {
  return binding as unknown as JsonObject
}

/** Build the immutable, hash-bound runtime artifact for a materialized Stage 4C selection. */
export function createFrozenSelectionRuntimeBinding(input: {
  readonly profile_id: string
  readonly candidate_id: string
  readonly generation: number
  readonly parent_candidate_id: string
  readonly plugin_id: string
  readonly strategy_version: string
  readonly host_source_sha256: string
  readonly source_pool_sha256: string
  readonly materialization_sha256: string
  readonly harness_id: string
  readonly seed: number
  readonly source: FrozenSelectionRuntimeBinding['source']
  readonly source_record_ids: readonly string[]
  readonly decisions: readonly FrozenSelectionDecision[]
}): FrozenSelectionRuntimeBinding {
  const sourceRecordIds = normalizeStringList(input.source_record_ids, 'runtime binding source_record_ids')
  if (!Array.isArray(input.decisions) || input.decisions.length === 0) {
    throw new EvolutionError('runtime binding decisions must be a non-empty array', 'INVALID_CANDIDATE')
  }
  if (input.decisions.length > sourceRecordIds.length) {
    throw new EvolutionError('runtime binding decisions cannot exceed source_record_ids', 'INVALID_CANDIDATE')
  }
  const sourceIds = new Set(sourceRecordIds)
  const seen = new Set<string>()
  const decisions = input.decisions.map((entry, index): FrozenSelectionDecision => {
    if (!isJsonObject(entry)) {
      throw new EvolutionError(`runtime binding decisions[${String(index)}] must be an object`, 'INVALID_CANDIDATE')
    }
    const keys = Object.keys(entry)
    if (
      !Object.hasOwn(entry, 'record_id')
      || keys.some(key => key !== 'record_id' && key !== 'note')
      || keys.length !== (entry.note === undefined ? 1 : 2)
    ) throw new EvolutionError(`runtime binding decisions[${String(index)}] has an invalid shape`, 'INVALID_CANDIDATE')
    const recordId = nonEmptyText(entry.record_id, `runtime binding decisions[${String(index)}].record_id`)
    if (!sourceIds.has(recordId) || seen.has(recordId)) {
      throw new EvolutionError('runtime binding decisions must uniquely select from source_record_ids', 'INVALID_CANDIDATE')
    }
    seen.add(recordId)
    if (
      entry.note !== undefined
      && (typeof entry.note !== 'string' || entry.note.length > MAX_RUNTIME_TEXT_LENGTH)
    ) {
      throw new EvolutionError(`runtime binding decisions[${String(index)}].note must be a string`, 'INVALID_CANDIDATE')
    }
    const note = entry.note
    return Object.freeze({ record_id: recordId, ...(note === undefined ? {} : { note }) })
  })
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new EvolutionError('runtime binding generation must be a positive safe integer', 'INVALID_CANDIDATE')
  }
  if (!Number.isSafeInteger(input.seed)) {
    throw new EvolutionError('runtime binding seed must be a safe integer', 'INVALID_CANDIDATE')
  }
  const plan = Object.freeze({
    schema_version: FROZEN_SELECTION_RUNTIME_VERSION,
    profile_id: nonEmptyText(input.profile_id, 'runtime binding profile_id'),
    candidate_id: nonEmptyText(input.candidate_id, 'runtime binding candidate_id'),
    generation: input.generation,
    parent_candidate_id: nonEmptyText(input.parent_candidate_id, 'runtime binding parent_candidate_id'),
    plugin_id: nonEmptyText(input.plugin_id, 'runtime binding plugin_id'),
    strategy_version: nonEmptyText(input.strategy_version, 'runtime binding strategy_version'),
    host_source_sha256: sha(input.host_source_sha256, 'runtime binding host_source_sha256'),
    source_pool_sha256: sha(input.source_pool_sha256, 'runtime binding source_pool_sha256'),
    materialization_sha256: sha(input.materialization_sha256, 'runtime binding materialization_sha256'),
    harness_id: nonEmptyText(input.harness_id, 'runtime binding harness_id'),
    seed: input.seed,
    source: normalizeSourceIdentity(input.source),
    source_record_ids: sourceRecordIds,
    decisions: Object.freeze(decisions),
  })
  const result = immutableJson({
    ...plan,
    runtime_plan_sha256: sha256(canonicalJson(runtimePlan(plan))),
  }) as unknown as FrozenSelectionRuntimeBinding
  if (Buffer.byteLength(canonicalJson(result), 'utf8') > MAX_RUNTIME_BINDING_BYTES) {
    throw new EvolutionError('runtime binding exceeds 8 MiB', 'INVALID_CANDIDATE')
  }
  return result
}

/** Strictly revalidate a persisted binding before compiling trusted runtime code. */
export function normalizeFrozenSelectionRuntimeBinding(value: unknown): FrozenSelectionRuntimeBinding {
  if (!isJsonObject(value)) throw new EvolutionError('candidate runtime_binding must be an object', 'INVALID_CANDIDATE')
  const expected = [
    'schema_version', 'profile_id', 'candidate_id', 'generation', 'parent_candidate_id',
    'plugin_id', 'strategy_version', 'host_source_sha256', 'source_pool_sha256',
    'materialization_sha256', 'harness_id', 'seed', 'source', 'source_record_ids',
    'decisions', 'runtime_plan_sha256',
  ] as const
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw new EvolutionError('candidate runtime_binding has an invalid shape', 'INVALID_CANDIDATE')
  }
  if (value.schema_version !== FROZEN_SELECTION_RUNTIME_VERSION) {
    throw new EvolutionError('candidate runtime_binding schema is unsupported', 'INVALID_CANDIDATE')
  }
  const normalized = createFrozenSelectionRuntimeBinding({
    profile_id: value.profile_id as string,
    candidate_id: value.candidate_id as string,
    generation: value.generation as number,
    parent_candidate_id: value.parent_candidate_id as string,
    plugin_id: value.plugin_id as string,
    strategy_version: value.strategy_version as string,
    host_source_sha256: value.host_source_sha256 as string,
    source_pool_sha256: value.source_pool_sha256 as string,
    materialization_sha256: value.materialization_sha256 as string,
    harness_id: value.harness_id as string,
    seed: value.seed as number,
    source: value.source as FrozenSelectionRuntimeBinding['source'],
    source_record_ids: value.source_record_ids as string[],
    decisions: value.decisions as unknown as FrozenSelectionDecision[],
  })
  if (value.runtime_plan_sha256 !== normalized.runtime_plan_sha256) {
    throw new EvolutionError('candidate runtime_binding digest changed', 'INVALID_CANDIDATE')
  }
  return normalized
}

/** Resolve and cross-check the frozen runtime plan carried by a formal candidate. */
export function candidateFrozenSelectionRuntimeBinding(
  profile: TaskProfile,
  candidate: CandidatePackage,
): FrozenSelectionRuntimeBinding | null {
  const metadata = candidate.manifest.metadata
  const bindingValue = metadata?.runtime_binding
  if (bindingValue === undefined) {
    if (metadata?.generation_run_id !== undefined || metadata?.materialization_sha256 !== undefined) {
      throw new EvolutionError('formal generation candidate is missing runtime_binding', 'INVALID_CANDIDATE')
    }
    return null
  }
  const binding = normalizeFrozenSelectionRuntimeBinding(bindingValue)
  if (
    binding.profile_id !== profile.id
    || binding.candidate_id !== candidate.manifest.candidate_id
    || binding.generation !== candidate.manifest.generation
    || binding.parent_candidate_id !== candidate.manifest.parent_candidate_id
    || binding.plugin_id !== profile.strategy_plugin_id
    || binding.strategy_version !== candidate.manifest.strategy_version
    || binding.host_source_sha256 !== sha256(candidate.host_source)
    || metadata?.source_sha256 !== binding.host_source_sha256
    || metadata?.materialization_sha256 !== binding.materialization_sha256
  ) throw new EvolutionError('candidate runtime_binding does not match its manifest and source', 'INVALID_CANDIDATE')
  return binding
}

/**
 * Compile formal Stage 4C candidates to a bounded, data-only runtime plugin.
 * Raw model-authored code is used only by isolated validation/materialization
 * workers and is never evaluated in the long-lived Host process.
 */
export function candidateRuntimeHostSource(profile: TaskProfile, candidate: CandidatePackage): string {
  const binding = candidateFrozenSelectionRuntimeBinding(profile, candidate)
  if (binding === null) return restrictedDataPluginHostSource(candidate.host_source)

  const sourceIds = JSON.stringify(binding.source_record_ids)
  const decisions = JSON.stringify(binding.decisions)
  const pluginId = JSON.stringify(binding.plugin_id)
  const version = JSON.stringify(binding.strategy_version)
  const harnessId = JSON.stringify(binding.harness_id)
  const generation = JSON.stringify(binding.generation)
  const seed = JSON.stringify(binding.seed)
  const source = JSON.stringify(binding.source)
  return restrictedDataPluginHostSource(`
    const sourceRecordIds = ${sourceIds}
    const decisions = ${decisions}
    const expectedSource = ${source}
    return {
      inject: ['autodata'],
      apply(ctx) {
        ctx.autodata.register({
          id: ${pluginId},
          version: ${version},
          run(input, context) {
            const inputIds = input.map((item) => item.record.source.record_id)
            if (
              context.harness_id !== ${harnessId}
              || context.generation !== ${generation}
              || context.seed !== ${seed}
              || context.source.adapter_id !== expectedSource.adapter_id
              || context.source.adapter_version !== expectedSource.adapter_version
              || context.source.dataset_id !== expectedSource.dataset_id
              || context.source.dataset_revision !== expectedSource.dataset_revision
              ||
              inputIds.length !== sourceRecordIds.length
              || inputIds.some((recordId, index) => recordId !== sourceRecordIds[index])
            ) throw new Error('frozen candidate runtime received a different source pool')
            return decisions.map((decision) => ({ ...decision }))
          },
        })
      },
    }
  `)
}

/**
 * Evaluate candidate source in the Runner VM, but invoke its plugin through a
 * capability facade that contains exactly `autodata.register`.
 *
 * The registered DataPlugin is rebuilt by the wrapper.  Its `run()` receives
 * VM-realm JSON copies instead of Host-realm objects, and its result is copied
 * once more before crossing back into the Core.  This prevents constructor or
 * prototype traversal through Host-owned input values.
 */
export function restrictedDataPluginHostSource(hostSource: string): string {
  if (typeof hostSource !== 'string' || hostSource.trim().length === 0) {
    throw new EvolutionError('candidate host_source must be a non-empty string', 'INVALID_CANDIDATE')
  }
  if (Buffer.byteLength(hostSource, 'utf8') > MAX_HOST_SOURCE_BYTES) {
    throw new EvolutionError('candidate host source exceeds 256 KiB', 'INVALID_CANDIDATE')
  }

  // DataPlugin declarations are deliberately synchronous.  Keeping the
  // nested evaluator synchronous also leaves source evaluation and shape
  // inspection inside Dynamic Cordis Runner's vmTimeout window.
  const evaluatedSource = JSON.stringify(`(() => {\n'use strict';\n${hostSource}\n})()`)
  return `'use strict';
const __adArrayIsArray = Array.isArray;
const __adArrayIncludes = Array.prototype.includes;
const __adArrayPrototype = Array.prototype;
const __adArraySome = Array.prototype.some;
const __adCreate = Object.create;
const __adDefine = Object.defineProperty;
const __adFreeze = Object.freeze;
const __adGetDescriptor = Object.getOwnPropertyDescriptor;
const __adGetPrototype = Object.getPrototypeOf;
const __adHasOwn = Object.prototype.hasOwnProperty;
const __adObjectPrototype = Object.prototype;
const __adFunctionPrototype = Function.prototype;
const __adPromise = Promise;
const __adPromisePrototype = Promise.prototype;
const __adErrorPrototype = Error.prototype;
const __adWeakSet = WeakSet;
const __adWeakSetAdd = WeakSet.prototype.add;
const __adWeakSetHas = WeakSet.prototype.has;
const __adOwnKeys = Reflect.ownKeys;
const __adApply = Reflect.apply;
const __adJsonParse = JSON.parse;
const __adJsonStringify = JSON.stringify;
const __adProxy = Proxy;
const __adError = Error;
const __adEval = eval;
const __adGlobal = globalThis;
const __adSource = ${evaluatedSource};

const __adOwnedErrors = new __adWeakSet();
const __adFail = (message) => {
  const error = new __adError(message);
  __adApply(__adWeakSetAdd, __adOwnedErrors, [error]);
  __adFreeze(error);
  throw error;
};
const __adSanitizeError = (error, message) => {
  if (
    typeof error === 'object'
    && error !== null
    && __adApply(__adWeakSetHas, __adOwnedErrors, [error])
  ) throw error;
  return __adFail(message);
};
const __adDataProperty = (object, key, value, enumerable = true) => {
  __adDefine(object, key, { value, enumerable, configurable: false, writable: false });
};
const __adRequireDataProperty = (object, key, label) => {
  const descriptor = __adGetDescriptor(object, key);
  if (descriptor === undefined || !__adApply(__adHasOwn, descriptor, ['value'])) {
    return __adFail(label + ' must be an own data property');
  }
  return descriptor.value;
};
const __adRequirePlainRecord = (value, label) => {
  if (typeof value !== 'object' || value === null || __adArrayIsArray(value)) {
    return __adFail(label + ' must be a plain object');
  }
  const prototype = __adGetPrototype(value);
  if (prototype !== __adObjectPrototype && prototype !== null) {
    return __adFail(label + ' must be a plain object');
  }
  return value;
};
const __adRequireExactKeys = (value, required, optional, label) => {
  const keys = __adOwnKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (
      typeof key !== 'string'
      || (!__adApply(__adArrayIncludes, required, [key]) && !__adApply(__adArrayIncludes, optional, [key]))
    ) {
      return __adFail(label + ' contains an unsupported property');
    }
  }
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (!__adApply(__adArrayIncludes, keys, [key])) return __adFail(label + ' is missing ' + key);
  }
};
const __adJsonCopy = (value, label) => {
  const text = __adApply(__adJsonStringify, undefined, [value]);
  if (typeof text !== 'string') return __adFail(label + ' must be JSON-compatible');
  return __adApply(__adJsonParse, undefined, [text]);
};

// DataPlugin candidates never need any Host-realm helper installed by the
// general-purpose Runner.  Even an apparently harmless Host function (for
// example console.log) exposes its Host Function constructor in node:vm, so
// remove the complete Runner-supplied set before evaluating candidate code.
for (const __adName of [
  'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder',
  'require', 'fetch', 'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval',
  // A contextified global inherits these from the Host-created sandbox
  // object.  Direct reads therefore expose Host-realm functions even though
  // Object.getPrototypeOf(globalThis) presents a VM-realm prototype.
  'constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty',
  '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf',
  'propertyIsEnumerable', 'toString', 'valueOf', '__proto__',
  'toLocaleString',
]) {
  __adDefine(__adGlobal, __adName, {
    value: undefined,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
__adFreeze(__adObjectPrototype);
__adFreeze(__adArrayPrototype);
__adFreeze(__adFunctionPrototype);
__adFreeze(__adPromisePrototype);
__adFreeze(__adPromise);
__adFreeze(__adErrorPrototype);
__adFreeze(__adError);
__adFreeze(__adWeakSet.prototype);

let __adCandidate;
let __adCandidateApply;
try {
  __adCandidate = (0, __adEval)(__adSource);
  __adRequirePlainRecord(__adCandidate, 'candidate Host plugin');
  __adRequireExactKeys(__adCandidate, ['inject', 'apply'], ['name'], 'candidate Host plugin');
  const __adInject = __adRequireDataProperty(__adCandidate, 'inject', 'candidate inject');
  if (
    !__adArrayIsArray(__adInject)
    || __adGetPrototype(__adInject) !== __adArrayPrototype
    || __adInject.length !== 1
    || __adInject[0] !== 'autodata'
    || __adApply(__adArraySome, __adOwnKeys(__adInject), [key => key !== '0' && key !== 'length'])
  ) __adFail('candidate inject must be exactly ["autodata"]');
  __adCandidateApply = __adRequireDataProperty(__adCandidate, 'apply', 'candidate apply');
  if (typeof __adCandidateApply !== 'function') __adFail('candidate apply must be a function');
  if (__adGetDescriptor(__adCandidate, 'name') !== undefined) {
    const name = __adRequireDataProperty(__adCandidate, 'name', 'candidate name');
    if (typeof name !== 'string' || name.length === 0) __adFail('candidate name must be a non-empty string');
  }
} catch (__adCandidateError) {
  __adSanitizeError(__adCandidateError, 'candidate Host source or plugin shape failed in the tool-free sandbox');
}

return {
  name: ${JSON.stringify(WRAPPER_VERSION)},
  inject: ['autodata'],
  apply(__adHostContext) {
    const __adHostAutodata = __adHostContext.autodata;
    const __adHostRegister = __adHostAutodata.register;
    let __adFacadeActive = true;
    let __adRegisterAttempted = false;
    let __adRegistered = false;

    const __adRegister = (__adPluginInput) => {
      if (!__adFacadeActive) return __adFail('candidate autodata.register capability has expired');
      if (__adRegisterAttempted) return __adFail('candidate must call autodata.register exactly once');
      __adRegisterAttempted = true;
      const __adPlugin = __adRequirePlainRecord(__adPluginInput, 'candidate DataPlugin');
      __adRequireExactKeys(__adPlugin, ['id', 'version', 'run'], [], 'candidate DataPlugin');
      const __adId = __adRequireDataProperty(__adPlugin, 'id', 'candidate DataPlugin id');
      const __adVersion = __adRequireDataProperty(__adPlugin, 'version', 'candidate DataPlugin version');
      const __adRun = __adRequireDataProperty(__adPlugin, 'run', 'candidate DataPlugin run');
      if (typeof __adId !== 'string' || typeof __adVersion !== 'string' || typeof __adRun !== 'function') {
        return __adFail('candidate DataPlugin must contain string id/version and function run');
      }

      const __adRestrictedPlugin = __adCreate(null);
      __adDataProperty(__adRestrictedPlugin, 'id', __adId);
      __adDataProperty(__adRestrictedPlugin, 'version', __adVersion);
      __adDataProperty(__adRestrictedPlugin, 'run', function (__adHostInput, __adHostPluginContext) {
        try {
          const __adInput = __adJsonCopy(__adHostInput, 'candidate DataPlugin input');
          const __adPluginContext = __adJsonCopy(__adHostPluginContext, 'candidate DataPlugin context');
          const __adDecisions = __adApply(__adRun, __adPlugin, [__adInput, __adPluginContext]);
          if (!__adArrayIsArray(__adDecisions)) {
            return __adFail('candidate DataPlugin run must return a synchronous array');
          }
          return __adJsonCopy(__adDecisions, 'candidate DataPlugin decisions');
        } catch (__adRunError) {
          return __adSanitizeError(__adRunError, 'candidate DataPlugin run failed');
        }
      });
      __adFreeze(__adRestrictedPlugin);
      try {
        __adHostRegister(__adRestrictedPlugin);
      } catch {
        return __adFail('candidate DataPlugin registration failed');
      }
      __adRegistered = true;
      return undefined;
    };

    const __adAutodataTarget = __adCreate(null);
    __adDataProperty(__adAutodataTarget, 'register', __adRegister);
    __adFreeze(__adAutodataTarget);
    const __adAutodataHandler = __adCreate(null);
    __adDataProperty(__adAutodataHandler, 'get', (_target, property) => {
      if (property === 'register') return __adRegister;
      return __adFail('candidate context exposes only ctx.autodata.register');
    });
    __adDataProperty(__adAutodataHandler, 'set', () => __adFail('candidate context is read-only'));
    __adDataProperty(__adAutodataHandler, 'defineProperty', () => __adFail('candidate context is read-only'));
    __adDataProperty(__adAutodataHandler, 'deleteProperty', () => __adFail('candidate context is read-only'));
    __adDataProperty(__adAutodataHandler, 'setPrototypeOf', () => __adFail('candidate context is read-only'));
    __adDataProperty(__adAutodataHandler, 'has', (_target, property) => property === 'register');
    __adDataProperty(__adAutodataHandler, 'ownKeys', () => ['register']);
    __adDataProperty(__adAutodataHandler, 'getPrototypeOf', () => null);
    __adDataProperty(__adAutodataHandler, 'getOwnPropertyDescriptor', (_target, property) =>
      property === 'register'
        ? { value: __adRegister, enumerable: true, configurable: false, writable: false }
        : undefined);
    __adFreeze(__adAutodataHandler);
    const __adAutodataFacade = new __adProxy(__adAutodataTarget, __adAutodataHandler);

    const __adContextTarget = __adCreate(null);
    __adDataProperty(__adContextTarget, 'autodata', __adAutodataFacade);
    __adFreeze(__adContextTarget);
    const __adContextHandler = __adCreate(null);
    __adDataProperty(__adContextHandler, 'get', (_target, property) => {
      if (property === 'autodata') return __adAutodataFacade;
      return __adFail('candidate context exposes only ctx.autodata.register');
    });
    __adDataProperty(__adContextHandler, 'set', () => __adFail('candidate context is read-only'));
    __adDataProperty(__adContextHandler, 'defineProperty', () => __adFail('candidate context is read-only'));
    __adDataProperty(__adContextHandler, 'deleteProperty', () => __adFail('candidate context is read-only'));
    __adDataProperty(__adContextHandler, 'setPrototypeOf', () => __adFail('candidate context is read-only'));
    __adDataProperty(__adContextHandler, 'has', (_target, property) => property === 'autodata');
    __adDataProperty(__adContextHandler, 'ownKeys', () => ['autodata']);
    __adDataProperty(__adContextHandler, 'getPrototypeOf', () => null);
    __adDataProperty(__adContextHandler, 'getOwnPropertyDescriptor', (_target, property) =>
      property === 'autodata'
        ? { value: __adAutodataFacade, enumerable: true, configurable: false, writable: false }
        : undefined);
    __adFreeze(__adContextHandler);
    const __adContextFacade = new __adProxy(__adContextTarget, __adContextHandler);

    try {
      const __adApplyResult = __adApply(__adCandidateApply, __adCandidate, [__adContextFacade]);
      if (__adApplyResult !== undefined) __adFail('candidate apply must complete synchronously without a return value');
      if (!__adRegistered) __adFail('candidate must call autodata.register exactly once');
    } catch (__adApplyError) {
      __adSanitizeError(__adApplyError, 'candidate apply failed in the restricted Context');
    } finally {
      __adFacadeActive = false;
    }
  },
};
`
}

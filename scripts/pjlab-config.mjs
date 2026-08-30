export const PJLAB_PROVIDER = 'pjlab'
export const PJLAB_API = 'openai-completions'
export const PJLAB_BASE_URL = 'https://token.pjlab.org.cn/v1'
export const PJLAB_MODEL = 'glm-5.3-flash'
export const PJLAB_API_KEY_ENV = 'PJLAB_API_KEY'

const compat = Object.freeze({
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: false,
  maxTokensField: 'max_tokens',
  supportsStrictMode: false,
})
const model = Object.freeze({ id: PJLAB_MODEL })
const provider = Object.freeze({
  apiKeyEnv: PJLAB_API_KEY_ENV,
  api: PJLAB_API,
  baseURL: PJLAB_BASE_URL,
  defaultContextWindow: 1_048_576,
  compat,
  models: Object.freeze([model]),
})

/** Frozen, credential-by-reference configuration for the Stage 4C Evolver. */
export const PJLAB_LLM_CONFIG = Object.freeze({
  providers: Object.freeze({ [PJLAB_PROVIDER]: provider }),
})

/** Return a fresh mutable copy because Cordis schema resolution materializes defaults in place. */
export function createPjlabLlmConfig() {
  return {
    providers: {
      [PJLAB_PROVIDER]: {
        apiKeyEnv: PJLAB_API_KEY_ENV,
        api: PJLAB_API,
        baseURL: PJLAB_BASE_URL,
        defaultContextWindow: 1_048_576,
        compat: { ...compat },
        models: [{ id: PJLAB_MODEL }],
      },
    },
  }
}

/** Return whether the explicit PJLAB credential reference resolves in this process. */
export function hasPjlabApiKey(environment = process.env) {
  const value = environment[PJLAB_API_KEY_ENV]
  return typeof value === 'string' && value.trim().length > 0
}

/** Reject route drift and any attempt to inline credentials. */
export function assertPjlabConfig(config = PJLAB_LLM_CONFIG) {
  const root = requireRecord(config, 'PJLAB config')
  assertExactKeys(root, ['providers'], 'PJLAB config')

  const providers = requireRecord(root.providers, 'PJLAB providers')
  assertExactKeys(providers, [PJLAB_PROVIDER], 'PJLAB providers')

  const route = requireRecord(providers[PJLAB_PROVIDER], 'PJLAB route')
  assertExactKeys(route, ['apiKeyEnv', 'api', 'baseURL', 'defaultContextWindow', 'compat', 'models'], 'PJLAB route')
  assertEqual(route.apiKeyEnv, PJLAB_API_KEY_ENV, 'apiKeyEnv')
  assertEqual(route.api, PJLAB_API, 'api')
  assertEqual(route.baseURL, PJLAB_BASE_URL, 'baseURL')
  assertEqual(route.defaultContextWindow, 1_048_576, 'defaultContextWindow')

  const configuredCompat = requireRecord(route.compat, 'PJLAB compatibility')
  assertExactKeys(configuredCompat, Object.keys(compat), 'PJLAB compatibility')
  for (const [key, value] of Object.entries(compat)) assertEqual(configuredCompat[key], value, `compat.${key}`)

  if (!Array.isArray(route.models) || route.models.length !== 1) {
    throw new Error('PJLAB route must declare exactly one model')
  }
  const configuredModel = requireRecord(route.models[0], 'PJLAB model')
  assertExactKeys(configuredModel, ['id'], 'PJLAB model')
  assertEqual(configuredModel.id, PJLAB_MODEL, 'model id')
  return config
}

function requireRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(', ')}`)
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`PJLAB ${label} must be ${String(expected)}`)
}

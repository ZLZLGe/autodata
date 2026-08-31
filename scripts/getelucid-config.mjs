export const GETELUCID_PROVIDER = 'getelucid'
export const GETELUCID_API = 'openai-responses'
export const GETELUCID_BASE_URL = 'https://hk.getelucid.com/v1'
export const GETELUCID_MODEL = 'gpt-5.6-sol'
export const GETELUCID_API_KEY_ENV = 'GETELUCID_API_KEY'

const model = Object.freeze({ id: GETELUCID_MODEL })
const provider = Object.freeze({
  apiKeyEnv: GETELUCID_API_KEY_ENV,
  api: GETELUCID_API,
  baseURL: GETELUCID_BASE_URL,
  retryPolicy: Object.freeze({ mode: 'normal', maxRetries: 0 }),
  models: Object.freeze([model]),
})

/** Frozen, credential-by-reference configuration for the Stage 4C proposal model. */
export const GETELUCID_LLM_CONFIG = Object.freeze({
  providers: Object.freeze({ [GETELUCID_PROVIDER]: provider }),
})

/** Return a fresh mutable copy because Cordis schema resolution materializes defaults in place. */
export function createGetElucidLlmConfig() {
  return {
    providers: {
      [GETELUCID_PROVIDER]: {
        apiKeyEnv: GETELUCID_API_KEY_ENV,
        api: GETELUCID_API,
        baseURL: GETELUCID_BASE_URL,
        retryPolicy: { mode: 'normal', maxRetries: 0 },
        models: [{ id: GETELUCID_MODEL }],
      },
    },
  }
}

/** Return whether the explicit GetElucid credential reference resolves in this process. */
export function hasGetElucidApiKey(environment = process.env) {
  const value = environment[GETELUCID_API_KEY_ENV]
  return typeof value === 'string' && value.trim().length > 0
}

/** Reject route drift and any attempt to inline credentials. */
export function assertGetElucidConfig(config = GETELUCID_LLM_CONFIG) {
  const root = requireRecord(config, 'GetElucid config')
  assertExactKeys(root, ['providers'], 'GetElucid config')

  const providers = requireRecord(root.providers, 'GetElucid providers')
  assertExactKeys(providers, [GETELUCID_PROVIDER], 'GetElucid providers')

  const route = requireRecord(providers[GETELUCID_PROVIDER], 'GetElucid route')
  assertExactKeys(route, ['apiKeyEnv', 'api', 'baseURL', 'retryPolicy', 'models'], 'GetElucid route')
  assertEqual(route.apiKeyEnv, GETELUCID_API_KEY_ENV, 'apiKeyEnv')
  assertEqual(route.api, GETELUCID_API, 'api')
  assertEqual(route.baseURL, GETELUCID_BASE_URL, 'baseURL')

  const retryPolicy = requireRecord(route.retryPolicy, 'GetElucid retry policy')
  assertExactKeys(retryPolicy, ['mode', 'maxRetries'], 'GetElucid retry policy')
  assertEqual(retryPolicy.mode, 'normal', 'retry mode')
  assertEqual(retryPolicy.maxRetries, 0, 'max retries')

  if (!Array.isArray(route.models) || route.models.length !== 1) {
    throw new Error('GetElucid route must declare exactly one model')
  }
  const configuredModel = requireRecord(route.models[0], 'GetElucid model')
  assertExactKeys(configuredModel, ['id'], 'GetElucid model')
  assertEqual(configuredModel.id, GETELUCID_MODEL, 'model id')
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
  if (actual !== expected) throw new Error(`GetElucid ${label} must be ${String(expected)}`)
}

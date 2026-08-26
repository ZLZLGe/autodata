export const FREEROUTER_PROVIDER = 'free-router'
export const FREEROUTER_API = 'openai-responses'
export const FREEROUTER_BASE_URL = 'https://free-router.opendatalab.com/v1'
export const FREEROUTER_MODEL = 'gpt-5.6-sol'
export const FREEROUTER_API_KEY_ENV = 'FREEROUTER_API_KEY'

const model = Object.freeze({ id: FREEROUTER_MODEL })
const provider = Object.freeze({
  apiKeyEnv: FREEROUTER_API_KEY_ENV,
  api: FREEROUTER_API,
  baseURL: FREEROUTER_BASE_URL,
  reasoning: 'high',
  models: Object.freeze([Object.freeze({
    ...model,
    reasoningEfforts: Object.freeze({ high: 'high' }),
  })]),
})

/** Fixed, credential-by-reference configuration for the opt-in real-model smoke. */
export const FREEROUTER_LLM_CONFIG = Object.freeze({
  providers: Object.freeze({ [FREEROUTER_PROVIDER]: provider }),
})

/** Return a fresh mutable copy because Cordis schema resolution materializes defaults in place. */
export function createFreerouterLlmConfig() {
  return {
    providers: {
      [FREEROUTER_PROVIDER]: {
        apiKeyEnv: FREEROUTER_API_KEY_ENV,
        api: FREEROUTER_API,
        baseURL: FREEROUTER_BASE_URL,
        reasoning: 'high',
        models: [{
          id: FREEROUTER_MODEL,
          reasoningEfforts: { high: 'high' },
        }],
      },
    },
  }
}

/** Return whether the explicit FreeRouter credential reference resolves in this process. */
export function hasFreerouterApiKey(environment = process.env) {
  const value = environment[FREEROUTER_API_KEY_ENV]
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Reject drift from the one approved smoke route. Exact keys also prevent an
 * inline secret or an auth-file path from being added to this configuration.
 */
export function assertFreerouterSmokeConfig(config = FREEROUTER_LLM_CONFIG) {
  const root = requireRecord(config, 'FreeRouter config')
  assertExactKeys(root, ['providers'], 'FreeRouter config')

  const providers = requireRecord(root.providers, 'FreeRouter providers')
  assertExactKeys(providers, [FREEROUTER_PROVIDER], 'FreeRouter providers')

  const route = requireRecord(providers[FREEROUTER_PROVIDER], 'FreeRouter route')
  assertExactKeys(route, ['apiKeyEnv', 'api', 'baseURL', 'reasoning', 'models'], 'FreeRouter route')
  assertEqual(route.apiKeyEnv, FREEROUTER_API_KEY_ENV, 'apiKeyEnv')
  assertEqual(route.api, FREEROUTER_API, 'api')
  assertEqual(route.baseURL, FREEROUTER_BASE_URL, 'baseURL')
  assertEqual(route.reasoning, 'high', 'reasoning')

  if (!Array.isArray(route.models) || route.models.length !== 1) {
    throw new Error('FreeRouter route must declare exactly one model')
  }
  const configuredModel = requireRecord(route.models[0], 'FreeRouter model')
  assertExactKeys(configuredModel, ['id', 'reasoningEfforts'], 'FreeRouter model')
  assertEqual(configuredModel.id, FREEROUTER_MODEL, 'model id')
  const reasoningEfforts = requireRecord(configuredModel.reasoningEfforts, 'FreeRouter reasoning efforts')
  assertExactKeys(reasoningEfforts, ['high'], 'FreeRouter reasoning efforts')
  assertEqual(reasoningEfforts.high, 'high', 'model high reasoning effort')
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
  if (actual !== expected) throw new Error(`FreeRouter ${label} must be ${expected}`)
}

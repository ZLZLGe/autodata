export const FREEROUTER_PROVIDER = 'free-router'
export const FREEROUTER_API = 'openai-responses'
export const FREEROUTER_BASE_URL = 'https://free-router.opendatalab.com/v1'
export const FREEROUTER_MODEL = 'gpt-5.6-sol'
export const FREEROUTER_API_KEY_ENV = 'FREEROUTER_API_KEY'
export const FREEROUTER_DEFAULT_SESSION_ID = 'autodata-freerouter-smoke-agent'

const SESSION_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu

function sessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new Error('FreeRouter session id must contain 1-128 safe header characters')
  }
  return value
}

const model = Object.freeze({ id: FREEROUTER_MODEL })
const provider = Object.freeze({
  apiKeyEnv: FREEROUTER_API_KEY_ENV,
  api: FREEROUTER_API,
  baseURL: FREEROUTER_BASE_URL,
  reasoning: 'high',
  headers: Object.freeze({ 'x-session-id': FREEROUTER_DEFAULT_SESSION_ID }),
  retryPolicy: Object.freeze({ mode: 'normal', maxRetries: 0 }),
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
export function createFreerouterLlmConfig(sessionIdInput = FREEROUTER_DEFAULT_SESSION_ID) {
  const value = sessionId(sessionIdInput)
  return {
    providers: {
      [FREEROUTER_PROVIDER]: {
        apiKeyEnv: FREEROUTER_API_KEY_ENV,
        api: FREEROUTER_API,
        baseURL: FREEROUTER_BASE_URL,
        reasoning: 'high',
        headers: { 'x-session-id': value },
        retryPolicy: { mode: 'normal', maxRetries: 0 },
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
 * Install a process-local wire gate for one formal FreeRouter operation.
 * It rejects route/header drift, redirects, and any request beyond the
 * predeclared budget before that request reaches the network.
 */
export function installFreerouterRequestBudget(sessionIdInput, maxRequests = 1) {
  const expectedSession = sessionId(sessionIdInput)
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error('FreeRouter request budget must be a positive safe integer')
  }
  const expectedUrl = `${FREEROUTER_BASE_URL}/responses`
  const originalFetch = globalThis.fetch
  let attempts = 0
  let calls = 0
  const gatedFetch = async (input, init) => {
    const request = new Request(input, { ...init, redirect: 'error' })
    if (request.url !== expectedUrl || request.method !== 'POST') {
      throw new Error('FreeRouter request budget blocked an unexpected network request')
    }
    if (request.headers.get('x-session-id') !== expectedSession) {
      throw new Error('FreeRouter request budget blocked a request with the wrong x-session-id')
    }
    calls += 1
    if (calls > maxRequests) {
      throw new Error('FreeRouter request budget blocked an excess provider request before transmission')
    }
    attempts += 1
    return originalFetch(request)
  }
  globalThis.fetch = gatedFetch
  return Object.freeze({
    attempts: () => attempts,
    calls: () => calls,
    dispose: () => {
      if (globalThis.fetch !== gatedFetch) {
        throw new Error('global fetch changed while the FreeRouter request budget was installed')
      }
      globalThis.fetch = originalFetch
    },
  })
}

/**
 * Reject drift from the one approved smoke route. Exact keys also prevent an
 * inline secret or an auth-file path from being added to this configuration.
 */
export function assertFreerouterConfig(
  config = FREEROUTER_LLM_CONFIG,
  expectedSessionId = FREEROUTER_DEFAULT_SESSION_ID,
) {
  const expectedSession = sessionId(expectedSessionId)
  const root = requireRecord(config, 'FreeRouter config')
  assertExactKeys(root, ['providers'], 'FreeRouter config')

  const providers = requireRecord(root.providers, 'FreeRouter providers')
  assertExactKeys(providers, [FREEROUTER_PROVIDER], 'FreeRouter providers')

  const route = requireRecord(providers[FREEROUTER_PROVIDER], 'FreeRouter route')
  assertExactKeys(
    route,
    ['apiKeyEnv', 'api', 'baseURL', 'reasoning', 'headers', 'retryPolicy', 'models'],
    'FreeRouter route',
  )
  assertEqual(route.apiKeyEnv, FREEROUTER_API_KEY_ENV, 'apiKeyEnv')
  assertEqual(route.api, FREEROUTER_API, 'api')
  assertEqual(route.baseURL, FREEROUTER_BASE_URL, 'baseURL')
  assertEqual(route.reasoning, 'high', 'reasoning')
  const headers = requireRecord(route.headers, 'FreeRouter headers')
  assertExactKeys(headers, ['x-session-id'], 'FreeRouter headers')
  assertEqual(headers['x-session-id'], expectedSession, 'x-session-id')
  const retryPolicy = requireRecord(route.retryPolicy, 'FreeRouter retry policy')
  assertExactKeys(retryPolicy, ['mode', 'maxRetries'], 'FreeRouter retry policy')
  assertEqual(retryPolicy.mode, 'normal', 'retry mode')
  assertEqual(retryPolicy.maxRetries, 0, 'max retries')

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

/** Backward-compatible name retained for the existing standalone Agent smoke. */
export function assertFreerouterSmokeConfig(
  config = FREEROUTER_LLM_CONFIG,
  expectedSessionId = FREEROUTER_DEFAULT_SESSION_ID,
) {
  return assertFreerouterConfig(config, expectedSessionId)
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

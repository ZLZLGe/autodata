const REDACTED = '[REDACTED]'
const MAX_DIAGNOSTIC_LENGTH = 2_000

/** Render a turn-ending reason without serializing the surrounding session event. */
export function formatTurnEndReason(reason, secrets = []) {
  if (!isRecord(reason) || typeof reason.kind !== 'string' || reason.kind.length === 0) {
    return 'missing'
  }
  if (reason.kind !== 'error') return sanitizeDiagnosticText(reason.kind, secrets)

  const failure = isRecord(reason.error) ? reason.error : undefined
  const rawCode = typeof failure?.code === 'string' ? failure.code : ''
  const code = /^[a-z0-9_.-]{1,64}$/iu.test(rawCode) ? rawCode : 'UNKNOWN'
  const message = typeof failure?.message === 'string' && failure.message.length > 0
    ? sanitizeDiagnosticText(failure.message, secrets)
    : 'LLM request failed without a message'
  return `error(code=${code}, message=${message})`
}

/** Render caught errors through the same bounded, credential-safe diagnostic surface. */
export function diagnostic(error, secrets = []) {
  if (error instanceof AggregateError) {
    const members = [...error.errors].map(entry => diagnostic(entry, secrets)).join('; ')
    return sanitizeDiagnosticText(members, secrets)
  }
  const message = error instanceof Error ? error.message : safeString(error)
  return sanitizeDiagnosticText(message, secrets)
}

/** Redact known and conventionally formatted credentials from one bounded log line. */
export function sanitizeDiagnosticText(value, secrets = []) {
  let text = safeString(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.replaceAll(secret, REDACTED)
  }
  text = text
    .replace(/((?:"|')?(?:x[-_]?api[-_]?key|api[_-]?key|authorization|access[_-]?token|token)(?:"|')?\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}]*)/giu, `$1${REDACTED}`)
    .replace(/(\bBearer\s+)[^\s,;]+/giu, `$1${REDACTED}`)
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&\s]+/giu, `$1${REDACTED}`)
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .trim()
  if (text.length <= MAX_DIAGNOSTIC_LENGTH) return text
  return `${text.slice(0, MAX_DIAGNOSTIC_LENGTH)}...`
}

function safeString(value) {
  try {
    return String(value)
  } catch {
    return 'unprintable diagnostic'
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

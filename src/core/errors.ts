/** Stable error model for the AutoData Stage 2 in-memory Core. */

export type AutoDataCoreErrorCode =
  | 'INVALID_PLUGIN'
  | 'PLUGIN_FAILED'
  | 'PLUGIN_ALREADY_REGISTERED'
  | 'PLUGIN_NOT_FOUND'
  | 'INVALID_RUN_REQUEST'
  | 'INVALID_SOURCE'
  | 'INVALID_RECORD'
  | 'DUPLICATE_RECORD_ID'
  | 'MISSING_SELECTED_RECORD'
  | 'EMPTY_SELECTION'
  | 'EMPTY_TRAINING_VIEW'
  | 'INVALID_JSON'
  | 'CONTEXT_UNAVAILABLE'
  | 'HOST_SCOPE_REQUIRED'

export interface AutoDataCoreErrorOptions {
  readonly plugin_id?: string
  readonly cause?: unknown
}

/** A typed failure at the public Core boundary. */
export class AutoDataCoreError extends Error {
  readonly code: AutoDataCoreErrorCode
  readonly plugin_id?: string

  constructor(message: string, code: AutoDataCoreErrorCode, options: AutoDataCoreErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AutoDataCoreError'
    this.code = code
    if (options.plugin_id !== undefined) this.plugin_id = options.plugin_id
  }
}

/** Migration alias retained for callers of the old in-memory runner. */
export { AutoDataCoreError as DataHarnessError }
export type DataHarnessErrorCode = AutoDataCoreErrorCode

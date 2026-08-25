import { Service, type Context } from '@deepseek-ai/cordis'

/** AutoData package version exposed by the Stage 1 service contract. */
export const AUTODATA_VERSION = '0.1.0-rc.1'

/** The capabilities currently exposed by the AutoData bundle. */
export const AUTODATA_CAPABILITIES = Object.freeze(['autodata_status'] as const)

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
}

/** Minimal AutoData service mounted into the shared DSH Cordis context. */
export class AutoDataService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'autodata')
  }

  /** Return deterministic in-memory status without reading project or run data. */
  status(): AutoDataStatus {
    return {
      version: AUTODATA_VERSION,
      ready: true,
      capabilities: AUTODATA_CAPABILITIES,
    }
  }
}

export default AutoDataService

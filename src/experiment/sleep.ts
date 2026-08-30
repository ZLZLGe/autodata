/** Abort-aware sleep used by the experiment controller polling loop. */

/**
 * Resolve after the requested delay, or reject with the abort reason.
 *
 * The abort listener is removed on both settlement paths. Long-running RJobs
 * can poll hundreds of times with the same signal, so leaving completed sleep
 * listeners attached would otherwise retain one closure per observation.
 */
export function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    const onAbort = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveSleep()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

import { describe, expect, it } from 'vitest'
import { sleepWithAbort } from '../src/experiment/sleep.js'

class TrackingSignal {
  aborted = false
  reason: unknown
  readonly listeners = new Set<() => void>()

  addEventListener(type: string, listener: () => void): void {
    if (type === 'abort') this.listeners.add(listener)
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'abort') this.listeners.delete(listener)
  }

  abort(reason: unknown): void {
    this.aborted = true
    this.reason = reason
    for (const listener of [...this.listeners]) listener()
  }
}

describe('experiment polling sleep', () => {
  it('removes the abort listener after every completed poll delay', async () => {
    const signal = new TrackingSignal()

    for (let index = 0; index < 20; index += 1) {
      await sleepWithAbort(0, signal as unknown as AbortSignal)
      expect(signal.listeners.size).toBe(0)
    }
  })

  it('clears the timer and listener when aborted', async () => {
    const signal = new TrackingSignal()
    const reason = new Error('cancelled')
    const sleeping = sleepWithAbort(60_000, signal as unknown as AbortSignal)

    expect(signal.listeners.size).toBe(1)
    signal.abort(reason)

    await expect(sleeping).rejects.toBe(reason)
    expect(signal.listeners.size).toBe(0)
  })
})

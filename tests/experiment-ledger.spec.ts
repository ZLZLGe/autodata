import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExperimentLedger } from '../src/experiment/ledger.js'
import { createInitialExperimentState } from '../src/experiment/state.js'
import type { ExperimentStage, ExperimentState } from '../src/experiment/types.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { readonly ledger: ExperimentLedger; readonly state: ExperimentState; readonly root: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'autodata-experiment-ledger-'))
  roots.push(root)
  const runRoot = resolve(root, 'runs')
  const stagingRoot = resolve(root, 'staging')
  const ledger = new ExperimentLedger(runRoot, stagingRoot)
  const runId = 'retry-cleanup'
  const state = createInitialExperimentState({
    contract_id: 'contract',
    contract_sha256: 'sha256',
    profile_id: 'bfcl-v4',
    run_id: runId,
    run_directory: ledger.runDirectory('bfcl-v4', runId),
    staging_directory: ledger.stagingDirectory(runId),
    now: '2026-08-30T00:00:00.000Z',
  })
  return { ledger, state, root }
}

function output(state: ExperimentState, stage: ExperimentStage, attempt: number): string {
  return resolve(state.staging_directory, 'outputs', stage, `attempt-${String(attempt)}`)
}

describe('ExperimentLedger.removeStagedAttemptOutput', () => {
  it('removes exactly the selected attempt output directory', () => {
    const { ledger, state } = fixture()
    const selected = output(state, 'train', 1)
    const nextTrain = output(state, 'train', 2)
    const evalAttempt = output(state, 'eval', 1)
    for (const directory of [selected, nextTrain, evalAttempt]) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(resolve(directory, 'payload'), directory)
    }

    ledger.removeStagedAttemptOutput(state, 'train', 1)

    expect(existsSync(selected)).toBe(false)
    expect(readFileSync(resolve(nextTrain, 'payload'), 'utf8')).toBe(nextTrain)
    expect(readFileSync(resolve(evalAttempt, 'payload'), 'utf8')).toBe(evalAttempt)
  })

  it('is idempotent when the selected output is missing', () => {
    const { ledger, state } = fixture()
    mkdirSync(state.staging_directory, { recursive: true })

    expect(() => ledger.removeStagedAttemptOutput(state, 'train', 1)).not.toThrow()
    expect(() => ledger.removeStagedAttemptOutput(state, 'train', 1)).not.toThrow()
  })

  it('rejects a state staging directory outside the configured staging root', () => {
    const { ledger, state, root } = fixture()
    const outside = resolve(root, 'outside')
    const unsafe = { ...state, staging_directory: outside }
    mkdirSync(output(unsafe, 'train', 1), { recursive: true })
    writeFileSync(resolve(output(unsafe, 'train', 1), 'payload'), 'keep')

    expect(() => ledger.removeStagedAttemptOutput(unsafe, 'train', 1)).toThrowError(
      expect.objectContaining({ code: 'PATH_ESCAPE' }),
    )
    expect(readFileSync(resolve(output(unsafe, 'train', 1), 'payload'), 'utf8')).toBe('keep')
  })

  it('rejects traversal-like runtime stage values without deleting outside data', () => {
    const { ledger, state, root } = fixture()
    const outside = resolve(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(resolve(outside, 'payload'), 'keep')

    expect(() => ledger.removeStagedAttemptOutput(
      state,
      '../../../outside' as ExperimentStage,
      1,
    )).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(readFileSync(resolve(outside, 'payload'), 'utf8')).toBe('keep')
  })

  it.each(['component', 'target'] as const)('rejects a symbolic link at the %s', location => {
    const { ledger, state, root } = fixture()
    const outside = resolve(root, `outside-${location}`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(resolve(outside, 'payload'), 'keep')
    mkdirSync(state.staging_directory, { recursive: true })
    if (location === 'component') {
      symlinkSync(outside, resolve(state.staging_directory, 'outputs'))
    } else {
      mkdirSync(resolve(state.staging_directory, 'outputs', 'train'), { recursive: true })
      symlinkSync(outside, output(state, 'train', 1))
    }

    expect(() => ledger.removeStagedAttemptOutput(state, 'train', 1)).toThrowError(
      expect.objectContaining({ code: 'PATH_ESCAPE' }),
    )
    expect(readFileSync(resolve(outside, 'payload'), 'utf8')).toBe('keep')
  })
})

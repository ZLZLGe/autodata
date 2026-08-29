/** Materialize immutable Stage 2 data and fixed Stage 4A worker assets. */

import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { canonicalJson, cloneJson } from '../core/json.js'
import {
  AUTODATA_RUN_SUMMARY_VERSION,
  CANONICAL_TRAJECTORY_SCHEMA_VERSION,
  LOGICAL_TRAINING_UNIT_SCHEMA_VERSION,
} from '../core/index.js'
import type { DataRunResult } from '../core/types.js'
import { Stage4AError, type Stage4AMaterializedData } from './types.js'
import { Stage4ALedger } from './ledger.js'

export interface Stage4APreparedData {
  readonly materialized: Stage4AMaterializedData
  readonly files: Readonly<Record<'canonical.jsonl' | 'logical-view.jsonl' | 'run-summary.json', string>>
}

function jsonLines(records: readonly unknown[]): string {
  return records.length === 0 ? '' : `${records.map(record => canonicalJson(record)).join('\n')}\n`
}

function validateDataRun(value: DataRunResult): DataRunResult {
  const clone = cloneJson(value) as unknown as DataRunResult
  if (!Array.isArray(clone.canonical_records) || !Array.isArray(clone.logical_training_view)) {
    throw new Stage4AError('data_run must contain canonical_records and logical_training_view arrays', 'INVALID_REQUEST')
  }
  if (clone.summary?.summary_version !== AUTODATA_RUN_SUMMARY_VERSION) {
    throw new Stage4AError('data_run has an unsupported run summary version', 'INVALID_REQUEST')
  }
  if (
    clone.summary.canonical_schema_version !== CANONICAL_TRAJECTORY_SCHEMA_VERSION
    || clone.summary.logical_view_schema_version !== LOGICAL_TRAINING_UNIT_SCHEMA_VERSION
  ) throw new Stage4AError('data_run schema versions do not match the current Core', 'INVALID_REQUEST')
  if (
    clone.summary.counts.canonical_records !== clone.canonical_records.length
    || clone.summary.counts.logical_training_units !== clone.logical_training_view.length
  ) throw new Stage4AError('data_run counts do not match its materialized records', 'INVALID_REQUEST')
  if (clone.canonical_records.some(record => record.schema_version !== CANONICAL_TRAJECTORY_SCHEMA_VERSION)) {
    throw new Stage4AError('data_run contains an unsupported canonical record', 'INVALID_REQUEST')
  }
  if (clone.logical_training_view.some(unit => unit.schema_version !== LOGICAL_TRAINING_UNIT_SCHEMA_VERSION)) {
    throw new Stage4AError('data_run contains an unsupported logical training unit', 'INVALID_REQUEST')
  }
  return clone
}

/** Validate and serialize the ordinary inputs before the run directory is atomically published. */
export function prepareStage4AData(
  dataRun: DataRunResult,
  stagingDirectory: string,
): Stage4APreparedData {
  const data = validateDataRun(dataRun)
  const files = {
    'canonical.jsonl': jsonLines(data.canonical_records),
    'logical-view.jsonl': jsonLines(data.logical_training_view),
    'run-summary.json': `${canonicalJson(data.summary)}\n`,
  } as const
  return Object.freeze({
    files: Object.freeze(files),
    materialized: Object.freeze({
      canonical_jsonl: resolve(stagingDirectory, 'canonical.jsonl'),
      logical_view_jsonl: resolve(stagingDirectory, 'logical-view.jsonl'),
      run_summary_json: resolve(stagingDirectory, 'run-summary.json'),
    }),
  })
}

/** Rebuild GPFS inputs idempotently from the atomically published local run. */
export function stageStage4AData(
  ledger: Stage4ALedger,
  runDirectory: string,
  stagingDirectory: string,
): void {
  for (const name of ['canonical.jsonl', 'logical-view.jsonl', 'run-summary.json'] as const) {
    ledger.copyNewOrSame(stagingDirectory, resolve(runDirectory, name), resolve(stagingDirectory, name))
  }
}

/** Copy a fixed, symlink-free worker tree without overwriting staged content. */
export function stageStage4AAssets(ledger: Stage4ALedger, assetRoot: string, stagingDirectory: string): void {
  const root = resolve(assetRoot)
  if (!existsSync(root)) {
    throw new Stage4AError(`Stage 4A asset root is missing: ${root}`, 'ARTIFACT_INVALID')
  }
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Stage4AError(`Stage 4A asset root must be a regular directory: ${root}`, 'ARTIFACT_INVALID')
  }
  const visit = (sourceDirectory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const source = resolve(sourceDirectory, entry.name)
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Stage4AError(`Stage 4A assets must not contain symlinks: ${source}`, 'ARTIFACT_INVALID')
      if (entry.isDirectory()) {
        visit(source, relativePath)
      } else if (entry.isFile()) {
        ledger.copyNewOrSame(stagingDirectory, source, resolve(stagingDirectory, relativePath))
      } else {
        throw new Stage4AError(`unsupported Stage 4A asset: ${source}`, 'ARTIFACT_INVALID')
      }
    }
  }
  visit(root, '')
  for (const required of ['train.sh', 'eval.sh', 'python/autodata_stage4a/worker.py', 'bfcl/search.jsonl']) {
    const path = resolve(stagingDirectory, required)
    if (basename(path) === '' || !existsSync(path) || !lstatSync(path).isFile()) {
      throw new Stage4AError(`required Stage 4A asset is missing: ${required}`, 'ARTIFACT_INVALID')
    }
  }
}

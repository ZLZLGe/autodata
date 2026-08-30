import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const FIRST_H1_CLAIM_SCHEMA_VERSION = 'autodata-first-h1-claim-1'
export const FIRST_H1_CLAIM_FILE = 'first-h1-claim.json'

const COMMIT = /^[a-f0-9]{40}$/u
const ID = /^[a-z][a-z0-9-]*$/u
const PROFILE_ID = /^[a-z][a-z0-9-]*$/u
const CLAIM_FIELDS = Object.freeze([
  'schema_version',
  'profile_id',
  'run_id',
  'experiment_run_id',
  'candidate_id',
  'execution_commit',
])

function assertCommit(commit) {
  if (typeof commit !== 'string' || !COMMIT.test(commit)) {
    throw new Error('formal Stage 4C Git HEAD is not a full lowercase commit SHA')
  }
  return commit
}

function assertProfileId(profileId) {
  if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId) || profileId.length > 48) {
    throw new Error('formal Stage 4C profile ID is invalid')
  }
  return profileId
}

function inspectExistingPath(path, label, expectedType) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw new Error(`cannot inspect ${label}: ${path}`, { cause: error })
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`)
  if (expectedType === 'directory' && !stat.isDirectory()) throw new Error(`${label} must be a directory: ${path}`)
  if (expectedType === 'file' && !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`)
  return true
}

function claimPath(generationRunRoot, profileId) {
  if (typeof generationRunRoot !== 'string' || !isAbsolute(generationRunRoot)) {
    throw new Error('generation run root must be absolute')
  }
  const root = resolve(generationRunRoot)
  const profile = resolve(root, assertProfileId(profileId))
  const child = relative(root, profile)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('formal Stage 4C claim path escapes the generation root')
  }
  if (inspectExistingPath(root, 'generation run root', 'directory')) {
    inspectExistingPath(profile, 'generation profile directory', 'directory')
  }
  return resolve(profile, FIRST_H1_CLAIM_FILE)
}

function validDate(value) {
  if (!/^\d{8}$/u.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function identity(commit, date) {
  const shortCommit = commit.slice(0, 12)
  return Object.freeze({
    commit,
    short_commit: shortCommit,
    run_date: date,
    generation_run_id: `first-h1-${shortCommit}-${date}`,
    experiment_run_id: `h1-${shortCommit}-${date}`,
    candidate_id: `candidate-h1-${shortCommit}-${date}`,
  })
}

function parseClaim(path, expectedProfileId, expectedCommit) {
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot parse the durable first-H1 claim: ${path}`, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('durable first-H1 claim must be an object')
  }
  const keys = Object.keys(value)
  if (keys.length !== CLAIM_FIELDS.length || CLAIM_FIELDS.some(field => !Object.hasOwn(value, field))) {
    throw new Error('durable first-H1 claim has an invalid shape')
  }
  if (keys.some(field => !CLAIM_FIELDS.includes(field))) {
    throw new Error('durable first-H1 claim has an unsupported field')
  }
  if (value.schema_version !== FIRST_H1_CLAIM_SCHEMA_VERSION) {
    throw new Error('durable first-H1 claim has an unsupported schema')
  }
  if (value.profile_id !== expectedProfileId) {
    throw new Error('durable first-H1 claim belongs to a different profile')
  }
  if (value.execution_commit !== expectedCommit) {
    throw new Error('durable first-H1 claim belongs to a different Git commit')
  }
  for (const field of ['run_id', 'experiment_run_id', 'candidate_id']) {
    if (typeof value[field] !== 'string' || value[field].length > 48 || !ID.test(value[field])) {
      throw new Error(`durable first-H1 claim ${field} is invalid`)
    }
  }
  const shortCommit = expectedCommit.slice(0, 12)
  const match = new RegExp(`^first-h1-${shortCommit}-(\\d{8})$`, 'u').exec(value.run_id)
  const date = match?.[1]
  if (date === undefined || !validDate(date)) {
    throw new Error('durable first-H1 claim run_id is not bound to its commit and date')
  }
  const expected = identity(expectedCommit, date)
  if (
    value.experiment_run_id !== expected.experiment_run_id
    || value.candidate_id !== expected.candidate_id
  ) throw new Error('durable first-H1 claim IDs do not share one commit and date identity')
  return expected
}

/** Return YYYYMMDD using the formal experiment timezone, independent of host locale/timezone. */
export function hongKongRunDate(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('formal Stage 4C clock is invalid')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}${values.month}${values.day}`
}

/** Resolve stable IDs from the durable claim, or mint today's IDs before the claim exists. */
export function resolveStage4CExecutionIdentity({ generationRunRoot, profileId, commit, now = new Date() }) {
  const normalizedCommit = assertCommit(commit)
  const normalizedProfileId = assertProfileId(profileId)
  const path = claimPath(generationRunRoot, normalizedProfileId)
  if (inspectExistingPath(path, 'durable first-H1 claim', 'file')) {
    return parseClaim(path, normalizedProfileId, normalizedCommit)
  }
  return identity(normalizedCommit, hongKongRunDate(now))
}

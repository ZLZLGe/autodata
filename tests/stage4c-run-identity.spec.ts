import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface ExecutionIdentity {
  readonly commit: string
  readonly short_commit: string
  readonly run_date: string
  readonly generation_run_id: string
  readonly experiment_run_id: string
  readonly candidate_id: string
}

interface IdentityModule {
  readonly FIRST_H1_CLAIM_SCHEMA_VERSION: string
  resolveStage4CExecutionIdentity(input: {
    readonly generationRunRoot: string
    readonly profileId: string
    readonly commit: string
    readonly now?: Date
  }): ExecutionIdentity
}

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'scripts/stage4c-run-identity.mjs')).href
const identityModule = await import(moduleUrl) as IdentityModule
const roots: string[] = []
const commit = '0123456789abcdef0123456789abcdef01234567'
const profileId = 'bfcl-v4'

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'autodata-stage4c-identity-'))
  roots.push(path)
  return path
}

function writeClaim(generationRunRoot: string, overrides: Record<string, unknown> = {}): string {
  const profile = resolve(generationRunRoot, profileId)
  mkdirSync(profile, { recursive: true })
  const path = resolve(profile, 'first-h1-claim.json')
  writeFileSync(path, `${JSON.stringify({
    schema_version: identityModule.FIRST_H1_CLAIM_SCHEMA_VERSION,
    profile_id: profileId,
    run_id: 'first-h1-0123456789ab-20260830',
    experiment_run_id: 'h1-0123456789ab-20260830',
    candidate_id: 'candidate-h1-0123456789ab-20260830',
    execution_commit: commit,
    ...overrides,
  })}\n`)
  return path
}

describe('Stage 4C formal execution identity', () => {
  it('uses the Asia/Hong_Kong date only when no durable claim exists', async () => {
    const generationRunRoot = await root()
    const beforeMidnight = identityModule.resolveStage4CExecutionIdentity({
      generationRunRoot,
      profileId,
      commit,
      now: new Date('2026-08-30T15:59:59.000Z'),
    })
    const afterMidnight = identityModule.resolveStage4CExecutionIdentity({
      generationRunRoot,
      profileId,
      commit,
      now: new Date('2026-08-30T16:00:00.000Z'),
    })
    expect(beforeMidnight.run_date).toBe('20260830')
    expect(afterMidnight.run_date).toBe('20260831')
  })

  it('reuses the durable claim across midnight instead of drifting IDs', async () => {
    const generationRunRoot = await root()
    writeClaim(generationRunRoot)
    const resolved = identityModule.resolveStage4CExecutionIdentity({
      generationRunRoot,
      profileId,
      commit,
      now: new Date('2026-09-12T00:00:00.000Z'),
    })
    expect(resolved).toMatchObject({
      run_date: '20260830',
      generation_run_id: 'first-h1-0123456789ab-20260830',
      experiment_run_id: 'h1-0123456789ab-20260830',
      candidate_id: 'candidate-h1-0123456789ab-20260830',
    })
  })

  it.each([
    ['extra field', { extra: true }],
    ['wrong schema', { schema_version: 'wrong' }],
    ['wrong commit', { execution_commit: 'f'.repeat(40) }],
    ['mismatched experiment ID', { experiment_run_id: 'h1-0123456789ab-20260831' }],
    ['mismatched candidate ID', { candidate_id: 'candidate-h1-0123456789ab-20260831' }],
    ['invalid calendar date', { run_id: 'first-h1-0123456789ab-20260230' }],
  ])('fails closed for a claim with %s', async (_label, overrides) => {
    const generationRunRoot = await root()
    writeClaim(generationRunRoot, overrides)
    expect(() => identityModule.resolveStage4CExecutionIdentity({ generationRunRoot, profileId, commit }))
      .toThrow()
  })

  it('fails closed for malformed or symlinked claims', async () => {
    const malformedRoot = await root()
    const malformed = writeClaim(malformedRoot)
    writeFileSync(malformed, '{')
    expect(() => identityModule.resolveStage4CExecutionIdentity({
      generationRunRoot: malformedRoot,
      profileId,
      commit,
    })).toThrow(/cannot parse/iu)

    const symlinkRoot = await root()
    const target = writeClaim(symlinkRoot)
    const linkRoot = await root()
    const profile = resolve(linkRoot, profileId)
    mkdirSync(profile, { recursive: true })
    symlinkSync(target, resolve(profile, 'first-h1-claim.json'))
    expect(() => identityModule.resolveStage4CExecutionIdentity({
      generationRunRoot: linkRoot,
      profileId,
      commit,
    })).toThrow(/symbolic link/iu)
  })
})

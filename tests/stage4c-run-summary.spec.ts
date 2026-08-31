import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface Stage4CSummaryModule {
  summarizeStage4CExecution(input: Record<string, unknown>): Readonly<Record<string, unknown>>
}

const summaryModuleUrl = pathToFileURL(join(process.cwd(), 'scripts/stage4c-run-summary.mjs')).href
const summaryModule = await import(summaryModuleUrl) as Stage4CSummaryModule

const execution = Object.freeze({
  commit: '0123456789abcdef0123456789abcdef01234567',
  short_commit: '0123456789ab',
  generation_run_id: 'first-h1-0123456789ab-20260831',
  experiment_run_id: 'h1-0123456789ab-20260831',
  candidate_id: 'candidate-h1-0123456789ab-20260831',
})

function summarize(state: Record<string, unknown>, operation = 'resume') {
  return summaryModule.summarizeStage4CExecution({
    requestedCommand: operation,
    operation,
    state: {
      max_proposal_drafts: 1,
      proposal_drafts_started: Array.isArray(state.attempts) ? state.attempts.length : 0,
      ...state,
    },
    execution,
    provider: 'getelucid',
    model: 'gpt-5.6-sol',
    profileId: 'bfcl-v4',
    runManifest: {
      path: '/data/run-manifest.json',
      sha256: 'a'.repeat(64),
      manifest: {
        proposal: { context_sha256: 'b'.repeat(64) },
        h0: { source_pool_sha256: 'c'.repeat(64) },
      },
    },
  })
}

describe('Stage 4C CLI summary', () => {
  it('reports an independent GetElucid run through its manifest without recovery fields', () => {
    const summary = summaryModule.summarizeStage4CExecution({
      requestedCommand: 'status',
      operation: 'status',
      state: {
        status: 'running',
        phase: 'proposing',
        attempts: [],
        max_proposal_drafts: 1,
        proposal_drafts_started: 1,
        formal_candidate_persisted: false,
        experiment_started: false,
      },
      execution,
      provider: 'getelucid',
      model: 'gpt-5.6-sol',
      profileId: 'bfcl-v4',
      runManifest: {
        path: '/data/run-manifest.json',
        sha256: 'a'.repeat(64),
        manifest: {
          proposal: { context_sha256: 'b'.repeat(64) },
          h0: { source_pool_sha256: 'c'.repeat(64) },
        },
      },
    })
    expect(summary).toMatchObject({
      exploratory: true,
      provider: 'getelucid',
      max_proposal_drafts: 1,
      proposal_drafts_started: 1,
      run_manifest: {
        path: '/data/run-manifest.json',
        sha256: 'a'.repeat(64),
        proposal_context_sha256: 'b'.repeat(64),
        source_pool_sha256: 'c'.repeat(64),
      },
    })
    expect(Object.hasOwn(summary, 'protocol_amendment')).toBe(false)
    expect(Object.hasOwn(summary, 'same_logical_h1')).toBe(false)
  })

  it('reports an accepted complete generation as a closed loop', () => {
    const summary = summarize({
      status: 'succeeded',
      phase: 'complete',
      attempts: [{ status: 'passed' }],
      formal_candidate_persisted: true,
      experiment_started: true,
      feedback_id: 'h1-search-feedback',
      decision: {
        accepted: true,
        reason: 'accepted_strict_improvement',
        candidate_score: 0.84,
        baseline_score: 0.8,
      },
    })

    expect(summary).toMatchObject({
      status: 'succeeded',
      outcome: 'h1_accepted',
      closed_loop: true,
      failed_drafts: 0,
      h1_feedback_registered: true,
      run_manifest: {
        sha256: 'a'.repeat(64),
        proposal_context_sha256: 'b'.repeat(64),
      },
      restart_reconciliation_exercised: true,
    })
    expect(Object.hasOwn(summary, 'protocol_amendment')).toBe(false)
    expect(Object.hasOwn(summary, 'closedLoop')).toBe(false)
  })

  it('reports a rejected complete generation as a closed loop', () => {
    expect(summarize({
      status: 'succeeded',
      phase: 'complete',
      attempts: [{ status: 'passed' }],
      formal_candidate_persisted: true,
      experiment_started: true,
      decision: {
        accepted: false,
        reason: 'not_strictly_better',
        candidate_score: 0.8,
        baseline_score: 0.8,
      },
    }, 'start')).toMatchObject({
      outcome: 'h1_rejected_closed_loop',
      closed_loop: true,
      h1_feedback_registered: false,
      restart_reconciliation_exercised: false,
    })
  })

  it('reports a recovery-required generation as incomplete', () => {
    expect(summarize({
      status: 'recovery_required',
      phase: 'experiment',
      attempts: [{ status: 'passed' }],
      formal_candidate_persisted: true,
      experiment_started: true,
    })).toMatchObject({
      outcome: 'incomplete',
      closed_loop: false,
      decision: null,
      requires_resume: true,
      restart_reconciliation_exercised: false,
    })
  })

  it.each(['queued', 'running'])('reports a durable %s generation as requiring resume', status => {
    expect(summarize({
      status,
      phase: status === 'queued' ? 'initialized' : 'proposing',
      attempts: [],
      formal_candidate_persisted: false,
      experiment_started: false,
    }, 'status')).toMatchObject({
      outcome: 'incomplete',
      closed_loop: false,
      requires_resume: true,
      restart_reconciliation_exercised: false,
    })
  })
})

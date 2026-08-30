/** Build the machine-readable result emitted by the formal Stage 4C CLI. */
export function summarizeStage4CExecution({
  requestedCommand,
  operation,
  state,
  execution,
  provider,
  model,
  profileId,
  protocolAmendment,
}) {
  const closedLoop = state.status === 'succeeded' && state.phase === 'complete' && state.decision !== undefined
  const outcome = !closedLoop
    ? 'incomplete'
    : state.decision.accepted
      ? 'h1_accepted'
      : 'h1_rejected_closed_loop'
  return Object.freeze({
    schema_version: 'autodata-stage4c-first-h1-summary-1',
    requested_command: requestedCommand,
    operation,
    provider,
    model,
    same_logical_h1: true,
    protocol_amendment: {
      amendment_id: protocolAmendment.id,
      sha256: protocolAmendment.sha256,
      path: protocolAmendment.path,
      original_generation_run_id: protocolAmendment.originalGenerationRunId,
    },
    execution_commit: execution.commit,
    execution_commit_short: execution.short_commit,
    profile_id: profileId,
    generation_run_id: execution.generation_run_id,
    experiment_run_id: execution.experiment_run_id,
    candidate_id: execution.candidate_id,
    status: state.status,
    phase: state.phase,
    draft_attempts: state.attempts.length,
    failed_drafts: state.attempts.filter(attempt => attempt.status === 'failed').length,
    formal_candidate_persisted: state.formal_candidate_persisted,
    experiment_started: state.experiment_started === true,
    decision: state.decision === undefined ? null : {
      accepted: state.decision.accepted,
      reason: state.decision.reason,
      candidate_score: state.decision.candidate_score,
      baseline_score: state.decision.baseline_score,
    },
    h1_feedback_registered: state.feedback_id !== undefined,
    outcome,
    closed_loop: closedLoop,
    requires_resume: ['queued', 'running', 'recovery_required'].includes(state.status),
    restart_reconciliation_exercised: operation === 'resume' && state.status === 'succeeded',
    b_test_touched: false,
  })
}

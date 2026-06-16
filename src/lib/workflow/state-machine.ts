/**
 * Workflow Engine — State Machine
 *
 * Enforces valid state transitions. Invalid transitions are logged and rejected.
 */

import { StepStatus, type WorkflowRunRecord, type DagNode, logger } from './types';

// ═══════════════════════════════════════════════════ State Transitions ═══

export const VALID_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  [StepStatus.PENDING]:     [StepStatus.BLOCKED, StepStatus.IN_PROGRESS, StepStatus.WAITING, StepStatus.SKIPPED, StepStatus.FAILED],
  [StepStatus.BLOCKED]:     [StepStatus.PENDING, StepStatus.SKIPPED],
  [StepStatus.IN_PROGRESS]: [StepStatus.WAITING, StepStatus.COMPLETED, StepStatus.FAILED],
  [StepStatus.WAITING]:     [StepStatus.IN_PROGRESS, StepStatus.COMPLETED, StepStatus.FAILED],
  [StepStatus.COMPLETED]:   [],  // terminal state
  [StepStatus.SKIPPED]:     [],  // terminal state
  [StepStatus.FAILED]:      [StepStatus.PENDING],  // only retry allowed
} as const;

/** Check if a state transition is valid */
export function isValidTransition(from: StepStatus, to: StepStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Safe state transition with validation */
export function transition(run: WorkflowRunRecord, node: DagNode, newStatus: StepStatus): boolean {
  if (!isValidTransition(node.status, newStatus)) {
    logger.warn('transition', `Invalid: ${node.status} → ${newStatus} for ${node.step.id} (run ${run.runId.slice(0, 8)})`);
    return false;
  }
  const oldStatus = node.status;
  node.status = newStatus;
  run.steps.set(node.step.id, newStatus);
  logger.debug('transition', `${node.step.id}: ${oldStatus} → ${newStatus}`);
  return true;
}

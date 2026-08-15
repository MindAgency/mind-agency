import { StepStatus, type DagNode, type WorkflowRunRecord } from './types.js';

export const VALID_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  [StepStatus.PENDING]: [
    StepStatus.BLOCKED,
    StepStatus.IN_PROGRESS,
    StepStatus.WAITING,
    StepStatus.SKIPPED,
    StepStatus.FAILED,
  ],
  [StepStatus.BLOCKED]: [StepStatus.PENDING, StepStatus.SKIPPED, StepStatus.FAILED],
  [StepStatus.IN_PROGRESS]: [StepStatus.WAITING, StepStatus.COMPLETED, StepStatus.FAILED],
  [StepStatus.WAITING]: [StepStatus.IN_PROGRESS, StepStatus.COMPLETED, StepStatus.FAILED],
  [StepStatus.COMPLETED]: [],
  [StepStatus.SKIPPED]: [],
  [StepStatus.FAILED]: [StepStatus.PENDING],
};

export function isValidTransition(from: StepStatus, to: StepStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(run: WorkflowRunRecord, node: DagNode, next: StepStatus): boolean {
  if (!isValidTransition(node.status, next)) return false;
  node.status = next;
  run.steps.set(node.step.id, next);
  return true;
}

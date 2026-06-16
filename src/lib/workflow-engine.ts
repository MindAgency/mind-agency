/**
 * Workflow Engine — Barrel Re-export
 *
 * All types, classes, and functions are now in ./workflow/ modules.
 * This file re-exports everything for backward compatibility.
 */

export * from './workflow/types';
export * from './workflow/engine';
export * from './workflow/state-machine';
export * from './workflow/scheduler';
export * from './workflow/executor';
export * from './workflow/callbacks';

// Explicit named re-exports to ensure backward compatibility
export { WorkflowEngine } from './workflow/engine';
export { StepStatus, WorkflowStatus, WorkflowPhase, LogLevel } from './workflow/types';
export type {
  WorkflowStep,
  WorkflowStepRoute,
  WorkflowTrigger,
  WorkflowDefinition,
  TaskReport,
  WorkflowRunRecord,
  StepExecutor,
  StepLifecycle,
  EngineMetrics,
  DagNode,
  EngineState,
  EngineAPI,
} from './workflow/types';
export { EngineLogger, logger, phaseForAction, parseReviewFindings, getAgents, parseWorkflowYaml, PRIORITY } from './workflow/types';
export { isValidTransition, VALID_TRANSITIONS, transition } from './workflow/state-machine';
export { SimulatedStepExecutor, ChatStepExecutor, createStepExecutor } from './workflow/executor';

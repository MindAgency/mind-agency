import type { StepExecutionContext, StepExecutor, WorkflowStep } from './types.js';

export class SimulatedStepExecutor implements StepExecutor {
  async execute(step: WorkflowStep, context: StepExecutionContext): Promise<string> {
    const action = step.action || 'execute';
    const agent = step.agent || step.agents?.[0] || 'unassigned';
    const upstream = Object.keys(context.upstream);
    return [
      `COMPLETED ACTION:${action} AGENT:${agent} STEP:${step.id}`,
      step.prompt ? `Prompt: ${step.prompt}` : undefined,
      upstream.length > 0 ? `Upstream: ${upstream.join(', ')}` : undefined,
    ].filter(Boolean).join('\n');
  }
}

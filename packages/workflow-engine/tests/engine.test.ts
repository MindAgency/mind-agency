import { describe, expect, it, vi } from 'vitest';
import {
  StepStatus,
  WorkflowEngine,
  WorkflowEventType,
  WorkflowStatus,
  type StepExecutor,
} from '../src/index.js';

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('WorkflowEngine', () => {
  it('executes a dependent DAG and passes upstream output', async () => {
    const executor: StepExecutor = {
      async execute(step, context) {
        if (step.id === 'build') {
          expect(context.upstream.design).toContain('design-output');
        }
        return `${step.id}-output`;
      },
    };
    const engine = new WorkflowEngine({ executor, concurrency: 2 });
    const run = engine.execute({
      name: 'basic',
      steps: [
        { id: 'design' },
        { id: 'build', dependsOn: ['design'] },
      ],
    });

    await waitFor(() => engine.getRun(run.runId)?.status === WorkflowStatus.COMPLETED);

    expect(run.outputs.get('design')).toBe('design-output');
    expect(run.outputs.get('build')).toBe('build-output');
    expect(run.steps.get('build')).toBe(StepStatus.COMPLETED);
  });

  it('supports callback-based waiting steps', async () => {
    const engine = new WorkflowEngine({
      executor: {
        async execute(step) {
          if (step.id === 'external') return { status: 'waiting', output: '' };
          return 'after-callback';
        },
      },
    });
    const run = engine.execute({
      name: 'callback',
      steps: [
        { id: 'external' },
        { id: 'next', dependsOn: ['external'] },
      ],
    });

    await waitFor(() => run.steps.get('external') === StepStatus.WAITING);
    expect(engine.callback(run.runId, 'external', 'external-output')).toBe(true);
    await waitFor(() => run.status === WorkflowStatus.COMPLETED);

    expect(run.outputs.get('external')).toBe('external-output');
    expect(run.outputs.get('next')).toBe('after-callback');
  });

  it('emits approval requests and resumes after approval', async () => {
    const approvals: string[] = [];
    const engine = new WorkflowEngine({
      executor: {
        async execute(step) {
          return `${step.id}-done`;
        },
      },
    });
    engine.on(event => {
      if (event.type === WorkflowEventType.APPROVAL_REQUESTED) {
        approvals.push(String(event.payload?.approvalId));
      }
    });

    const run = engine.execute({
      name: 'approval',
      steps: [
        { id: 'draft' },
        { id: 'gate', action: 'human_approval', dependsOn: ['draft'] },
        { id: 'publish', dependsOn: ['gate'] },
      ],
    });

    await waitFor(() => approvals.length === 1);
    expect(engine.submitApproval(approvals[0]!, 'APPROVED')).toBe(true);
    await waitFor(() => run.status === WorkflowStatus.COMPLETED);

    expect(run.outputs.get('publish')).toBe('publish-done');
  });

  it('retries failed steps', async () => {
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) throw new Error('temporary');
      return 'ok';
    });
    const engine = new WorkflowEngine({
      executor: { execute },
      defaultRetry: 1,
    });
    const run = engine.execute({ name: 'retry', steps: [{ id: 'fragile' }] });

    await waitFor(() => run.status === WorkflowStatus.COMPLETED, 2000);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(run.outputs.get('fragile')).toBe('ok');
  });

  it('parses route conditions and skips unmatched dependents', async () => {
    const engine = new WorkflowEngine({
      executor: {
        async execute(step) {
          if (step.id === 'review') return 'APPROVED';
          return `${step.id}-done`;
        },
      },
    });
    const run = engine.execute({
      name: 'routes',
      steps: [
        {
          id: 'review',
          routes: [{ step: 'ship', when: 'output contains APPROVED' }],
        },
        { id: 'ship', dependsOn: ['review'] },
        { id: 'revise', dependsOn: ['review'] },
      ],
    });

    await waitFor(() => run.status === WorkflowStatus.COMPLETED);

    expect(run.steps.get('ship')).toBe(StepStatus.COMPLETED);
    expect(run.steps.get('revise')).toBe(StepStatus.SKIPPED);
  });
});

# Mind Workflow Engine

A standalone TypeScript workflow engine for long-horizon agentic DAG execution.

This package is the open-source core extracted from Mind Agency. It deliberately
does not depend on Next.js, Electron, WebSocket servers, local agent folders, RAG,
or any Mind Agency product-specific runtime. Side effects enter through a small
`StepExecutor` interface and leave through workflow events.

## Why this exists

Most agent systems start as scripts and become hard to reason about once they
need retries, review loops, human approval, callback-based agents, partial
failure, branching, or long-running state. This package focuses on the part that
should stay portable:

- DAG workflow execution
- step state transitions
- async and callback-based steps
- claim steps for multi-agent assignment
- human approval gates
- route-based branching
- retry and timeout handling
- event subscription for observability and persistence adapters

## Install

```bash
npm install @mind-agency/workflow-engine
```

## Quick Start

```ts
import {
  WorkflowEngine,
  WorkflowEventType,
  type StepExecutor,
} from '@mind-agency/workflow-engine';

const executor: StepExecutor = {
  async execute(step, context) {
    return `completed ${step.id} after ${Object.keys(context.upstream).length} upstream steps`;
  },
};

const engine = new WorkflowEngine({ executor, concurrency: 2 });

engine.on(event => {
  if (event.type === WorkflowEventType.RUN_COMPLETED) {
    console.log(`workflow ${event.workflowName} completed`);
  }
});

const run = engine.execute({
  name: 'ship-feature',
  steps: [
    { id: 'design', agent: 'architect', prompt: 'Create design' },
    { id: 'build', agent: 'engineer', dependsOn: ['design'], prompt: 'Implement' },
    { id: 'review', action: 'human_approval', dependsOn: ['build'] },
  ],
});

console.log(run.runId);
```

## Callback Steps

Return `{ status: 'waiting', output: '' }` when the work is delegated to an
external actor. Later, resume the DAG with `callback()`.

```ts
const engine = new WorkflowEngine({
  executor: {
    async execute(step) {
      if (step.action === 'delegate') return { status: 'waiting', output: '' };
      return `done ${step.id}`;
    },
  },
});

const run = engine.execute({
  name: 'callback-demo',
  steps: [
    { id: 'ask-agent', action: 'delegate' },
    { id: 'next', dependsOn: ['ask-agent'] },
  ],
});

engine.callback(run.runId, 'ask-agent', 'agent completed the task');
```

## YAML

```ts
import { parseWorkflowYaml } from '@mind-agency/workflow-engine';

const workflow = parseWorkflowYaml(`
name: research-loop
concurrency: 2
steps:
  - id: research
    agent: researcher
    prompt: Find evidence
  - id: critique
    agent: reviewer
    dependsOn: [research]
    routes:
      - step: revise
        when: output contains NEEDS_REVISION
  - id: revise
    agent: researcher
    dependsOn: [critique]
`);
```

## Adapter Boundary

The core package intentionally excludes:

- provider-specific chat calls
- filesystem persistence
- WebSocket broadcasting
- product metrics
- RAG or memory indexing
- permission systems

Those should be implemented as adapters around `StepExecutor`, `engine.on(...)`,
and `engine.snapshot(...)`.

## Development

```bash
npm run typecheck
npm test
npm run build
```

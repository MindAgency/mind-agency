import { describe, expect, it } from 'vitest';
import { parseWorkflowYaml } from '../src/index.js';

describe('parseWorkflowYaml', () => {
  it('parses a workflow definition', () => {
    const workflow = parseWorkflowYaml(`
name: sample
concurrency: 2
steps:
  - id: research
    agent: alice
  - id: review
    dependsOn: [research]
    routes:
      - step: revise
        when: output contains NEEDS_REVISION
`);

    expect(workflow.name).toBe('sample');
    expect(workflow.concurrency).toBe(2);
    expect(workflow.steps[1]?.dependsOn).toEqual(['research']);
    expect(workflow.steps[1]?.routes?.[0]?.step).toBe('revise');
  });

  it('rejects empty workflows', () => {
    expect(() => parseWorkflowYaml('name: bad\nsteps: []')).toThrow(/at least one step/);
  });
});

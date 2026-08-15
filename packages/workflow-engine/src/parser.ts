import yaml from 'js-yaml';
import type { WorkflowDefinition, WorkflowStep } from './types.js';

export function parseWorkflowYaml(raw: string): WorkflowDefinition {
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Workflow YAML must be an object');
  }

  const data = parsed as Record<string, unknown>;
  const name = asString(data.name, 'name');
  const steps = data.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Workflow YAML must contain at least one step');
  }

  const definition: WorkflowDefinition = {
    name,
    source: raw,
    steps: steps.map((step, index) => normalizeStep(step, index)),
  };
  const description = optionalString(data.description);
  const concurrency = optionalPositiveInteger(data.concurrency, 'concurrency');
  if (description !== undefined) definition.description = description;
  if (concurrency !== undefined) definition.concurrency = concurrency;
  return definition;
}

function normalizeStep(input: unknown, index: number): WorkflowStep {
  if (!input || typeof input !== 'object') {
    throw new Error(`Step at index ${index} must be an object`);
  }
  const step = input as Record<string, unknown>;
  const id = asString(step.id, `steps[${index}].id`);

  const normalized: WorkflowStep = {
    id,
  };
  const type = optionalEnum(step.type, ['step', 'trigger', 'claim', 'human_approval']);
  const agent = optionalString(step.agent);
  const agents = optionalStringArray(step.agents, `steps[${index}].agents`);
  const action = optionalString(step.action);
  const prompt = optionalString(step.prompt);
  const condition = optionalString(step.condition);
  const dependsOn = optionalStringArray(step.dependsOn, `steps[${index}].dependsOn`);
  const routes = Array.isArray(step.routes)
    ? step.routes.map((route, routeIndex) => normalizeRoute(route, index, routeIndex))
    : undefined;
  const timeoutMs = optionalPositiveInteger(step.timeoutMs ?? step.timeout, `steps[${index}].timeoutMs`);
  const retry = optionalNonNegativeInteger(step.retry, `steps[${index}].retry`);
  const retryBackoff = optionalEnum(step.retryBackoff, ['fixed', 'exponential']);
  const priority = optionalEnum(step.priority, ['low', 'normal', 'high', 'critical']);
  const onFailure = optionalString(step.onFailure);
  const onReject = optionalString(step.onReject);
  const onApprove = optionalString(step.onApprove);
  const maxRejectRetries = optionalNonNegativeInteger(step.maxRejectRetries, `steps[${index}].maxRejectRetries`);

  if (type !== undefined) normalized.type = type;
  if (agent !== undefined) normalized.agent = agent;
  if (agents !== undefined) normalized.agents = agents;
  if (action !== undefined) normalized.action = action;
  if (prompt !== undefined) normalized.prompt = prompt;
  if (step.input !== undefined) normalized.input = step.input;
  if (condition !== undefined) normalized.condition = condition;
  if (dependsOn !== undefined) normalized.dependsOn = dependsOn;
  if (routes !== undefined) normalized.routes = routes;
  if (timeoutMs !== undefined) normalized.timeoutMs = timeoutMs;
  if (retry !== undefined) normalized.retry = retry;
  if (retryBackoff !== undefined) normalized.retryBackoff = retryBackoff;
  if (priority !== undefined) normalized.priority = priority;
  if (onFailure !== undefined) normalized.onFailure = onFailure;
  if (onReject !== undefined) normalized.onReject = onReject;
  if (onApprove !== undefined) normalized.onApprove = onApprove;
  if (maxRejectRetries !== undefined) normalized.maxRejectRetries = maxRejectRetries;
  return normalized;
}

function normalizeRoute(input: unknown, stepIndex: number, routeIndex: number) {
  if (!input || typeof input !== 'object') {
    throw new Error(`steps[${stepIndex}].routes[${routeIndex}] must be an object`);
  }
  const route = input as Record<string, unknown>;
  return {
    step: asString(route.step, `steps[${stepIndex}].routes[${routeIndex}].step`),
    when: asString(route.when, `steps[${stepIndex}].routes[${routeIndex}].when`),
  };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Expected one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

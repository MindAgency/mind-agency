/**
 * Agency — unified manager for all resources.
 *
 * Consolidates:
 *   - AgentRegistry (agent proxies)
 *   - GroupRegistry (group proxies)
 *   - SystemProxy (system configuration)
 *   - WorkflowProxy (workflow management)
 *   - ConsensusProxy (consensus management)
 *   - AuditProxy (audit logging)
 *
 * Singleton instance — use getAgency() to access.
 */

import { AgentRegistry, getAgentRegistry } from './agent-registry';
import { AgentProxy } from './agent-proxy';
import { GroupRegistry, getGroupRegistry } from './group-registry';
import { GroupProxy } from './group-proxy';
import { SystemProxy, getSystemProxy } from './system-proxy';
import { WorkflowProxy, getWorkflowProxy } from './workflow-proxy';
import { ConsensusProxy, getConsensusProxy } from './consensus-proxy';
import { AuditProxy, getAuditProxy } from './audit-proxy';

// ── Error types ───────────────────────────────────────────

/**
 * Base error class for all Agency-related errors.
 *
 * Provides a structured error with a machine-readable `code` and optional
 * `details` payload for programmatic error handling downstream.
 */
export class AgencyError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgencyError';
  }
}

/**
 * Thrown when a requested resource (agent, group, etc.) does not exist.
 *
 * @example
 * throw new NotFoundError('Agent', 'me');
 */
export class NotFoundError extends AgencyError {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found`, 'NOT_FOUND', { resource, id });
    this.name = 'NotFoundError';
  }
}

/**
 * Thrown when input validation fails (e.g. invalid agent/group names).
 *
 * Carries the error code `VALIDATION_ERROR` and optional details about
 * which field failed validation.
 */
export class ValidationError extends AgencyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown when an operation fails at runtime (e.g. file I/O, API call).
 *
 * Carries the error code `OPERATION_ERROR` and optional details about
 * the failed operation.
 */
export class OperationError extends AgencyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'OPERATION_ERROR', details);
    this.name = 'OperationError';
  }
}

// ── Agency class ──────────────────────────────────────────

/**
 * Central orchestrator that unifies all resource registries.
 *
 * Provides a single entry point for accessing and managing agents,
 * groups, system config, workflows, consensus, and audit logging.
 * Use {@link getAgency} to obtain the singleton instance.
 */
export class Agency {
  private _agents: AgentRegistry;
  private _groups: GroupRegistry;
  private _system: SystemProxy;
  private _workflow: WorkflowProxy;
  private _consensus: ConsensusProxy;
  private _audit: AuditProxy;

  constructor() {
    this._agents = getAgentRegistry();
    this._groups = getGroupRegistry();
    this._system = getSystemProxy();
    this._workflow = getWorkflowProxy();
    this._consensus = getConsensusProxy();
    this._audit = getAuditProxy();
  }

  // ── Registry access ───────────────────────────────────

  get agents(): AgentRegistry {
    return this._agents;
  }

  get groups(): GroupRegistry {
    return this._groups;
  }

  get system(): SystemProxy {
    return this._system;
  }

  get workflow(): WorkflowProxy {
    return this._workflow;
  }

  get consensus(): ConsensusProxy {
    return this._consensus;
  }

  get audit(): AuditProxy {
    return this._audit;
  }

  // ── Agent shortcuts ───────────────────────────────────

  getAgent(name: string): AgentProxy {
    return this._agents.getOrCreate(name);
  }

  getAgents(): AgentProxy[] {
    return this._agents.getAll();
  }

  getAgentsByGroup(groupName: string): AgentProxy[] {
    return this._agents.getByGroup(groupName);
  }

  // ── Group shortcuts ───────────────────────────────────

  getGroup(name: string): GroupProxy {
    return this._groups.getOrCreate(name);
  }

  getGroups(): GroupProxy[] {
    return this._groups.getAll();
  }

  getGroupsByAgent(agentName: string): GroupProxy[] {
    return this._groups.getByAgent(agentName);
  }

  // ── Task shortcuts (via AgentProxy) ─────────────────────

  async addTask(agentName: string, task: import('./agent-proxy').AgentTask): Promise<void> {
    const proxy = this.getAgent(agentName);
    await proxy.addTask(task);
  }

  async getPendingTasks(agentName: string): Promise<import('./agent-proxy').AgentTask[]> {
    const proxy = this.getAgent(agentName);
    const tasks = await proxy.loadTasks();
    if (!Array.isArray(tasks)) return [];
    return tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
  }

  async completeTask(agentName: string, runId: string, result: string): Promise<void> {
    const proxy = this.getAgent(agentName);
    await proxy.completeTask(runId, result);
  }

  // ── Discovery ─────────────────────────────────────────

  /**
   * Discover all agents and groups from disk.
   */
  discoverAll(): void {
    this._agents.getAll(); // Trigger discovery
    this._groups.getAll(); // Trigger discovery
  }

  // ── Stats ─────────────────────────────────────────────

  /**
   * Get overall stats.
   */
  async getStats(): Promise<{
    agents: number;
    groups: number;
    pendingTasks: number;
  }> {
    // taste: parallel loading instead of sequential O(n*m)
    const agents = this.getAgents();
    const taskCounts = await Promise.all(
      agents.map(async (a) => {
        try { const tasks = await this.getPendingTasks(a.name); return tasks.length; }
        catch { return 0; }
      })
    );

    return {
      agents: agents.length,
      groups: this.getGroups().length,
      pendingTasks: taskCounts.reduce((sum, n) => sum + n, 0),
    };
  }

  // ── Error handling ────────────────────────────────────


  /**
   * Validate resource name (agent or group).
   */
  private validateName(name: string, type: string): void {
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new ValidationError(`Invalid ${type} name`, { name });
    }
  }

  /**
   * Validates that the given string is a legal agent name (alphanumeric, underscores, hyphens).
   * Throws {@link ValidationError} if the name is invalid.
   *
   * @param name - The agent name to validate.
   * @throws {ValidationError} If the name contains invalid characters.
   */
  validateAgentName(name: string): void { this.validateName(name, 'agent'); }

  /**
   * Validates that the given string is a legal group name (alphanumeric, underscores, hyphens).
   * Throws {@link ValidationError} if the name is invalid.
   *
   * @param name - The group name to validate.
   * @throws {ValidationError} If the name contains invalid characters.
   */
  validateGroupName(name: string): void { this.validateName(name, 'group'); }

  /**
   * Check if agent exists.
   */
  requireAgent(name: string): AgentProxy {
    this.validateAgentName(name);
    const proxy = this.getAgent(name);
    if (!proxy.exists()) {
      throw new NotFoundError('Agent', name);
    }
    return proxy;
  }

  /**
   * Check if group exists.
   */
  requireGroup(name: string): GroupProxy {
    this.validateGroupName(name);
    const proxy = this.getGroup(name);
    if (!proxy.exists()) {
      throw new NotFoundError('Group', name);
    }
    return proxy;
  }
}

// ── Singleton ─────────────────────────────────────────────

let instance: Agency | null = null;

/**
 * Returns the singleton {@link Agency} instance, creating it on first call.
 *
 * @returns The shared Agency instance.
 */
export function getAgency(): Agency {
  if (!instance) {
    instance = new Agency();
  }
  return instance;
}

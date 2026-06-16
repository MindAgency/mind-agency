/**
 * Human-readable error messages for workflow failures.
 *
 * Design principles (from UX best practices):
 * 1. Clear severity levels — distinguish blocking vs recoverable vs informational
 * 2. Actionable messages — always tell users what they can do next
 * 3. Progressive detail — summary first, details on demand
 * 4. Preserve context — include step IDs, agent names so users can find the issue
 * 5. Bilingual support — Chinese UI text with English technical details
 */

export interface UserError {
  /** Short title for the error category */
  title: string;
  /** Human-readable description of what went wrong */
  message: string;
  /** What the user can do to fix or work around the problem */
  suggestion: string;
  /** Whether the user can retry this step */
  retryable: boolean;
  /** Error severity: 'blocking' stops the workflow, 'recoverable' can be retried,
   *  'warning' is informational */
  severity: 'blocking' | 'recoverable' | 'warning';
  /** Optional error code for programmatic handling */
  code?: string;
  /** Optional link to documentation or help page */
  helpUrl?: string;
}

// ═══════════════════════════════════════════════════ Error Definitions ═══

const ERROR_MAP: Record<string, (ctx: Record<string, string>) => UserError> = {
  // ── Timeout ──
  'timeout': (ctx) => ({
    title: 'Step timed out',
    message: `Step "${ctx.stepId || 'unknown'}" did not finish within ${ctx.timeout || '5 minutes'}. The AI provider may be slow or the task may be too complex.`,
    suggestion: 'Try again — if it keeps timing out, break the task into smaller steps or increase the timeout in your workflow definition.',
    retryable: true,
    severity: 'recoverable',
    code: 'TIMEOUT',
  }),

  // ── Callback / Agent reporting ──
  'callback_failed': (ctx) => ({
    title: 'Agent did not report results',
    message: `Agent "${ctx.agent || 'unknown'}" finished but did not send back a valid result. The step output may be empty or malformed.`,
    suggestion: 'This is usually a transient issue. The system will auto-retry. If it persists, check the agent\'s logs for errors.',
    retryable: true,
    severity: 'recoverable',
    code: 'CALLBACK_FAILED',
  }),

  // ── Balance / Quota ──
  'insufficient_balance': (ctx) => ({
    title: 'API quota exceeded',
    message: `Agent "${ctx.agent}" needs ${ctx.needed || 'more'} tokens but the account balance is ${ctx.balance || 'insufficient'}.`,
    suggestion: 'Top up your API key balance, or reduce the token budget for this step. You can also switch to a cheaper model in Settings.',
    retryable: false,
    severity: 'blocking',
    code: 'INSUFFICIENT_BALANCE',
  }),

  // ── Agent not found ──
  'agent_not_found': (ctx) => ({
    title: 'Agent not found',
    message: `No agent named "${ctx.agent || 'unknown'}" exists. Workflow steps require agents that have been created and configured.`,
    suggestion: 'Check the agent name for typos. If it doesn\'t exist yet, create it from the sidebar (Agents > New Agent).',
    retryable: false,
    severity: 'blocking',
    code: 'AGENT_NOT_FOUND',
    helpUrl: '/agents',
  }),

  // ── Workflow not found ──
  'workflow_not_found': (ctx) => ({
    title: 'Workflow not found',
    message: `No workflow exists in group "${ctx.group || 'unknown'}". You need to create a workflow before you can run it.`,
    suggestion: 'Create a workflow from the Workflow panel, or use a template to get started quickly.',
    retryable: false,
    severity: 'blocking',
    code: 'WORKFLOW_NOT_FOUND',
  }),

  // ── Review rejected ──
  'review_rejected': (ctx) => ({
    title: 'Review rejected',
    message: `Step "${ctx.stepId || 'unknown'}" was rejected by the reviewer. ${ctx.reason ? `Reason: ${ctx.reason}` : 'No reason provided.'}`,
    suggestion: 'The workflow will automatically retry this step. If rejection keeps happening, review the task prompt for clarity.',
    retryable: true,
    severity: 'recoverable',
    code: 'REVIEW_REJECTED',
  }),

  // ── Network / Connection errors ──
  'network': (ctx) => ({
    title: 'Network error',
    message: `Could not reach ${ctx.provider || 'AI provider'}. Your internet connection may be down or the service may be temporarily unavailable.`,
    suggestion: 'Check your internet connection and try again. If the problem persists, the AI provider may be experiencing an outage — try again in a few minutes.',
    retryable: true,
    severity: 'recoverable',
    code: 'NETWORK_ERROR',
  }),

  // ── API key invalid ──
  'invalid_api_key': (ctx) => ({
    title: 'Invalid API key',
    message: `The API key for ${ctx.provider || 'your AI provider'} was rejected. The key may be expired, revoked, or incorrect.`,
    suggestion: 'Go to Settings and update your API key. You can get a new key from your provider\'s dashboard.',
    retryable: false,
    severity: 'blocking',
    code: 'INVALID_API_KEY',
    helpUrl: '/settings',
  }),

  // ── Rate limiting ──
  'rate_limit': (ctx) => ({
    title: 'Rate limit hit',
    message: `Too many requests to ${ctx.provider || 'the AI provider'}. You\'ve been rate-limited.`,
    suggestion: 'Wait a moment and try again. If this happens frequently, consider adding a delay between steps or upgrading your API plan.',
    retryable: true,
    severity: 'recoverable',
    code: 'RATE_LIMITED',
  }),

  // ── YAML parse errors ──
  'yaml_parse': (ctx) => ({
    title: 'Invalid workflow file',
    message: `The workflow YAML file has a syntax error${ctx.line ? ` at line ${ctx.line}` : ''}. ${ctx.detail || 'The file could not be parsed.'}`,
    suggestion: 'Open the workflow file in a text editor and check for indentation errors, missing colons, or unclosed quotes. Use an online YAML validator if needed.',
    retryable: false,
    severity: 'blocking',
    code: 'YAML_PARSE_ERROR',
  }),

  // ── Circular dependencies ──
  'circular': (ctx) => ({
    title: 'Circular dependency detected',
    message: `Steps ${ctx.steps || 'in the workflow'} form a circular loop. A step cannot depend on another step that depends back on it.`,
    suggestion: 'Review your step dependencies and break the cycle. Each step should form a directed acyclic graph (DAG) — no loops allowed.',
    retryable: false,
    severity: 'blocking',
    code: 'CIRCULAR_DEPENDENCY',
  }),

  // ── Duplicate step IDs ──
  'duplicate': (ctx) => ({
    title: 'Duplicate step IDs',
    message: `The workflow has multiple steps with the same ID: "${ctx.ids || 'unknown'}". Each step must have a unique identifier.`,
    suggestion: 'Rename the duplicate steps so each has a unique ID. Step IDs are used for dependencies and logging.',
    retryable: false,
    severity: 'blocking',
    code: 'DUPLICATE_STEP_ID',
  }),

  // ── Circuit breaker open ──
  'circuit_breaker': (ctx) => ({
    title: 'Agent temporarily disabled',
    message: `Agent "${ctx.agent || 'unknown'}" has failed too many times and has been temporarily paused to prevent cascading failures.`,
    suggestion: 'Wait a few minutes for the circuit breaker to reset, then try again. If the agent keeps failing, check its configuration and the AI provider status.',
    retryable: true,
    severity: 'recoverable',
    code: 'CIRCUIT_BREAKER_OPEN',
  }),

  // ── File not found ──
  'file_not_found': (ctx) => ({
    title: 'File not found',
    message: `The file "${ctx.path || 'unknown'}" could not be found. ${ctx.detail || ''}`,
    suggestion: 'Check the file path for typos. If the file was recently moved or deleted, update the path in your workflow step.',
    retryable: false,
    severity: 'blocking',
    code: 'FILE_NOT_FOUND',
  }),

  // ── Permission denied ──
  'permission': (ctx) => ({
    title: 'Permission denied',
    message: `Cannot access "${ctx.path || 'resource'}". The system does not have permission to read or write this location.`,
    suggestion: 'Check file permissions. On Windows, make sure Mind Agency has write access to the data directory.',
    retryable: false,
    severity: 'blocking',
    code: 'PERMISSION_DENIED',
  }),

  // ── Max retries exceeded ──
  'max_retries': (ctx) => ({
    title: 'Max retries exceeded',
    message: `Step "${ctx.stepId || 'unknown'}" has been retried ${ctx.count || 'multiple'} times and still failed. Giving up to avoid infinite loops.`,
    suggestion: 'The step needs attention. Check the error logs for the underlying issue. You may need to fix the task prompt or agent configuration.',
    retryable: false,
    severity: 'blocking',
    code: 'MAX_RETRIES',
  }),

  // ── Disk space ──
  'enospc': (ctx) => ({
    title: 'Disk space full',
    message: `The system ran out of disk space while writing to "${ctx.path || 'the data directory'}". No new data can be saved.`,
    suggestion: 'Free up disk space by deleting old workflow runs or temporary files. Check the .mind directory size.',
    retryable: false,
    severity: 'blocking',
    code: 'DISK_FULL',
  }),

  // ── Agent busy / locked ──
  'busy': (ctx) => ({
    title: 'Agent is busy',
    message: `Agent "${ctx.agent || 'unknown'}" is already running a task and cannot start another one at the same time.`,
    suggestion: 'Wait for the current task to finish, or use a different agent. Check the workflow panel for running tasks.',
    retryable: true,
    severity: 'recoverable',
    code: 'AGENT_BUSY',
  }),

  // ── Model not found ──
  'model_not_found': (ctx) => ({
    title: 'Model not available',
    message: `The model "${ctx.model || 'unknown'}" is not available from ${ctx.provider || 'your AI provider'}. It may have been deprecated or renamed.`,
    suggestion: 'Go to Settings and select a different model. Check your provider\'s documentation for available models.',
    retryable: false,
    severity: 'blocking',
    code: 'MODEL_NOT_FOUND',
    helpUrl: '/settings',
  }),

  // ── Workflow validation failed ──
  'validation': (ctx) => ({
    title: 'Workflow validation failed',
    message: `The workflow definition has an error: ${ctx.detail || 'invalid configuration'}. The workflow cannot be started until this is fixed.`,
    suggestion: 'Open the workflow YAML file and check for syntax errors, missing required fields, or invalid step references.',
    retryable: false,
    severity: 'blocking',
    code: 'VALIDATION_ERROR',
  }),

  // ── Agent configuration error ──
  'config_error': (ctx) => ({
    title: 'Agent configuration error',
    message: `Agent "${ctx.agent || 'unknown'}" has an invalid configuration: ${ctx.detail || 'missing required fields'}.`,
    suggestion: 'Open the agent\'s configuration file and check for missing or invalid fields. Re-create the agent if needed.',
    retryable: false,
    severity: 'blocking',
    code: 'CONFIG_ERROR',
    helpUrl: '/agents',
  }),

  // ── Dependency not found ──
  'dependency_not_found': (ctx) => ({
    title: 'Missing dependency',
    message: `Step "${ctx.stepId || 'unknown'}" depends on step "${ctx.dependsOn || 'unknown'}" which does not exist in this workflow.`,
    suggestion: 'Check the dependsOn configuration. Make sure the referenced step ID is spelled correctly and exists in the workflow.',
    retryable: false,
    severity: 'blocking',
    code: 'DEPENDENCY_NOT_FOUND',
  }),

  // ── Workflow already running ──
  'already_running': (ctx) => ({
    title: 'Workflow already running',
    message: `Workflow "${ctx.workflow || 'unknown'}" is already running. You cannot start a second instance of the same workflow.`,
    suggestion: 'Wait for the current run to complete, or stop it from the workflow panel before starting a new one.',
    retryable: true,
    severity: 'recoverable',
    code: 'ALREADY_RUNNING',
  }),
};

// ═══════════════════════════════════════════════════ Core Functions ═══

/** Translate a technical error into a user-friendly message */
export function toUserError(error: string, context: Record<string, string> = {}): UserError {
  const lower = error.toLowerCase();

  // Try to match error pattern
  for (const [pattern, formatter] of Object.entries(ERROR_MAP)) {
    if (lower.includes(pattern)) {
      return formatter(context);
    }
  }

  // Check for HTTP status codes and map them
  const httpMatch = error.match(/(?:status|code)[\s:=]*(\d{3})/i) || error.match(/\b(\d{3})\s*(?:error|status)/i);
  if (httpMatch) {
    const code = parseInt(httpMatch[1]);
    if (code === 401 || code === 403) {
      return {
        title: 'Authentication error',
        message: `The AI provider returned a ${code} error. Your API key may be invalid or expired.`,
        suggestion: 'Go to Settings and update your API key. Get a new key from your provider\'s dashboard.',
        retryable: false,
        severity: 'blocking',
        code: 'AUTH_ERROR',
        helpUrl: '/settings',
      };
    }
    if (code === 404) {
      return {
        title: 'Resource not found',
        message: `The AI provider returned a 404. The requested model or endpoint may not exist.`,
        suggestion: 'Check that the model name is correct in Settings. Some models may have been deprecated.',
        retryable: false,
        severity: 'blocking',
        code: 'NOT_FOUND',
        helpUrl: '/settings',
      };
    }
    if (code === 429) {
      return {
        title: 'Rate limit hit',
        message: `The AI provider returned a 429 (Too Many Requests) error.`,
        suggestion: 'Wait a moment and try again. If this happens frequently, consider adding delays between steps or upgrading your API plan.',
        retryable: true,
        severity: 'recoverable',
        code: 'RATE_LIMITED',
      };
    }
    if (code === 502 || code === 503) {
      return {
        title: 'Provider temporarily unavailable',
        message: `The AI provider returned a ${code} — the service is temporarily down or overloaded.`,
        suggestion: 'Try again in 1-2 minutes. Check the provider\'s status page for ongoing incidents.',
        retryable: true,
        severity: 'recoverable',
        code: 'SERVICE_UNAVAILABLE',
      };
    }
    if (code >= 500) {
      return {
        title: 'Server error',
        message: `The AI provider returned a ${code} server error. This is an issue on their end, not yours.`,
        suggestion: 'Try again in a few minutes. Check the provider\'s status page if the problem persists.',
        retryable: true,
        severity: 'recoverable',
        code: 'SERVER_ERROR',
      };
    }
  }

  // Default: return the error with useful context
  const truncated = error.length > 200 ? error.slice(0, 197) + '...' : error;
  return {
    title: 'Execution failed',
    message: truncated,
    suggestion: 'Check the workflow logs for details, or try running the step again. If this keeps happening, the task prompt may need adjustment.',
    retryable: true,
    severity: 'recoverable',
    code: 'UNKNOWN',
  };
}

/** Format UserError for display */
export function formatUserError(err: UserError): string {
  const severityTag = err.severity === 'blocking' ? '[BLOCKING]' : err.severity === 'recoverable' ? '' : '[INFO]';
  return `${severityTag} [${err.title}] ${err.message} -- ${err.suggestion}`;
}

/**
 * Get a user-friendly severity label for display in UI.
 * Use this when rendering errors in the workflow panel.
 */
export function getSeverityLabel(severity: UserError['severity']): string {
  switch (severity) {
    case 'blocking': return 'Error';
    case 'recoverable': return 'Warning';
    case 'warning': return 'Info';
  }
}

/**
 * Get a CSS class name for severity-based styling.
 * Returns a Tailwind-compatible class string.
 */
export function getSeverityClasses(severity: UserError['severity']): string {
  switch (severity) {
    case 'blocking': return 'text-red-500 bg-red-50 dark:bg-red-950';
    case 'recoverable': return 'text-amber-500 bg-amber-50 dark:bg-amber-950';
    case 'warning': return 'text-blue-500 bg-blue-50 dark:bg-blue-950';
  }
}

/**
 * Get an icon for severity-based display.
 * Returns an emoji that can be used in UI labels and notifications.
 */
export function getSeverityIcon(severity: UserError['severity']): string {
  switch (severity) {
    case 'blocking': return 'X';
    case 'recoverable': return '!';
    case 'warning': return 'i';
  }
}

/**
 * Get a summary of multiple errors, grouped by severity.
 * Useful for displaying batch error reports in the workflow panel.
 *
 * Returns a structured summary with counts, blocking errors listed first,
 * and a combined suggestion for the most common issue.
 */
export function getUserErrorSummary(errors: UserError[]): {
  total: number;
  blocking: number;
  recoverable: number;
  warnings: number;
  blockingErrors: UserError[];
  topSuggestion: string;
} {
  const blocking = errors.filter(e => e.severity === 'blocking');
  const recoverable = errors.filter(e => e.severity === 'recoverable');
  const warning = errors.filter(e => e.severity === 'warning');

  // Pick the most actionable suggestion (from blocking errors, or first recoverable)
  const topError = blocking[0] || recoverable[0] || errors[0];
  const topSuggestion = topError?.suggestion || 'Check the workflow logs for details.';

  return {
    total: errors.length,
    blocking: blocking.length,
    recoverable: recoverable.length,
    warnings: warning.length,
    blockingErrors: blocking,
    topSuggestion,
  };
}

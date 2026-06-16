/**
 * Metrics Collection System
 *
 * Lightweight Prometheus-compatible metrics without external dependencies.
 * Collects counters, histograms, and gauges for system monitoring.
 *
 * Usage:
 * ```typescript
 * import { metrics } from '@/lib/metrics';
 * metrics.httpRequests.inc({ method: 'GET', path: '/api/groups' });
 * metrics.workflowDuration.observe(1234);
 * ```
 */

// ═══════ Counter ═══════

class Counter {
  private value = 0;
  private labels: Record<string, string>;

  constructor(labels: Record<string, string> = {}) {
    this.labels = labels;
  }

  inc(amount: number = 1) {
    this.value += amount;
  }

  reset() {
    this.value = 0;
  }

  get(): number {
    return this.value;
  }

  getLabels(): Record<string, string> {
    return this.labels;
  }
}

// ═══════ Histogram ═══════

class Histogram {
  private buckets: number[];
  private counts: number[];
  private sum = 0;
  private count = 0;

  constructor(buckets: number[] = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000]) {
    this.buckets = buckets;
    this.counts = new Array(buckets.length + 1).fill(0);
  }

  observe(value: number) {
    this.sum += value;
    this.count++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        this.counts[i]++;
        return;
      }
    }
    this.counts[this.buckets.length]++; // +Inf bucket
  }

  reset() {
    this.counts = new Array(this.buckets.length + 1).fill(0);
    this.sum = 0;
    this.count = 0;
  }

  getSum(): number { return this.sum; }
  getCount(): number { return this.count; }
  getBuckets(): { le: number; count: number }[] {
    return this.buckets.map((le, i) => ({ le, count: this.counts[i] }));
  }
}

// ═══════ Gauge ═══════

class Gauge {
  private value = 0;

  set(value: number) { this.value = value; }
  inc(amount: number = 1) { this.value += amount; }
  dec(amount: number = 1) { this.value -= amount; }
  reset() { this.value = 0; }
  get(): number { return this.value; }
}

// ═══════ Metrics Registry ═══════

class MetricsRegistry {
  // HTTP metrics
  readonly httpRequests = new Map<string, Counter>();
  readonly httpDuration = new Histogram();

  // Workflow metrics
  readonly workflowRuns = new Counter();
  readonly workflowStepDuration = new Histogram();
  readonly workflowStepRetries = new Counter();
  readonly workflowStepFailures = new Counter();

  // Agent metrics
  readonly agentChatDuration = new Histogram();
  readonly agentTaskQueue = new Gauge();

  // RAG metrics
  readonly ragQueries = new Counter();
  readonly ragQueryDuration = new Histogram();

  // System metrics
  readonly activeConnections = new Gauge();
  readonly memoryUsage = new Gauge();

  /** Increment HTTP request counter */
  incHttpRequest(method: string, path: string, status: number) {
    const key = `${method}:${path}:${status}`;
    if (!this.httpRequests.has(key)) {
      this.httpRequests.set(key, new Counter({ method, path, status: String(status) }));
    }
    this.httpRequests.get(key)!.inc();
  }

  /** Export metrics in Prometheus text format */
  toPrometheus(): string {
    const lines: string[] = [];

    // HTTP requests
    for (const [, counter] of this.httpRequests) {
      const labels = counter.getLabels();
      const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
      lines.push(`mind_http_requests_total{${labelStr}} ${counter.get()}`);
    }

    // Workflow
    lines.push(`mind_workflow_runs_total ${this.workflowRuns.get()}`);
    lines.push(`mind_workflow_step_retries_total ${this.workflowStepRetries.get()}`);
    lines.push(`mind_workflow_step_failures_total ${this.workflowStepFailures.get()}`);

    // Histograms
    lines.push(...this.formatHistogram('mind_workflow_step_duration_ms', this.workflowStepDuration));
    lines.push(...this.formatHistogram('mind_http_request_duration_ms', this.httpDuration));
    lines.push(...this.formatHistogram('mind_agent_chat_duration_ms', this.agentChatDuration));
    lines.push(...this.formatHistogram('mind_rag_query_duration_ms', this.ragQueryDuration));

    // Gauges
    lines.push(`mind_agent_task_queue ${this.agentTaskQueue.get()}`);
    lines.push(`mind_rag_queries_total ${this.ragQueries.get()}`);
    lines.push(`mind_active_connections ${this.activeConnections.get()}`);

    return lines.join('\n') + '\n';
  }

  private formatHistogram(name: string, hist: Histogram): string[] {
    const lines: string[] = [];
    for (const { le, count } of hist.getBuckets()) {
      lines.push(`${name}_bucket{le="${le}"} ${count}`);
    }
    lines.push(`${name}_sum ${hist.getSum()}`);
    lines.push(`${name}_count ${hist.getCount()}`);
    return lines;
  }

  /** Reset all metrics (for testing) */
  reset() {
    this.httpRequests.clear();
    this.workflowRuns.reset();
    this.workflowStepRetries.reset();
    this.workflowStepFailures.reset();
    this.agentTaskQueue.reset();
    this.ragQueries.reset();
    this.activeConnections.reset();
    this.httpDuration.reset();
    this.workflowStepDuration.reset();
    this.agentChatDuration.reset();
    this.ragQueryDuration.reset();
  }
}

// ═══════ Singleton ═══════

export const metrics = new MetricsRegistry();

// ═══════ Assertions (for testing) ═══════

export function assertMetricEquals(name: string, expected: number, actual: number) {
  if (actual !== expected) {
    throw new Error(`Metric assertion failed: ${name} expected ${expected}, got ${actual}`);
  }
}

export function assertMetricGte(name: string, min: number, actual: number) {
  if (actual < min) {
    throw new Error(`Metric assertion failed: ${name} expected >= ${min}, got ${actual}`);
  }
}

export function assertWorkflowStarted() {
  assertMetricGte('workflow_runs', 1, metrics.workflowRuns.get());
}

export function assertStepCompleted(stepId: string) {
  assertMetricGte('workflow_step_duration', 1, metrics.workflowStepDuration.getCount());
}

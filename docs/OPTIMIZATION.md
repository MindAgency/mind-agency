# Multi-Agent Platform Optimization Recommendations

Based on analysis of multi-agent frameworks (CrewAI, AutoGen, LangGraph) and best practices for production agent systems.

---

## 1. Reducing LLM Call Latency

### 1.1 Streaming Response Consumption

The current `ChatStepExecutor` streams responses but waits for the full completion. Consider incremental processing:

- **Partial output processing**: Parse tool calls as they arrive rather than waiting for full response
- **Early termination**: For simple classification/routing steps, detect the decision early and stop consuming the stream
- **Token-level batching**: Process tokens in larger batches to reduce reader overhead

### 1.2 Prompt Optimization

- **Context budget management**: The current 4000-char context budget is reasonable. Consider dynamic budgeting based on model context window size
- **Prompt caching**: Cache system prompts and repeated prefixes. Most LLM providers support prompt caching (Claude, GPT-4o)
- **Selective context injection**: Not all upstream outputs are equally relevant. Use relevance scoring to include only the most pertinent context

### 1.3 Model Selection Strategy

- **Fast-path routing**: Route simple steps (notifications, approvals, status checks) to smaller, faster models
- **Complexity detection**: Use a lightweight classifier to determine if a step needs a large model
- **Parallel model calls**: For independent steps in the DAG, execute them concurrently (already done via DAG scheduling)

### 1.4 Connection Management

- **HTTP/2 multiplexing**: Use persistent connections to LLM providers
- **Connection pooling**: Maintain warm connections to avoid TLS handshake overhead
- **Regional endpoints**: Use the nearest API endpoint for lower network latency

---

## 2. Caching Strategies for Similar Requests

### 2.1 Semantic Caching

Implement a two-tier caching system:

**Tier 1: Exact match cache**
```
Key: SHA256(system_prompt + user_prompt + model)
Value: response
TTL: 1 hour (configurable)
```

**Tier 2: Semantic similarity cache**
```
Key: Embedding of the prompt (using existing BGE-small-zh)
Threshold: Cosine similarity > 0.95
Value: response (with metadata about the original query)
TTL: 30 minutes
```

### 2.2 Step-Level Caching

- **Workflow template cache**: Cache the compiled prompt templates for each step type
- **Context assembly cache**: Cache the assembled context when upstream outputs haven't changed
- **Decision cache**: For deterministic routing steps, cache the decision based on input features

### 2.3 Implementation Points

- Add a `CacheManager` class that wraps LLM calls
- Store cache in LanceDB (reuse existing vector store infrastructure)
- Add cache hit/miss metrics to the existing `metrics` module
- Support cache invalidation via the learning system (when agent feedback indicates a cached response was wrong)

### 2.4 Cache Invalidation Rules

- **Time-based**: TTL expiration (configurable per step type)
- **Event-based**: Invalidate when upstream steps produce new outputs
- **Feedback-based**: When evaluation system marks a response as incorrect, invalidate similar cached responses
- **Manual**: Allow operators to flush cache via MCP tool

---

## 3. Observability and Metrics

### 3.1 Distributed Tracing

Extend the existing `EventBus` system to support OpenTelemetry-compatible tracing:

```
Workflow Run (trace)
  ├─ Step: design (span)
  │  ├─ LLM Call: Claude-3.5 (span)
  │  │  ├─ Prompt assembly (span)
  │  │  ├─ API request (span)
  │  │  └─ Response parsing (span)
  │  └─ Cache lookup (span)
  ├─ Step: implement (span)
  └─ Step: review (span)
```

- Generate trace IDs at workflow run start
- Propagate trace context through step dependencies
- Export traces to Jaeger, Zipkin, or OTLP-compatible backends

### 3.2 Metrics to Track

**Latency metrics:**
- `workflow_step_duration_seconds` (histogram) - per step execution time
- `workflow_step_llm_latency_seconds` (histogram) - LLM API call duration
- `workflow_step_queue_time_seconds` (histogram) - time spent waiting in queue
- `workflow_total_duration_seconds` (histogram) - end-to-end workflow time

**Quality metrics:**
- `workflow_step_retry_count` (counter) - retries per step
- `workflow_step_failure_rate` (gauge) - rolling failure rate
- `workflow_evaluation_score` (histogram) - review/audit scores
- `workflow_circuit_breaker_trips` (counter) - agent circuit breaker activations

**Resource metrics:**
- `workflow_token_usage` (counter) - tokens consumed per step/agent
- `workflow_cache_hit_rate` (gauge) - cache effectiveness
- `workflow_concurrent_steps` (gauge) - parallelism utilization

### 3.3 Dashboard Integration

- **Workflow timeline view**: Visual DAG execution timeline showing step durations, overlaps, and critical path
- **Agent performance panel**: Per-agent metrics (success rate, avg latency, token usage)
- **Cost analysis**: Token consumption breakdown by workflow/agent/step type
- **Alert rules**: Configurable thresholds for latency, failure rate, and cost

### 3.4 Implementation Integration Points

1. **Existing metrics module**: Extend `src/lib/metrics.ts` with the new histograms/gauges
2. **EventBus hooks**: Add tracing spans in the lifecycle callbacks (`onBeforeExecute`, `onStepCompleted`, `onStepFailed`)
3. **MCP observability tools**: Expose metrics via new MCP tools for agent-driven monitoring
4. **WebSocket broadcast**: Stream real-time metrics to the frontend for live dashboards

### 3.5 Structured Logging Enhancement

Enhance the existing `logger` to include:

- Correlation IDs (trace ID + span ID)
- Step context (runId, stepId, agent)
- Timing information
- Structured JSON format for log aggregation (ELK, Loki)

---

## 4. Additional Recommendations

### 4.1 Adaptive Timeout System

Replace fixed timeouts with adaptive ones based on:
- Historical execution time for similar steps
- Current model load and response times
- Step complexity (prompt length, expected output size)

### 4.2 Speculative Execution

For steps with predictable outcomes:
- Start the next step speculatively before the current one completes
- Roll back if the speculation was wrong
- This can reduce total workflow time by 20-40% for linear pipelines

### 4.3 Connection Warm-up

- Pre-establish connections to LLM providers at system startup
- Keep connections alive with periodic health checks
- This eliminates cold-start latency for the first call

### 4.4 Batch Processing

For workflows with many similar steps:
- Group similar prompts and send as batch requests
- Use batch APIs where available (OpenAI, Anthropic support this)
- This can reduce per-request overhead significantly

---

## Priority Order

1. **High priority**: Semantic caching (2.1) - immediate latency reduction
2. **High priority**: Streaming optimization (1.1) - better user experience
3. **Medium priority**: Structured tracing (3.1) - essential for debugging
4. **Medium priority**: Adaptive timeouts (4.1) - prevents false failures
5. **Low priority**: Speculative execution (4.2) - complex but high impact

---

*Generated based on analysis of CrewAI, AutoGen, LangGraph, and production multi-agent system patterns.*

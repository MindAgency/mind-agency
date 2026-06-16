# Mind Agency — Developer Guide

## Quick Start

```bash
# Install dependencies
npm install

# Start dev servers
npm run dev:all    # Next.js + WebSocket

# Type check
npx tsc --noEmit

# Build
npm run build
```

## Adding a New Step Type

1. Define the type in `src/lib/workflow-engine.ts`:
```typescript
// In WorkflowStep interface
type?: 'step' | 'trigger' | 'claim' | 'your_type';
```

2. Handle it in `execNode()`:
```typescript
if (node.step.type === 'your_type') {
  // Your execution logic
  this.transition(run, node, StepStatus.COMPLETED);
  this.schedule(runId);
  return;
}
```

3. Add MCP tool if needed in `mcp/tools/workflow.ts`.

## Adding a New API Endpoint

1. Create route file: `src/app/api/your-endpoint/route.ts`
2. Use shared utilities:
```typescript
import { apiOk, apiNotFound, apiValidation, parseBody } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const { name } = await params;
  const validName = requireName(name);
  if (validName instanceof Response) return validName;
  // ... logic
  return apiOk({ data });
}
```

3. Add to SPEC.md API Reference.

## Adding a New MCP Tool

1. Add tool definition in `mcp/tools/your-tools.ts`:
```typescript
export function yourTools(): ToolDef[] {
  return [{
    name: 'your_tool',
    description: 'What it does',
    inputSchema: { type: 'object', properties: { ... }, required: [...] }
  }];
}
```

2. Add handler in `handleYourTool()`.
3. Register in `mcp/tools/shared.ts`.

## Testing

```bash
# Run all tests
npx vitest run

# Run specific test
npx vitest run tests/workflow.test.ts

# Coverage
npx vitest run --coverage
```

## Code Quality Rules

1. **No `any` types** — use `unknown` + type guards
2. **No `console.log`** — use `createLogger('module')` from `@/lib/logger`
3. **No silent catches** — always log or store error
4. **JSDoc on all exports** — document parameters and return values
5. **Atomic writes** — use `atomicWrite()` from `@/lib/atomic`
6. **Input validation** — validate at API boundaries
7. **Error format** — `{ error: { code, message } }`

## Debugging

### Workflow Stuck
1. Check `GET /api/groups/{name}/workflow?action=runs`
2. Look for step with `waiting` status — agent hasn't called back
3. Check agent's `.workflow-notifications/` directory
4. Check logs: `logger.info('workflow', '...')`

### Agent Not Responding
1. Check agent config: `GET /api/agents/{name}/config`
2. Check agent process: `GET /api/agents/{name}/heartbeat`
3. Check auto-respond logs

### RAG Not Working
1. Check collection stats: `GET /api/rag?action=stats`
2. Check embedding model loaded
3. Check LanceDB directory exists

## Architecture Decisions

### Why Callback Model?
Agents are autonomous — they decide when to execute and how to report back. The engine doesn't push work, it notifies and waits. This is more resilient than synchronous execution.

### Why Lazy Instantiation?
Workflows can have 100+ steps. Instantiating all upfront wastes memory. Steps are created only when their dependencies are met.

### Why File-Based State?
Simplicity. No database dependency. Checkpoint files enable crash recovery. Trade-off: no concurrent writes (solved with atomic writes + file locks).

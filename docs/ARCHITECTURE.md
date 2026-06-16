# Mind Agency — Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (Next.js)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │  Chat UI │ │ Workflow │ │  Kanban  │ │   Sidebar    │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘   │
│       │            │            │               │           │
│       └────────────┴────────────┴───────────────┘           │
│                          │ SSE/WebSocket                     │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                    Node.js Server                            │
│  ┌───────────────────────┴────────────────────────────┐     │
│  │              Agency Orchestrator                    │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │     │
│  │  │  Agent   │ │  Group   │ │  Workflow Engine  │   │     │
│  │  │  Proxy   │ │  Proxy   │ │  (DAG + Callback) │   │     │
│  │  └────┬─────┘ └────┬─────┘ └────────┬─────────┘   │     │
│  │       │            │                 │              │     │
│  │  ┌────┴────────────┴─────────────────┴────────┐    │     │
│  │  │              MCP JSON-RPC Layer             │    │     │
│  │  └────────────────────┬───────────────────────┘    │     │
│  └───────────────────────┼────────────────────────────┘     │
│                          │                                   │
│  ┌───────────────────────┴────────────────────────────┐     │
│  │                   AI Providers                      │     │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐              │     │
│  │  │ Claude  │ │DeepSeek │ │  GPT-4o │              │     │
│  │  └─────────┘ └─────────┘ └─────────┘              │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │   RAG System     │  │  Token Economy   │                 │
│  │ LanceDB + BGE    │  │  Balance/Transfer│                 │
│  └──────────────────┘  └──────────────────┘                 │
└──────────────────────────────────────────────────────────────┘
                           │
                    File System
            ┌──────────────┼──────────────┐
            │              │              │
       Agents/        Groups/        .mind/
       (agent configs) (workflows)   (state)
```

## Core Modules

### 1. Agency Orchestrator (`agency.ts`)
Central singleton managing agents and groups.

```
Agency
├── getAgent(name) → AgentProxy
├── getGroup(name) → GroupProxy
├── getAgents() → AgentProxy[]
└── getGroups() → GroupProxy[]
```

### 2. Agent Proxy (`agent-proxy.ts`)
Per-agent state machine handling config, chat, tasks, email.

```
AgentProxy
├── loadConfig() / saveConfig()
├── chat(message) → response
├── startProcess() / stopProcess()
├── loadTasks() / addTask() / completeTask()
└── buildSystemPrompt() → string
```

### 3. Workflow Engine (`workflow-engine.ts`)
DAG-based workflow execution with callback model.

```
WorkflowEngine
├── execute(def) → runId
├── callback(runId, stepId, output) → boolean
├── claim(runId, stepId, agent) → boolean
├── cancel(runId) → boolean
└── schedule(runId) → void
```

**State Machine:**
```
PENDING → BLOCKED → PENDING → IN_PROGRESS → WAITING → COMPLETED
                                    ↓
                                  FAILED → PENDING (retry)
```

**Execution Flow:**
```
1. execute() → create run, instantiate trigger step
2. schedule() → find ready steps (deps all completed)
3. notifyAgent() → write notification file, add to task queue
4. Agent executes → calls workflow_callback MCP tool
5. callback() → mark step COMPLETED
6. schedule() → lazy-instantiate downstream steps
7. Repeat until all steps complete or fail
```

### 4. RAG System (`rag.ts`)
Local vector search with embedding + reranking.

```
RAG Pipeline:
1. embed(text) → vector (384-dim, BGE-small-zh)
2. chunkText(text) → chunks (512 tokens, 50 overlap)
3. indexDocument(doc) → store in LanceDB
4. search(query, filter) → ranked results
5. rerankResults(query, results) → top-K
```

### 5. Token Economy (`token-economy.ts`)
Agent token balance and transfer system.

```
TokenEconomy
├── getAgentAccount(agent) → balance
├── deposit(agent, amount) → newBalance
├── transfer(from, to, amount) → boolean
├── reward(agent, amount, reason) → void
└── penalize(agent, amount, reason) → void
```

### 6. Event Bus (`event-bus.ts`)
Pub/sub system with dead letter queue.

```
EventBus
├── emit(event) → void
├── subscribe(type, handler) → unsubscribe
├── cleanupClient(clientId) → void
└── getStats() → { total, deadLetters, ... }
```

## Data Flow

### Chat Flow
```
User input → ChatPanel → POST /api/poll → AgentProxy.chat()
→ AI Provider (SSE) → ChatPanel renders stream
```

### Workflow Flow
```
Trigger → POST /api/groups/{name}/workflow
→ triggerWorkflow() → engine.execute()
→ schedule() → notifyAgent()
→ Agent MCP → workflow_callback
→ engine.callback() → schedule() (next step)
```

### RAG Flow
```
Query → GET /api/rag?query=X
→ ragQuery() → embed() → search() → rerank()
→ formatted results → AI prompt context
```

## File Structure

```
src/
├── app/                    # Next.js pages
│   ├── api/               # API routes
│   │   ├── groups/        # Group CRUD + workflow
│   │   ├── agents/        # Agent CRUD + chat
│   │   ├── rag/           # RAG search + index
│   │   └── system/        # System settings
│   └── groups/            # Group page
├── components/            # React components
│   ├── workflow-arch.tsx  # DAG visualization
│   ├── chat-panel.tsx     # Chat UI
│   ├── kanban-tab.tsx     # Kanban board
│   └── sidebar-context.tsx # Shared state
├── lib/                   # Core modules
│   ├── agency.ts          # Central orchestrator
│   ├── agent-proxy.ts     # Agent state machine
│   ├── workflow-engine.ts # DAG executor
│   ├── rag.ts             # Vector search
│   ├── chat.ts            # AI integration
│   ├── token-economy.ts   # Token system
│   ├── event-bus.ts       # Pub/sub
│   └── logger.ts          # Structured logging
└── hooks/                 # React hooks
```

## Configuration

### Agent Config (`Agents/{name}/config.yaml`)
```yaml
name: Alice
role: developer
model: claude-sonnet-4-6
systemPrompt: "You are a senior developer..."
```

### Workflow Config (`Groups/{name}/workflow.yaml`)
```yaml
name: deploy-pipeline
steps:
  - id: code
    agent: Alice
    action: create
    prompt: "Write the implementation"
  - id: review
    agent: Bob
    action: review
    dependsOn: [code]
  - id: deploy
    agent: Carol
    action: deploy
    dependsOn: [review]
```

### Group Config (`Groups/{name}/config.yaml`)
```yaml
owner: admin
members:
  - Alice
  - Bob
  - Carol
```

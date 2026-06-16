# Mind Agency — API Reference

## Base URL
```
http://localhost:3000/api
```

## Error Format
All error responses follow:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description"
  }
}
```

## Success Format
All success responses follow:
```json
{
  "ok": true,
  ...data
}
```

---

## Groups

### List Groups
```
GET /api/groups
```
Response: `{ groups: Array<{ name: string }> }`

### Create Group
```
POST /api/groups
Body: { name: string }
```
Response: `{ ok: true, name: string }`

### Get Group
```
GET /api/groups/{name}
```
Response: `{ name, members, messages, ... }`

### Delete Group
```
DELETE /api/groups/{name}?owner={ownerName}
```
Requires owner authorization.

---

## Workflow

### Get Workflow
```
GET /api/groups/{name}/workflow
```
Response: `{ name, steps, stepsList, yaml, runs }`

### Trigger Workflow
```
POST /api/groups/{name}/workflow
Body: { triggerStepId?: string }
```
Response: `{ ok: true, runId: string }`

### Callback (Agent completes step)
```
POST /api/groups/{name}/workflow
Body: { runId, stepId, status, summary, details? }
```
Response: `{ ok: true, runId, stepId, status }`

### Claim Step
```
POST /api/groups/{name}/workflow
Body: { runId, stepId, claim: true, agent: string }
```
Response: `{ ok: true, runId, stepId, agent }`

### Get Run Status
```
GET /api/groups/{name}/workflow?action=runs
```
Response: `{ runs: Array<{ runId, status, steps }> }`

### Get Run History
```
GET /api/groups/{name}/workflow?action=history&limit=50
```
Response: `{ history: Array<{ runId, status, ... }> }`

---

## Agents

### List Agents
```
GET /api/agents
```
Response: `{ agents: Array<{ name, status, ... }> }`

### Get Agent Config
```
GET /api/agents/{name}/config
```
Response: `{ name, role, model, ... }`

### Update Agent Config
```
PUT /api/agents/{name}/config
Body: { ...config }
```

### Launch Agent
```
POST /api/agents/{name}/launch
```
Opens terminal with agent process.

### Agent Tasks
```
GET /api/agents/{name}/tasks
```
Response: `{ tasks: Array<{ stepId, status, ... }> }`

---

## Chat

### Poll Messages
```
GET /api/poll?group={name}
```
Response: `{ messages: Array<{ from, body, date }> }`

### Send Message
```
POST /api/relay
Body: { agent, message, group? }
```

---

## RAG

### Search
```
GET /api/rag?agent={name}&query={text}&topK=5
```
Response: `{ results: Array<{ content, score, metadata }> }`

### Index
```
POST /api/rag
Body: { action: "index_all" | "index_memory" | "clear", agent: string }
```

---

## Token Economy

### Get Balance
```
GET /api/economy/account?agent={name}
```
Response: `{ balance, spent, earned, ... }`

### Deposit
```
POST /api/economy/deposit
Body: { agent, amount, reason? }
```

### Transfer
```
POST /api/economy/transfer
Body: { from, to, amount, reason? }
```

---

## MCP Tools

### workflow_trigger
```json
{
  "name": "workflow_trigger",
  "arguments": { "group": "my-group", "triggerStepId": "step1" }
}
```

### workflow_callback
```json
{
  "name": "workflow_callback",
  "arguments": {
    "runId": "...",
    "stepId": "step1",
    "status": "COMPLETED",
    "summary": "Done",
    "details": "..."
  }
}
```

### workflow_claim
```json
{
  "name": "workflow_claim",
  "arguments": { "runId": "...", "stepId": "step1" }
}
```

### workflow_status
```json
{
  "name": "workflow_status",
  "arguments": { "group": "my-group" }
}
```

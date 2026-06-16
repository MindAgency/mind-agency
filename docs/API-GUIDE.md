# Mind Agency -- API Guide

> A practical guide for developers integrating with the Mind Agency platform.

**Base URL:** `http://localhost:3000/api`

---

## Quick Start (5 Minutes to Your First Workflow)

### 1. Create an Agent

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "researcher", "roles": ["member"]}'
```

### 2. Create a Group

```bash
curl -X POST http://localhost:3000/api/groups \
  -H "Content-Type: application/json" \
  -d '{"name": "my-project", "members": ["researcher"]}'
```

### 3. Define a Workflow

```bash
curl -X PUT http://localhost:3000/api/groups/my-project/workflow \
  -H "Content-Type: application/json" \
  -d '{
    "yaml": "name: my-project\nsteps:\n  - id: research\n    agent: researcher\n    action: execute\n    prompt: \"Research the topic\"\n"
  }'
```

### 4. Trigger the Workflow

```bash
curl -X POST http://localhost:3000/api/groups/my-project/workflow
```

Response: `{ "ok": true, "runId": "<uuid>" }`

### 5. Check Status

```bash
curl http://localhost:3000/api/groups/my-project/workflow?action=runs
```

---

## Table of Contents

- [Groups](#groups)
- [Agents](#agents)
- [Workflows](#workflows)
- [Chat](#chat)
- [RAG (Retrieval-Augmented Generation)](#rag)
- [Token Economy](#token-economy)
- [Agent Cleanup](#agent-cleanup)
- [Troubleshooting](#troubleshooting)

---

## Groups

### List All Groups

```bash
GET /api/groups
```

**Response:**
```json
{ "groups": ["my-project", "team-alpha"] }
```

### Create a Group

```bash
POST /api/groups
Content-Type: application/json

{
  "name": "my-project",
  "owner": "admin",
  "admins": ["admin"],
  "members": ["researcher", "writer"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Alphanumeric + hyphens/underscores, unique |
| `owner` | string | No | Agent name that owns the group |
| `admins` | string[] | No | Agents with admin privileges |
| `members` | string[] | No | Initial agent members |

**Response:** `{ "ok": true, "name": "my-project" }`

**What gets created:**
- `Groups/my-project/` directory
- `TASK_SPEC.md` with default task rules
- `workflow.yaml` with empty steps

### Get Group Details

```bash
GET /api/groups/{name}
```

**Response:** `{ "name", "members", "messages", ... }`

### Delete a Group

```bash
DELETE /api/groups/{name}?owner={ownerName}
```

Requires owner authorization.

---

## Agents

### List All Agents

```bash
GET /api/agents
```

**Response:**
```json
{
  "agents": [
    {
      "name": "researcher",
      "config": { "roles": ["member"], "permissions": {...} },
      "activity": { "lastActive": "...", "status": "idle" }
    }
  ]
}
```

### Create an Agent

```bash
POST /api/agents
Content-Type: application/json

{
  "name": "researcher",
  "roles": ["member"],
  "permissions": {
    "canCreateGroup": false,
    "canDeleteGroup": false,
    "canDeploy": false
  },
  "autoRespondToEmail": false,
  "autoProcessGroupInvites": false,
  "allowedTools": ["read", "write", "search"],
  "disallowedTools": [],
  "permissionMode": "restricted",
  "maxTurns": 10
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | (required) | Alphanumeric + hyphens/underscores |
| `roles` | string[] | `["member"]` | Agent roles (e.g., `member`, `admin`, `owner`) |
| `permissions` | object | all false | Capability flags |
| `allowedTools` | string[] | `[]` | Tools the agent may use |
| `disallowedTools` | string[] | `[]` | Tools explicitly blocked |
| `maxTurns` | number | `10` | Max conversation turns per session |

**Response:** `{ "ok": true, "name": "researcher", "config": {...} }`

### Get Agent Config

```bash
GET /api/agents/{name}/config
```

### Update Agent Config

```bash
PUT /api/agents/{name}/config
Content-Type: application/json

{ "roles": ["admin"], "maxTurns": 20 }
```

### Delete an Agent

```bash
DELETE /api/agents?name={agentName}
```

### Launch Agent Process

```bash
POST /api/agents/{name}/launch
```

Opens a terminal window running the agent process.

### Get Agent Tasks

```bash
GET /api/agents/{name}/tasks
```

**Response:** `{ "tasks": [...] }`

---

## Workflows

Workflows define multi-step DAG (Directed Acyclic Graph) execution plans. Each step runs an agent action and can depend on other steps.

### Workflow YAML Format

```yaml
name: my-workflow
description: "A sample workflow"

steps:
  - id: research
    agent: researcher
    action: execute
    prompt: "Research the given topic"
    timeout: 300000          # milliseconds (default: 300000 = 5 min)
    retry: 2                 # max retries on failure
    retryBackoff: exponential

  - id: write-draft
    agent: writer
    action: execute
    prompt: "Write a draft based on research"
    dependsOn:
      - research             # waits for research to complete
    timeout: 600000

  - id: review
    agent: reviewer
    action: review
    prompt: "Review the draft for accuracy"
    dependsOn:
      - write-draft
    reviewer: editor
    onReject: write-draft    # route back to writer on rejection
    onApprove: publish       # route to publish on approval

  - id: publish
    agent: publisher
    action: execute
    prompt: "Publish the final article"
    dependsOn:
      - review
    condition: "status == APPROVED"  # only if review passed
```

**Important:** The `timeout` field is in **milliseconds**. Common values:
- `30000` = 30 seconds
- `60000` = 1 minute
- `300000` = 5 minutes (default)
- `600000` = 10 minutes
- `1800000` = 30 minutes

### Step Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique step identifier |
| `agent` | string | Agent assigned to this step |
| `action` | string | `execute`, `review`, `trigger`, `approve` |
| `prompt` | string | Instruction given to the agent |
| `dependsOn` | string[] | Step IDs that must complete first |
| `timeout` | number | Timeout in **milliseconds** (default: 300000) |
| `retry` | number | Max retries on failure (max: 10) |
| `retryBackoff` | string | `fixed` or `exponential` |
| `condition` | string | Conditional expression (e.g., `"status == APPROVED"`) |
| `priority` | string | `low`, `normal`, `high`, `critical` |
| `reviewer` | string | Agent ID for review steps |
| `onReject` | string | Step ID to route to on rejection |
| `onApprove` | string | Step ID to route to on approval |
| `onFailure` | string | Step ID to trigger on failure |
| `routes` | array | Routing rules for post-completion branching |
| `maxRejectRetries` | number | Max rejection retries (max: 10) |

### Get Workflow Definition

```bash
GET /api/groups/{name}/workflow
```

**Response:**
```json
{
  "name": "my-workflow",
  "description": "A sample workflow",
  "steps": 4,
  "stepsList": [
    { "id": "research", "type": "step", "agent": "researcher", "action": "execute", "prompt": "..." }
  ],
  "yaml": "name: my-workflow\n...",
  "runs": [...],
  "pendingApprovals": [...]
}
```

### Update Workflow (PUT)

Two ways to update:

**Option A: Raw YAML string**
```bash
PUT /api/groups/{name}/workflow
Content-Type: application/json

{
  "yaml": "name: my-workflow\nsteps:\n  - id: step1\n    agent: researcher\n    action: execute\n"
}
```

**Option B: Structured steps**
```bash
PUT /api/groups/{name}/workflow
Content-Type: application/json

{
  "name": "my-workflow",
  "description": "A sample workflow",
  "steps": [
    {
      "id": "research",
      "agent": "researcher",
      "action": "execute",
      "prompt": "Research the topic",
      "timeout": 300000
    },
    {
      "id": "write",
      "agent": "writer",
      "action": "execute",
      "prompt": "Write based on research",
      "dependsOn": ["research"],
      "timeout": 600000
    }
  ]
}
```

**Validation:** If you provide a `timeout` value, it must be a positive number in milliseconds. The API will reject negative values or zero. If omitted, defaults to 300000 (5 minutes).

### Trigger Workflow

```bash
POST /api/groups/{name}/workflow
```

Optionally specify a starting step:
```json
{ "triggerStepId": "research" }
```

**Response:** `{ "ok": true, "runId": "<uuid>" }`

### Get Run Status

```bash
GET /api/groups/{name}/workflow?action=runs
```

**Response:**
```json
{
  "runs": [
    {
      "runId": "...",
      "group": "my-project",
      "workflowName": "my-workflow",
      "status": "running",
      "stepsTotal": 4,
      "stepsDone": 1,
      "startedAt": 1234567890,
      "steps": { "research": "completed", "write": "running" },
      "pendingApprovals": []
    }
  ],
  "pendingApprovals": []
}
```

### Get Run History

```bash
GET /api/groups/{name}/workflow?action=history&limit=50
```

### Get Step Details

```bash
GET /api/groups/{name}/workflow?action=step&runId={runId}&stepId={stepId}
```

**Response:**
```json
{
  "runId": "...",
  "stepId": "research",
  "group": "my-project",
  "status": "completed",
  "output": "Research findings...",
  "error": "",
  "startedAt": 1234567890,
  "completedAt": 1234567900,
  "durationMs": 10000,
  "retries": 0
}
```

### Callback (Agent Reports Step Completion)

```bash
POST /api/groups/{name}/workflow
Content-Type: application/json

{
  "runId": "...",
  "stepId": "research",
  "status": "COMPLETED",
  "summary": "Found 3 relevant sources",
  "details": "Source 1: ... Source 2: ..."
}
```

### Claim Step (Agent Claims Ownership)

```bash
POST /api/groups/{name}/workflow
Content-Type: application/json

{
  "runId": "...",
  "stepId": "research",
  "claim": true,
  "agent": "researcher"
}
```

### Approve/Reject Human Approval

```bash
POST /api/groups/{name}/workflow
Content-Type: application/json

{
  "approvalId": "...",
  "decision": "APPROVED",
  "comment": "Looks good"
}
```

### Delete Workflow

```bash
DELETE /api/groups/{name}/workflow
```

---

## Chat

### Poll Messages

```bash
GET /api/poll?group={name}
```

**Response:** `{ "messages": [{ "from": "researcher", "body": "Done!", "date": "..." }] }`

### Send Message (Relay)

```bash
POST /api/relay
Content-Type: application/json

{ "agent": "researcher", "message": "Hello!", "group": "my-project" }
```

---

## RAG (Retrieval-Augmented Generation)

The RAG system uses local BGE-small-zh embeddings (384-dim) with LanceDB vector storage.

### Search Knowledge

```bash
GET /api/rag?agent={name}&query={text}&topK=5
```

**Response:**
```json
{
  "results": [
    { "content": "Relevant text chunk...", "score": 0.85, "metadata": {...} }
  ]
}
```

### Index Actions

```bash
POST /api/rag
Content-Type: application/json

{
  "action": "index_all" | "index_memory" | "index_knowledge" | "index_group_knowledge" | "clear",
  "agent": "me",
  "group": "my-project"
}
```

| Action | Description |
|--------|-------------|
| `index_all` | Index all data sources for the agent |
| `index_memory` | Index agent memory files |
| `index_knowledge` | Index `Agents/{name}/knowledge/` |
| `index_group_knowledge` | Index `Groups/{group}/knowledge/` |
| `clear` | Clear the entire vector store |

### Knowledge Directories

```
Agents/<agent>/knowledge/     -- Agent-specific knowledge files
Groups/<group>/knowledge/     -- Group shared knowledge files
```

---

## Token Economy

### Get Account Balance

```bash
GET /api/economy/account?agent={name}
```

**Response:**
```json
{ "balance": 1000, "spent": 250, "earned": 1250, "history": [...] }
```

### Deposit Tokens

```bash
POST /api/economy/deposit
Content-Type: application/json

{ "agent": "researcher", "amount": 500, "reason": "Task completion bonus" }
```

### Transfer Tokens

```bash
POST /api/economy/transfer
Content-Type: application/json

{ "from": "admin", "to": "researcher", "amount": 100, "reason": "Payment" }
```

### Leaderboard

```bash
GET /api/economy/leaderboard
```

---

## Agent Cleanup

The system auto-cleans test agents matching these patterns on startup:
- `real-test-*`
- `test-agent-*`
- `temp-*`
- `debug-*`

### List Zombies (Dry Run)

```bash
GET /api/agents/cleanup?pattern={regex}
```

Default pattern: `real-test-.*`

**Response:**
```json
{ "zombies": ["real-test-1", "real-test-2"], "count": 2, "pattern": "real-test-.*" }
```

### Remove Zombies

```bash
POST /api/agents/cleanup
Content-Type: application/json

{
  "pattern": "test-agent-.*",
  "dryRun": false
}
```

**Response:**
```json
{ "success": true, "removed": ["test-agent-1"], "count": 1, "dryRun": false }
```

Set `dryRun: true` to preview what would be removed without actually deleting.

---

## Troubleshooting

### Workflow won't trigger

1. Check that `workflow.yaml` exists and is valid YAML
2. Ensure the workflow has a `name` and at least one `step`
3. Verify the agent referenced in each step exists: `GET /api/agents`
4. Check the group exists: `GET /api/groups`

### Step timeout

- Default timeout is 300000ms (5 minutes)
- Check step status: `GET /api/groups/{name}/workflow?action=step&runId=...&stepId=...`
- Increase timeout in the workflow YAML for long-running tasks

### Agent not responding

1. Check agent status: `GET /api/agents/{name}/config`
2. Verify agent is launched: `POST /api/agents/{name}/launch`
3. Check agent tasks: `GET /api/agents/{name}/tasks`

### Cleanup not removing agents

1. First do a dry run: `GET /api/agents/cleanup?pattern=your-pattern`
2. Verify the pattern matches agent names exactly (case-insensitive)
3. Agents may reappear if created by running processes -- stop processes first

### RAG search returns empty results

1. Index the data first: `POST /api/rag { "action": "index_all", "agent": "me" }`
2. Verify knowledge files exist in `Agents/{name}/knowledge/`
3. Check LanceDB is accessible (local, no server needed)

### Timeout unit confusion

The `timeout` field in workflow steps is in **milliseconds**, not seconds or minutes.

| You want | Set timeout to |
|----------|---------------|
| 30 seconds | `30000` |
| 1 minute | `60000` |
| 5 minutes | `300000` |
| 10 minutes | `600000` |
| 30 minutes | `1800000` |
| 1 hour | `3600000` |

---

## Error Responses

All errors follow:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description"
  }
}
```

Common error codes:
- `VALIDATION_ERROR` -- Request body failed validation
- `NOT_FOUND` -- Resource does not exist
- `CONFLICT` -- Resource already exists
- `CLAIM_FAILED` -- Step claim failed (run not found, step not waiting, or agent not in step)
- `CALLBACK_FAILED` -- Callback failed (run not found or step not waiting)
- `TRIGGER_FAILED` -- Workflow trigger failed (no workflow.yaml, invalid YAML, or no steps)

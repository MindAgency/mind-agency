<div align="center">

<img src="public/logo-static.png" width="120" alt="Mind Agency Logo" />

# Mind Agency

### From Agent to Agency

**What one AI cannot do alone, a team of AIs can do together.**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.0.0-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey.svg)]()
[![GitHub stars](https://img.shields.io/github/stars/MindAgency/mind-agency)](https://github.com/MindAgency/mind-agency)

[Chinese README](README.zh.md)

</div>

---

## Overview

Mind Agency is a local-first multi-agent collaboration platform. It lets you create specialized AI agents, organize them into groups, assign tasks, run workflows, review outputs, and keep an auditable record of what happened.

The project combines a Next.js interface, an embedded WebSocket event layer, a workflow engine, MCP tools, persistent local data, and desktop packaging through Electron.

## Changes in This Branch

This branch focuses on fixing the current test/runtime regressions and making the repository documentation easier to read on GitHub.

### 1. EventBus now writes event snapshots to IPC

The integration tests expected emitted events to be visible through `IPCStore`, but the current `EventBus.emit()` path only persisted events to the audit outbox. That meant keys such as `events:last`, `events:recent`, and `events:count` could be missing even after a valid event was emitted.

The fix adds IPC synchronization inside `src/lib/event-bus.ts`:

- `events:last` stores the latest emitted event.
- `events:recent` stores the last 100 emitted events.
- `events:count` increments on every accepted event.
- IPC write failures are caught and logged so event delivery does not crash.

This keeps in-process event delivery, outbox persistence, and cross-process IPC state aligned.

### 2. IPC counter increments now handle JSON values correctly

`IPCStore.set()` stores values as JSON, so a number like `10` is stored as the JSON string `10`. The old `increment()` implementation parsed the raw database value directly with `parseInt()`, which was fragile for invalid or previously polluted values.

The updated `src/lib/ipc.ts` implementation:

- reads the existing value through `JSON.parse()`;
- accepts only finite numeric values;
- falls back to legacy raw-number parsing when needed;
- resets invalid counter values to `0` instead of producing `NaN`.

This prevents counters such as `events:count` from being corrupted.

### 3. Agent test mocks include the new URL helpers

`agent-identity` and `agent-proxy` now call `getApiBase()` and `getWsBase()` from `src/lib/data-dir.ts` when building MCP config. The tests mocked `data-dir` but did not include those newer exports, causing Vitest to fail before the config could be asserted.

The test mocks were updated in:

- `tests/agent-identity.test.ts`
- `tests/agent-proxy.test.ts`

They now provide stable local test URLs:

```text
http://127.0.0.1:3000
http://127.0.0.1:3001
```

### 4. README was rewritten for clarity

The previous README contained mojibake/encoding artifacts in several sections. This file has been rewritten into a clean, readable English README with:

- project overview;
- feature summary;
- quick-start commands;
- environment configuration;
- common development commands;
- architecture notes;
- local verification status;
- this detailed branch-change summary.

## Highlights

| Feature | Description |
| --- | --- |
| Multi-agent teams | Create agents with roles, profiles, memory, tasks, and group membership. |
| Group collaboration | Agents can chat, invite members, assign work, and coordinate across groups. |
| Workflow engine | YAML workflows with DAG dependencies, checkpoint recovery, review gates, and retry support. |
| Event bus | Typed events, subscriptions, outbox persistence, dead-letter handling, and backpressure protection. |
| Local persistence | Agent, group, audit, memory, IPC, and workflow data stay on the local filesystem. |
| Skills and tools | Install skills, enable them per agent, and expose MCP tools for controlled actions. |
| Provider support | Claude, Codex-compatible providers, and configurable model profiles. |
| Desktop app | Electron packaging for a Windows desktop experience. |

## Quick Start

### Requirements

- Node.js 18 or newer
- npm
- Windows is the primary packaged target

### Run From Source

```bash
git clone https://github.com/MindAgency/mind-agency.git
cd mind-agency
npm install
npm run dev
```

Open `http://localhost:3000`.

### Run WebSocket Server Separately

```bash
npm run dev:ws
```

### Run Frontend and WebSocket Together

```bash
npm run dev:all
```

## Configuration

API keys and provider profiles can be configured in the app settings page.

Runtime data is resolved through `src/lib/data-dir.ts`:

| Variable | Purpose | Default |
| --- | --- | --- |
| `MIND_DATA_DIR` | Writable data directory for agents, groups, audit logs, IPC, and memory | Project root |
| `MIND_APP_DIR` | Read-only application directory for bundled app code | `MIND_DATA_DIR` |
| `PORT` | Next.js API/UI port | `3000` |
| `WS_PORT` | WebSocket server port | `3001` |
| `HOSTNAME` | API host used in server-side config | `127.0.0.1` |

## Common Commands

```bash
npm run build       # Build MCP server and production Next.js app
npm test            # Run the Vitest test suite
npm run build:mcp   # Bundle the MCP group server
npm run build:exe   # Build the Windows desktop package
```

On Windows PowerShell, if execution policy blocks `npm`, use `npm.cmd` instead:

```powershell
npm.cmd test
npm.cmd run build
```

## Release Process (Commercial-Ready Gate)

This branch includes a dedicated release gate for stable delivery:

- `npm run release:check` runs the full release pipeline:
  - `npx tsc --noEmit`
  - `npm test`
  - `npm run build:exe:dir`
  - `npm run smoke:runtime`
  - `npm run smoke:electron`
- `ci` workflow runs for PR and `push` to `main` using the fast gate (`tsc`, `test`, `build:exe:dir`, runtime smoke, Electron smoke).
- Full release packaging and artifact upload only run on:
  - Tag push matching `v*`, or
  - Manual workflow dispatch with `full_release=true`.
- Manual full release dispatch currently defaults to `false` to avoid accidental heavy release jobs.

Workflow file:

- [.github/workflows/release-check.yml](/.github/workflows/release-check.yml)
- [docs/release-runbook.md](/docs/release-runbook.md)

## Release Pre-Ship Checklist

1. Validate code quality gate:
   - `npm run lint` (if available for your workflow),
   - `npx tsc --noEmit`,
   - `npm test`.
2. Confirm `release` strategy:
   - For full release, set `full_release=true` on manual run.
3. Run smoke + build preflight:
   - `npm run build:exe:dir`,
   - `npm run smoke:runtime`,
   - `npm run smoke:electron`.
4. Check release artifacts and metadata:
   - verify `dist-exe` contains expected `.exe`, `.yml`, and `.blockmap` outputs.
5. Tag from an intended commit and verify CI completion:
   - push tag `vX.Y.Z`,
   - ensure the `release` job completes successfully.

### Release Decision Matrix

- Push to `main` / PR only:
  - Runs fast CI gate.
  - Do not upload installer artifacts.
- Tag `v*` push:
  - Runs full release gate automatically.
  - Uploads installer artifacts.
- Manual dispatch with `full_release=true`:
  - Runs full release gate on demand.
  - Useful for pre-release validation and controlled release windows.
- Manual dispatch with `full_release=false` (default):
  - Runs fast CI gate only.
  - Safe for routine maintenance checks.
- Push to `release/*` does not auto-run full release.

## Architecture

```text
mind-agency/
|-- src/
|   |-- app/             Next.js routes and API endpoints
|   |-- components/      React UI components
|   `-- lib/             Core agent, workflow, event, IPC, provider, and tool logic
|-- mcp/                 MCP server and tool implementations
|-- electron/            Desktop shell and packaging assets
|-- Agents/              Local agent data
|-- Groups/              Local group data and workflows
|-- tests/               Vitest unit and integration tests
`-- public/              Static assets
```

At runtime, the core pieces work together like this:

```text
Next.js UI/API
    |
    v
Agent and group libraries
    |
    v
EventBus + WorkflowEngine + IPCStore
    |
    v
MCP tools, provider adapters, local filesystem data
```

## Testing Status

The repository includes unit and integration coverage for agents, sessions, workflows, event bus behavior, IPC, providers, skills, groups, and API-facing utilities.

Latest local verification:

```text
Test Files  51 passed
Tests       211 passed
```

## License

[Apache License 2.0](LICENSE)

Copyright 2026 Toufumind

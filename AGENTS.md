# Mind Agency Multi-Agent Collaboration Platform

## Tech Stack
- **Frontend**: Next.js 15 (App Router), React 19, Tailwind CSS v4, TypeScript
- **Backend**: Node.js, WebSocket (server.ts :3001), MCP JSON-RPC
- **Desktop**: Electron 42, NSIS installer
- **AI**: Codex / DeepSeek / GPT-4o via API
- **RAG**: LanceDB + BGE-small-zh (local embedding) + BGE-reranker
- **Deployment**: Cloudflare Pages (landing), GitHub Releases (exe)

## Commands
```bash
npm run dev          # Next.js dev server (:3000)
npm run dev:ws       # WebSocket server (:3001)
npm run dev:all      # Both simultaneously
npm run build        # Production build
npx tsc --noEmit     # Type check
```

## Code Conventions
- `'use client'` for all interactive components
- Tailwind CSS v4 with CSS custom properties (no raw hex in components)
- `cn()` utility for conditional classNames
- Theme system via `data-theme` attribute + CSS variables
- i18n via `data-i18n` attributes + `useT()` hook
- Components in `src/components/`, pages in `src/app/`
- API routes in `src/app/api/`
- MCP tools in `mcp/tools/`

## Architecture
Browser (Next.js) -> SSE -> AI Provider (Codex/DeepSeek)
                          ↕ MCP JSON-RPC
                       group-server.ts (31 tools)
                          ↕
                       Agent filesystem (Agents/, Groups/)
                          ↕
                       RAG System (LanceDB + BGE embedding)

## Key Files
| File | Role |
|------|------|
| `src/lib/agency.ts` | Central Agency orchestrator |
| `src/lib/agent-proxy.ts` | Agent state machine (8 modules) |
| `src/lib/chat.ts` | AI integration + session management |
| `src/lib/auto-respond.ts` | Signal-driven autonomous response |
| `src/lib/event-bus.ts` | EventBus + WorkflowEngine |
| `src/lib/rag.ts` | RAG system (embedding, vector store, retrieval) |
| `src/components/sidebar-context.tsx` | Shared polling + WebSocket |
| `src/components/chat-panel.tsx` | Chat UI with dual-source loading |
| `electron/main.cjs` | Desktop app entry point |

## RAG System
- **Embedding**: BGE-small-zh-v1.5 (local ONNX model, 384-dim)
- **Vector Store**: LanceDB (local persistent, no server needed)
- **Chunking**: 512 tokens with 50 overlap
- **Reranking**: BGE-reranker-base-zh-v1.5
- **Data Sources**: Memory, Skills, Knowledge, Group Knowledge, Session Context
- **Auto-indexing**: On agent config load + tool use incremental

### RAG API
```bash
# Search
GET /api/rag?agent=me&query=Python&topK=5

# Index management
POST /api/rag { "action": "index_all", "agent": "me" }
POST /api/rag { "action": "index_knowledge", "agent": "me" }
POST /api/rag { "action": "index_group_knowledge", "group": "default" }
POST /api/rag { "action": "clear" }
```

### Knowledge Directories
```
Agents/<agent>/knowledge/ -> Agent-specific knowledge
Groups/<group>/knowledge/ -> Group shared knowledge
```

## Boundaries
- Never commit `.env`, `.mind/`, `.audit/`, `session.json`
- Never modify `node_modules/` directly
- Run `npx tsc --noEmit` before committing
- Test Electron builds with `npm run build:exe`
- Do not commit generated installer artifacts in `dist-exe/` (built by CI)
- Landing page changes: `cd landing && wrangler pages deploy`

## Release Gate Strategy
- `npm run release:check` is the full release gate: typecheck, unit tests, `build:exe:dir`, runtime smoke, and Electron smoke.
- CI split:
  - Pull Request / `push` to `main`: runs fast CI gate (`tsc`, `test`, `build:exe:dir`, runtime smoke, Electron smoke).
  - Tag `v*` pushes and manual workflow runs with `full_release=true`: run full release gate and upload installer artifacts.
  - Manual full release dispatch defaults to `full_release=false` (fast CI only) to avoid accidental packaging.
  - Release branches (`release/*`) do not auto-trigger full release; use manual `workflow_dispatch` with `full_release=true` for explicit promotion.

### Release Decision Matrix

- Push to `main` / PR only:
  - Runs fast CI gate.
  - Does not upload installer artifacts.
- Tag `v*` push:
  - Runs full release gate automatically.
  - Uploads installer artifacts.
- Manual dispatch with `full_release=true`:
  - Runs full release gate on demand.
  - Use for controlled release windows and pre-release validation.
- Manual dispatch with `full_release=false` (default):
  - Runs fast CI gate only.
  - Safe for routine maintenance checks.

## Patterns
```tsx
// Theme-aware component
import { useTheme } from '@/lib/theme';
const { theme } = useTheme();
const filter = THEME_FILTERS[theme] || 'none';

// i18n
import { useT } from '@/components/i18n';
const { t } = useT();
<p data-i18n="key">{t('key')}</p>

// Shared data
import { useSidebarData } from '@/components/sidebar-context';
const { agents, groups, activity, refresh } = useSidebarData();
```


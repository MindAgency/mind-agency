# Spec: Mind Agency Architecture Refactoring

## Objective

全面重构 Mind Agency 的代码架构，解决当前存在的稳定性、可维护性和质量问题。目标是让项目从"能跑就行"升级到"工程化可维护"。

### 目标用户
开发者/团队，用于 AI Agent 编排和协作

### 成功标准
- EXE 打包稳定，开箱即用（logo 显示、默认 agent/group 存在、无白屏）
- 代码无重复逻辑（系统提示、WebSocket 重连、proxy 模式）
- i18n 完整覆盖所有 UI 字符串
- 空 catch 块全部替换为日志
- 构建系统统一（不再有两套打包方案）
- 主题 CSS 不再重复 600 行

## Tech Stack

- **Frontend:** Next.js 15 (App Router), React 19, Tailwind CSS v4, TypeScript
- **Backend:** Node.js, WebSocket (server.ts :3001), MCP JSON-RPC
- **Desktop:** Electron 42, electron-packager
- **AI:** Claude / DeepSeek / GPT-4o via API
- **RAG:** LanceDB + BGE-small-zh (local embedding)
- **Testing:** Vitest v4, V8 coverage
- **Deployment:** Cloudflare Pages (landing), GitHub Releases (exe)

## Commands

```bash
npm run dev          # Next.js dev server (:3000)
npm run dev:ws       # WebSocket server (:3001)
npm run dev:all      # Both simultaneously
npm run build        # Production build
npm run build:exe    # Electron packaging (electron-packager)
npx tsc --noEmit     # Type check
npx vitest run       # Run tests
npx vitest run --coverage  # Run tests with coverage
```

## Project Structure

```
src/
├── app/                    # Next.js App Router pages + API routes
│   ├── api/                # REST API endpoints
│   ├── groups/[name]/      # Group detail page
│   ├── agents/[name]/      # Agent detail page
│   └── ...
├── lib/                    # Server-side business logic (78 files, ~16.5k lines)
│   ├── agent-identity.ts   # Agent identity building (canonical source)
│   ├── agent-proxy.ts      # Agent state machine
│   ├── chat.ts             # AI integration + session management
│   ├── data-dir.ts         # Centralized path config
│   ├── event-bus.ts        # EventBus + WorkflowEngine
│   ├── providers/          # AI provider implementations
│   └── ...
├── components/             # React UI components (20 files, ~5.1k lines)
│   ├── workflow-arch.tsx   # NLP paper style architecture diagram
│   ├── sidebar-context.tsx # Shared polling + WebSocket
│   ├── chat-panel.tsx      # Chat UI
│   └── ...
electron/
├── main.cjs               # Electron entry point
├── preload.cjs            # Context bridge
mcp/
├── tools/                 # MCP tool definitions
├── group-server.ts        # MCP JSON-RPC server
tests/
├── *.test.ts              # Unit tests (50+ files)
scripts/
├── build-exe.mjs          # Electron packaging
landing/                   # Static landing page (Cloudflare Pages)
```

## Code Style

```typescript
// 1. Always use 'use client' for interactive components
'use client';

// 2. Use cn() for conditional classNames
import { cn } from '@/lib/utils';
<div className={cn('base-class', isActive && 'active', className)} />

// 3. Use theme system via CSS variables (no raw hex in components)
const filter = THEME_FILTERS[theme] || 'none';

// 4. Use useT() hook for i18n (never hardcode Chinese)
const { t } = useT();
<p data-i18n="key">{t('key')}</p>

// 5. Prefer inline SVG over <img src> for assets (EXE compatibility)
// BAD:  <img src="/logo.svg" />
// GOOD: <svg viewBox="0 0 32 32">...</svg>

// 6. Always log errors (never empty catch)
// BAD:  try { ... } catch {}
// GOOD: try { ... } catch (e) { console.error('[context]', e); }

// 7. Use centralized URL config (never hardcode 127.0.0.1)
import { getApiBase, getWsBase } from '@/lib/data-dir';
fetch(`${getApiBase()}/api/endpoint`);
```

## Testing Strategy

- **Framework:** Vitest v4 with V8 coverage
- **Unit tests:** `tests/*.test.ts` — cover lib/ modules
- **Component tests:** (missing, to be added) `tests/*.test.tsx`
- **API tests:** (missing, to be added) `tests/api/*.test.ts`
- **Coverage target:** 80%+ for src/lib/
- **Run before commit:** `npx vitest run`

## Refactoring Tasks

### Phase 1: Critical Fixes (EXE 稳定性)

- [x] **T1: Centralized URL config** ✅
- [x] **T2: Deduplicate system prompt** ✅
- [x] **T3: Clean stale test data** ✅
- [x] **T4: Fix EXE agent seeding** ✅
- [x] **T5: Fix EXE logo** ✅

### Phase 2: Code Quality (代码质量)

- [x] **T6: Replace empty catch blocks** ✅ (201 fixed)
- [x] **T7: Unify WebSocket reconnect** ✅ (useWebSocket hook)
- [x] **T8: Complete i18n coverage** ✅ (30+ keys added)
- [x] **T9: Eliminate self-referential HTTP calls** ✅

### Phase 3: Architecture (架构优化)

- [ ] **T10: Consolidate proxy pattern** — Deferred (low ROI, each proxy has unique methods)

### Phase 4: API Quality (接口规范化)

- [x] **T11: Shared API error/success utility** — `src/lib/api-utils.ts`
- [x] **T12: Standardize error format** — All routes use `{ error: { code, message } }`
- [x] **T13: Standardize success format** — All routes use `{ ok: true }`
- [x] **T14: exec → spawn** — `agents/[name]/launch` uses spawn now
- [x] **T15: Auth on group DELETE** — Requires owner param
- [x] **T16: Auth on system export** — Requires admin key
- [x] **T17: Name validation** — All `[name]` routes validate with regex
- [x] **T18: Error messages in English** — No more mixed Chinese/English
- [x] **T11: Externalize theme CSS** ✅ (already externalized via scripts/themes.mjs → themes-generated.css)
- [x] **T12: Consolidate build system** ✅ (electron-builder removed)
- [x] **T13: Fix process.env mutation** ✅ (only 1 mutation existed: ELECTRON_RUN_AS_NODE in chat.ts, now scoped with cleanup)
- [x] **T14: Standardize polling intervals** ✅ (config.ts created)

## Boundaries

- **Always:** Run `npx tsc --noEmit` before commit, follow naming conventions, use `cn()` for classNames, use `t()` for UI strings
- **Ask first:** Database schema changes, adding new dependencies, changing build config, modifying Electron main process
- **Never:** Commit `.env`/`.mind/`/`.audit/`, edit `node_modules/`, remove failing tests, hardcode `127.0.0.1`, use empty `catch {}`

## Success Criteria

1. ✅ EXE 开箱即用：logo 显示、默认 agent/group 存在、无白屏
2. ✅ 无重复代码：系统提示 1 份、WebSocket 重连 1 份、proxy 基类 1 份
3. ✅ i18n 完整：所有 UI 字符串通过 `t()` 翻译
4. ✅ 无空 catch：所有错误都被记录
5. ✅ 构建统一：只有一个打包方案
6. ✅ 主题 CSS < 100 行（当前 600 行）
7. ✅ 测试覆盖 80%+（当前缺失 component/API 测试）

## Open Questions

1. 是否需要添加 component 测试（React Testing Library）？
2. 是否需要添加 E2E 测试（Playwright）？
3. 主题系统是否需要支持用户自定义主题？
4. 是否需要将文件系统存储迁移到数据库？

---

## API Reference

### Error Format

所有错误响应统一格式：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable error message",
    "details": {}
  }
}
```

HTTP 状态码：
- **400** — 请求参数错误
- **404** — 资源不存在
- **422** — 验证失败（语义错误）
- **500** — 服务器内部错误

### Groups

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/groups` | 列出所有 group |
| POST | `/api/groups` | 创建 group |
| GET | `/api/groups/[name]` | 获取 group 信息（成员、配置） |
| PUT | `/api/groups/[name]` | 更新 group 配置 |
| DELETE | `/api/groups/[name]` | 删除 group |
| GET | `/api/groups/[name]/config` | 获取 group 配置（owner、admins） |
| PUT | `/api/groups/[name]/config` | 更新 group 配置 |
| GET | `/api/groups/[name]/files` | 获取 group 文件列表 |
| GET | `/api/groups/[name]/search` | 搜索 group 内容 |
| POST | `/api/groups/scan` | 扫描磁盘 group 目录 |

### Workflow

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/groups/[name]/workflow` | 获取 workflow YAML |
| POST | `/api/groups/[name]/workflow` | 触发 / 审批 / 回调 / 认领 |
| PUT | `/api/groups/[name]/workflow` | 更新 workflow YAML |
| DELETE | `/api/groups/[name]/workflow` | 删除 workflow |
| GET | `/api/groups/[name]/workflow?action=runs` | 获取运行状态 |
| GET | `/api/groups/[name]/workflow?action=history` | 获取运行历史 |

**POST 参数：**
- `triggerStepId` — 触发指定 step（触发 workflow）
- `runId` + `stepId` + `status` + `summary` — 回调（agent 完成 step）
- `runId` + `stepId` + `claim` + `agent` — 认领 step
- `approvalId` + `decision` — 审批（APPROVED/REJECTED）
- `yaml` / `steps` — 更新 YAML

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | 列出所有 agent |
| GET | `/api/agents/[name]/config` | 获取 agent 配置 |
| PUT | `/api/agents/[name]/config` | 更新 agent 配置 |
| POST | `/api/agents/[name]/launch` | 启动 agent |
| POST | `/api/agents/[name]/heartbeat` | Agent 心跳 |
| GET | `/api/agents/[name]/tasks` | 获取 agent 任务列表 |
| POST | `/api/agents/[name]/auto-respond` | 触发 auto-respond |

### Chat & Polling

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/poll?group=X` | 轮询 group 聊天消息 |
| GET | `/api/poll/agent?agent=X` | 轮询 agent 消息 |
| POST | `/api/relay` | 转发消息到 agent |
| GET | `/api/emails` | 获取邮件/消息 |

### RAG

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/rag?agent=X&query=Y` | RAG 搜索 |
| POST | `/api/rag` | 触发索引（index_all / index_knowledge / clear） |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/system/status` | 系统状态 |
| GET | `/api/system/settings` | 系统设置 |
| PUT | `/api/system/settings` | 更新系统设置 |
| GET | `/api/system/providers` | AI provider 列表 |
| GET | `/api/system/models` | 可用模型列表 |
| GET | `/api/system/pending` | 待处理任务 |
| GET | `/api/system/skills` | Agent skills |
| POST | `/api/system/update` | 更新系统 |
| GET | `/api/system/export` | 导出数据 |
| GET | `/api/system/analytics` | 分析数据 |
| GET | `/api/health` | 健康检查 |

### Economy

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/economy/account?agent=X` | 获取账户余额 |
| POST | `/api/economy/deposit` | 充值 token |
| POST | `/api/economy/transfer` | 转账 |
| GET | `/api/economy/leaderboard` | 排行榜 |

### Tasks & Learning

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks?group=X` | 获取任务列表 |
| POST | `/api/tasks` | 创建任务 |
| PUT | `/api/tasks` | 更新任务状态 |
| GET | `/api/learning` | 获取学习记录 |
| GET | `/api/scoring` | 获取评分数据 |

### Orchestrate

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/orchestrate` | 触发多 agent 编排 |

### Audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit` | 获取审计日志 |

# Release Runbook (Commercial-Ready)

## 1. Preflight

Before release, confirm repository state is clean and current:

- `git status` has no unrelated uncommitted changes.
- Version and branch intent are clear (`vX.Y.Z` target for release).
- Required docs are available:
  - `README.md` (release section)
  - `AGENTS.md` (release decision matrix)
  - this runbook

## 2. Mandatory Gate

Use the unified gate whenever you run a serious release validation:

- `npm run release:check`

This runs:
- `npx tsc --noEmit`
- `npm test`
- `npm run build:exe:dir`
- `npm run smoke:runtime`
- `npm run smoke:electron`

Expected outcome: all commands pass, exit code `0`.

## 3. Release Trigger Matrix

- PR / `push` to `main`:
  - Run fast CI gate (`release-check` workflow fast mode).
  - No installer artifacts are uploaded.
- Tag `v*` push:
  - Run full gate and upload installer artifacts automatically.
- Manual workflow dispatch with `full_release=true`:
  - Run full gate on demand for controlled release windows.
- Manual dispatch with `full_release=false` (default):
  - Fast gate only.

## 4. Manual Full Release (if needed)

1. Trigger `.github/workflows/release-check.yml` manually and set `full_release=true`.
2. Wait for green workflow (fast and packaging stages).
3. Verify artifact output exists in workflow assets:
   - `dist-exe/*.exe`
   - `dist-exe/*.yml`
   - `dist-exe/*.blockmap`

## 4. Runtime Smoke Rollout Checks

- Run app/desktop from release build.
- Validate:
  - Next frontend loads.
  - WebSocket connects.
  - API health endpoints return expected values.
  - RAG endpoints are reachable and respond.

## 5. Incident Response and Rollback

If smoke or post-release issues are found:

- Triage:
  - Capture release version, job logs, and first failing signal.
  - Keep feature changes local to the release branch only.
- Rollback option:
  - Retag only after stabilization, or
  - Publish hotfix release from a clean branch.
- If issue scope is high, prefer pre-release fix + repeat full `release:check` before re-run.

## 6. Required Evidence for Completion

- `npm run release:check` result.
- Release artifact build logs (or uploaded artifacts list).
- Deployment confirmation and smoke result summary.

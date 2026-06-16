/**
 * Process Tracker — Track active query AbortControllers for clean shutdown.
 *
 * Each `createChatStream()` registers an AbortController here. On server
 * shutdown, `killAllQueries()` aborts all running queries so the SDK's
 * subprocess cleanup kicks in immediately rather than leaving orphan
 * claude.exe processes behind.
 *
 * v1.1: Added safety limit to prevent unbounded growth if untrackQuery
 * is missed due to unhandled errors. Logs a warning when the limit is hit
 * so the leak can be investigated.
 */

const tracked = new Set<AbortController>();
const MAX_TRACKED = 50; // safety limit — should never exceed concurrent request count

/** Register a new query. Returns the AbortController that will abort it. */
export function trackQuery(): AbortController {
  // Safety: if tracked set grows beyond limit, abort oldest entries
  // This prevents the Set from growing forever if untrackQuery is missed
  if (tracked.size >= MAX_TRACKED) {
    console.warn(`[process-tracker] Safety limit hit (${tracked.size}/${MAX_TRACKED}). Aboldest tracked queries to prevent leak.`);
    const oldest = tracked.values().next().value;
    if (oldest) {
      try { oldest.abort(); } catch { /* ignore */ }
      tracked.delete(oldest);
    }
  }
  const ac = new AbortController();
  tracked.add(ac);
  return ac;
}

/** Remove a completed/errored query from tracking. */
export function untrackQuery(ac: AbortController): void {
  tracked.delete(ac);
}

/**
 * Abort all tracked queries. Used during server shutdown.
 * Returns the number of queries aborted.
 */
export function killAllQueries(): number {
  let count = 0;
  for (const ac of tracked) {
    try { ac.abort(); count++; } catch { /* ignore */ }
  }
  tracked.clear();
  return count;
}

/** Number of currently active queries. */
export function activeQueryCount(): number {
  return tracked.size;
}

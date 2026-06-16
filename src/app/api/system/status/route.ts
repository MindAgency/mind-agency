/**
 * GET /api/system/status — System resource status
 *
 * Returns OS-level metrics: CPU load, memory usage, uptime,
 * data directory path, and current working directory.
 */

import { NextResponse } from 'next/server';
import { safeHandler } from '@/lib/api-handler';

export const GET = safeHandler(async () => {
  const os = await import('os');
  const { DATA_DIR } = await import('@/lib/data-dir');

  const [load1] = os.loadavg();
  const cpuCount = os.cpus().length;
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  return NextResponse.json({
    timestamp: Date.now(),
    uptime: Math.round(process.uptime()),
    load: { load1, cpuCount, loadPercent: Math.round(load1 / cpuCount * 100) },
    memory: { free: Math.round(freeMem / 1024 / 1024), total: Math.round(totalMem / 1024 / 1024), percent: Math.round((1 - freeMem / totalMem) * 100) },
    dataDir: DATA_DIR,
    cwd: process.cwd(),
  });
});

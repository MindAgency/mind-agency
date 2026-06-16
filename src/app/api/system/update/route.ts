/**
 * Update Check API — Check for new versions from GitHub Releases
 *
 * GET /api/system/update — Check if a new version is available
 */

import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

async function getLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const res = await fetch('https://api.github.com/repos/MindAgency/mind-agency/releases/latest', {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function getCurrentVersion(): string {
  try {
    const pkgPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export async function GET() {
  const currentVersion = getCurrentVersion();
  const release = await getLatestRelease();

  if (!release) {
    return NextResponse.json({
      currentVersion,
      updateAvailable: false,
      error: 'Unable to check for updates',
    });
  }

  const latestVersion = release.tag_name.replace(/^v/, '');
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

  // Find exe asset for Windows
  const exeAsset = release.assets.find(a => a.name.endsWith('.exe'));

  return NextResponse.json({
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseNotes: release.body,
    publishedAt: release.published_at,
    downloadUrl: exeAsset?.browser_download_url || null,
    downloadSize: exeAsset?.size || null,
  });
}

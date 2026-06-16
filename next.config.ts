import { existsSync, rmSync } from 'fs';
import { join } from 'path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['ts', 'tsx', 'js', 'jsx'],
  output: 'standalone',

  // Exclude heavy native modules from webpack bundling (Next.js 14+ way)
  serverExternalPackages: [
    '@xenova/transformers',
    '@lancedb/lancedb',
    'sharp',
    'onnxruntime-node',
  ],

  webpack: (config: any, { isServer }: { isServer: boolean }) => {
    // ── Externals (legacy fallback for older Next.js versions) ──
    try {
      if (isServer) {
        config.externals = [
          ...(config.externals || []),
          '@xenova/transformers',
          '@lancedb/lancedb',
          'sharp',
          'onnxruntime-node',
        ];
      }
    } catch (err) {
      console.error('[next.config] Webpack externals config error:', err);
    }

    // ── Cache corruption recovery ────────────────────────────────
    // "webpack_modules is not a function" errors are caused by stale
    // or corrupted filesystem cache entries that reference modules
    // from a previous compilation. Clear the cache on startup for
    // BOTH client and server builds to ensure a clean slate.
    try {
      if (config.cache?.type === 'filesystem') {
        const cacheDir = join(process.cwd(), '.next', 'cache', 'webpack');
        if (existsSync(cacheDir)) {
          console.log(`[next.config] Clearing webpack filesystem cache (${isServer ? 'server' : 'client'}) to prevent stale module references`);
          rmSync(cacheDir, { recursive: true, force: true });
          // Rebuild from scratch — use memory cache for this session
          config.cache = { type: 'memory' };
        }
      }
    } catch (err) {
      console.error('[next.config] Cache cleanup error:', err);
      // Fallback: disable cache entirely
      try { delete config.cache; } catch {}
    }

    // ── HMR stability for server-side code ───────────────────────
    // Prevent webpack from watching node_modules, which can cause
    // unnecessary recompilations and module invalidation cascades.
    if (config.watchOptions) {
      try {
        config.watchOptions.ignored = [
          ...(Array.isArray(config.watchOptions.ignored)
            ? config.watchOptions.ignored
            : []),
          '**/node_modules/**',
        ];
      } catch (err) {
        // watchOptions may be frozen in Next.js 15
        config.watchOptions = {
          ...config.watchOptions,
          ignored: [
            ...(Array.isArray(config.watchOptions.ignored)
              ? config.watchOptions.ignored
              : []),
            '**/node_modules/**',
          ],
        };
      }
    }

    return config;
  },
};
export default nextConfig;

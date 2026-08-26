import type { NextConfig } from "next";
import fs from 'fs';
import path from 'path';

// Resolve app version (prefer package.json, then manifest, then server/version.js)
// package.json is checked first because it's the one file every release
// patch reliably bumps - .release-please-manifest.json and
// server/version.js are managed by a separate tool (release-please) that
// isn't part of this fork's manual patch workflow, so they drift stale
// silently if a release skips running it. Falling back to them only when
// package.json is missing avoids the version badge getting stuck on an
// old number even though newer code is genuinely running.
let APP_VERSION = 'dev';
try {
  // 1) Prefer root package.json
  try {
    const pkgRaw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw);
    if (pkg.version) APP_VERSION = pkg.version;
  } catch {}

  // 2) Fallback to .release-please-manifest.json (manifest mode)
  if (APP_VERSION === 'dev') {
    try {
      const manifestPath = path.join(__dirname, '..', '.release-please-manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
        const manifestJson = JSON.parse(manifestRaw);
        if (manifestJson && typeof manifestJson['.'] === 'string' && manifestJson['.']) {
          APP_VERSION = manifestJson['.'];
        }
      }
    } catch {}
  }

  // 3) Fallback to server/version.js (managed by release-please extra-files)
  if (APP_VERSION === 'dev') {
    try {
      const serverRaw = fs.readFileSync(path.join(__dirname, '..', 'server', 'version.js'), 'utf8');
      const m = serverRaw.match(/VERSION\s*=\s*'([^']+)'/);
      if (m && m[1]) APP_VERSION = m[1];
    } catch {}
  }
} catch {}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_INSTANCE_TYPE: process.env.INSTANCE || 'private',
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
  async rewrites() {
    return [
      // Main API routes
      {
        source: '/api/:path*',
        destination: 'http://localhost:4000/api/:path*',
      },
      // Uploaded avatar images (served statically by the backend)
      {
        source: '/uploads/:path*',
        destination: 'http://localhost:4000/uploads/:path*',
      },
      // Addon proxy (server/routes/proxy.js) - the whole point of the
      // feature is handing out a URL on THIS host that hides the addon's
      // real manifest URL, and Stremio/Nuvio fetch it unauthenticated from
      // outside. Without this rewrite that URL reached Next.js instead of
      // the backend and returned a 404 HTML page, so every proxied addon
      // was dead on arrival - the backend route itself was fine and
      // answered correctly on its own port the whole time.
      {
        source: '/proxy/:path*',
        destination: 'http://localhost:4000/proxy/:path*',
      },
      // Public invite routes (no auth required)
      {
        source: '/invite/:inviteCode/check',
        destination: 'http://localhost:4000/invite/:inviteCode/check',
      },
      {
        source: '/invite/:inviteCode/request',
        destination: 'http://localhost:4000/invite/:inviteCode/request',
      },
      {
        source: '/invite/:inviteCode/status',
        destination: 'http://localhost:4000/invite/:inviteCode/status',
      },
      {
        source: '/invite/:inviteCode/generate-oauth',
        destination: 'http://localhost:4000/invite/:inviteCode/generate-oauth',
      },
      {
        source: '/invite/:inviteCode/complete',
        destination: 'http://localhost:4000/invite/:inviteCode/complete',
      },
      {
        source: '/invite/:inviteCode/user-info',
        destination: 'http://localhost:4000/invite/:inviteCode/user-info',
      },
      // Public user deletion routes
      {
        source: '/invite/generate-oauth',
        destination: 'http://localhost:4000/invite/generate-oauth',
      },
      {
        source: '/invite/delete-user',
        destination: 'http://localhost:4000/invite/delete-user',
      },
    ];
  },
  // The Guides section used to live at /help. Keep the old paths working
  // rather than 404ing anyone with a bookmark, an open tab from before the
  // rename, or a link shared in Discord.
  async redirects() {
    return [
      { source: '/help', destination: '/guides', permanent: true },
      { source: '/help/:id', destination: '/guides/:id', permanent: true },
    ];
  },
};

export default nextConfig;

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
};

export default nextConfig;

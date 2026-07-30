import type { YearInReview } from './api';

// Shareable "Wrapped" card for Year in Review - the visual/downloadable
// complement to the existing monthly poster mosaic (server/utils/
// posterMosaic.js), which is a Discord-only poster collage with no stats
// baked in. This is the opposite shape: a stats-forward card, generated
// entirely client-side.
//
// Deliberately NOT server-rendered. posterMosaic.js's own header comment
// explains why it avoids Jimp's bitmap-font plugin on this app's bun+Alpine
// build - baking real numbers into an image needs actual text rendering,
// which is exactly the risk that comment sidesteps. The browser's Canvas 2D
// API already does real text layout with zero extra dependencies, and
// rendering client-side means the card automatically matches whatever theme
// the viewer has active (colors read live from CSS custom properties, not
// hardcoded) - a real requirement here since SlickSync ships multiple
// selectable themes (see the Themes page).
//
// No remote poster images are drawn onto the canvas - Cinemeta/metahub image
// hosts aren't guaranteed to send CORS headers permitting canvas export, and
// a tainted canvas throws on toBlob(). Top titles are rendered as text
// instead, which sidesteps that risk entirely and keeps the export reliable
// regardless of image host.

const WIDTH = 1080;
const HEIGHT = 1920;

function fmtDuration(sec: number): string {
  if (!sec || sec < 60) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export async function renderWrappedCard(data: YearInReview): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');

  const primary = cssVar('--color-primary', '#8b7ec8');
  const secondary = cssVar('--color-secondary', '#5fd4c4');
  const bg = cssVar('--color-surface', '#0c0812');

  // Background: the theme's own surface color, with a soft radial glow in
  // the primary/secondary accents so every theme still looks intentional.
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const glow = ctx.createRadialGradient(WIDTH * 0.5, HEIGHT * 0.22, 0, WIDTH * 0.5, HEIGHT * 0.22, WIDTH * 0.9);
  glow.addColorStop(0, `${primary}55`);
  glow.addColorStop(1, `${primary}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const glow2 = ctx.createRadialGradient(WIDTH * 0.5, HEIGHT * 0.95, 0, WIDTH * 0.5, HEIGHT * 0.95, WIDTH * 0.8);
  glow2.addColorStop(0, `${secondary}33`);
  glow2.addColorStop(1, `${secondary}00`);
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.textAlign = 'center';
  const cx = WIDTH / 2;
  let y = 200;

  // Eyebrow
  ctx.fillStyle = secondary;
  ctx.font = '600 34px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText('SLICKSYNC WRAPPED', cx, y);
  y += 90;

  // Year
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 140px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(String(data.year), cx, y);
  y += 160;

  // Headline hours
  ctx.fillStyle = primary;
  ctx.font = '800 110px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(fmtDuration(data.totalWatchTimeSeconds), cx, y);
  y += 60;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '400 36px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText('watched together', cx, y);
  y += 140;

  // Stat row
  const stats: Array<[string, string]> = [
    [String(data.moviesWatched), 'Movies'],
    [String(data.episodesWatched), 'Episodes'],
    [String(data.showsWatched), 'Shows'],
  ];
  const colW = WIDTH / stats.length;
  for (let i = 0; i < stats.length; i++) {
    const x = colW * i + colW / 2;
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 72px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(stats[i][0], x, y);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '400 30px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(stats[i][1], x, y + 44);
  }
  y += 160;

  // Divider
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(120, y);
  ctx.lineTo(WIDTH - 120, y);
  ctx.stroke();
  y += 90;

  // Top shows
  if (data.topShows.length > 0) {
    ctx.fillStyle = secondary;
    ctx.font = '600 32px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText('TOP SHOWS', cx, y);
    y += 60;
    for (const show of data.topShows.slice(0, 5)) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 40px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(show.name, cx, y);
      y += 58;
    }
    y += 40;
  }

  // Most rewatched
  if (data.mostRewatched.length > 0) {
    ctx.fillStyle = secondary;
    ctx.font = '600 32px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText('MOST REWATCHED', cx, y);
    y += 60;
    const top = data.mostRewatched[0];
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 40px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(`${top.name} — ${(top.rewatchCount || 0) + 1}×`, cx, y);
    y += 58;
  }

  // Footer branding
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '500 30px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText('slicksync', cx, HEIGHT - 80);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Failed to export image'))), 'image/png');
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

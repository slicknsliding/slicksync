'use client';

// Menu highlight: how the option you are on stands out in every pop-up menu
// (Settings → Themes → Menu highlight). One option is lit at a time - the one
// under the mouse, under a finger while it is down, or focused by a TV remote
// or keyboard - by giving it data-mh="<style>" and, for the edges and lights,
// a .mh-fx layer (app/menu-highlight.css draws both). The account's choices
// sit on <html> as data-mh-* attributes, are kept on this device for the
// first paint, and are saved to the account so they follow it everywhere.

import { useEffect, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';

const CHOICES = {
  style: ['soft', 'solid', 'bar', 'outline', 'edge', 'edgeGlow', 'ringGlow', 'softRing', 'orbit', 'aurora'],
  colour: ['accent', 'white', 'blue', 'green', 'amber', 'pink', 'custom'],
  strength: ['subtle', 'medium', 'strong'],
  // Orbit
  wait: ['now', 'half', 'long'],
  laps: ['four', 'always'],
  dir: ['cw', 'acw'],
  speed: ['slow', 'normal', 'fast'],
  // Aurora
  auwait: ['now', 'half', 'long'],
  aulaps: ['always', 'four'],
  audir: ['acw', 'cw'],
  auspeed: ['slow', 'normal', 'fast'],
  aucolours: ['warm', 'own'],
} as const;

type Choices = typeof CHOICES;
export type MenuHighlight = { [K in keyof Choices]: Choices[K][number] } & {
  /** The Custom colour, #rrggbb; used when colour is 'custom'. */
  custom: string;
};
export type MhStyle = MenuHighlight['style'];

// Aurora by default: right away, the whole time, anticlockwise, normal speed,
// warm to cool.
export const MH_DEFAULT: MenuHighlight = {
  style: 'aurora', colour: 'accent', strength: 'medium',
  wait: 'half', laps: 'four', dir: 'cw', speed: 'normal',
  auwait: 'now', aulaps: 'always', audir: 'acw', auspeed: 'normal', aucolours: 'warm',
  custom: '#8b7ec8',
};

export const MH_FILLS: readonly MhStyle[] = ['soft', 'solid', 'bar', 'outline'];
export const MH_EDGES: readonly MhStyle[] = ['edge', 'edgeGlow', 'ringGlow', 'softRing', 'orbit', 'aurora'];

const HEX = /^#[0-9a-f]{6}$/i;

/** Whatever was saved, as a full set of known choices; anything unknown falls back to the default. */
export function sanitizeMenuHighlight(raw: unknown): MenuHighlight {
  const out: MenuHighlight = { ...MH_DEFAULT };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(CHOICES) as (keyof Choices)[]) {
    const v = r[key];
    if ((CHOICES[key] as readonly unknown[]).includes(v)) (out as Record<string, unknown>)[key] = v;
  }
  if (typeof r.custom === 'string' && HEX.test(r.custom)) out.custom = r.custom.toLowerCase();
  return out;
}

const same = (a: MenuHighlight, b: MenuHighlight) =>
  (Object.keys(MH_DEFAULT) as (keyof MenuHighlight)[]).every((k) => a[k] === b[k]);

// --- The store ----------------------------------------------------------------

const STORAGE_KEY = 'slicksync-menu-highlight';
let current: MenuHighlight = MH_DEFAULT;
let hydrated = false;
let editedAt = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

function readLocal(): MenuHighlight {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? sanitizeMenuHighlight(JSON.parse(s)) : MH_DEFAULT;
  } catch {
    return MH_DEFAULT;
  }
}

function writeLocal(v: MenuHighlight) {
  try {
    if (same(v, MH_DEFAULT)) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch { /* private window or blocked storage: the account copy still holds it */ }
}

function hydrate() {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  current = readLocal();
  applyAttributes(current);
}

/** Black or white ink on a colour, whichever reads better. */
function inkFor(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => toLin(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0b0b10' : '#fff';
}

function applyAttributes(v: MenuHighlight) {
  const h = document.documentElement;
  for (const key of Object.keys(CHOICES) as (keyof Choices)[]) {
    if (key !== 'style') h.setAttribute(`data-mh-${key}`, v[key]);
  }
  // Custom: the chosen colour, a lighter partner for the gradients, and ink
  // for Solid that stays readable on it.
  if (v.colour === 'custom') {
    h.style.setProperty('--mh-c', v.custom);
    h.style.setProperty('--mh-c2', `color-mix(in oklab, ${v.custom} 55%, white)`);
    h.style.setProperty('--mh-ink', inkFor(v.custom));
  } else {
    h.style.removeProperty('--mh-c');
    h.style.removeProperty('--mh-c2');
    h.style.removeProperty('--mh-ink');
  }
}

function setCurrent(next: MenuHighlight, opts: { save: boolean }) {
  if (same(next, current)) return;
  current = next;
  writeLocal(next);
  applyAttributes(next);
  if (opts.save) {
    editedAt = Date.now();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      api.saveMenuHighlight(same(current, MH_DEFAULT) ? null : { ...current }).catch(() => {});
    }, 400);
  }
  relight();
  subscribers.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  hydrate();
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** The account's menu highlight, and a setter that takes changes (or null for Reset to default). */
export function useMenuHighlight(): [MenuHighlight, (change: Partial<MenuHighlight> | null) => void] {
  const value = useSyncExternalStore(subscribe, () => { hydrate(); return current; }, () => MH_DEFAULT);
  return [value, setMenuHighlight];
}

export function setMenuHighlight(change: Partial<MenuHighlight> | null) {
  hydrate();
  setCurrent(change === null ? MH_DEFAULT : sanitizeMenuHighlight({ ...current, ...change }), { save: true });
}

// --- Aurora's comet -----------------------------------------------------------
// N short pieces laid along the option's outline (pathLength 100), stacked so
// every piece runs from its own start right up to the head: no seams, and each
// adds just enough light to follow a smooth fade from tail to head. Stacked
// pieces show through each other, so each is given a slightly warmer colour
// for the mix to land on the intended one.

const toLin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const fromLin = (c: number) => Math.round(Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) * 255);

function oklab(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => toLin(parseInt(hex.slice(i, i + 2), 16)));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function labToHex([L, a, b]: number[]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const out = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return '#' + out.map(fromLin).map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Warm to cool, tail to head: blue, indigo, violet, magenta, red-pink, red-orange.
const WARM: [number, string][] = [[0, '#3b5cff'], [0.28, '#6c4dff'], [0.5, '#a43ff2'], [0.7, '#e2399f'], [0.86, '#ff3b5c'], [1, '#ff6a2c']];
function warmAt(t: number) {
  let i = 0;
  while (i < WARM.length - 2 && t > WARM[i + 1][0]) i++;
  const [t0, c0] = WARM[i];
  const [t1, c1] = WARM[i + 1];
  const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  const a = oklab(c0);
  const b = oklab(c1);
  return labToHex(a.map((v, k) => v + (b[k] - v) * f));
}

/** One set of comet pieces: its colour variables (warm and own-colour) and its rects. */
function comet(pieces: number, prefix: 'a' | 'b') {
  const SHARE = 48; // how much of the outline the comet covers, in pathLength units
  const FLOOR = 0.07;
  const CURVE = 1.15;
  const seg = SHARE / pieces;
  const alpha = (t: number) => Math.min(1, FLOOR + (1 - FLOOR) * t ** CURVE);
  const warm: string[] = [];
  const own: string[] = [];
  const rects: string[] = [];
  let below = 0; // how much light the pieces underneath already give, 0..1
  let prevT = 0;
  for (let k = 0; k < pieces; k++) {
    const t = pieces === 1 ? 1 : k / (pieces - 1);
    const want = alpha(t);
    const op = below >= 1 ? 1 : 1 - (1 - want) / (1 - below);
    const ct = k === 0 || op <= 0 ? t : Math.min(1, t + (t - prevT) * below * (1 - op) / op);
    prevT = t;
    warm.push(`--mh-${prefix}${k}:${warmAt(ct)}`);
    own.push(`--mh-${prefix}${k}:color-mix(in oklab, var(--mh-c2) ${Math.round(ct * 100)}%, var(--mh-c))`);
    const start = 100 - SHARE + k * seg;
    below = want;
    rects.push(`<rect pathLength="100" style="stroke:var(--mh-${prefix}${k});stroke-opacity:${Math.max(0, op).toFixed(4)};stroke-dasharray:0 ${start.toFixed(3)} ${(100 - start).toFixed(3)} 0"/>`);
  }
  if (prefix === 'a') {
    const pick = (f: number) => Math.round(f * (pieces - 1));
    // The still ring after 4 laps uses four points along the comet.
    warm.push(`--mh-aH:var(--mh-a${pieces - 1})`, `--mh-aM:var(--mh-a${pick(0.66)})`, `--mh-aL:var(--mh-a${pick(0.33)})`, '--mh-aT:var(--mh-a0)');
  }
  return { css: `:root{${warm.join(';')}}\nhtml[data-mh-aucolours=own]{${own.join(';')}}\n`, rects: rects.join('') };
}

let built: { css: string; inner: string } | null = null;
function fx() {
  if (built) return built;
  // The crisp line needs many pieces to look smooth; the two blurred layers
  // don't (the blur hides the steps), so they get fewer, which is cheaper.
  const line = comet(32, 'a');
  const soft = comet(12, 'b');
  const inner = '<span class="mh-edge"></span>'
    + '<svg class="mh-orbit"><rect class="mh-orbit-ring" pathLength="100"/><rect class="mh-orbit-light" pathLength="100"/></svg>'
    + '<span class="mh-aurora"><span class="mh-au-base"></span>'
    + `<svg class="mh-au mh-au-bloom">${soft.rects}</svg><svg class="mh-au mh-au-glow">${soft.rects}</svg><svg class="mh-au mh-au-line">${line.rects}</svg>`
    + '<span class="mh-au-rest"></span></span>';
  built = { css: line.css + soft.css, inner };
  return built;
}

/** The light layers of a lit option, as markup (for the previews in Settings). */
export function menuHighlightFxMarkup() {
  return fx().inner;
}

const DEFS = '<defs><linearGradient id="mh-orbit-grad" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" style="stop-color:color-mix(in srgb, var(--mh-c) 60%, white)"/>'
  + '<stop offset="1" style="stop-color:var(--mh-c2)"/></linearGradient></defs>';

// --- Lighting the option you are on ---------------------------------------------

// Pop-up menus and pickers. Dialogs, the command palette and the notification
// lists mark themselves data-mh-off: they are not menus of options.
const ROOTS = '.popup-panel, [role="menu"], [role="listbox"], .arrange-menu';
const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], button, a[href]';
const ROLES = new Set(['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option']);

let lit: HTMLElement | null = null;
let litBy: 'pointer' | 'touch' | 'focus' | null = null;

/** The menu option an event is on, or null when it isn't on one. */
function optionAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const item = target.closest<HTMLElement>(ITEMS);
  if (!item) return null;
  const root = item.closest<HTMLElement>(ROOTS);
  if (!root || root === item || root.closest('[data-mh-off]')) return null;
  if (item.matches(':disabled, [aria-disabled="true"]')) return null;
  // An option: a menu role, or a row the menu already marks as hoverable.
  const role = item.getAttribute('role');
  if (!(role && ROLES.has(role)) && !item.classList.contains('hover:bg-surface-hover') && !item.hasAttribute('data-mh-item')) return null;
  // A row across the menu, not a small button in a corner (a close ×).
  if (item.getBoundingClientRect().width < root.clientWidth * 0.5) return null;
  return item;
}

function light(el: HTMLElement, by: 'pointer' | 'touch' | 'focus') {
  if (lit === el && el.getAttribute('data-mh') === current.style) { litBy = by; return; }
  unlight();
  el.setAttribute('data-mh', current.style);
  const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 8;
  el.style.setProperty('--mh-rx', `${Math.max(0, r - 0.75)}px`);
  el.style.setProperty('--mh-r', `${r}px`);
  if (!MH_FILLS.includes(current.style)) {
    const layer = document.createElement('span');
    layer.className = 'mh-fx';
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = fx().inner;
    el.appendChild(layer);
  }
  lit = el;
  litBy = by;
}

function unlight() {
  const el = lit;
  lit = null;
  litBy = null;
  if (!el) return;
  el.removeAttribute('data-mh');
  el.style.removeProperty('--mh-rx');
  el.style.removeProperty('--mh-r');
  el.querySelectorAll(':scope > .mh-fx').forEach((n) => n.remove());
}

/** After a change of style, light the same option again in the new one. */
function relight() {
  if (!lit) return;
  const el = lit;
  const by = litBy || 'pointer';
  unlight();
  if (el.isConnected) light(el, by);
}

/**
 * Mounted once at the top of the app: puts the account's choices on <html>,
 * brings in the account's saved copy, and lights the option you are on in
 * every pop-up menu.
 */
export function MenuHighlightRoot() {
  useEffect(() => {
    hydrate();
    const doc = document;

    if (!doc.getElementById('mh-comet')) {
      const style = doc.createElement('style');
      style.id = 'mh-comet';
      style.textContent = fx().css;
      doc.head.appendChild(style);
    }
    if (!doc.getElementById('mh-defs')) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'mh-defs';
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.position = 'absolute';
      svg.innerHTML = DEFS;
      doc.body.appendChild(svg);
    }

    // The account's copy wins over this device's, unless something was
    // changed here while it was on its way.
    const asked = Date.now();
    api.getMenuHighlight().then((r) => {
      if (!r || editedAt > asked) return;
      setCurrent(r.menuHighlight ? sanitizeMenuHighlight(r.menuHighlight) : MH_DEFAULT, { save: false });
    }).catch(() => {});

    const isTV = () => doc.documentElement.hasAttribute('data-tv');
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const item = optionAt(e.target);
      if (item) light(item, 'pointer');
    };
    const out = (e: PointerEvent) => {
      if (!lit || litBy !== 'pointer' || e.pointerType === 'touch') return;
      const to = e.relatedTarget;
      if (to instanceof Node && lit.contains(to)) return;
      unlight();
    };
    // A phone: lit while the finger is on the option.
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const item = optionAt(e.target);
      if (item) light(item, 'touch');
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && litBy === 'touch') unlight();
    };
    // A TV remote or keyboard: lit on the option it is on. A click focuses a
    // button too, so a computer only counts focus it would show a ring for.
    const focusIn = (e: FocusEvent) => {
      const item = optionAt(e.target);
      if (item && (isTV() || item.matches(':focus-visible'))) light(item, 'focus');
    };
    const focusOut = (e: FocusEvent) => {
      if (litBy === 'focus' && e.target === lit) unlight();
    };

    doc.addEventListener('pointerover', over, { passive: true });
    doc.addEventListener('pointerout', out, { passive: true });
    doc.addEventListener('pointerdown', down, { passive: true });
    doc.addEventListener('pointerup', up, { passive: true });
    doc.addEventListener('pointercancel', up, { passive: true });
    doc.addEventListener('focusin', focusIn);
    doc.addEventListener('focusout', focusOut);
    return () => {
      doc.removeEventListener('pointerover', over);
      doc.removeEventListener('pointerout', out);
      doc.removeEventListener('pointerdown', down);
      doc.removeEventListener('pointerup', up);
      doc.removeEventListener('pointercancel', up);
      doc.removeEventListener('focusin', focusIn);
      doc.removeEventListener('focusout', focusOut);
      unlight();
    };
  }, []);
  return null;
}

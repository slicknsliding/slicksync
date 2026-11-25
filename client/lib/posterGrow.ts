import { fxOn } from './effects';

// Effects → Poster to detail: a details window opened from a poster grows out
// of that poster as one rounded shape, and goes back into it when it closes.
//
// The window is drawn where it will end up and shown through a shape that
// starts at the poster's outline: at first the window's own wide picture
// fills that shape, then the shape widens to the whole window. Nothing is
// laid over the window, so nothing has to be taken away again. The window's
// shadow is cut off by the shape while it moves, so a stand-in shadow
// travels with it, and the darkening behind comes in over the whole opening
// rather than all at once.

let last: { el: HTMLElement; at: number } | null = null;
let watching = false;

/** Remembers the poster that was just pressed (ArrangeProvider starts it). */
export function watchPosterTaps(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('click', (e) => {
    const card = (e.target as Element | null)?.closest?.('[data-fx-poster]');
    if (!(card instanceof HTMLElement)) return;
    const art = card.querySelector<HTMLElement>('[data-fx-poster-art]') || card;
    last = { el: art, at: performance.now() };
  }, true);
}

/** The poster a window opening right now came from, when the effect is on. Once only. */
export function takePosterOrigin(): HTMLElement | null {
  const l = last;
  last = null;
  return l && performance.now() - l.at < 800 && l.el.isConnected && fxOn('poster') ? l.el : null;
}

// How much of the window's wide picture, from its top, is clear picture: lower
// down it fades into the window. That part fills the poster's shape at the start.
const CLEAR = 0.45;
const OPEN_MS = 320;
const CLOSE_MS = 280;

/**
 * Grows `panel` out of `origin` (or shrinks it back). The panel must be in
 * its final place with no transform. Returns `done` and a `cancel` that puts
 * everything back at once.
 */
export function growWindow(panel: HTMLElement, origin: HTMLElement, opening: boolean, overlay: HTMLElement | null, shadow: HTMLElement | null): { done: Promise<boolean>; cancel: () => void } {
  let frame = 0;
  let over = false;
  let finish: (ran: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => { finish = resolve; });
  const tidy = () => {
    panel.style.transform = '';
    panel.style.clipPath = '';
    panel.style.transformOrigin = '';
    panel.style.willChange = '';
    panel.removeAttribute('data-fx-morphing');
    if (shadow) { shadow.style.display = ''; shadow.style.opacity = ''; }
    if (overlay && opening) overlay.style.opacity = '';
  };
  const end = (ran: boolean) => { if (over) return; over = true; cancelAnimationFrame(frame); tidy(); finish(ran); };

  const pr = origin.getBoundingClientRect();
  if (!pr.width || !pr.height || !panel.offsetWidth || !panel.offsetHeight) { end(false); return { done, cancel: () => end(false) }; }
  const heroEl = panel.querySelector<HTMLElement>('[data-fx-hero]');
  const corner = parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 16;
  const from = parseFloat(getComputedStyle(origin).borderTopLeftRadius) || 12;

  // t = 0: the poster. t = 1: the open window. Where the window stands is
  // read afresh each time: it grows taller when its details arrive, which can
  // be while it is still moving. (offsetLeft/Top ignore the transform, and
  // count from the screen: the window sits in a holder that fills it.)
  const at = (t: number) => {
    const f = { left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight };
    const heroH = (heroEl && heroEl.offsetHeight ? heroEl.offsetHeight : Math.min(f.height, 330)) * CLEAR;
    const k0 = Math.max(pr.width / f.width, pr.height / heroH);
    const l = pr.left + (f.left - pr.left) * t;
    const top = pr.top + (f.top - pr.top) * t;
    const w = pr.width + (f.width - pr.width) * t;
    const hh = pr.height + (f.height - pr.height) * t;
    const k = k0 + (1 - k0) * t;
    const ax = f.width / 2;
    const ay = heroH / 2 + (f.height / 2 - heroH / 2) * t;
    const tx = l + w / 2 - f.left - k * ax;
    const ty = top + hh / 2 - f.top - k * ay;
    panel.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    const cl = Math.max(0, (l - f.left - tx) / k);
    const ct = Math.max(0, (top - f.top - ty) / k);
    const cr = Math.max(0, f.width - (l + w - f.left - tx) / k);
    const cb = Math.max(0, f.height - (top + hh - f.top - ty) / k);
    panel.style.clipPath = `inset(${ct}px ${cr}px ${cb}px ${cl}px round ${(from + (corner - from) * t) / k}px)`;
    if (shadow) { shadow.style.left = `${l}px`; shadow.style.top = `${top}px`; shadow.style.width = `${w}px`; shadow.style.height = `${hh}px`; }
  };

  panel.setAttribute('data-fx-morphing', '');
  panel.style.transformOrigin = '0 0';
  panel.style.willChange = 'transform, clip-path';
  if (shadow) { shadow.style.display = 'block'; shadow.style.opacity = opening ? '0' : '1'; }
  if (overlay) overlay.style.opacity = '0';
  at(opening ? 0 : 1);
  const t0 = performance.now();
  const ms = opening ? OPEN_MS : CLOSE_MS;
  const step = (now: number) => {
    if (over) return;
    const q = Math.max(0, Math.min(1, (now - t0) / ms));
    at(opening ? 1 - Math.pow(1 - q, 3) : 1 - q * q * (3 - 2 * q));
    if (opening) {
      if (overlay) overlay.style.opacity = String(q);
      if (shadow) shadow.style.opacity = String(q);
    }
    if (q < 1) frame = requestAnimationFrame(step); else end(true);
  };
  frame = requestAnimationFrame(step);
  return { done, cancel: () => end(false) };
}

/**
 * A window that has just closed goes back into its poster: a copy of it,
 * standing where it stood, because the window itself is usually gone from the
 * page by now. `stood`: where it was, for when it is already off the page.
 */
export function shrinkAway(panel: HTMLElement, origin: HTMLElement, stood: DOMRect | null): void {
  if (typeof document === 'undefined' || !origin.isConnected) return;
  const live = panel.isConnected ? panel.getBoundingClientRect() : null;
  const r = live && live.width ? live : stood;
  if (!r || !r.width || !r.height) return;
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.setAttribute('inert', '');
  holder.style.cssText = 'position:fixed;inset:0;z-index:50;pointer-events:none;';
  const shadow = document.createElement('div');
  shadow.className = 'fx-grow-shadow';
  const copy = panel.cloneNode(true) as HTMLElement;
  copy.removeAttribute('role');
  copy.removeAttribute('aria-modal');
  copy.removeAttribute('data-tv-modal');
  copy.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;max-width:none;max-height:none;margin:0;`;
  holder.append(shadow, copy);
  document.body.appendChild(holder);
  // The copy starts scrolled to the top; put it where the window was scrolled to.
  if (panel.isConnected) {
    const was = Array.from(panel.querySelectorAll<HTMLElement>('*')).filter((el) => el.scrollTop > 0);
    const all = Array.from(panel.querySelectorAll<HTMLElement>('*'));
    const copies = Array.from(copy.querySelectorAll<HTMLElement>('*'));
    for (const el of was) { const twin = copies[all.indexOf(el)]; if (twin) twin.scrollTop = el.scrollTop; }
  }
  const gone = () => holder.remove();
  growWindow(copy, origin, false, null, shadow).done.then(gone, gone);
}

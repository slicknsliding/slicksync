// A card with no visible ... button (everywhere but TV) still hangs its menu
// from that button: it is kept as an invisible 1px anchor and moved to the spot
// the person right-clicked or held, so the menu opens there. A context-menu key
// press (no pointer position) puts it in the middle of the card.

export function pointAnchor(anchor: HTMLElement | null, at: { clientX: number; clientY: number } | null) {
  // Only the invisible anchor moves; TV's visible button stays in its corner.
  if (!anchor || anchor.getAttribute('aria-hidden') !== 'true') return;
  const box = anchor.offsetParent as HTMLElement | null;
  if (!box) return;
  // The spot is kept inside the whole card; the anchor may sit in a smaller
  // positioned box within it, so it is placed relative to that box.
  const card = (anchor.closest('[data-continue-card], [role="button"]') as HTMLElement | null) ?? box;
  const c = card.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const has = !!at && (at.clientX !== 0 || at.clientY !== 0);
  const x = has ? Math.max(c.left, Math.min(c.right - 1, at!.clientX)) : c.left + c.width / 2;
  const y = has ? Math.max(c.top, Math.min(c.bottom - 1, at!.clientY)) : c.top + c.height / 2;
  anchor.style.left = `${x - b.left}px`;
  anchor.style.top = `${y - b.top}px`;
}

/** Classes for the ... button: the round button on TV, the invisible anchor elsewhere. */
export const HIDDEN_ANCHOR = 'absolute z-[2] w-px h-px opacity-0 pointer-events-none';

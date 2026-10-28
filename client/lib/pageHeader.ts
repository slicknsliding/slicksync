'use client';

// Themes → Layout → Page header: how the title row at the top of every page is
// drawn. Compact is one slim row (title, small subtitle, icon-only buttons, the
// palette and bell); Full is the big centred title with its buttons under it;
// Minimal drops the title row and keeps just the buttons in a slim strip.
// Saved to the account; with nothing saved, phones get Compact and wide
// screens get Full.

import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react';
import { useArrangement } from '@/lib/arrange';
import { useIsTV } from '@/lib/hooks/useIsTV';
import type { Arrangement } from '@/lib/arrange-core';

export type PageHeaderMode = 'compact' | 'full' | 'minimal';

export const PAGE_HEADER_MODES: { id: PageHeaderMode; label: string }[] = [
  { id: 'compact', label: 'Compact' },
  { id: 'full', label: 'Full' },
  { id: 'minimal', label: 'Minimal' },
];

// The saved field is added to the Arrangement type by arrange-core; read and
// written through this shape so this file stands on its own.
type WithPageHeader = Arrangement & { pageHeader?: PageHeaderMode };

const PHONE_QUERY = '(max-width: 767px)';

function subscribePhone(cb: () => void) {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
const phoneNow = () => window.matchMedia(PHONE_QUERY).matches;
const phoneServer = () => false;

/** True on a phone-width screen (under the md breakpoint). */
export function useIsPhoneWidth() {
  return useSyncExternalStore(subscribePhone, phoneNow, phoneServer);
}

function isMode(v: unknown): v is PageHeaderMode {
  return v === 'compact' || v === 'full' || v === 'minimal';
}

/** The header style in effect, and a setter that saves the choice to the account. */
export function usePageHeader() {
  const { arrangement, update } = useArrangement();
  const phone = useIsPhoneWidth();
  // The TV app keeps the page header as it is.
  const isTV = useIsTV();
  const saved = (arrangement as WithPageHeader).pageHeader;
  const mode: PageHeaderMode = isTV ? 'full' : isMode(saved) ? saved : phone ? 'compact' : 'full';
  const setMode = useCallback((m: PageHeaderMode) => {
    update((prev) => ({ ...(prev as WithPageHeader), pageHeader: m }) as Arrangement);
  }, [update]);
  return { mode, saved: isMode(saved) ? saved : null, setMode };
}

// Icon-only buttons in the Compact row. A button that holds an icon and a word
// shows just the icon; a dropdown (aria-haspopup) keeps its words, since its
// words are what it shows.
export const PAGE_HEADER_CSS = `
[data-ph-actions="icons"] [data-ph-icon]{font-size:0 !important;gap:0 !important;padding:0 !important;width:36px;height:36px;min-width:36px;display:inline-flex !important;align-items:center;justify-content:center}
[data-ph-actions="icons"] [data-ph-icon] *:not(svg):not(path){font-size:0 !important;gap:0 !important;margin:0 !important}
[data-ph-actions="icons"] [data-ph-icon] svg{margin:0 !important}
[data-ph-actions="slim"] button:not([data-ph-keep]), [data-ph-actions="slim"] a[href]:not([data-ph-keep]){padding:5px 10px !important;font-size:12.5px !important}
`;

/**
 * Gives every icon-and-word button inside `ref` an accessible name and a
 * tooltip, and marks it so the Compact CSS can show just its icon. Only
 * attributes are written, so React's own tree is untouched.
 */
export function useIconifyActions(ref: RefObject<HTMLElement | null>, on: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const run = () => {
      el.querySelectorAll<HTMLElement>('button, a[href]').forEach((b) => {
        const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
        const hasIcon = !!b.querySelector('svg');
        if (!text || !hasIcon || b.hasAttribute('aria-haspopup')) {
          b.removeAttribute('data-ph-icon');
          return;
        }
        if (!b.hasAttribute('data-ph-icon')) b.setAttribute('data-ph-icon', '');
        const prev = b.getAttribute('data-ph-label');
        for (const attr of ['aria-label', 'title']) {
          const cur = b.getAttribute(attr);
          if (!cur || cur === prev) b.setAttribute(attr, text);
        }
        if (prev !== text) b.setAttribute('data-ph-label', text);
      });
    };
    run();
    const mo = new MutationObserver(run);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      el.querySelectorAll('[data-ph-icon]').forEach((b) => b.removeAttribute('data-ph-icon'));
    };
  }, [ref, on]);
}

/**
 * While a bar is pinned to the bottom of the screen (Library's Select bar), the
 * floating account picture steps aside so the two never collide.
 */
export function useBottomBarUp(on: boolean) {
  useEffect(() => {
    if (!on) return;
    document.body.setAttribute('data-bottom-bar', '1');
    return () => document.body.removeAttribute('data-bottom-bar');
  }, [on]);
}

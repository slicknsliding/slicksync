// The one clipboard entry point - because navigator.clipboard only exists in
// secure contexts. On plain-HTTP origins (betatest by IP, any self-hosted
// instance without TLS yet) it is undefined, so every bare
// `navigator.clipboard.writeText(x)` in the app silently copied nothing -
// and the optimistic `toast.success('Copied')` next to it lied about it.
// Confirmed live: the SlickTrax manifest link toasted "copied" with an empty
// clipboard.
//
// Falls back to the classic hidden-textarea + execCommand('copy') path,
// which still works everywhere that matters precisely because it predates
// the secure-context requirement. Returns whether ANY path actually
// succeeded, so callers can stop toasting success on faith.
// Copy with a tick: the button that was pressed shows a green tick over its
// own icon for a second, right under the finger, and the "Copied" pop-up in
// the corner is not needed for it (components/ui/Toast leaves it out). Only
// a button with an icon can show one; any other copy keeps its pop-up.
let pressed: HTMLElement | null = null;
let tickedAt = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    pressed = e.target instanceof Element ? e.target.closest<HTMLElement>('button, [role="button"], a') : null;
  }, true);
}
function tick(): HTMLElement | null {
  const b = pressed;
  if (!b || !b.isConnected || !b.querySelector('svg')) return null;
  tickedAt = performance.now();
  b.setAttribute('data-copied', '');
  window.setTimeout(() => b.removeAttribute('data-copied'), 1200);
  return b;
}
/** Whether a copy just showed its tick on the button (so its pop-up can be left out). */
export function copyJustTicked(): boolean {
  return tickedAt > 0 && performance.now() - tickedAt < 600;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  // Straight away, not once the copy has settled: most callers show their
  // pop-up on the next line without waiting, and it has to know by then.
  const ticked = tick();
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen but focusable - display:none would make select() a no-op.
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) ticked?.removeAttribute('data-copied');
    return ok;
  } catch {
    ticked?.removeAttribute('data-copied');
    return false;
  }
}

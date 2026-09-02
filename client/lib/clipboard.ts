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
export async function copyToClipboard(text: string): Promise<boolean> {
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
    return ok;
  } catch {
    return false;
  }
}

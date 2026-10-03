'use client';

// Where someone was before they opened a guide, so the guide's Back takes
// them there rather than to the list of guides.
//
// The admin layout reports every page change. A page that is not a guide
// topic becomes the return point; each guide topic opened after it is added
// to a short trail, so Back can step the browser back over all of them in
// one go and land on the page - and the scroll position - they left.

const PAGE_KEY = 'slicksync:guide-return-page';
const TRAIL_KEY = 'slicksync:guide-trail';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

/** Called by the admin layout on every page change. */
export function trackGuideNavigation(pathname: string, search: string) {
  const topic = pathname.startsWith('/guides/') ? pathname.slice('/guides/'.length) : null;
  if (!topic) {
    write(PAGE_KEY, pathname + (search || ''));
    write(TRAIL_KEY, []);
    return;
  }
  const trail = read<string[]>(TRAIL_KEY, []);
  if (trail[trail.length - 1] === topic) return;
  // The browser's own Back from one guide to the one before it.
  if (trail[trail.length - 2] === topic) trail.pop();
  else trail.push(topic);
  write(TRAIL_KEY, trail);
}

const PAGE_NAMES: Record<string, string> = {
  '': 'Dashboard', users: 'Users', activity: 'Activity', metrics: 'Metrics', groups: 'Groups',
  discover: 'Discover', catalogs: 'Catalogs', addons: 'Addons', vault: 'Vault', invitations: 'Invitations',
  settings: 'Settings', tasks: 'Tasks', guides: 'Guides',
};

/**
 * The way back from the guide being shown, or null when it was opened
 * directly (a bookmark, a new tab) and there is nowhere in the app to return to.
 */
export function guideReturn(): { label: string; go: () => void } | null {
  const page = read<string | null>(PAGE_KEY, null);
  if (!page) return null;
  const segments = page.split('?')[0].split('/').filter(Boolean);
  const name = segments.length <= 1 ? PAGE_NAMES[segments[0] || ''] : null;
  return {
    label: name ? `Back to ${name}` : 'Back',
    // Read when pressed, not when the guide opened: the layout records this
    // guide's own visit after the guide page has already rendered.
    go: () => window.history.go(-Math.max(1, read<string[]>(TRAIL_KEY, []).length)),
  };
}

'use client';

// A new page starts at the very top. Next.js only scrolls the new page's own
// content into view, which leaves the top bar (logo and menu) above the fold
// whenever you came from further down a page. Back and Forward keep the
// browser's own scroll position; a change of query only (a filter, a tab)
// keeps yours too.

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

export function ScrollToTopOnNavigate() {
  const pathname = usePathname();
  const first = useRef(true);
  const fromHistory = useRef(false);

  useEffect(() => {
    const onPop = () => { fromHistory.current = true; };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (fromHistory.current) { fromHistory.current = false; return; }
    // A link to a spot on the page (#section) goes there instead.
    if (window.location.hash) return;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname]);

  return null;
}

'use client';

import { useEffect } from 'react';

// "(3) SlickSync" in the browser tab while notifications are waiting.
//
// Pages set their own titles ("SlickSync - Sam") and Next.js swaps the
// <title> element whenever they do, so the prefix cannot be set once. This
// watches the head and puts it back in front of whatever the page chose,
// stripping an older count first. The write only happens when the title is
// not already right, so it cannot chase its own change.

const COUNT_PREFIX = /^\((?:\d+|99\+)\)\s+/;

export function useUnreadTitle(count: number) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prefix = count > 0 ? `(${count > 99 ? '99+' : count}) ` : '';
    const apply = () => {
      const next = prefix + document.title.replace(COUNT_PREFIX, '');
      if (document.title !== next) document.title = next;
    };
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
      const plain = document.title.replace(COUNT_PREFIX, '');
      if (document.title !== plain) document.title = plain;
    };
  }, [count]);
}

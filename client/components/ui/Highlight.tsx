'use client';

// Search shows what matched: the letters typed into a page's search box are
// marked inside the name that came up, so the reason it is in the list shows
// at a glance. First match only, any capitals; no raw HTML ever.
//
// A page wraps its list in <HighlightQuery q={searchQuery}> and every
// <Highlight text="..." /> inside reads it from there, so the cards need no
// extra prop. A <Highlight q="..."> given directly wins.

import { createContext, useContext, type ReactNode } from 'react';

const QueryContext = createContext('');

export function HighlightQuery({ q, children }: { q: string; children: ReactNode }) {
  return <QueryContext.Provider value={q}>{children}</QueryContext.Provider>;
}

export function Highlight({ text, q, whole, from = 0 }: {
  text: string;
  q?: string;
  /** When `text` is only a piece of a longer name (a card that wraps its last word), the whole name and where the piece starts: the match is found in the whole and marked wherever it falls in the piece. */
  whole?: string;
  from?: number;
}) {
  const fromPage = useContext(QueryContext);
  const query = (q ?? fromPage).trim();
  if (!query || !text) return <>{text}</>;
  const found = (whole ?? text).toLowerCase().indexOf(query.toLowerCase());
  if (found < 0) return <>{text}</>;
  // The match, in this piece's own positions.
  const start = Math.max(0, found - (whole ? from : 0));
  const end = Math.min(text.length, found + query.length - (whole ? from : 0));
  if (end <= start) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark className="match-mark">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

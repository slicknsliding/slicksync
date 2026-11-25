'use client';

import { useEffect, useRef, useState } from 'react';
import { fxOn } from '@/lib/effects';

type Parts = { before: string; after: string; n: number; decimals: number; grouped: boolean };

// One number with an optional word around it ("126h", "1,204", "98%").
// Anything else ("4d 8h", "...", "-") is shown as it is.
function parse(text: string): Parts | null {
  const m = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(\D*)$/.exec(text);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const dot = m[2].indexOf('.');
  return { before: m[1], after: m[3], n, decimals: dot < 0 ? 0 : m[2].length - dot - 1, grouped: m[2].includes(',') };
}

function format(p: Parts, n: number): string {
  const fixed = n.toFixed(p.decimals);
  if (!p.grouped) return fixed;
  const [whole, rest] = fixed.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (rest ? `.${rest}` : '');
}

const ROLL_MS = 600;
const TICK_MS = 320;

/**
 * A big figure (Effects → Counting numbers): it rolls up from 0 the first
 * time it has a value, and when the value changes later, only the digits
 * that changed roll over. With the effect off it is plain text.
 */
export function FxNumber({ value }: { value: string | number }) {
  const text = typeof value === 'number' ? value.toLocaleString('en-US') : value;
  const plain = useRef<HTMLSpanElement>(null);
  const rolled = useRef(false);

  // A change: the digits that differ roll over, when the shape is the same.
  const [seen, setSeen] = useState(text);
  const [tick, setTick] = useState<{ from: string; to: string } | null>(null);
  if (seen !== text) {
    setSeen(text);
    setTick(seen.length === text.length && !!parse(seen) && !!parse(text) && fxOn('numbers') ? { from: seen, to: text } : null);
  }
  useEffect(() => {
    if (!tick) return;
    const done = window.setTimeout(() => setTick(null), TICK_MS);
    return () => window.clearTimeout(done);
  }, [tick]);

  // The first value: roll up from 0, written straight into the text so the
  // page isn't drawn again for every step.
  useEffect(() => {
    const now = parse(text);
    if (rolled.current || !now) return;
    rolled.current = true;
    const node = plain.current?.firstChild;
    if (!node || now.n <= 0 || !fxOn('numbers')) return;
    let frame = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.max(0, Math.min(1, (t - t0) / ROLL_MS));
      node.nodeValue = p >= 1 ? text : now.before + format(now, now.n * (1 - Math.pow(1 - p, 3))) + now.after;
      if (p < 1) frame = requestAnimationFrame(step);
    };
    node.nodeValue = now.before + format(now, 0) + now.after;
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); node.nodeValue = text; };
  }, [text]);

  if (tick && tick.to === text) {
    return (
      <span className="fx-num" aria-label={text}>
        {[...text].map((ch, i) => (
          tick.from[i] !== ch
            ? <span key={`${i}${ch}`} className="fx-digit" data-old={tick.from[i]} aria-hidden="true"><span>{ch}</span></span>
            : <span key={i} aria-hidden="true">{ch}</span>
        ))}
      </span>
    );
  }
  return <span ref={plain}>{text}</span>;
}

'use client';

// The pieces the public pages are built from in the v2 design: signing in,
// creating the account, an invite link and how it can end, removing your own
// account, the public stats page and Superadmin. Nobody is signed in on these,
// so there is no Classic choice: this is simply how they look. The pages keep
// their own data, handlers and errors.

import type { CSSProperties, ReactNode } from 'react';
import { motion } from 'framer-motion';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ClipboardIcon } from '@heroicons/react/24/outline';
import { SlickSyncLogo } from '@/components/ui/SlickSyncLogo';

/** The page: the app's background with the soft glow, the content centred in a narrow column (or a wide one). */
export function PubFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen relative overflow-x-hidden" style={{ background: 'var(--color-bg)' }}>
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="glow glow-corner-a" />
        <div className="glow glow-corner-b" />
      </div>
      <div className="relative mx-auto px-4 py-9 sm:py-16" style={{ maxWidth: wide ? 1212 : 492, width: '100%' }}>
        {children}
      </div>
    </div>
  );
}

/** The SlickSync mark, the name and one line saying what this page is for. */
export function PubLogo({ sub }: { sub: ReactNode }) {
  return (
    <div className="text-center mb-6">
      <motion.div
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.05 }}
        className="inline-flex w-14 h-14 rounded-2xl items-center justify-center"
        style={{ background: 'var(--color-primary)' }}
      >
        <SlickSyncLogo className="w-9 h-9" />
      </motion.div>
      <h1 className="text-[26px] font-bold font-display mt-2.5" style={{ color: 'var(--color-text)' }}>SlickSync</h1>
      <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>{sub}</p>
    </div>
  );
}

/** The card a page's form or choices sit in. */
export function PubCard({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div
      className={`pub-card ${className}`}
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', borderRadius: 22, padding: 22, ...style }}
    >
      {children}
    </div>
  );
}

/** Two plain choices side by side (I watch here / I run this). */
export function PubSeg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex p-1 rounded-xl mb-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)' }} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 py-2.5 px-3 rounded-lg font-medium text-sm transition-all ${value === o.value ? 'seg-on' : 'seg-off'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One way to sign in: a mark, its name, one line saying what it is for. */
export function PubTile({ name, line, color, onClick }: { name: string; line: string; color: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3.5 text-left rounded-2xl px-4 py-3.5 transition-colors hover:border-[color:var(--color-primary)]"
      style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
    >
      <span className="w-10 h-10 rounded-xl flex-none flex items-center justify-center text-white font-bold text-base" style={{ background: color }}>{name.slice(0, 1)}</span>
      <span className="flex-1 min-w-0">
        <span className="block font-semibold">{name}</span>
        <span className="block text-[12.5px]" style={{ color: 'var(--color-text-muted)' }}>{line}</span>
      </span>
      <ChevronRightIcon className="w-4 h-4 flex-none" style={{ color: 'var(--color-text-muted)' }} />
    </button>
  );
}

/** A full-width button: the one obvious action is `primary`, the rest are plain. */
export function PubButton({ children, primary = false, danger = false, icon, ...rest }: {
  children: ReactNode;
  primary?: boolean;
  danger?: boolean;
  icon?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const style: CSSProperties = primary
    ? { background: 'var(--color-primary-solid)', color: 'var(--color-on-primary-solid, #fff)', border: '1px solid transparent' }
    : danger
      ? { background: 'var(--color-error)', color: '#fff', border: '1px solid transparent' }
      : { background: 'transparent', color: 'var(--color-text)', border: '1px solid var(--color-surface-border)' };
  return (
    <button
      type="button"
      {...rest}
      className={`w-full py-3 px-4 rounded-xl font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-50 ${rest.className || ''}`}
      style={{ ...style, ...rest.style }}
    >
      {icon}
      {children}
    </button>
  );
}

/** A small text-only button (Back, New code). */
export function PubLink({ children, icon, ...rest }: { children: ReactNode; icon?: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 text-sm hover:underline disabled:opacity-50 ${rest.className || ''}`}
      style={{ color: 'var(--color-text-muted)', ...rest.style }}
    >
      {icon}
      {children}
    </button>
  );
}

/** "Back" at the top of a step that was opened from a list of choices. */
export function PubBack({ onClick, children = 'Back' }: { onClick: () => void; children?: ReactNode }) {
  return (
    <div className="mb-3">
      <PubLink onClick={onClick} icon={<ChevronLeftIcon className="w-4 h-4" />}>{children}</PubLink>
    </div>
  );
}

/** What the card is about to ask: a bold line and a quiet one under it. */
export function PubHeading({ title, line }: { title: ReactNode; line?: ReactNode }) {
  return (
    <div className="text-center mb-4">
      <h2 className="font-bold text-lg" style={{ color: 'var(--color-text)' }}>{title}</h2>
      {line && <p className="text-[13.5px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>{line}</p>}
    </div>
  );
}

/** The input look every public form shares. */
export const pubInputStyle: CSSProperties = {
  background: 'var(--color-bg)',
  border: '1px solid var(--color-surface-border)',
  color: 'var(--color-text)',
};

export function PubField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[13px] font-semibold mb-1.5" style={{ color: 'var(--color-text)' }}>{label}</label>
      {children}
    </div>
  );
}

/** "or" between a form and the other ways in. */
export function PubOr() {
  return (
    <div className="flex items-center gap-2.5 my-1" style={{ color: 'var(--color-text-muted)', fontSize: 12.5 }}>
      <span className="flex-1 h-px" style={{ background: 'var(--color-surface-border)' }} />
      or
      <span className="flex-1 h-px" style={{ background: 'var(--color-surface-border)' }} />
    </div>
  );
}

/** A problem, in words, in the page's error colour. */
export function PubError({ children }: { children: ReactNode }) {
  return <p className="text-sm text-center" role="alert" style={{ color: 'var(--color-error)' }}>{children}</p>;
}

/** "Waiting for you to approve it…" with a dot that breathes. */
export function PubWaiting({ children, tone = 'var(--color-warning, #f59e0b)' }: { children: ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
      <motion.span
        className="w-2 h-2 rounded-full"
        style={{ background: tone }}
        animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.25, 1] }}
        transition={{ duration: 1.2, repeat: Infinity }}
      />
      <span className="text-[13px]">{children}</span>
    </div>
  );
}

/** A code to type somewhere else, large, with a copy button. */
export function PubCode({ code, copied, onCopy }: { code: string; copied: boolean; onCopy: () => void }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={!code}
      aria-label="Copy the code"
      className="inline-flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all"
      style={{ background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)' }}
    >
      <span className="font-mono text-[22px] tracking-[0.2em]" style={{ color: 'var(--color-text)' }}>{code || '----'}</span>
      {copied
        ? <CheckIcon className="w-4 h-4" style={{ color: 'var(--color-success)' }} />
        : <ClipboardIcon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />}
    </button>
  );
}

/** The QR code for a link, on white so a phone can read it in any theme. */
export function PubQr({ data, alt }: { data: string; alt: string }) {
  return (
    <div className="mx-auto p-3 rounded-2xl inline-block" style={{ background: '#fff' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/qr?data=${encodeURIComponent(data)}`} alt={alt} width={150} height={150} />
    </div>
  );
}

export type PubTone = 'warn' | 'ok' | 'bad' | 'off';
const OUTCOME_DOT: Record<PubTone, string> = {
  warn: 'var(--color-warning, #f59e0b)',
  ok: 'var(--color-success, #22c55e)',
  bad: 'var(--color-error, #ef4444)',
  off: '#9ca3af',
};

/** How something ended: a coloured dot, a title, a line in plain words and, where it helps, one button. */
export function PubOutcome({ tone, title, children, action, pulse = false }: { tone: PubTone; title: ReactNode; children?: ReactNode; action?: ReactNode; pulse?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-3.5"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', borderRadius: 18, padding: 18 }}
    >
      {pulse ? (
        <motion.span
          className="w-3 h-3 rounded-full flex-none mt-[5px]"
          style={{ background: OUTCOME_DOT[tone] }}
          animate={{ opacity: [0.45, 1, 0.45], scale: [1, 1.2, 1] }}
          transition={{ duration: 1.2, repeat: Infinity }}
        />
      ) : (
        <span className="w-3 h-3 rounded-full flex-none mt-[5px]" style={{ background: OUTCOME_DOT[tone] }} />
      )}
      <div className="flex-1 min-w-0">
        <h2 className="font-bold text-[17px]" style={{ color: 'var(--color-text)' }}>{title}</h2>
        {children && <div className="text-[13.5px] mt-1" style={{ color: 'var(--color-text-muted)' }}>{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </motion.div>
  );
}

'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Toaster, toast as hotToast, resolveValue, type Toast as HotToast, type ToastOptions, type Renderable } from 'react-hot-toast';
import { XMarkIcon } from '@heroicons/react/24/outline';

// One look for every pop-up: an icon for what happened, a short bold line,
// an optional second line, buttons when there is something to do, and an X.
// Errors stay until closed; a pop-up with a button counts down with a thin
// bar so you can see how long you have.

export type ToastAction = {
  label: string;
  onClick: () => void;
};

type Kind = 'success' | 'error' | 'warning' | 'info' | 'loading' | 'blank';

export type SlickToastOptions = ToastOptions & {
  // The second, quieter line under the title.
  line?: ReactNode;
  // The first one is the main button.
  actions?: ToastAction[];
  // A poster takes the icon's place (removing a title, for example).
  poster?: string | null;
};

type Extra = { kind: Kind; line?: ReactNode; actions?: ToastAction[]; poster?: string | null };

// Kept beside react-hot-toast's own record, keyed by toast id.
const extras = new Map<string, Extra>();
let counter = 0;

type Message = Parameters<typeof hotToast>[0];

function show(kind: Kind, message: Message, opts: SlickToastOptions = {}) {
  const { line, actions, poster, ...rest } = opts;
  // The same error twice is one pop-up, not a stack of them.
  const id = rest.id ?? (kind === 'error' && typeof message === 'string' ? `err:${message}` : `ss-${++counter}`);
  extras.delete(id);
  extras.set(id, { kind, line, actions, poster });
  // Kept for the newest pop-ups only; an older one is long gone by then.
  // (Not cleared on unmount: React's development double-mount would wipe
  // a pop-up's buttons before it ever drew them.)
  while (extras.size > 60) extras.delete(extras.keys().next().value as string);
  const o = { ...rest, id };
  if (kind === 'success') return hotToast.success(message, o);
  if (kind === 'error') return hotToast.error(message, o);
  if (kind === 'loading') return hotToast.loading(message, o);
  return hotToast(message, o);
}

type Handler = (message: Message, opts?: SlickToastOptions) => string;

export const toast = Object.assign(((message: Message, opts?: SlickToastOptions) => show('blank', message, opts)) as Handler, {
  success: ((m, o) => show('success', m, o)) as Handler,
  error: ((m, o) => show('error', m, o)) as Handler,
  warning: ((m, o) => show('warning', m, o)) as Handler,
  info: ((m, o) => show('info', m, o)) as Handler,
  loading: ((m, o) => show('loading', m, o)) as Handler,
  custom: hotToast.custom,
  dismiss: hotToast.dismiss,
  dismissAll: hotToast.dismissAll,
  remove: hotToast.remove,
  removeAll: hotToast.removeAll,
  promise: hotToast.promise,
});

function kindOf(t: HotToast): Kind {
  const e = extras.get(t.id);
  if (e && (e.kind === 'warning' || e.kind === 'info')) return e.kind;
  return t.type === 'custom' ? 'blank' : (t.type as Kind);
}

const DOT: Record<string, string> = {
  success: 'var(--color-success, #22c55e)',
  error: 'var(--color-error, #ef4444)',
  warning: 'var(--color-warning, #f59e0b)',
  info: 'var(--color-primary)',
};

function Icon({ kind }: { kind: Kind }) {
  if (kind === 'loading') return <span className="ss-toast-spin" aria-hidden />;
  const fill = DOT[kind];
  if (!fill) return null;
  const mark = kind === 'success'
    ? <path d="m8 12.5 2.6 2.6L16 9.5" stroke="var(--color-surface)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    : kind === 'info'
      ? <path d="M12 11v6M12 7.5v.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      : <path d="M12 7v6M12 16.5v.5" stroke={kind === 'warning' ? '#0b0f17' : '#fff'} strokeWidth="2.2" strokeLinecap="round" />;
  return (
    <svg viewBox="0 0 24 24" className="ss-toast-icon" aria-hidden>
      <circle cx="12" cy="12" r="10" fill={fill} />
      {mark}
    </svg>
  );
}

function ToastCard({ t }: { t: HotToast }) {
  const e = extras.get(t.id);
  const kind = kindOf(t);
  const body = resolveValue(t.message, t) as Renderable;
  const lead = e?.poster
    ? <img src={e.poster} alt="" className="ss-toast-poster" />
    : t.icon ? <span className="ss-toast-icon">{t.icon}</span> : <Icon kind={kind} />;
  const actions = e?.actions ?? [];
  const timed = actions.length > 0 && Number.isFinite(t.duration) && (t.duration ?? 0) > 0;
  return (
    <div className={`ss-toast${t.visible ? ' ss-toast-in' : ' ss-toast-out'}`} {...t.ariaProps}>
      {lead}
      <div className="ss-toast-text">
        <div className="ss-toast-title">{body}</div>
        {e?.line ? <div className="ss-toast-line">{e.line}</div> : null}
        {actions.length > 0 && (
          <div className="ss-toast-actions">
            {actions.map((a, i) => (
              <button
                key={a.label}
                type="button"
                className={i === 0 ? 'ss-toast-btn ss-toast-btn-main' : 'ss-toast-btn'}
                onClick={() => {
                  hotToast.dismiss(t.id);
                  a.onClick();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {kind !== 'loading' && (
        <button type="button" className="ss-toast-x" aria-label="Close" onClick={() => hotToast.dismiss(t.id)}>
          <XMarkIcon className="w-4 h-4" />
        </button>
      )}
      {timed && <div className="ss-toast-bar" style={{ animationDuration: `${t.duration}ms` }} />}
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  // Portaled to <body>. react-hot-toast renders in place rather than
  // portaling, and this provider lives inside layout.tsx's
  // `<div className="relative z-10">` - which is its own stacking context.
  // Modals portal to body at z-50, so anything trapped inside that z-10
  // context loses to them no matter how high its own z-index is: an error
  // toast raised from inside a modal appeared BEHIND the modal, dimmed and
  // blurred by its backdrop, and could only be read by closing the modal
  // first. Portaling puts the toasts in the same stacking context as the
  // modals so the z-index below actually decides the order.
  // false during SSR, true once hydrated - the sanctioned way to express
  // that without writing state from inside an effect.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  const toaster = (
    <Toaster
      position="bottom-right"
      containerClassName="ss-toaster"
      // Above modals (z-50) and their backdrops. An error you cannot read
      // is not an error message.
      containerStyle={{ zIndex: 9999 }}
      toastOptions={{
        duration: 5000,
        // Errors stay until closed.
        error: { duration: Infinity },
      }}
    >
      {(t) => (t.type === 'custom' ? <>{resolveValue(t.message, t)}</> : <ToastCard t={t} />)}
    </Toaster>
  );

  return (
    <>
      {children}
      {/* Only after mount - document.body does not exist during SSR. */}
      {mounted && createPortal(toaster, document.body)}
    </>
  );
}

// Helper functions for consistent toast styling
export const showToast = {
  success: (message: string, opts?: SlickToastOptions) => toast.success(message, opts),
  error: (message: string, opts?: SlickToastOptions) => toast.error(message, opts),
  info: (message: string, opts?: SlickToastOptions) => toast.info(message, opts),
  warning: (message: string, opts?: SlickToastOptions) => toast.warning(message, opts),
  loading: (message: string) => toast.loading(message),
  dismiss: (id?: string) => hotToast.dismiss(id),
  promise: <T,>(
    promise: Promise<T>,
    msgs: { loading: string; success: string; error: string }
  ) => hotToast.promise(promise, msgs),
};

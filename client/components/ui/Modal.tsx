'use client';

import { Fragment, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { XMarkIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { useCoarsePointer } from '@/lib/hooks/useCoarsePointer';
import { cachedImageUrl } from '@/lib/posterUrl';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  /** Name for screen readers when the modal has no visible title. */
  ariaLabel?: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  children: React.ReactNode;
  /** Suppress the built-in overlaid close button - for content (e.g. an
   * embedded video player) that has its own top-right controls the button
   * would otherwise sit on top of. The caller is responsible for providing
   * another way to close (backdrop click and Escape still work). */
  hideCloseButton?: boolean;
  /** Optional ambient art behind the whole panel (e.g. a title's backdrop),
   * not just a header strip - a large, blurred, dimmed version fading into
   * the panel's normal surface color. Unmounts with the rest of the modal
   * on close, nothing extra needed there. Omit for the plain solid panel.
   * Caller should omit this while playing a trailer/video in the same
   * modal - blurring a large layer is real rasterization cost, and doing
   * it at the same moment a video is trying to start competes for the
   * same paint/compositing budget (confirmed real perceived slowdown). */
  backdropImage?: string;
  /** Render without the dialog library's page-wide hooks. The library marks
   * the whole page inert on open and again on close, and flips the page's
   * scroll container on and off - each a full style and layout pass over
   * every element on the page, then a repaint, which on a phone is most of
   * what a close costs on a long page. This shell keeps the behaviour that
   * matters (backdrop tap and Escape close it, focus stays inside and is
   * handed back on close, screen readers see a modal dialog) and never
   * touches the page: scrolling is contained by the panel's own scroll
   * behaviour and by the overlay swallowing touches and wheel. No enter or
   * exit motion either way - the library shell had none in practice. */
  lightweight?: boolean;
}

const sizeStyles = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  full: 'max-w-4xl',
};

const sizeMaxWidthPx = {
  sm: '384px',
  md: '448px',
  lg: '512px',
  xl: '576px',
  full: '896px',
};

export function Modal({ isOpen, onClose, title, ariaLabel, description, size = 'md', children, hideCloseButton = false, backdropImage, lightweight = false }: ModalProps) {
  // On a phone or tablet the close is a plain fade. The default close also
  // shrinks and slides the panel, and a transform on a panel whose backdrop
  // art is a large blurred image makes WebKit re-rasterize that image on
  // every frame of the exit; a fade alone composites for free. The open
  // keeps its motion - the content has to be painted then regardless.
  const coarse = useCoarsePointer();
  // The library's own title element inside its shell; a plain heading in
  // the lightweight one, wired to the dialog by id for screen readers.
  const TitleTag: React.ElementType = lightweight ? 'h2' : DialogTitle;
  // A generated id per modal: two open at once must not share one.
  const generatedTitleId = useId();
  const titleId = lightweight ? generatedTitleId : undefined;
  const panelBody = (
    <>
      {!title && !lightweight && <DialogTitle className="sr-only">{ariaLabel || 'Details'}</DialogTitle>}
      {/* Ambient backdrop art - z-0, sits behind the header/content
          below (both explicitly z-10) rather than relying on default
          paint order, which would otherwise put this absolutely-
          positioned layer above their static-flow content. Sized to
          the panel itself (capped at max-h-[85dvh] above), not the
          scrollable content, so the fade-to-solid point stays fixed
          regardless of how long the content is. */}
      {backdropImage && (
        <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none" aria-hidden="true">
          {/* Phones and tablets get the 64px copy of the art from the
              poster cache, stretched to fill: an image scaled up that
              far is a blur already, with no filter for the GPU to
              recompute whenever the panel repaints. The dimming is an
              opacity over the panel's own surface, which composites
              for free as well. Desktops keep the real blur. */}
          {coarse ? (
            <img
              src={cachedImageUrl(backdropImage, 64) || backdropImage}
              alt=""
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover scale-110"
              style={{ opacity: 0.45 }}
            />
          ) : (
            <img
              src={backdropImage}
              alt=""
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover scale-110"
              style={{ filter: 'blur(20px) brightness(0.55)' }}
            />
          )}
          <div
            className="absolute inset-0"
            style={{ background: 'linear-gradient(180deg, transparent 0%, var(--color-surface) 65%)' }}
          />
        </div>
      )}

      {/* Close button - unconditional (not tied to title/description) and
          positioned on the panel itself, not inside the scrollable content,
          so it stays put regardless of what's rendered below (a custom
          hero-image header, a title, or nothing) and regardless of scroll.
          Skipped entirely when hideCloseButton is set. */}
      {!hideCloseButton && (
      <button
        onClick={onClose}
        className="modal-close-btn absolute top-3 right-3 z-20 p-2 rounded-lg transition-colors"
        aria-label="Close"
      >
        <XMarkIcon className="w-5 h-5" />
      </button>
      )}

      {/* Header */}
      {(title || description) && (
        <div
          className="relative z-10 px-6 pt-6 pb-4 pr-14 shrink-0"
          style={{ borderBottom: '1px solid var(--color-surface-border)' }}
        >
          {title && (
            <TitleTag
              id={titleId}
              className="text-xl font-semibold font-display"
              style={{ color: 'var(--color-text)' }}
            >
              {title}
            </TitleTag>
          )}
          {description && (
            <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {description}
            </p>
          )}
        </div>
      )}

      {/* Content */}
      <div className="relative z-10 p-6 overflow-y-auto">
        {children}
      </div>
    </>
  );

  if (lightweight) {
    return (
      <LightShell isOpen={isOpen} onClose={onClose} size={size} titleId={title ? titleId : undefined} ariaLabel={ariaLabel}>
        {panelBody}
      </LightShell>
    );
  }
  // The close fade is unconditional again. A previous diagnostic skipped
  // the leave transition on mobile while chasing a reported "closing any
  // modal freezes the page" bug - that investigation concluded the freeze
  // was specific to the reporter's Safari app itself (the same build is
  // smooth in another WebKit browser on the same phone), not to anything
  // this component does, so the instant-close degradation had no earned
  // benefit and is reverted.
  return (
    <Transition show={isOpen} as={Fragment}>
      <Dialog onClose={onClose} className="relative z-50">
        {/* Backdrop */}
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div
            // backdrop-filter blur across the full viewport is GPU-heavy and,
            // recomputed every frame of the panel's enter/exit transition, is
            // a common cause of visibly janky modal opens on phones - the
            // rgba dimming alone is enough to read as an overlay, so the
            // blur itself only kicks in at sm: and up, where the extra
            // compositing budget is less likely to be felt.
            className="fixed inset-0 sm:backdrop-blur-sm"
            style={{ background: 'rgba(0, 0, 0, 0.7)' }}
          />
        </TransitionChild>

        {/* Modal container */}
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <TransitionChild
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="opacity-0 scale-95 translate-y-4"
            enterTo="opacity-100 scale-100 translate-y-0"
            leave="ease-in duration-150"
            leaveFrom={coarse ? 'opacity-100' : 'opacity-100 scale-100 translate-y-0'}
            leaveTo={coarse ? 'opacity-0' : 'opacity-0 scale-95 translate-y-4'}
          >
            <DialogPanel
              className={clsx(
                'relative w-full flex flex-col max-h-[85dvh]',
                sizeStyles[size],
                'popup-panel rounded-2xl p-0 overflow-hidden'
              )}
              style={{ maxWidth: sizeMaxWidthPx[size] }}
            >
              {panelBody}
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}

// The shell behind `lightweight` - see that prop's comment on Modal.
function LightShell({ isOpen, onClose, size, titleId, ariaLabel, children }: {
  isOpen: boolean;
  onClose: () => void;
  size: NonNullable<ModalProps['size']>;
  titleId?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<Element | null>(null);
  // The latest onClose, read from the key handler, so a parent that passes a
  // new function every render does not tear down and re-focus the dialog.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    restoreFocusTo.current = document.activeElement;
    const panel = panelRef.current;
    // Focus the panel itself so Escape and Tab land inside it.
    panel?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !panel) return;
      // Keep Tab inside the panel.
      // Only what can actually take focus: not hidden, not collapsed.
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
      if (focusable.length === 0) { e.preventDefault(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const el = restoreFocusTo.current as HTMLElement | null;
      if (el && typeof el.focus === 'function' && el.isConnected) el.focus({ preventScroll: true });
    };
  }, [isOpen]);

  if (!isOpen || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* Overlay: closes on tap, and swallows touch and wheel so the page
          underneath never scrolls - without ever changing the page. */}
      <div
        className="fixed inset-0"
        style={{ background: 'rgba(0, 0, 0, 0.7)', touchAction: 'none' }}
        onClick={onClose}
        onWheel={(e) => e.preventDefault()}
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-label={titleId ? undefined : (ariaLabel || 'Details')}
          tabIndex={-1}
          className={clsx(
            'relative w-full flex flex-col max-h-[85dvh] pointer-events-auto outline-none',
            sizeStyles[size],
            'popup-panel rounded-2xl p-0 overflow-hidden overscroll-contain'
          )}
          style={{ maxWidth: sizeMaxWidthPx[size] }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

// Confirmation modal
interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'default';
  isLoading?: boolean;
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default',
  isLoading,
}: ConfirmModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <p className="mb-6" style={{ color: 'var(--color-text-muted)' }}>{description}</p>
      <div className="flex gap-3 justify-end">
        <button
          onClick={onClose}
          disabled={isLoading}
          className="px-6 py-3 rounded-xl font-medium transition-all duration-300"
          style={{
            background: 'var(--color-surface-hover)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-surface-border)'
          }}
        >
          {cancelText}
        </button>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onConfirm}
          disabled={isLoading}
          className="px-6 py-3 rounded-xl font-medium transition-all duration-300"
          style={{
            background: variant === 'danger' 
              ? 'var(--color-error)'
              : variant === 'warning'
              ? 'var(--color-warning)'
              : 'var(--color-primary-solid)',
            color: 'white'
          }}
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <motion.span
                className="w-4 h-4 border-2 border-current border-t-transparent rounded-full"
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
              />
              Processing...
            </span>
          ) : confirmText}
        </motion.button>
      </div>
    </Modal>
  );
}

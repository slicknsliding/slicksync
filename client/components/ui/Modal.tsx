'use client';

import { Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { XMarkIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
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

export function Modal({ isOpen, onClose, title, description, size = 'md', children, hideCloseButton = false, backdropImage }: ModalProps) {
  // Diagnostic/fix for a reported freeze closing any modal on mobile Safari
  // specifically (confirmed NOT present on PC, and a Chromium long-task
  // profile of the same open/close cycle came back completely clean - so
  // whatever's costing time isn't generic heavy JS, it's something WebKit/
  // mobile-Safari-specific neither desktop nor Chromium can reproduce).
  // Skipping the leave transition entirely on mobile removes one whole
  // category of suspect (blur/opacity/scale compositing during the close
  // animation) at the cost of an instant close instead of a fade - if this
  // fixes it, that's confirmation; if the freeze persists even with no
  // animation, that rules animation out and points elsewhere (unmount cost,
  // focus/inert handling, viewport resize).
  const isMobile = useIsMobile();
  return (
    <Transition show={isOpen} as={Fragment}>
      <Dialog onClose={onClose} className="relative z-50">
        {/* Backdrop */}
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave={isMobile ? '' : 'ease-in duration-150'}
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
            leave={isMobile ? '' : 'ease-in duration-150'}
            leaveFrom="opacity-100 scale-100 translate-y-0"
            leaveTo="opacity-0 scale-95 translate-y-4"
          >
            <DialogPanel
              className={clsx(
                'relative w-full flex flex-col max-h-[85vh]',
                sizeStyles[size],
                'rounded-2xl p-0 overflow-hidden'
              )}
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-surface-border)',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                maxWidth: sizeMaxWidthPx[size],
              }}
            >
              {/* Ambient backdrop art - z-0, sits behind the header/content
                  below (both explicitly z-10) rather than relying on default
                  paint order, which would otherwise put this absolutely-
                  positioned layer above their static-flow content. Sized to
                  the panel itself (capped at max-h-[85vh] above), not the
                  scrollable content, so the fade-to-solid point stays fixed
                  regardless of how long the content is. */}
              {backdropImage && (
                <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none" aria-hidden="true">
                  <img
                    src={backdropImage}
                    alt=""
                    decoding="async"
                    className="absolute inset-0 w-full h-full object-cover scale-110"
                    style={{ filter: 'blur(20px) brightness(0.55)' }}
                  />
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
                className="absolute top-3 right-3 z-20 p-2 rounded-lg backdrop-blur-sm transition-colors"
                style={{ color: 'var(--color-text-muted)', background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)' }}
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
                    <DialogTitle
                      className="text-xl font-semibold font-display"
                      style={{ color: 'var(--color-text)' }}
                    >
                      {title}
                    </DialogTitle>
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
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
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
              : 'var(--color-primary)',
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

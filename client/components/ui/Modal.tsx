'use client';

import { Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { XMarkIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';

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

export function Modal({ isOpen, onClose, title, description, size = 'md', children, hideCloseButton = false }: ModalProps) {
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
              {/* Close button - unconditional (not tied to title/description) and
                  positioned on the panel itself, not inside the scrollable content,
                  so it stays put regardless of what's rendered below (a custom
                  hero-image header, a title, or nothing) and regardless of scroll.
                  Skipped entirely when hideCloseButton is set. */}
              {!hideCloseButton && (
              <button
                onClick={onClose}
                className="absolute top-3 right-3 z-10 p-2 rounded-lg backdrop-blur-sm transition-colors"
                style={{ color: 'var(--color-textMuted)', background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)' }}
                aria-label="Close"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
              )}

              {/* Header */}
              {(title || description) && (
                <div
                  className="px-6 pt-6 pb-4 pr-14 shrink-0"
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
                    <p className="mt-1 text-sm" style={{ color: 'var(--color-textMuted)' }}>
                      {description}
                    </p>
                  )}
                </div>
              )}

              {/* Content */}
              <div className="p-6 overflow-y-auto">
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
      <p className="mb-6" style={{ color: 'var(--color-textMuted)' }}>{description}</p>
      <div className="flex gap-3 justify-end">
        <button
          onClick={onClose}
          disabled={isLoading}
          className="px-6 py-3 rounded-xl font-medium transition-all duration-300"
          style={{
            background: 'var(--color-surfaceHover)',
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

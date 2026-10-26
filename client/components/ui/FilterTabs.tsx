'use client';

import { useState, useRef, useLayoutEffect, useEffect, useId, type KeyboardEvent } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useDroppable } from '@dnd-kit/core';
import {
  ChevronDownIcon,
  CheckIcon
} from '@heroicons/react/24/outline';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { ScrollRow } from './ScrollRow';

// One tab stop per group (the selected tab); arrows, Home and End move
// between tabs, and landing on one selects it. Focus scrolls the tab into view.
function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
  if (!tabs.length) return;
  const current = tabs.indexOf(event.currentTarget);
  const direction = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
  const step = event.key === 'ArrowRight' ? direction : -direction;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + step + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}

// Wraps a tab button to make it a dnd-kit drop target when enabled — kept as
// its own component since useDroppable is a hook and can't be called
// conditionally inside the options.map() loop.
function DroppableTabButton({ id, enabled, isOver: isOverOverride, children }: { id: string; enabled: boolean; isOver?: boolean; children: (isOver: boolean) => React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !enabled });
  // A tab may grow into spare room, but only to 150px: on a wide screen the
  // rest becomes even space between tabs rather than long, mostly empty
  // buttons. min-w-max keeps a longer name (Vault's "Metadata & Trackers")
  // whole - an explicit min-width wins over max-width. Inline, as this
  // project's max-w-* classes don't apply (see commit 423221d).
  return <div ref={enabled ? setNodeRef : undefined} className="grow shrink-0 min-w-max" style={{ maxWidth: 150 }}>{children(enabled ? isOver : false)}</div>;
}

export interface FilterTabOption {
  key: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  badge?: {
    value: number | string;
    variant?: 'default' | 'error' | 'warning' | 'success';
  };
}

export interface FilterTabsProps {
  /** Stretch the box across the space it's given, the tabs sharing the
   *  spare width. Off: the box is as wide as its tabs. Either way a row
   *  that doesn't fit scrolls sideways instead of cutting names short. */
  fill?: boolean;
  options: FilterTabOption[];
  activeKey: string;
  onChange: (key: string) => void;
  size?: 'sm' | 'md';
  className?: string;
  /** Unique ID for the sliding indicator animation (use different IDs if multiple FilterTabs on same page) */
  layoutId?: string;
  /** When true, each tab becomes a dnd-kit droppable zone with id `${dropTargetPrefix}${key}` — must be rendered inside a DndContext */
  enableDropTargets?: boolean;
  /** Prefix for the droppable id, so pages sharing one DndContext can tell
   *  each other's category-tab drops apart (e.g. 'vault-category-' vs
   *  'addon-tag-'). Defaults to 'vault-category-' for backward compat with
   *  the original (only) consumer. */
  dropTargetPrefix?: string;
}

/**
 * FilterTabs - A modern tab selector with Framer Motion sliding indicator
 * 
 * Features:
 * - Animated sliding background indicator
 * - Support for icons, counts, and badges
 * - Two sizes: sm (compact) and md (default)
 * - Accessible with ARIA attributes
 */
export function FilterTabs({
  fill = false,
  options,
  activeKey,
  onChange,
  size = 'sm',
  className = '',
  layoutId,
  enableDropTargets = false,
  dropTargetPrefix = 'vault-category-',
}: FilterTabsProps) {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number } | null>(null);
  const generatedId = useId();
  const uniqueLayoutId = layoutId || `filter-tabs-${generatedId}`;

  // Function to calculate and update indicator position
  const updateIndicatorPosition = () => {
    if (!containerRef.current) return;

    // Matched on the attribute value (a key with a quote in it would break
    // a selector) and measured in layout pixels: offsetLeft/offsetWidth
    // ignore the transform of a dialog that is mid-scale on open, where
    // getBoundingClientRect reads the shrunken box and parks the indicator
    // off the tab. A transform does not trigger the ResizeObserver either.
    const activeButton = Array.from(containerRef.current.querySelectorAll<HTMLButtonElement>('[data-tab-key]'))
      .find((button) => button.dataset.tabKey === activeKey);

    if (activeButton) {
      const next = { left: activeButton.offsetLeft, width: activeButton.offsetWidth };
      setIndicatorStyle((previous) => (previous?.left === next.left && previous.width === next.width ? previous : next));
    }
  };

  // Calculate indicator position based on active tab - use layoutEffect to avoid flash
  useLayoutEffect(() => {
    updateIndicatorPosition();
  }, [activeKey, options]);

  // Use ResizeObserver to recalculate when button sizes change (e.g., after icons load)
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      updateIndicatorPosition();
    });

    // Observe all tab buttons for size changes
    const buttons = containerRef.current.querySelectorAll('[data-tab-key]');
    buttons.forEach((button) => resizeObserver.observe(button));
    resizeObserver.observe(containerRef.current);

    return () => resizeObserver.disconnect();
  }, [activeKey, options]);

  // Size variants
  const sizeClasses = {
    sm: {
      container: 'gap-1 p-1',
      gap: 'gap-1',
      pad: 'p-1',
      button: 'px-4 py-1.5 text-sm',
      icon: 'w-4 h-4',
      badge: 'w-5 h-5 text-xs',
    },
    md: {
      container: 'gap-2 p-1.5',
      gap: 'gap-2',
      pad: 'p-1.5',
      button: 'px-5 py-2 text-sm',
      icon: 'w-5 h-5',
      badge: 'w-6 h-6 text-xs',
    },
  };

  const styles = sizeClasses[size];
  const isTV = useIsTV();

  return (
    // The box fills the space it's given. Every tab shows its full name and
    // the tabs share any spare width; when they don't all fit, the row
    // scrolls sideways (drag, swipe, wheel, or the small edge arrows).
    <ScrollRow
      arrows
      wrapperClassName={`rounded-xl bg-surface border border-default ${fill ? 'w-full' : 'w-auto max-w-full'} ${className}`}
      className={styles.pad}
      role="tablist"
      aria-label="Filter options"
    >
    <div ref={containerRef} className={`relative flex justify-evenly ${styles.gap} w-max min-w-full`}>
      {/* Animated sliding indicator - only render when position is calculated */}
      {indicatorStyle && (
        <motion.div
          layoutId={uniqueLayoutId}
          className="absolute top-1 bottom-1 rounded-lg bg-primary-muted"
          initial={false}
          animate={{
            left: indicatorStyle.left,
            width: indicatorStyle.width,
          }}
          transition={{
            duration: reduceMotion ? 0 : undefined,
            type: reduceMotion ? 'tween' : 'spring',
            stiffness: 500,
            damping: 35,
            mass: 1,
          }}
          style={{
            zIndex: 0,
          }}
        />
      )}

      {/* Tab buttons */}
      {options.map((option) => {
        const isActive = activeKey === option.key;
        
        return (
          <DroppableTabButton key={option.key} id={`${dropTargetPrefix}${option.key}`} enabled={enableDropTargets}>
            {(isOver) => {
              const btn = (
              <button
                data-tab-key={option.key}
                onClick={() => onChange(option.key)}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive || (option.key === options[0]?.key && !options.some((o) => o.key === activeKey)) ? 0 : -1}
                onKeyDown={moveTabFocus}
                className={`
                  relative z-10 flex items-center justify-center gap-2 w-full whitespace-nowrap ${styles.button} rounded-lg font-medium
                  transition-colors duration-150 ease-out
                  ${isActive
                    ? 'text-primary'
                    : 'text-muted nav-item-hover-pill'
                  }
                  ${isOver ? 'tab-drop-over' : ''}
                `}
              >
              {/* Icon */}
              {option.icon && (
                <span className={`${styles.icon} shrink-0`}>
                  {option.icon}
                </span>
              )}

              {/* Label - always the full name; the row scrolls instead. */}
              <span>{option.label}</span>

              {/* Count (inline, muted) */}
              {option.count !== undefined && (
                <span className={`shrink-0 text-xs tabular-nums ${isActive ? 'text-primary/60' : 'text-subtle'}`}>
                  ({option.count})
                </span>
              )}

              {/* Badge (notification style, positioned) */}
              {option.badge && (
                <span
                  className={`
                    absolute -top-1 -right-1 ${styles.badge} rounded-full
                    flex items-center justify-center font-bold
                    ${option.badge.variant === 'error'
                      ? 'bg-error text-white'
                      : option.badge.variant === 'warning'
                        ? 'bg-warning text-white'
                        : option.badge.variant === 'success'
                          ? 'bg-success text-white'
                          : 'bg-primary-solid text-white'
                    }
                  `}
                  aria-label={`${option.badge.value} ${option.label}`}
                >
                  {option.badge.value}
                </span>
              )}
              </button>
              );
              return isTV ? <TVFocusable onEnterPress={() => onChange(option.key)}>{btn}</TVFocusable> : btn;
            }}
          </DroppableTabButton>
        );
      })}
    </div>
    </ScrollRow>
  );
}

/**
 * FilterTabsSimple - A simpler version without the sliding indicator
 * Useful when you need multiple tab sets that shouldn't share animation context
 */
export function FilterTabsSimple({
  options,
  activeKey,
  onChange,
  size = 'sm',
  className = '',
}: Omit<FilterTabsProps, 'layoutId'>) {
  const sizeClasses = {
    sm: {
      container: 'gap-1 p-1',
      button: 'px-4 py-1.5 text-sm',
    },
    md: {
      container: 'gap-2 p-1.5',
      button: 'px-5 py-2 text-sm',
    },
  };

  const styles = sizeClasses[size];

  return (
    <div
      className={`flex flex-wrap ${styles.container} rounded-xl bg-surface border border-default ${className}`}
      role="tablist"
      aria-label="Filter options"
    >
      {options.map((option) => {
        const isActive = activeKey === option.key;
        
        return (
          <button
            key={option.key}
            onClick={() => onChange(option.key)}
            role="tab"
            tabIndex={isActive || (option.key === options[0]?.key && !options.some((o) => o.key === activeKey)) ? 0 : -1}
            onKeyDown={moveTabFocus}
            aria-selected={isActive}
            className={`
              ${styles.button} rounded-lg font-medium transition-all duration-150
              ${isActive 
                ? 'bg-primary-muted text-primary' 
                : 'text-muted hover:text-default'
              }
            `}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={`ml-1.5 text-xs ${isActive ? 'text-primary/60' : 'text-subtle'}`}>
                ({option.count})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * FilterTabsResponsive - Shows dropdown on mobile, tabs on desktop
 * Perfect for pages with many filter options that don't fit on mobile
 */
export function FilterTabsResponsive({
  fill = false,
  options,
  activeKey,
  onChange,
  size = 'sm',
  className = '',
  layoutId,
  enableDropTargets = false,
  dropTargetPrefix,
}: FilterTabsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeOption = options.find(opt => opt.key === activeKey);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      const originalStyle = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalStyle;
      };
    }
  }, [isOpen]);

  const sizeClasses = {
    sm: {
      trigger: 'px-3 py-2 text-sm',
      option: 'px-3 py-2.5 text-sm',
      icon: 'w-4 h-4',
    },
    md: {
      trigger: 'px-4 py-2.5 text-sm',
      option: 'px-4 py-3 text-sm',
      icon: 'w-5 h-5',
    },
  };

  const styles = sizeClasses[size];

  // Full-width tabs slide sideways at every width, phones included, so they
  // need no drop-down.
  if (fill) {
    return (
      <FilterTabs
        fill
        options={options}
        activeKey={activeKey}
        onChange={onChange}
        size={size}
        className={className}
        layoutId={layoutId}
        enableDropTargets={enableDropTargets}
        dropTargetPrefix={dropTargetPrefix}
      />
    );
  }

  // More than five tabs: the drop-down until a laptop's width, not a tablet's.
  const many = options.length > 5;

  return (
    <div ref={dropdownRef} className={`relative ${many ? 'lg:w-auto' : 'md:w-auto'} ${className}`}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`
          ${many ? 'lg:hidden' : 'md:hidden'} w-full h-9 flex items-center justify-between
          ${styles.trigger} rounded-lg font-medium
          bg-surface border border-default
          text-default transition-colors duration-150
          hover:bg-surface-hover
        `}
        style={{ minHeight: '36px' }}
        aria-label="Select filter"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="flex items-center gap-1.5 truncate">
          {activeOption?.icon && (
            <span className={`${styles.icon} shrink-0 text-primary`}>
              {activeOption.icon}
            </span>
          )}
          <span className="truncate">{activeOption?.label || 'Select'}</span>
          {activeOption?.count !== undefined && (
            <span className="text-xs text-muted">({activeOption.count})</span>
          )}
        </span>
        <ChevronDownIcon className={`w-4 h-4 text-muted shrink-0 ml-1 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop - fixed on mobile to cover entire screen */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={`fixed inset-0 bg-black/60 z-40 ${many ? 'lg:hidden' : 'md:hidden'}`}
              onClick={() => setIsOpen(false)}
            />
            
            {/* Dropdown panel - fixed on mobile to escape overflow containers */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className={`fixed left-4 right-4 top-1/2 -translate-y-1/2 z-50 ${many ? 'lg:hidden' : 'md:hidden'}`}
            >
              <div className="popup-panel rounded-xl overflow-hidden max-h-[70dvh] overflow-y-auto">
                {options.map((option) => {
                  const isActive = activeKey === option.key;
                  
                  return (
                    <button
                      key={option.key}
                      onClick={() => {
                        onChange(option.key);
                        setIsOpen(false);
                      }}
                      role="option"
                      aria-selected={isActive}
                      className={`
                        w-full flex items-center justify-between gap-3
                        ${styles.option} font-medium
                        transition-colors duration-150
                        ${isActive 
                          ? 'bg-primary-muted text-primary' 
                          : 'text-default hover:bg-surface-hover'
                        }
                      `}
                    >
                      <span className="flex items-center gap-2">
                        {option.icon && (
                          <span className={`${styles.icon} shrink-0 ${isActive ? 'text-primary' : 'text-muted'}`}>
                            {option.icon}
                          </span>
                        )}
                        <span>{option.label}</span>
                        {option.count !== undefined && (
                          <span className={`text-xs ${isActive ? 'text-primary/60' : 'text-muted'}`}>
                            ({option.count})
                          </span>
                        )}
                      </span>
                      {isActive && (
                        <CheckIcon className="w-4 h-4 text-primary shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className={many ? 'hidden lg:block' : 'hidden md:block'}>
        <FilterTabs
          fill={fill}
          options={options}
          activeKey={activeKey}
          onChange={onChange}
          size={size}
          layoutId={layoutId}
          enableDropTargets={enableDropTargets}
          dropTargetPrefix={dropTargetPrefix}
        />
      </div>
    </div>
  );
}

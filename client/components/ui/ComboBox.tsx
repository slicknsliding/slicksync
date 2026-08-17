'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';

export interface ComboBoxOption {
  value: string;
  label: string;
}

interface ComboBoxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboBoxOption[];
  placeholder?: string;
  className?: string;
}

// A text input that's still freely typable (a fixed list would go stale the
// moment a provider ships a new model, or someone points at a custom
// endpoint) but LOOKS like it has a dropdown - a plain <input list="...">
// bound to a <datalist> technically works, but gives no visible sign a list
// exists until you start typing, and rendering varies enough across
// browsers that it often just looks like a bare text field. This adds the
// same explicit chevron + click-to-open panel every <select> in this app
// already uses (see FilterTabs.tsx), so "there's a dropdown here" is obvious
// on sight, while still accepting arbitrary text typed directly.
export function ComboBox({ value, onChange, options, placeholder, className }: ComboBoxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={containerRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setIsOpen(true)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={`${className || 'input-base w-full px-3 py-2 text-sm'} pr-9`}
      />
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="absolute right-0 top-0 h-full px-2.5 flex items-center"
        tabIndex={-1}
        aria-label="Show options"
      >
        <ChevronDownIcon className={`w-4 h-4 text-subtle transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && options.length > 0 && (
        <div
          className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg shadow-lg py-1"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setIsOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-hover transition-colors truncate"
              style={{ color: 'var(--color-text)' }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

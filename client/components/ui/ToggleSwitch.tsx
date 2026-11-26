'use client';

import { motion } from 'framer-motion';
import { fxOn } from '@/lib/effects';

interface ToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  size?: 'sm' | 'md';
  title?: string;
  disabled?: boolean;
  className?: string;
}

export function ToggleSwitch({
  checked,
  onChange,
  size = 'md',
  title,
  disabled = false,
  className = ''
}: ToggleSwitchProps) {
  const trackBase = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11';
  const knobBase = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const knobTranslate = size === 'sm' 
    ? (checked ? 'translate-x-4' : 'translate-x-0.5') 
    : (checked ? 'translate-x-5' : 'translate-x-1');

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange();
      }}
      disabled={disabled}
      className={`relative inline-flex items-center rounded-full transition-colors ${trackBase} disabled:opacity-50 ${checked ? 'tgl-on' : 'tgl-off'} ${className}`}
      aria-pressed={checked}
      data-fx-tgl=""
      title={title}
      type="button"
    >
      <motion.span
        className={`inline-block rounded-full ${knobBase} ${checked ? 'tgl-knob-on' : 'tgl-knob-off'}`}
        animate={{
          x: checked ? (size === 'sm' ? 16 : 20) : (size === 'sm' ? 2 : 4)
        }}
        // Effects → On/off switches: a looser spring, so the knob runs a little past and comes back.
        transition={fxOn('toggles') ? { type: 'spring', stiffness: 520, damping: 17 } : { type: 'spring', stiffness: 500, damping: 30 }}
      />
    </button>
  );
}

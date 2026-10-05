'use client';

import { useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AvatarColorSwatches } from './Avatar';

interface ColorPickerProps {
  currentColorIndex: number;
  onColorChange: (colorIndex: number) => void;
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement | HTMLDivElement | null>;
}

// The same colours as the avatar itself (components/ui/Avatar.tsx) - one
// list, so this quick picker and every dialog agree on what each one is.

export function ColorPicker({ 
  currentColorIndex, 
  onColorChange, 
  isOpen, 
  onClose, 
  triggerRef 
}: ColorPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        pickerRef.current && 
        !pickerRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen) return null;

  return (
    <motion.div
      ref={pickerRef}
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="absolute top-full left-0 mt-2 p-3 rounded-xl shadow-xl border border-default z-50"
      style={{
        background: 'var(--color-surface)',
        width: 'min(340px, calc(100vw - 32px))'
      }}
    >
      <div className="text-xs font-medium mb-3 text-muted px-1">
        Select Color
      </div>
      <AvatarColorSwatches
        value={currentColorIndex}
        onChange={(index) => {
          onColorChange(index);
          onClose();
        }}
      />
    </motion.div>
  );
}

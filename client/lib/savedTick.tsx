'use client';

import { useSyncExternalStore } from 'react';

// "Saved", right beside the setting that was just saved (Settings, both page
// designs). A switch or a choice there saves by itself; instead of a toast at
// the corner, a small green tick appears next to that row's control for about
// a second and a half. Errors still use a toast.
//
// How it finds the row: every setting row carries its name as data-setting.
// A capture-phase listener notes the row of the last press or keystroke, and
// a row being typed in (the address saves when you leave the field, by which
// time the press is on something else). A save calls beginSave() as it
// starts, which takes that row then, and the function it returns lights the
// tick when the save went through.

const SHOW_MS = 1600;

const shown = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let lastRow: string | null = null;
let typingRow: string | null = null;
let installed = false;

function rowOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-setting]')?.getAttribute('data-setting') ?? null;
}

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const press = (e: Event) => { lastRow = rowOf(e.target); };
  document.addEventListener('pointerdown', press, true);
  document.addEventListener('keydown', press, true);
  document.addEventListener('input', (e) => { typingRow = rowOf(e.target); }, true);
}

function emit() { listeners.forEach((l) => l()); }

function subscribe(l: () => void) {
  install();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Call as a save starts; call what it returns when the save succeeded. */
export function beginSave(): () => void {
  const row = typingRow ?? lastRow;
  typingRow = null;
  return () => {
    if (!row) return;
    clearTimeout(timers.get(row));
    shown.add(row);
    emit();
    timers.set(row, setTimeout(() => { shown.delete(row); timers.delete(row); emit(); }, SHOW_MS));
  };
}

/** The tick itself; put it beside a row's control. `id` is the row's data-setting. */
export function SavedTick({ id, className = '' }: { id: string; className?: string }) {
  const on = useSyncExternalStore(subscribe, () => shown.has(id), () => false);
  if (!on) return null;
  return <span className={`saved-tick ${className}`} role="status">{'✓'} Saved</span>;
}

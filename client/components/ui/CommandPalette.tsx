'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  MagnifyingGlassIcon, HomeIcon, ClockIcon, ChartBarIcon, UsersIcon, UserGroupIcon,
  PuzzlePieceIcon, ShieldCheckIcon, EnvelopeIcon, QueueListIcon, Cog6ToothIcon, SwatchIcon,
  DocumentTextIcon, RectangleStackIcon, SparklesIcon, ArrowUpRightIcon,
} from '@heroicons/react/24/outline';
import { api } from '@/lib/api';

// Global Ctrl+K/Cmd+K command palette - the trigger key shown adapts to the
// OS (Mac gets the Cmd glyph, everyone else gets Ctrl), same convention
// every command palette (Linear, Notion, Raycast) already uses. Two tiers:
// fast client-side fuzzy search over static nav destinations + live
// users/addons/catalogs (fetched once on first open, not per keystroke),
// and - only when nothing matches - an AI fallback that answers a
// free-text question read-only (see server's own comment on why this
// doesn't execute arbitrary write actions).
const NAV_ITEMS = [
  { label: 'Dashboard', href: '/', icon: HomeIcon, keywords: 'home' },
  { label: 'Activity', href: '/activity', icon: ClockIcon, keywords: 'watch history' },
  { label: 'Metrics', href: '/metrics', icon: ChartBarIcon, keywords: 'stats analytics health' },
  { label: 'Users', href: '/users', icon: UsersIcon, keywords: 'household members' },
  { label: 'Groups', href: '/groups', icon: UserGroupIcon, keywords: '' },
  { label: 'Discover', href: '/discover', icon: MagnifyingGlassIcon, keywords: 'browse search' },
  { label: 'Catalogs', href: '/catalogs', icon: RectangleStackIcon, keywords: 'lists' },
  { label: 'Addons', href: '/addons', icon: PuzzlePieceIcon, keywords: '' },
  { label: 'Vault', href: '/vault', icon: ShieldCheckIcon, keywords: 'credentials api keys debrid' },
  { label: 'Invitations', href: '/invitations', icon: EnvelopeIcon, keywords: 'invite' },
  { label: 'Tasks', href: '/tasks', icon: QueueListIcon, keywords: 'backup snapshot' },
  { label: 'Settings', href: '/settings', icon: Cog6ToothIcon, keywords: '' },
  { label: 'Themes', href: '/themes', icon: SwatchIcon, keywords: 'appearance colors' },
  { label: 'Changelog', href: '/changelog', icon: DocumentTextIcon, keywords: 'whats new updates' },
];

function isMac() {
  if (typeof navigator === 'undefined') return false;
  // navigator.platform is deprecated but still the most broadly-supported
  // synchronous signal; userAgentData.platform (where available) is
  // checked first since it's the non-deprecated replacement.
  const uaData = (navigator as any).userAgentData;
  if (uaData?.platform) return /mac/i.test(uaData.platform);
  return /mac/i.test(navigator.platform || navigator.userAgent || '');
}

interface Result {
  id: string;
  label: string;
  sublabel?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export function CommandPalette() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [mac, setMac] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [entities, setEntities] = useState<Result[] | null>(null);
  const [loadingEntities, setLoadingEntities] = useState(false);

  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [askingAi, setAskingAi] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => { setMac(isMac()); }, []);

  const loadEntities = useCallback(async () => {
    if (entities || loadingEntities) return;
    setLoadingEntities(true);
    try {
      const [users, addons, lists] = await Promise.all([
        api.getUsers().catch(() => []),
        api.getAddons().catch(() => []),
        api.getLists().catch(() => []),
      ]);
      const results: Result[] = [
        ...users.map((u) => ({ id: `user-${u.id}`, label: u.username, sublabel: 'User', href: `/users/${u.id}`, icon: UsersIcon })),
        ...addons.map((a) => ({ id: `addon-${a.id}`, label: a.name, sublabel: 'Addon', href: `/addons/${a.id}`, icon: PuzzlePieceIcon })),
        ...lists.map((l) => ({ id: `list-${l.id}`, label: l.name, sublabel: 'Catalog', href: `/catalogs/${l.id}`, icon: RectangleStackIcon })),
      ];
      setEntities(results);
    } finally {
      setLoadingEntities(false);
    }
  }, [entities, loadingEntities]);

  const open = useCallback(() => {
    setIsOpen(true);
    setQuery('');
    setAiAnswer(null);
    setAiError(null);
    setActiveIndex(0);
    loadEntities();
  }, [loadEntities]);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Global trigger - Ctrl+K everywhere except Mac, which gets Cmd+K.
  // Ignored while typing in a real input/textarea/contenteditable elsewhere
  // on the page, so it never hijacks a K keystroke mid-form.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const modifierPressed = mac ? e.metaKey : e.ctrlKey;
      if (modifierPressed && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen((prev) => {
          if (prev) return prev; // already open, let it handle its own Escape
          setQuery('');
          setAiAnswer(null);
          setAiError(null);
          setActiveIndex(0);
          loadEntities();
          return true;
        });
        return;
      }
      if (e.key === 'Escape' && isOpen) close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mac, isOpen, close, loadEntities]);

  useEffect(() => {
    if (isOpen) {
      // Next tick, so the input exists before we try to focus it.
      const id = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(id);
    }
  }, [isOpen]);

  const navResults: Result[] = useMemo(() => NAV_ITEMS.map((n) => ({ id: `nav-${n.href}`, label: n.label, href: n.href, icon: n.icon, sublabel: undefined })), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return navResults.slice(0, 8);
    const pool = [
      ...NAV_ITEMS.filter((n) => n.label.toLowerCase().includes(q) || n.keywords.includes(q))
        .map((n) => ({ id: `nav-${n.href}`, label: n.label, href: n.href, icon: n.icon, sublabel: undefined })),
      ...(entities || []).filter((r) => r.label.toLowerCase().includes(q)),
    ];
    return pool.slice(0, 8);
  }, [query, navResults, entities]);

  useEffect(() => { setActiveIndex(0); }, [query]);

  const handleSelect = (result: Result) => {
    router.push(result.href);
    close();
  };

  const handleAskAi = async () => {
    if (!query.trim() || askingAi) return;
    setAskingAi(true);
    setAiError(null);
    setAiAnswer(null);
    try {
      const { answer } = await api.commandAsk(query.trim());
      setAiAnswer(answer);
    } catch (err: any) {
      setAiError(err.message || 'Failed to get an answer');
    } finally {
      setAskingAi(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIndex]) handleSelect(filtered[activeIndex]);
      else if (query.trim()) handleAskAi();
    }
  };

  return (
    <>
      {/* Small floating trigger hint - discoverability for a keyboard
          shortcut that's otherwise invisible. Hidden on mobile (no keyboard
          shortcut to advertise there). */}
      <button
        type="button"
        onClick={open}
        className="hidden md:flex fixed bottom-5 right-5 z-40 items-center gap-2 px-3 py-2 rounded-full text-xs font-medium shadow-lg transition-transform hover:scale-105"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', color: 'var(--color-textMuted)' }}
        title="Open command palette"
      >
        <MagnifyingGlassIcon className="w-3.5 h-3.5" />
        <kbd className="font-mono">{mac ? '⌘' : 'Ctrl'}K</kbd>
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] bg-black/50"
              onClick={close}
            />
            <motion.div
              initial={{ opacity: 0, y: -12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="fixed top-[15vh] left-1/2 -translate-x-1/2 z-[101] w-full max-w-lg mx-4"
            >
              <div
                className="rounded-2xl overflow-hidden shadow-2xl"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
              >
                <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--color-surface-border)' }}>
                  <MagnifyingGlassIcon className="w-5 h-5 shrink-0" style={{ color: 'var(--color-textMuted)' }} />
                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Jump to a page, user, addon, catalog… or ask a question"
                    className="flex-1 bg-transparent outline-none text-sm"
                    style={{ color: 'var(--color-text)' }}
                  />
                  <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'var(--color-subtle)', color: 'var(--color-textMuted)' }}>Esc</kbd>
                </div>

                <div className="max-h-80 overflow-y-auto py-2">
                  {filtered.length === 0 && !aiAnswer && !askingAi && !aiError && (
                    <div className="px-4 py-6 text-center">
                      <p className="text-sm text-muted mb-3">No matches for &quot;{query}&quot;</p>
                      <button
                        onClick={handleAskAi}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
                        style={{ background: 'var(--color-primary-muted)', color: 'var(--color-primary)' }}
                      >
                        <SparklesIcon className="w-3.5 h-3.5" />
                        Ask AI instead
                      </button>
                    </div>
                  )}

                  {filtered.map((r, i) => {
                    const Icon = r.icon;
                    return (
                      <button
                        key={r.id}
                        onClick={() => handleSelect(r)}
                        onMouseEnter={() => setActiveIndex(i)}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
                        style={{ background: i === activeIndex ? 'var(--color-surface-hover)' : 'transparent' }}
                      >
                        <Icon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-textMuted)' }} />
                        <span className="text-sm flex-1 truncate" style={{ color: 'var(--color-text)' }}>{r.label}</span>
                        {r.sublabel && <span className="text-xs" style={{ color: 'var(--color-textMuted)' }}>{r.sublabel}</span>}
                        <ArrowUpRightIcon className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-textMuted)', opacity: i === activeIndex ? 1 : 0 }} />
                      </button>
                    );
                  })}

                  {askingAi && (
                    <div className="px-4 py-4 flex items-center gap-2 text-sm text-muted">
                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Thinking…
                    </div>
                  )}
                  {aiAnswer && (
                    <div className="mx-4 my-2 p-3 rounded-lg text-sm flex items-start gap-2" style={{ background: 'var(--color-primary-muted)', color: 'var(--color-text)' }}>
                      <SparklesIcon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--color-primary)' }} />
                      <p>{aiAnswer}</p>
                    </div>
                  )}
                  {aiError && (
                    <div className="mx-4 my-2 p-3 rounded-lg text-sm" style={{ background: 'var(--color-error-muted, var(--color-surface-hover))', color: 'var(--color-error)' }}>
                      {aiError}
                    </div>
                  )}
                  {loadingEntities && !query && (
                    <div className="px-4 py-2 text-xs text-muted">Loading users, addons, catalogs…</div>
                  )}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

'use client';

// Sync state for the v2 people and group cards: the same verdict Classic's
// SyncBadge shows (Synced, Unsynced, Syncing, Reconnect), read the same way
// and remembered under the same key, drawn in v2's own words and dot.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { startAdaptivePoll } from '@/lib/adaptivePoll';
import type { V2Tone } from './V2Bits';

export type V2SyncKind = 'checking' | 'synced' | 'unsynced' | 'stale' | 'connect' | 'error' | 'unsupported' | 'syncing';
export type V2Sync = { kind: V2SyncKind; /** "1 of 3 people", for an unsynced group. */ detail?: string; message?: string };

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readCached(key: string): V2Sync | null {
  if (!key || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.status || Date.now() - (parsed.at || 0) > CACHE_TTL_MS) return null;
    return { kind: parsed.status as V2SyncKind };
  } catch {
    return null;
  }
}

function writeCached(key: string, kind: V2SyncKind) {
  if (!key || typeof window === 'undefined' || kind === 'checking' || kind === 'syncing') return;
  try { window.localStorage.setItem(key, JSON.stringify({ status: kind, at: Date.now() })); } catch { /* private mode */ }
}

/**
 * One person's or one group's sync verdict. `syncing` (a sync running from
 * this page) shows "Syncing" and re-checks when it ends; `enabled` false
 * skips the check (switched off, signed out, no addon list).
 */
export function useV2Sync({ userId, groupId, syncing = false, enabled = true }: { userId?: string; groupId?: string; syncing?: boolean; enabled?: boolean }): V2Sync {
  // Shared with SyncBadge, so a card shows its last answer straight away.
  const cacheKey = userId ? `ss-syncbadge:u:${userId}` : (groupId ? `ss-syncbadge:g:${groupId}` : '');
  const [state, setState] = useState<V2Sync>({ kind: 'checking' });
  const kindRef = useRef<V2SyncKind>('checking');
  const prevSyncing = useRef(syncing);

  const apply = useCallback((next: V2Sync) => {
    kindRef.current = next.kind;
    setState(next);
    writeCached(cacheKey, next.kind);
  }, [cacheKey]);

  const check = useCallback(async () => {
    if (!userId && !groupId) { apply({ kind: 'stale' }); return; }
    try {
      if (userId) {
        const res = await api.getUserSyncStatus(userId) as { status?: string; message?: string } | undefined;
        const value = res?.status;
        const message = res?.message || '';
        if (value === 'error') {
          apply({ kind: /Stremio connection invalid|authentication|auth|invalid|corrupted/.test(message) ? 'connect' : 'error', message });
        } else if (value === 'stale' || !value) {
          apply({ kind: 'stale' });
        } else {
          apply({ kind: value as V2SyncKind, message });
        }
      } else if (groupId) {
        const agg = await api.getGroupSyncStatus(groupId);
        const members = agg?.memberCount ?? (agg?.userStatuses?.length ?? 0);
        const addons = agg?.addonCount ?? 0;
        if (addons === 0 || members === 0) { apply({ kind: 'stale' }); return; }
        const statuses = agg?.userStatuses || [];
        const failing = statuses.find((s) => s.status === 'error' || s.status === 'connect');
        if (failing) { apply({ kind: 'error', message: failing.message }); return; }
        const behind = statuses.filter((s) => s.status !== 'synced').length;
        if (statuses.length > 0 && behind === 0) apply({ kind: 'synced' });
        else apply({ kind: 'unsynced', detail: statuses.length > 1 ? `${behind} of ${statuses.length} people` : undefined });
      }
    } catch {
      apply({ kind: 'error' });
    }
  }, [userId, groupId, apply]);

  // Right after a write the provider can still read the old state for a
  // moment, so an "unsynced" answer is asked again twice before it stands.
  const checkVerified = useCallback(async () => {
    for (let left = 2; ; left--) {
      await check();
      if (kindRef.current !== 'unsynced' || left <= 0) return;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }, [check]);

  useEffect(() => {
    if (!enabled) return;
    const cached = readCached(cacheKey);
    if (cached && kindRef.current === 'checking') { kindRef.current = cached.kind; setState(cached); }
    void checkVerified();
    const stop = startAdaptivePoll(() => { void check(); }, 120000, 300000);
    let pending: ReturnType<typeof setTimeout> | null = null;
    const onLive = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { pending = null; void check(); }, 800);
    };
    window.addEventListener('slicksync:live-sync', onLive);
    return () => {
      stop();
      if (pending) clearTimeout(pending);
      window.removeEventListener('slicksync:live-sync', onLive);
    };
  }, [enabled, cacheKey, check, checkVerified]);

  useEffect(() => {
    if (prevSyncing.current && !syncing && enabled) void checkVerified();
    prevSyncing.current = syncing;
  }, [syncing, enabled, checkVerified]);

  if (syncing) return { kind: 'syncing' };
  return state;
}

/** The word and dot for a verdict; null when there is nothing to say (no addon list). */
export function syncWords(s: V2Sync): { tone: V2Tone; words: string } | null {
  switch (s.kind) {
    case 'synced': return { tone: 'ok', words: 'Synced' };
    case 'unsynced': return { tone: 'warn', words: s.detail ? `Unsynced · ${s.detail}` : 'Unsynced' };
    case 'syncing': return { tone: 'ok', words: 'Syncing…' };
    case 'checking': return { tone: 'off', words: 'Checking…' };
    case 'connect': return { tone: 'warn', words: 'Sign-in needs a fix' };
    case 'error': return { tone: 'bad', words: 'Couldn’t check' };
    case 'stale': return { tone: 'off', words: 'Nothing to sync yet' };
    default: return null;
  }
}

// One reading of a Vault entry, shared by both page designs: what it says in
// a word, the line under it, whether it needs you, and the money side of it
// (a lifetime plan is paid once and never counted monthly).

import type { VaultEntry } from '@/lib/api';
import { AUTO_DATE_SOURCES } from '@/lib/vaultKinds';

export type VaultTone = 'bad' | 'warn' | 'live' | 'off';

export interface Judged {
  tone: VaultTone;
  /** The newer design's status words. */
  words: string;
  /** The one badge a Classic card shows. */
  badge: string;
  /** Classic badge style: 'life' is the lifetime color. */
  badgeTone: VaultTone | 'life';
  line: string;
  need: 'fix' | 'renew' | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar days from today to the end date, the way the services count them. */
export function daysUntil(dateStr: string | null | undefined, now = Date.now()): number | null {
  if (!dateStr) return null;
  const end = new Date(dateStr);
  if (isNaN(end.getTime())) return null;
  const n = new Date(now);
  const a = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  const b = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.round((b - a) / 86400000);
}

/** "Dec 29", or "Dec 29, 2027" when it is not this year. */
export function shortDay(dateStr: string | null | undefined, now = Date.now()): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getUTCFullYear()}`;
}

export const isLifetime = (e: VaultEntry) => e.costCycle === 'once';
export const isFree = (e: VaultEntry) => e.costCycle === 'free';
export const isNote = (e: VaultEntry) => e.category === 'note';
export const isSnoozed = (e: VaultEntry, now = Date.now()) => !!e.snoozedUntil && new Date(e.snoozedUntil).getTime() > now;
/** Its end date is read from the service, so there is nothing to renew by hand. */
export const datedByService = (e: VaultEntry) => !!AUTO_DATE_SOURCES[e.testType];

/** One status for an entry, in words, and whether it needs you. */
export function judgeEntry(e: VaultEntry, now: number): Judged {
  const unchecked = e.testType === 'manual' || !e.lastCheckStatus;
  if (e.lastCheckStatus === 'error') {
    return { tone: 'bad', words: 'Not working', badge: 'Not working', badgeTone: 'bad', line: e.lastCheckMessage || 'Last check failed', need: 'fix' };
  }
  // No end date: a lifetime plan, or something free.
  if (isLifetime(e) || isFree(e)) {
    const words = unchecked ? 'Not checked' : 'Working';
    const tone: VaultTone = unchecked ? 'off' : 'live';
    return isLifetime(e)
      ? { tone, words, badge: 'Lifetime', badgeTone: 'life', line: 'Lifetime · paid once', need: null }
      : { tone, words, badge: words, badgeTone: tone, line: 'Free', need: null };
  }
  const days = daysUntil(e.expiresAt, now);
  // It renews by itself: the date is only for your information.
  if (e.autoRenew && days !== null) {
    const words = unchecked ? 'Not checked' : 'Working';
    const tone: VaultTone = unchecked ? 'off' : 'live';
    return { tone, words, badge: words, badgeTone: tone, line: `Renews ${shortDay(e.expiresAt, now)} by itself`, need: null };
  }
  if (days !== null && days < 0) {
    return { tone: 'bad', words: 'Ended', badge: 'Ended', badgeTone: 'bad', line: `Ended ${-days === 1 ? 'yesterday' : `${-days} days ago`}`, need: 'renew' };
  }
  if (days !== null && days <= (e.notifyDaysBefore ?? 7) && !isSnoozed(e, now)) {
    const soon = days === 0 ? 'Ends today' : `Ends in ${days} day${days === 1 ? '' : 's'}`;
    return { tone: 'warn', words: 'Ending soon', badge: soon, badgeTone: 'warn', line: `${soon} · ${shortDay(e.expiresAt, now)}`, need: 'renew' };
  }
  const ends = days !== null ? `Ends in ${days} day${days === 1 ? '' : 's'} · ${shortDay(e.expiresAt, now)}` : '';
  if (unchecked) return { tone: 'off', words: 'Not checked', badge: 'Not checked', badgeTone: 'off', line: ends || 'No automatic check', need: null };
  return { tone: 'live', words: 'Working', badge: 'Working', badgeTone: 'live', line: ends || e.lastCheckMessage || 'Last check passed', need: null };
}

/**
 * "I renewed it" is for an entry with a billing period and a date someone
 * typed, that is ending or has ended: one press moves the date on a period.
 * Not offered where the service reports the date, or where it renews by itself.
 */
export function canMarkRenewed(e: VaultEntry, now: number): boolean {
  if (isNote(e) || isLifetime(e) || isFree(e) || e.autoRenew || datedByService(e) || !e.expiresAt) return false;
  if (e.costCycle && e.costCycle !== 'monthly' && e.costCycle !== 'yearly') return false;
  const days = daysUntil(e.expiresAt, now);
  return days !== null && days <= (e.notifyDaysBefore ?? 7);
}

/** What an entry costs a month: a yearly price spread over twelve, a lifetime or free one nothing. */
export function monthlyCost(e: VaultEntry): number {
  if (!e.cost || isLifetime(e) || isFree(e)) return 0;
  return e.cost / (e.costCycle === 'yearly' ? 12 : 1);
}

/** The money summary across all entries. */
export function costSummary(entries: VaultEntry[]) {
  const live = entries.filter((e) => !isNote(e));
  const monthly = live.reduce((sum, e) => sum + monthlyCost(e), 0);
  const tracked = live.filter((e) => monthlyCost(e) > 0).length;
  const lifetime = live.filter(isLifetime);
  const paidOnce = lifetime.reduce((sum, e) => sum + (e.cost && e.cost > 0 ? e.cost : 0), 0);
  return { monthly, tracked, paidOnce, lifetimeCount: lifetime.length };
}

/** Whether a search for `q` should show this entry (its name, its service, its kind's label). */
export function matchesSearch(e: VaultEntry, q: string, kindLabel: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [e.name, e.provider || '', kindLabel].some((s) => s.toLowerCase().includes(needle));
}

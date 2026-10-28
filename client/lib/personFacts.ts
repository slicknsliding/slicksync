// A person's facts in words, for the top of their page in Discover: what
// they do, and when they were born and how old they are, from the fields
// server/utils/personFacts.js sends.

import type { DiscoverPerson } from './api';

// The work as the person who does it: "Acting" is an actor.
const PEOPLE: Record<string, string> = {
  Acting: 'actor', Directing: 'director', Writing: 'writer', Producing: 'producer',
  Music: 'composer', Cinematography: 'cinematographer', Editing: 'editor', Creating: 'creator',
};

/** "Actor and producer" - what the person does, as a person. */
export function workAsPerson(knownFor: string[] | null | undefined): string | null {
  const roles = (knownFor ?? []).map((w) => PEOPLE[w] ?? w.toLowerCase()).filter(Boolean);
  if (roles.length === 0) return null;
  const text = roles.length === 1 ? roles[0] : `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "1962-07-03" read as the calendar date it is - never through a time zone,
// which would move a birthday a day either way.
function parts(iso: string | null | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (p: { y: number; m: number; d: number }) => `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;

function yearsBetween(from: { y: number; m: number; d: number }, to: { y: number; m: number; d: number }): number {
  let age = to.y - from.y;
  if (to.m < from.m || (to.m === from.m && to.d < from.d)) age -= 1;
  return age;
}

const FILLED_WORDS: Record<string, string> = { bio: 'about', birthday: 'birthday', birthplace: 'birthplace' };

/** "About and birthday from Wikipedia" - what Wikipedia filled where TMDb had nothing. */
export function wikipediaLine(filled: string[] | null | undefined): string | null {
  const words = (['bio', 'birthday', 'birthplace'] as const).filter((k) => filled?.includes(k)).map((k) => FILLED_WORDS[k]);
  if (words.length === 0) return null;
  const what = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} from Wikipedia`;
}

/** "Born July 3, 1962 · age 64", or with a death, "July 3, 1962 – March 1, 2020 (aged 57)". */
export function bornLine(facts: Pick<DiscoverPerson, 'birthday' | 'deathday'>, now = new Date()): string | null {
  const b = parts(facts.birthday);
  if (!b) return null;
  const d = parts(facts.deathday);
  const end = d ?? { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  const age = yearsBetween(b, end);
  return d ? `${longDate(b)} – ${longDate(d)} (aged ${age})` : `Born ${longDate(b)} · age ${age}`;
}

'use client';

// Resume on a Continue Watching card from a Jellyfin or AIOStreams sign-in
// (ContinueBanners). Those have no app address of their own, so the card
// opens the app this device chose in "Open titles with" (lib/openWith.ts) -
// the same choice the title popup's "Open in" and a person's own Home use.
// Until one is chosen, Resume opens that picker from the button; picking an
// app opens the title there and remembers it on this device. The card's menu
// offers "Choose app..." to change it. Links stay plain links: an app address
// opened from script is unreliable on phones.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from 'react';
import { PlayIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';
import { OpenWithPicker } from '@/components/ui/OpenWithPicker';
import { toast } from '@/components/ui/Toast';
import type { ContinueWatchingItem } from '@/lib/api';
import {
  OPEN_WITH_APPS, SHORTCUT_APP, WEB_APP,
  availableApps, linksFor, onRememberedAppChange, rememberApp, rememberedApp, resumeAppName, safeOpenUrl,
  type OpenTargets, type OpenWithAppId,
} from '@/lib/openWith';

/** Where a card's servers come from and how Play on reaches a device: the admin's, or the person's own. */
export interface ResumeApps {
  /** Keeps one source's answers apart from another's. */
  key: string;
  load: (item: ContinueWatchingItem) => Promise<OpenTargets>;
  playOn: (device: OpenTargets['devices'][number]) => Promise<unknown>;
}

const EMPTY: OpenTargets = { servers: [], devices: [], tmdbId: null };
const KEEP_MS = 5 * 60 * 1000;
const answers = new Map<string, { at: number; value: Promise<OpenTargets> }>();
function targetsFor(apps: ResumeApps, item: ContinueWatchingItem): Promise<OpenTargets> {
  const key = `${apps.key}|${item.userId}|${item.contentType}:${item.showId}`;
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.value;
  const value = apps.load(item).catch(() => EMPTY);
  answers.set(key, { at: Date.now(), value });
  if (answers.size > 300) { const oldest = answers.keys().next().value; if (oldest) answers.delete(oldest); }
  return value;
}

/** This device's pick, kept current when it changes on another card or in another tab. */
export function useRememberedApp(): OpenWithAppId | null {
  return useSyncExternalStore(onRememberedAppChange, rememberedApp, () => null);
}

/** A card that resumes through the chosen app: a Jellyfin-style sign-in, with no app address of its own. */
export const resumesThroughApp = (item: Pick<ContinueWatchingItem, 'providerType' | 'appUrl'>) => item.providerType === 'jellyfin' && !item.appUrl;

const ALL_APPS = [...OPEN_WITH_APPS, WEB_APP, SHORTCUT_APP];

export type ResumeWithApp = NonNullable<ReturnType<typeof useResumeWithApp>>;

/** Null for a card that opens its own app (Stremio, Nuvio) or where nothing can be looked up. */
export function useResumeWithApp(item: ContinueWatchingItem, apps: ResumeApps | undefined) {
  const on = !!apps && resumesThroughApp(item);
  const chosen = useRememberedApp();
  const [asked, setAsked] = useState(false);
  const [targets, setTargets] = useState<{ key: string; value: OpenTargets } | null>(null);
  const [pickerAt, setPickerAt] = useState<RefObject<HTMLElement | null> | null>(null);
  // Bumped when a Shortcut's names are saved, so the list re-reads them.
  const [shortcutSaved, setShortcutSaved] = useState(0);
  const key = `${item.userId}|${item.contentType}:${item.showId}`;
  // Looked up once there's an app to name on the button, or when asked.
  const need = on && (chosen != null || asked);
  useEffect(() => {
    if (!need || !apps) return;
    let stale = false;
    void targetsFor(apps, item).then((value) => { if (!stale) setTargets({ key, value }); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the item is read through its key
  }, [need, apps, key]);

  const loaded = targets && targets.key === key ? targets.value : null;
  const type = item.contentType;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- shortcutSaved: re-read the saved Shortcut
  const usable = useMemo(() => (loaded ? availableApps(loaded, type) : []), [loaded, type, shortcutSaved]);
  const current = usable.find((a) => a.id === chosen) || null;
  const url = current && loaded ? safeOpenUrl(linksFor(current.id, loaded, type)[0]?.url) : null;
  // Before the lookup the button already names the chosen app; after it,
  // only one that can open this title.
  const named = loaded ? current : ALL_APPS.find((a) => a.id === chosen) || null;

  const openPicker = useCallback((at: RefObject<HTMLElement | null>) => { setAsked(true); setPickerAt(at); }, []);
  const closePicker = useCallback(() => setPickerAt(null), []);
  const pick = useCallback((id: OpenWithAppId) => { rememberApp(id); setPickerAt(null); }, []);
  const playOn = useCallback(async (d: OpenTargets['devices'][number]) => {
    setPickerAt(null);
    if (!apps) return;
    try {
      await apps.playOn(d);
      toast.success(`Playing on ${d.device}`);
    } catch (e) {
      toast.error((e as Error)?.message || 'That device did not answer');
    }
  }, [apps]);
  const hrefFor = useCallback((id: OpenWithAppId) => (loaded ? safeOpenUrl(linksFor(id, loaded, type)[0]?.url) : null), [loaded, type]);
  const lookUp = useCallback(() => setAsked(true), []);
  const shortcutWasSaved = useCallback(() => setShortcutSaved((n) => n + 1), []);

  if (!on) return null;
  return {
    loaded,
    apps: usable,
    current,
    /** The chosen app's link for this title, once looked up. */
    url,
    /** "browser", "AIOStreams"...: what "Resume in ..." says, or null for plain Resume. */
    name: named ? resumeAppName(named) : null,
    /** Looked up and nothing at all can open it: the card keeps its title page. */
    nothing: !!loaded && usable.length === 0 && loaded.devices.length === 0,
    pickerAt,
    openPicker,
    closePicker,
    pick,
    playOn,
    hrefFor,
    lookUp,
    shortcutSaved: shortcutWasSaved,
  };
}

/** The "Open titles with" picker, hung from the Resume button or the card's menu. */
export function ResumePicker({ resume, item }: { resume: ResumeWithApp | null; item: ContinueWatchingItem }) {
  if (!resume?.pickerAt) return null;
  const { loaded } = resume;
  return (
    <AnchoredPopup anchorRef={resume.pickerAt} onClose={resume.closePicker} label={`Choose the app for ${item.showName}`} width={320}>
      <div className="-mx-2">
        {!loaded ? (
          <p className="px-2 py-2.5 text-[15px]" style={{ color: 'var(--color-text-muted)' }}>Checking the apps…</p>
        ) : resume.nothing ? (
          <p className="px-2 py-2.5 text-[15px]" style={{ color: 'var(--color-text-muted)' }}>No app can open this title from here.</p>
        ) : (
          <OpenWithPicker
            targets={loaded}
            apps={resume.apps}
            currentId={resume.current?.id ?? null}
            onPick={resume.pick}
            hrefFor={resume.hrefFor}
            onShortcutSaved={resume.shortcutSaved}
            onPlayOn={resume.playOn}
          />
        )}
      </div>
    </AnchoredPopup>
  );
}

/** The card menu's first lines: Resume in the chosen app, and Choose app... */
export function ResumeMenuRows({ resume, anchorRef, onClose }: { resume: ResumeWithApp; anchorRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  const { lookUp } = resume;
  useEffect(() => { lookUp(); }, [lookUp]);
  const row = 'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[15px] text-left text-default hover:bg-surface-hover transition-colors';
  const icon = 'w-[18px] h-[18px] shrink-0 text-muted';
  if (!resume.loaded) return <p className="px-3 py-2.5 text-[15px]" style={{ color: 'var(--color-text-muted)' }}>Checking the apps…</p>;
  if (resume.nothing) return null;
  const choose = () => { onClose(); resume.openPicker(anchorRef); };
  if (!resume.url) {
    return (
      <button type="button" className={row} onClick={choose}>
        <PlayIcon className={icon} />
        Choose an app to resume in
      </button>
    );
  }
  const page = /^https?:/i.test(resume.url);
  return (
    <>
      <a href={resume.url} target={page ? '_blank' : undefined} rel={page ? 'noopener noreferrer' : undefined} onClick={onClose} className={row}>
        <PlayIcon className={icon} />
        {`Resume in ${resume.name}`}
      </a>
      <button type="button" className={row} onClick={choose}>
        <Squares2X2Icon className={icon} />
        Choose app…
      </button>
    </>
  );
}

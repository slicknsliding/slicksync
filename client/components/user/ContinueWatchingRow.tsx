'use client';

// "Continue Watching" on a person's own Home: the shows and films they have
// partly watched, as banners in a row (the latest one wide above it when
// they pick Wide in Settings), each with a ... menu (Resume in their app, Remove from Continue
// Watching). The title Now Playing shows above is left out. Only their own - for a
// Stremio, Nuvio, Jellyfin or AIOStreams person alike - and the whole row
// hides itself when there is nothing to pick up. Removing a card keeps their
// watch history.
//
// Resume opens Stremio and Nuvio from the address SlickSync has for them. For
// a Jellyfin or AIOStreams person it opens the app this device chose (the same
// choice, list and memory as the admin's "Open in" - lib/openWith.ts), picked
// from "Choose app..." in the menu; until one is chosen the menu offers the
// title's page. All plain links, not scripted navigation - an app address
// opened from a click handler is unreliable on phones.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EllipsisHorizontalIcon, PlayIcon, Squares2X2Icon, XMarkIcon } from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui';
import { OpenWithPicker } from '@/components/ui/OpenWithPicker';
import { ScrollRow } from '@/components/ui/ScrollRow';
import { toast } from '@/components/ui/Toast';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';
import { useUserAuth } from '@/lib/hooks/useUserAuth';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { useCwFirst } from '@/lib/arrange';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { providerBadgeVariant, providerTypeLabel } from '@/lib/providers';
import { cachedImageUrl } from '@/lib/posterUrl';
import { startAdaptivePoll } from '@/lib/adaptivePoll';
import { availableApps, linksFor, rememberApp, rememberedApp, rememberedShortcut, type OpenTargets, type OpenWithAppId } from '@/lib/openWith';
import { userContinueWatching, userOpenTargets, type ContinueWatchingCardData } from '@/lib/user-api';
import { useArtworkFallback } from '@/lib/hooks/useArtworkFallback';
import { ContinueBannerCard, ContinueLeadBanner } from '@/components/dashboard/ContinueBanners';
import type { ContinueWatchingItem } from '@/lib/api';

const REFRESH_MS = 60 * 1000;
const EMPTY: ContinueWatchingCardData[] = [];

// Only addresses a link here may open: the two apps, and web pages.
const safeAppUrl = (u: string | null) => (u && /^(stremio|nuvio):/i.test(u) ? u : null);
const safeWebUrl = (u: string | null) => (u && /^https:\/\//i.test(u) ? u : null);
// What a chosen Jellyfin app may open: its own schemes, the Shortcuts app, the server's page.
const safeResumeUrl = (u: string) => (/^(swiftfin|streamyfin|infuse|aiostreams|shortcuts):/i.test(u) || /^https?:\/\//i.test(u) ? u : null);
const EMPTY_TARGETS: OpenTargets = { servers: [], devices: [], tmdbId: null };
// A Jellyfin or AIOStreams person's card resumes in the app they choose.
const choosesApp = (card: ContinueWatchingCardData) => card.providerType === 'jellyfin';

function episodeLine(c: ContinueWatchingCardData): string {
  if (c.season != null && c.episode != null) {
    const code = `S${String(c.season).padStart(2, '0')}E${String(c.episode).padStart(2, '0')}`;
    return `${c.resume ? 'Resume · ' : ''}${code}${c.episodeTitle ? ` · ${c.episodeTitle}` : ''}`;
  }
  if (c.remainingMinutes != null) {
    const m = c.remainingMinutes;
    const left = m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m ` : ''}left` : `${m} min left`;
    return `Resume · ${left}`;
  }
  return c.progressPercent != null ? `Resume · ${c.progressPercent}% watched` : 'Resume';
}

/** The badge on the picture: time left when resuming, Up next for the next episode. */
function leftLabel(c: ContinueWatchingCardData): string {
  if (!c.resume) return 'Up next';
  if (c.remainingMinutes != null) {
    const m = c.remainingMinutes;
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min ` : ''}left` : `${m} min left`;
  }
  return c.progressPercent != null ? `${c.progressPercent}% watched` : 'Resume';
}

// The link a card, and its menu's first line, goes to.
function openingOf(card: ContinueWatchingCardData) {
  const appUrl = safeAppUrl(card.appUrl);
  const webUrl = safeWebUrl(card.webUrl);
  return { appUrl, href: appUrl || webUrl, app: providerTypeLabel(card.providerType) };
}

// OK on the remote: what a click on the card's link does.
function openOnTV(appUrl: string | null, href: string) {
  if (appUrl) window.location.href = appUrl;
  else window.open(href, '_blank', 'noopener,noreferrer');
}

// A card as the banners read it: the same title, theirs only.
function asBannerItem(c: ContinueWatchingCardData, userId: string): ContinueWatchingItem {
  return {
    userId,
    username: '',
    providerType: c.providerType,
    profileLabel: c.profileLabel,
    contentType: c.contentType,
    showId: c.showId,
    showName: c.name,
    poster: c.poster,
    background: c.background,
    lastWatched: null,
    nextEpisode: c.season != null && c.episode != null ? { season: c.season, episode: c.episode, title: c.episodeTitle, thumbnail: c.thumbnail } : null,
    resume: c.resume,
    progressPercent: c.progressPercent,
    remainingMinutes: c.remainingMinutes,
    positionMs: c.positionMs ?? null,
    durationMs: c.durationMs ?? null,
    lastWatchedAt: c.lastWatchedAt,
    appUrl: safeAppUrl(c.appUrl) || undefined,
    webUrl: safeWebUrl(c.webUrl) || undefined,
    imdbRating: null,
    rottenTomatoes: null,
    metacritic: null,
  };
}

// List view: one row per title - picture, title, what's next, time left, app and the ... menu.
const ListRow = memo(function ListRow({ card, menuOpen, onToggleMenu }: {
  card: ContinueWatchingCardData;
  menuOpen: boolean;
  onToggleMenu: (card: ContinueWatchingCardData, button: HTMLElement) => void;
}) {
  const { appUrl, href, app } = openingOf(card);
  const { url: image, onError: onImageError } = useArtworkFallback([card.thumbnail, card.background, card.poster]);
  const isTV = useIsTV();
  const inner = (
    <>
      <span className="relative w-24 h-[54px] shrink-0 rounded-lg overflow-hidden" style={{ background: 'var(--color-surface-elevated)' }}>
        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cachedImageUrl(image, 185) || image} onError={onImageError} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
        )}
        {card.resume && card.progressPercent != null && (
          <span className="absolute left-0 bottom-0 h-1" style={{ width: `${Math.min(100, Math.max(3, card.progressPercent))}%`, background: 'var(--color-progress, linear-gradient(90deg, var(--color-primary), var(--color-secondary)))' }} />
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold break-words" style={{ color: 'var(--color-text)' }}>{card.name}</span>
        <span className="block text-xs break-words" style={{ color: 'var(--color-text-muted)' }}>{episodeLine(card)}</span>
      </span>
      <span className="hidden sm:block w-28 shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>{leftLabel(card)}</span>
      <Badge variant={providerBadgeVariant({ providerType: card.providerType })} size="sm" className="shrink-0">{app}</Badge>
    </>
  );
  return (
    <div className="flex items-center gap-2 px-2 py-2 border-b last:border-b-0" style={{ borderColor: 'var(--color-surface-border)' }} data-continue-card={card.showId}>
      {href ? (() => {
        const link = (
          <a href={href} target={appUrl ? undefined : '_blank'} rel={appUrl ? undefined : 'noopener noreferrer'} tabIndex={isTV ? -1 : undefined}
            aria-label={`${appUrl ? `Resume in ${app}` : 'Open'} ${card.name}`} className="flex-1 min-w-0 flex items-center gap-4 rounded-lg">
            {inner}
          </a>
        );
        return isTV ? <TVFocusable className="flex-1 min-w-0 flex" onEnterPress={() => openOnTV(appUrl, href)}>{link}</TVFocusable> : link;
      })() : <div className="flex-1 min-w-0 flex items-center gap-4">{inner}</div>}
      <button type="button" onClick={(e) => onToggleMenu(card, e.currentTarget)} aria-label={`More for ${card.name}`} aria-haspopup="dialog" aria-expanded={menuOpen}
        className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors" style={{ color: 'var(--color-text-muted)' }}>
        <EllipsisHorizontalIcon className="w-5 h-5" />
      </button>
    </div>
  );
});

export function ContinueWatchingRow({ view = 'grid', playingId = null }: {
  view?: 'grid' | 'list';
  /** What Now Playing shows above: that title is left out here. */
  playingId?: string | null;
} = {}) {
  const { userId, authKey } = useUserAuth();
  // Settings → Continue Watching first card: the same size as the rest unless they pick Wide.
  const wideFirst = useCwFirst().first === 'wide';
  const isTV = useIsTV();
  // Kept with the person it was read for, so a profile switch never shows the last one's row.
  const [loaded, setLoaded] = useState<{ forUser: string; items: ContinueWatchingCardData[] } | null>(null);
  const playingBase = playingId ? playingId.split(':')[0] : null;
  const all = loaded && loaded.forUser === userId ? loaded.items : EMPTY;
  const cards = useMemo(() => (playingBase ? all.filter((c) => c.showId.split(':')[0] !== playingBase) : all), [all, playingBase]);
  // The row scrolls itself and swallows the click that ends a drag.
  const notDragged = useRef(false);
  const [menuFor, setMenuFor] = useState<ContinueWatchingCardData | null>(null);
  // The app picker, hung from the same ... button once the menu is dismissed.
  const [pickerFor, setPickerFor] = useState<ContinueWatchingCardData | null>(null);
  // The open card's servers and devices (null while they load), the app this
  // device remembers, and a counter that re-reads a just-saved Shortcut.
  const [targets, setTargets] = useState<{ showId: string; value: OpenTargets } | null>(null);
  const [chosen, setChosen] = useState<OpenWithAppId | null>(() => rememberedApp());
  const [shortcutSaved, setShortcutSaved] = useState(0);
  // The ... button the open menu hangs from. The menu is drawn outside the
  // scrolling row, so the row's drag-to-scroll never sees presses inside it.
  const menuAnchor = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!userId || !authKey) return;
    let stale = false;
    const look = () => userContinueWatching.list(userId, authKey)
      .then((r) => { if (!stale) setLoaded({ forUser: userId, items: r.items }); })
      .catch(() => {});
    void look();
    const stopPoll = startAdaptivePoll(() => { void look(); }, REFRESH_MS, REFRESH_MS);
    return () => { stale = true; stopPoll(); };
  }, [userId, authKey]);

  const openCard = menuFor || pickerFor;
  const openShowId = openCard && choosesApp(openCard) ? openCard.showId : null;
  const openType = openCard?.contentType;
  useEffect(() => {
    if (!openShowId || !openType || !userId || !authKey) { setTargets(null); return; }
    let stale = false;
    userOpenTargets.get(userId, authKey, openShowId, openType)
      .then((value) => { if (!stale) setTargets({ showId: openShowId, value }); })
      .catch(() => { if (!stale) setTargets({ showId: openShowId, value: EMPTY_TARGETS }); });
    return () => { stale = true; };
  }, [openShowId, openType, userId, authKey]);

  const toggleMenu = useCallback((card: ContinueWatchingCardData, button: HTMLElement) => {
    menuAnchor.current = button;
    setPickerFor(null);
    setMenuFor((cur) => (cur?.showId === card.showId ? null : card));
  }, []);
  const closeMenu = useCallback(() => setMenuFor(null), []);
  const closePicker = useCallback(() => setPickerFor(null), []);
  const choose = useCallback((card: ContinueWatchingCardData) => { setMenuFor(null); setPickerFor(card); }, []);
  const pickApp = useCallback((id: OpenWithAppId) => { rememberApp(id); setChosen(id); setPickerFor(null); }, []);
  const playOn = useCallback(async (d: OpenTargets['devices'][number]) => {
    setPickerFor(null);
    if (!userId || !authKey) return;
    try {
      await userOpenTargets.playOn(userId, authKey, { sessionId: d.sessionId, itemId: d.itemId });
      toast.success(`Playing on ${d.device}`);
    } catch (e) {
      toast.error((e as Error)?.message || 'That device did not answer');
    }
  }, [userId, authKey]);

  // What the open Jellyfin or AIOStreams card can do: the apps that can open
  // it, the one this device remembers (if it can), and that app's link.
  const resume = useMemo(() => {
    const card = menuFor || pickerFor;
    const loaded = card && targets && targets.showId === card.showId ? targets.value : null;
    if (!card || !choosesApp(card) || !loaded) return { loaded, apps: [], current: null, url: null as string | null };
    const apps = availableApps(loaded, card.contentType);
    const current = apps.find((a) => a.id === chosen) || null;
    const link = current ? linksFor(current.id, loaded, card.contentType)[0] : null;
    return { loaded, apps, current, url: link ? safeResumeUrl(link.url) : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shortcutSaved: availableApps re-reads the saved Shortcut
  }, [menuFor, pickerFor, targets, chosen, shortcutSaved]);

  const remove = useCallback(async (card: ContinueWatchingCardData) => {
    if (!userId || !authKey) return;
    setMenuFor(null);
    try {
      await userContinueWatching.dismiss(userId, authKey, card.showId);
      setLoaded((cur) => (cur ? { ...cur, items: cur.items.filter((c) => c.showId !== card.showId) } : cur));
      toast.success(`Removed ${card.name} from Continue Watching`);
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not remove that');
    }
  }, [userId, authKey]);

  // The banners hand back their own item; the menu works on the card it came from.
  const moreFor = (item: ContinueWatchingItem, anchor: HTMLElement) => {
    const card = cards.find((c) => c.showId === item.showId);
    if (card) toggleMenu(card, anchor);
  };
  const noRemove = () => {};

  if (cards.length === 0) return null;
  const banners = cards.map((c) => asBannerItem(c, userId || ''));
  const lead = wideFirst ? banners[0] : null;
  const rest = wideFirst ? banners.slice(1) : banners;
  const tvOpen = (item: ContinueWatchingItem) => {
    const href = item.appUrl || item.webUrl;
    if (href) openOnTV(item.appUrl || null, href);
  };

  return (
    <section className="mb-8" aria-label="Continue Watching">
      <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--color-text)' }}>Continue Watching</h3>
      {view === 'list' ? (
        <div className="rounded-2xl px-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}>
          {cards.map((card) => (
            <ListRow key={card.showId} card={card} menuOpen={menuFor?.showId === card.showId} onToggleMenu={toggleMenu} />
          ))}
        </div>
      ) : (
        <>
          {lead && (() => {
            const leadCard = <ContinueLeadBanner item={lead} wasDraggedRef={notDragged} onRemove={noRemove} self onMore={moreFor} />;
            return isTV
              ? <TVFocusable ringInside className={rest.length ? 'mb-3' : ''} onEnterPress={() => tvOpen(lead)}>{leadCard}</TVFocusable>
              : <div className={rest.length ? 'mb-3' : ''}>{leadCard}</div>;
          })()}
          {rest.length > 0 && (
            <ScrollRow className={isTV
              ? 'flex gap-3 pb-1'
              : 'grid grid-flow-col gap-3 pb-1 auto-cols-[82%] min-[640px]:auto-cols-[calc((100%-24px)/3)] min-[1100px]:auto-cols-[calc((100%-36px)/4)] min-[1700px]:auto-cols-[calc((100%-48px)/5)]'}>
              {rest.map((item, index) => {
                const card = <ContinueBannerCard item={item} priority={index < 6} wasDraggedRef={notDragged} onRemove={noRemove} self onMore={moreFor} />;
                return isTV
                  ? <TVFocusable key={item.showId} ringInside className="w-[300px] shrink-0" onEnterPress={() => tvOpen(item)}>{card}</TVFocusable>
                  : <div key={item.showId} className="min-w-0">{card}</div>;
              })}
            </ScrollRow>
          )}
        </>
      )}
      {menuFor && cards.some((c) => c.showId === menuFor.showId) && (() => {
        const { appUrl, href, app } = openingOf(menuFor);
        const own = choosesApp(menuFor);
        const row = 'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[15px] text-left text-default hover:bg-surface-hover transition-colors';
        const icon = 'w-[18px] h-[18px] shrink-0 text-muted';
        const canChoose = resume.apps.length > 0 || (resume.loaded?.devices.length ?? 0) > 0;
        const current = resume.current;
        const resumeName = current ? (current.id === 'web' ? 'browser' : current.id === 'shortcut' ? (rememberedShortcut()?.app || 'your app') : current.name) : '';
        return (
          <AnchoredPopup anchorRef={menuAnchor} onClose={closeMenu} title={menuFor.name} width={280} align="end">
            <div className="space-y-1 -mx-1">
              {own && !resume.loaded && <p className="px-3 py-2.5 text-[15px]" style={{ color: 'var(--color-text-muted)' }}>Checking your apps…</p>}
              {own && resume.loaded && canChoose && (
                <>
                  {current && resume.url ? (
                    <a
                      href={resume.url}
                      target={/^https?:/i.test(resume.url) ? '_blank' : undefined}
                      rel={/^https?:/i.test(resume.url) ? 'noopener noreferrer' : undefined}
                      onClick={closeMenu}
                      className={row}
                    >
                      <PlayIcon className={icon} />
                      {`Resume in ${resumeName}`}
                    </a>
                  ) : (
                    <button type="button" onClick={() => choose(menuFor)} className={row}>
                      <PlayIcon className={icon} />
                      Choose an app to resume in
                    </button>
                  )}
                  {current && resume.url && (
                    <button type="button" onClick={() => choose(menuFor)} className={row}>
                      <Squares2X2Icon className={icon} />
                      Choose app…
                    </button>
                  )}
                </>
              )}
              {(!own || (resume.loaded && !canChoose)) && href && (
                <a
                  href={href}
                  target={appUrl ? undefined : '_blank'}
                  rel={appUrl ? undefined : 'noopener noreferrer'}
                  onClick={closeMenu}
                  className={row}
                >
                  <PlayIcon className={icon} />
                  {appUrl ? `Resume in ${app}` : 'Open title page'}
                </a>
              )}
              <button type="button" onClick={() => remove(menuFor)} className={row}>
                <XMarkIcon className={icon} />
                Remove from Continue Watching
              </button>
              <p className="px-3 pt-1 text-xs" style={{ color: 'var(--color-text-subtle)' }}>Your watch history is kept.</p>
            </div>
          </AnchoredPopup>
        );
      })()}
      {pickerFor && resume.loaded && cards.some((c) => c.showId === pickerFor.showId) && (
        <AnchoredPopup anchorRef={menuAnchor} onClose={closePicker} label={`Choose the app for ${pickerFor.name}`} width={320} align="end">
          <div className="-mx-2">
            <OpenWithPicker
              targets={resume.loaded}
              apps={resume.apps}
              currentId={resume.current?.id ?? null}
              onPick={pickApp}
              onShortcutSaved={() => setShortcutSaved((n) => n + 1)}
              onPlayOn={playOn}
            />
          </div>
        </AnchoredPopup>
      )}
    </section>
  );
}

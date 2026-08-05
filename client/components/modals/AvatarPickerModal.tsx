'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Modal, Button } from '@/components/ui';
import { Avatar } from '@/components/ui/Avatar';
import { toast } from '@/components/ui/Toast';
import { api, NuvioCommunityCover } from '@/lib/api';

const COLOR_COUNT = 8;

interface AvatarPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  name: string;
  currentAvatarUrl?: string | null;
  currentColorIndex?: number;
  onSave: (data: { avatarUrl?: string | null; colorIndex?: number }) => Promise<void>;
  // Optional - when given a SlickSync-managed Nuvio user's id, an extra
  // "Nuvio Covers" tab appears, browsing nuvio.tv's own public Community
  // Covers gallery (GIFs/JPG/PNG) and letting a pick fill the Image URL tab
  // instead of the caller having to find+paste a URL from that site
  // manually. Omitted (the default) for every other AvatarPickerModal use
  // (Users/Groups/Catalogs avatars) - that gallery is Nuvio-cover-art
  // specific, not a generic avatar source.
  nuvioCoversUserId?: string;
  // This component is reused for both circular person/account avatars and
  // rectangular cover art (Catalogs, Nuvio Collections/folders) - the
  // "Change Avatar" title and round preview only made sense for the former.
  // Cover-art callers pass '' (no title bar at all - the redesigned rect
  // preview + tabs already read as a cover picker with no label needed)
  // and 'rect' here instead.
  title?: string;
  previewShape?: 'circle' | 'rect';
  // Cover pickers need real room - a big preview, a legible grid of Nuvio
  // covers - the original 'md' avatar-picker size was cramped for that.
  size?: 'md' | 'lg' | 'xl';
}

type Tab = 'color' | 'url' | 'upload' | 'nuvio';

export function AvatarPickerModal({
  isOpen,
  onClose,
  name,
  currentAvatarUrl,
  currentColorIndex,
  onSave,
  nuvioCoversUserId,
  title = 'Change Avatar',
  previewShape = 'circle',
  size = 'md',
}: AvatarPickerModalProps) {
  const [tab, setTab] = useState<Tab>(currentAvatarUrl ? 'url' : 'color');
  const [urlInput, setUrlInput] = useState(currentAvatarUrl || '');
  const [selectedColor, setSelectedColor] = useState(currentColorIndex ?? 0);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentAvatarUrl || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [nuvioCovers, setNuvioCovers] = useState<NuvioCommunityCover[]>([]);
  const [nuvioCoversLoading, setNuvioCoversLoading] = useState(false);
  const [nuvioCoversError, setNuvioCoversError] = useState<string | null>(null);
  const [nuvioPage, setNuvioPage] = useState(1);
  const [nuvioHasMore, setNuvioHasMore] = useState(false);
  const [nuvioOrientation, setNuvioOrientation] = useState<'all' | 'landscape' | 'portrait'>('all');
  const [nuvioFormat, setNuvioFormat] = useState<'all' | 'gif' | 'jpg' | 'png'>('all');
  // Client-side, not a server search param - nuvio.tv's own search box on
  // the live site never fired a distinct network request under observation
  // (possibly broken there, possibly debounced far longer than tested), so
  // rather than guess an unverified query param that could silently return
  // wrong/no results, this filters whatever pages are already loaded by
  // title. See the auto-load effect below for why a search term also pulls
  // in a few more pages automatically instead of only ever searching the
  // first 24 items.
  const [nuvioSearch, setNuvioSearch] = useState('');

  const loadNuvioCovers = useCallback(async (page: number, replace: boolean) => {
    if (!nuvioCoversUserId) return;
    setNuvioCoversLoading(true);
    setNuvioCoversError(null);
    try {
      const data = await api.getNuvioCommunityCovers(nuvioCoversUserId, {
        sort: 'recent', orientation: nuvioOrientation, format: nuvioFormat, page, limit: 24,
      });
      setNuvioCovers((prev) => (replace ? data.items : [...prev, ...data.items]));
      setNuvioHasMore(!!data.pagination?.hasNextPage);
      setNuvioPage(page);
    } catch (err: any) {
      setNuvioCoversError(err.message || 'Failed to load Nuvio covers');
    } finally {
      setNuvioCoversLoading(false);
    }
  }, [nuvioCoversUserId, nuvioOrientation, nuvioFormat]);

  // (Re)load whenever the tab is opened or a filter changes - not on every
  // render, and never for callers without nuvioCoversUserId at all.
  useEffect(() => {
    if (tab === 'nuvio' && nuvioCoversUserId) {
      loadNuvioCovers(1, true);
      setNuvioSearch('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, nuvioOrientation, nuvioFormat, nuvioCoversUserId]);

  const filteredNuvioCovers = nuvioSearch.trim()
    ? nuvioCovers.filter((c) => c.title?.toLowerCase().includes(nuvioSearch.trim().toLowerCase()))
    : nuvioCovers;

  // Debounced auto-load-more while actively searching - filtering only
  // pulls from whatever's already fetched, so a search for something not
  // among the first page(s) would otherwise look like "no results" even
  // though it might be a few pages further in. Capped at 8 total pages
  // (~192 covers) so a genuinely rare search term doesn't quietly page
  // through the entire catalog in the background.
  useEffect(() => {
    if (!nuvioSearch.trim() || nuvioCoversLoading || !nuvioHasMore || filteredNuvioCovers.length >= 6 || nuvioPage >= 8) return;
    const t = setTimeout(() => loadNuvioCovers(nuvioPage + 1, false), 400);
    return () => clearTimeout(t);
  }, [nuvioSearch, nuvioCoversLoading, nuvioHasMore, filteredNuvioCovers.length, nuvioPage, loadNuvioCovers]);

  const handlePickNuvioCover = (cover: NuvioCommunityCover) => {
    setUrlInput(cover.image_url);
    setPreviewUrl(cover.image_url);
    setTab('url');
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    try {
      const result = await api.uploadAvatar(file);
      setPreviewUrl(result.url);
      setUrlInput(result.url);
      toast.success('Image uploaded — click Save to apply it');
    } catch (err: any) {
      toast.error(err.message || 'Failed to upload image');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSaveColor = async () => {
    setIsSaving(true);
    try {
      await onSave({ colorIndex: selectedColor, avatarUrl: null });
      toast.success('Avatar updated');
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update avatar');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveImage = async () => {
    if (!urlInput.trim()) {
      toast.error('Enter an image URL or upload a file first');
      return;
    }
    setIsSaving(true);
    try {
      await onSave({ avatarUrl: urlInput.trim() });
      toast.success('Avatar updated');
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update avatar');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveImage = async () => {
    setIsSaving(true);
    try {
      await onSave({ avatarUrl: null });
      toast.success('Reverted to default avatar');
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update avatar');
    } finally {
      setIsSaving(false);
    }
  };

  const tabs: Tab[] = nuvioCoversUserId ? ['color', 'url', 'upload', 'nuvio'] : ['color', 'url', 'upload'];
  const tabLabel: Record<Tab, string> = { color: 'color', url: 'Image URL', upload: 'upload', nuvio: 'Nuvio Covers' };

  const filterButtonClass = (active: boolean) =>
    `px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${active ? '' : 'hover:bg-surface-hover'}`;
  const filterButtonStyle = (active: boolean) => ({
    background: active ? 'var(--color-primary)' : 'var(--color-surfaceHover)',
    color: active ? 'white' : 'var(--color-textMuted)',
  });

  // The Nuvio Covers grid needs real room to actually be pickable from - a
  // 3-across grid of tiny thumbnails at modal-md width was the "how could
  // anyone choose from that" complaint this whole size/layout pass exists
  // to fix. More columns only at the wider sizes cover callers actually use.
  const nuvioGridCols = size === 'xl' ? 'grid-cols-4' : size === 'lg' ? 'grid-cols-3' : 'grid-cols-2';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size={size}>
      <div className="space-y-4">
        {previewShape === 'circle' ? (
          <div className="flex justify-center mb-2">
            <Avatar
              name={name}
              src={tab === 'color' ? undefined : (previewUrl || undefined)}
              colorIndex={selectedColor}
              size="2xl"
            />
          </div>
        ) : (
          <div className={`w-full ${size === 'md' ? 'aspect-video' : 'aspect-[21/9]'} rounded-xl overflow-hidden bg-surface-hover mb-2 border border-default`}>
            {tab !== 'color' && previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="" className="w-full h-full object-cover" />
            ) : tab === 'color' ? (
              <div className="w-full h-full" style={{ background: `color-mix(in srgb, var(--color-${selectedColor < 4 ? 'primary' : 'secondary'}) ${100 - (selectedColor % 4) * 25}%, white)` }} />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-subtle">
                {name}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2 p-1 rounded-xl" style={{ background: 'var(--color-subtle)' }}>
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="flex-1 py-2 text-sm font-medium rounded-lg capitalize transition-all whitespace-nowrap"
              style={{
                background: tab === t ? 'var(--color-primary)' : 'transparent',
                color: tab === t ? 'white' : 'var(--color-textMuted)',
              }}
            >
              {tabLabel[t]}
            </button>
          ))}
        </div>

        {tab === 'color' && (
          <div>
            <div className="grid grid-cols-8 gap-2 mb-4">
              {Array.from({ length: COLOR_COUNT }).map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelectedColor(i)}
                  className="w-9 h-9 rounded-full transition-transform"
                  style={{
                    background: `color-mix(in srgb, var(--color-${i < 4 ? 'primary' : 'secondary'}) ${100 - (i % 4) * 25}%, white)`,
                    transform: selectedColor === i ? 'scale(1.15)' : 'scale(1)',
                    boxShadow: selectedColor === i ? '0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-primary)' : 'none',
                  }}
                />
              ))}
            </div>
            <Button variant="primary" className="w-full" onClick={handleSaveColor} isLoading={isSaving}>
              Use Color Avatar
            </Button>
          </div>
        )}

        {tab === 'url' && (
          <div className="space-y-3">
            <input
              type="url"
              placeholder="https://example.com/photo.jpg"
              value={urlInput}
              onChange={(e) => { setUrlInput(e.target.value); setPreviewUrl(e.target.value); }}
              className="w-full px-4 py-3 rounded-xl focus:outline-none"
              style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
            />
            <Button variant="primary" className="w-full" onClick={handleSaveImage} isLoading={isSaving}>
              Save Image URL
            </Button>
          </div>
        )}

        {tab === 'upload' && (
          <div className="space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              onChange={handleFileSelect}
              className="hidden"
            />
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => fileInputRef.current?.click()}
              isLoading={isUploading}
            >
              Choose Image File
            </Button>
            {previewUrl && urlInput && (
              <Button variant="primary" className="w-full" onClick={handleSaveImage} isLoading={isSaving}>
                Save Uploaded Image
              </Button>
            )}
          </div>
        )}

        {tab === 'nuvio' && nuvioCoversUserId && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              Browsing nuvio.tv's community-submitted covers - hover one to preview it up top, click to use it.
            </p>

            <input
              type="text"
              value={nuvioSearch}
              onChange={(e) => setNuvioSearch(e.target.value)}
              placeholder="Search by title (e.g. Netflix)..."
              className="w-full px-3 py-2 rounded-xl text-sm focus:outline-none"
              style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
            />

            <div className="flex flex-wrap items-center gap-2 p-2 rounded-xl" style={{ background: 'var(--color-subtle)' }}>
              <div className="flex gap-1">
                {(['all', 'landscape', 'portrait'] as const).map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => setNuvioOrientation(o)}
                    className={`${filterButtonClass(nuvioOrientation === o)} capitalize`}
                    style={filterButtonStyle(nuvioOrientation === o)}
                  >
                    {o}
                  </button>
                ))}
              </div>
              <span className="w-px h-5" style={{ background: 'var(--color-surface-border)' }} />
              <div className="flex gap-1">
                {(['all', 'gif', 'jpg', 'png'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setNuvioFormat(f)}
                    className={`${filterButtonClass(nuvioFormat === f)} uppercase`}
                    style={filterButtonStyle(nuvioFormat === f)}
                  >
                    {f === 'all' ? 'All formats' : f}
                  </button>
                ))}
              </div>
            </div>

            {nuvioCoversError ? (
              <p className="text-xs text-error py-4 text-center">{nuvioCoversError}</p>
            ) : filteredNuvioCovers.length === 0 && nuvioSearch.trim() && !nuvioCoversLoading ? (
              <p className="text-xs text-muted py-4 text-center">No covers matching &quot;{nuvioSearch.trim()}&quot; in what's loaded so far.</p>
            ) : (
              <div className={`grid ${nuvioGridCols} gap-3 max-h-[28rem] overflow-y-auto pr-1`}>
                {filteredNuvioCovers.map((cover) => (
                  <button
                    key={cover.id}
                    type="button"
                    onClick={() => handlePickNuvioCover(cover)}
                    onMouseEnter={() => setPreviewUrl(cover.image_url)}
                    onMouseLeave={() => setPreviewUrl(urlInput || null)}
                    title={cover.title || 'Use this cover'}
                    className="group relative aspect-video rounded-lg overflow-hidden border-2 border-default hover:border-primary transition-colors bg-surface-hover"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cover.image_url} alt={cover.title || ''} className="w-full h-full object-cover" loading="lazy" />
                    {cover.title && (
                      <div
                        className="absolute inset-x-0 bottom-0 px-2 py-1 text-[11px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ background: 'linear-gradient(0deg, rgba(0,0,0,0.75) 0%, transparent 100%)' }}
                      >
                        {cover.title}
                      </div>
                    )}
                  </button>
                ))}
                {nuvioCoversLoading && Array.from({ length: size === 'md' ? 4 : 8 }).map((_, i) => (
                  <div key={`skeleton-${i}`} className="aspect-video rounded-lg bg-surface-hover animate-pulse" />
                ))}
              </div>
            )}

            {!nuvioCoversError && nuvioHasMore && (
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={() => loadNuvioCovers(nuvioPage + 1, false)}
                isLoading={nuvioCoversLoading}
              >
                Load more
              </Button>
            )}
          </div>
        )}

        {currentAvatarUrl && tab !== 'nuvio' && (
          <button
            type="button"
            onClick={handleRemoveImage}
            className="w-full py-2 text-sm font-medium rounded-xl transition-colors"
            style={{ color: 'var(--color-error)' }}
          >
            Remove custom image
          </button>
        )}
      </div>
    </Modal>
  );
}

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
  // "Change Avatar" title and round preview only make sense for the former.
  // Cover-art callers pass a real title and 'rect' here instead.
  title?: string;
  previewShape?: 'circle' | 'rect';
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, nuvioOrientation, nuvioFormat, nuvioCoversUserId]);

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

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
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
          <div className="w-full aspect-video rounded-xl overflow-hidden bg-surface-hover mb-2">
            {tab !== 'color' && previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full" style={tab === 'color' ? { background: `color-mix(in srgb, var(--color-${selectedColor < 4 ? 'primary' : 'secondary'}) ${100 - (selectedColor % 4) * 25}%, white)` } : undefined} />
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
              Browsing nuvio.tv's community-submitted covers. Pick one to fill in the Image URL tab, then Save there.
            </p>

            <div className="flex flex-wrap gap-1.5">
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
              <span className="w-px my-0.5" style={{ background: 'var(--color-surface-border)' }} />
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

            {nuvioCoversError ? (
              <p className="text-xs text-error py-4 text-center">{nuvioCoversError}</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 max-h-72 overflow-y-auto pr-1">
                {nuvioCovers.map((cover) => (
                  <button
                    key={cover.id}
                    type="button"
                    onClick={() => handlePickNuvioCover(cover)}
                    title={cover.title || 'Use this cover'}
                    className="relative aspect-video rounded-lg overflow-hidden border border-default hover:border-primary transition-colors bg-surface-hover"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cover.image_url} alt={cover.title || ''} className="w-full h-full object-cover" loading="lazy" />
                  </button>
                ))}
                {nuvioCoversLoading && Array.from({ length: 6 }).map((_, i) => (
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

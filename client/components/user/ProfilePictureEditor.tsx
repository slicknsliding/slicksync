'use client';

// "Change your own picture", on a person's Settings page: their avatar is the
// button (with a pencil on it) and opens a popup beside it with Colour, Image
// link, Upload and - for a Nuvio sign-in - Nuvio Covers. The picture is kept by
// SlickSync, so it is the same for a Stremio, Nuvio, Jellyfin or AIOStreams
// person. Saving goes through the person's own sign-in; the server only ever
// changes their row.

import { useCallback, useEffect, useRef, useState } from 'react';
import { PencilIcon, PhotoIcon } from '@heroicons/react/24/solid';
import { Avatar, AvatarColorSwatches, Button, Input } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';
import { useUserAuth } from '@/lib/hooks/useUserAuth';
import { userAvatar, type NuvioCoversPage } from '@/lib/user-api';

type Tab = 'color' | 'url' | 'upload' | 'nuvio';
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function sizeLabel(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ProfilePictureEditor({ name, email }: { name: string; email?: string }) {
  const { userInfo } = useUserAuth();
  const rowRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);

  return (
    <div ref={rowRef} className="flex items-center gap-4 flex-wrap">
      <button
        type="button"
        onClick={toggle}
        aria-label="Change picture"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative shrink-0 rounded-full"
      >
        <Avatar
          name={name}
          email={email}
          src={userInfo?.avatarUrl || undefined}
          useGravatar={userInfo?.useGravatar}
          colorIndex={userInfo?.colorIndex || 0}
          size="xl"
          showRing
          className="w-[72px] h-[72px]"
        />
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 w-[26px] h-[26px] rounded-full flex items-center justify-center border-2"
          style={{ background: 'var(--color-primary)', borderColor: 'var(--color-bg)' }}
        >
          <PencilIcon className="w-3 h-3 text-white" />
        </span>
      </button>
      <div className="flex-1 min-w-[120px]">
        <h3 className="text-xl font-semibold break-words" style={{ color: 'var(--color-text)' }}>{name}</h3>
        <p className="text-sm break-all" style={{ color: 'var(--color-text-muted)' }}>{email}</p>
      </div>
      <Button type="button" variant="secondary" size="md" onClick={toggle} aria-haspopup="dialog" aria-expanded={open}>
        Change picture
      </Button>
      {open && <PicturePopup anchorRef={rowRef} name={name} email={email} onClose={() => setOpen(false)} />}
    </div>
  );
}

function PicturePopup({ anchorRef, name, email, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  name: string;
  email?: string;
  onClose: () => void;
}) {
  const { userId, authKey, provider, userInfo, applyUserInfo } = useUserAuth();
  const isNuvio = provider === 'nuvio';
  const current = userInfo?.avatarUrl || null;
  const [tab, setTab] = useState<Tab>(current ? 'url' : 'color');
  const [color, setColor] = useState(userInfo?.colorIndex || 0);
  const [link, setLink] = useState(current && /^https?:/i.test(current) ? current : '');
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) { setFilePreview(null); return; }
    const url = URL.createObjectURL(file);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // What the circle at the top shows: whatever the open tab would save.
  const preview = tab === 'url' ? (link.trim() || undefined) : tab === 'upload' ? (filePreview || undefined) : undefined;
  const previewColor = tab === 'color' ? color : (userInfo?.colorIndex || 0);

  const chooseFile = (picked: File | undefined) => {
    if (!picked) return;
    if (!TYPES.includes(picked.type)) { toast.error('Choose a JPEG, PNG, GIF or WEBP picture'); return; }
    if (picked.size > MAX_BYTES) { toast.error('That picture is over 5 MB'); return; }
    setFile(picked);
  };

  const done = (patch: { avatarUrl?: string | null; colorIndex?: number }) => {
    applyUserInfo(patch);
    toast.success('Picture updated');
    onClose();
  };

  const save = async () => {
    if (!userId || !authKey || saving) return;
    setSaving(true);
    try {
      if (tab === 'color') {
        const r = await userAvatar.update(userId, authKey, { colorIndex: color, avatarUrl: null });
        done({ colorIndex: r.colorIndex, avatarUrl: r.avatarUrl });
      } else if (tab === 'upload') {
        if (!file) { toast.error('Choose a picture first'); return; }
        const r = await userAvatar.upload(userId, authKey, file);
        done({ avatarUrl: r.avatarUrl });
      } else {
        if (!link.trim()) { toast.error('Paste a link to a picture first'); return; }
        const r = await userAvatar.update(userId, authKey, { avatarUrl: link.trim() });
        done({ avatarUrl: r.avatarUrl });
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not change your picture');
    } finally {
      setSaving(false);
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'color', label: 'Colour' },
    { id: 'url', label: 'Image link' },
    { id: 'upload', label: 'Upload' },
    ...(isNuvio ? [{ id: 'nuvio' as Tab, label: 'Nuvio Covers' }] : []),
  ];

  return (
    <AnchoredPopup anchorRef={anchorRef} onClose={onClose} title="Change picture" width={360}>
      <div className="flex items-center gap-3.5">
        <Avatar name={name} email={email} src={preview} colorIndex={previewColor} size="xl" className="w-[72px] h-[72px] shrink-0" />
        <p className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>
          {tab === 'color' ? 'Initial on the colour you pick.' : 'An animated picture keeps moving everywhere it shows.'}
        </p>
      </div>

      <div role="tablist" aria-label="Picture source" className="flex gap-1 p-1 my-3 rounded-full" style={{ background: 'var(--color-surface-elevated)' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 min-w-0 px-2 py-1.5 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors ${tab === t.id ? 'bg-surface-hover text-default' : 'text-muted hover:text-default'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'color' && (
        <div>
          <p className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>Pick a colour</p>
          <AvatarColorSwatches value={color} onChange={setColor} />
        </div>
      )}

      {tab === 'url' && (
        <div>
          <label htmlFor="picture-link" className="block text-xs mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Link to a picture or a .gif</label>
          <Input
            id="picture-link"
            type="url"
            inputMode="url"
            placeholder="https://example.com/me.gif"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          />
          <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-subtle)' }}>A .gif plays animated. Any direct image link works.</p>
        </div>
      )}

      {tab === 'upload' && (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept={TYPES.join(',')}
            className="hidden"
            data-testid="picture-file"
            onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left border border-dashed border-default hover:bg-surface-hover transition-colors"
          >
            <PhotoIcon className="w-6 h-6 shrink-0 text-muted" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-default">{file ? 'Choose a different picture' : 'Choose a picture or .gif'}</span>
              <span className="block text-xs text-muted truncate">{file ? `${file.name} · ${sizeLabel(file.size)}` : 'JPEG, PNG, GIF or WEBP, up to 5 MB'}</span>
            </span>
          </button>
        </div>
      )}

      {tab === 'nuvio' && isNuvio && (
        <NuvioCovers onPick={(url) => { setLink(url); setTab('url'); }} />
      )}

      {tab !== 'nuvio' && (
        <Button type="button" variant="primary" size="md" className="w-full mt-3" isLoading={saving} onClick={save} disabled={tab === 'upload' && !file}>
          Save
        </Button>
      )}
    </AnchoredPopup>
  );
}

// nuvio.tv's public cover gallery. A pick fills the Image link tab, so the
// person sees it in the circle before saving.
function NuvioCovers({ onPick }: { onPick: (url: string) => void }) {
  const { userId, authKey } = useUserAuth();
  const [items, setItems] = useState<NuvioCoversPage['items']>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next: number) => {
    if (!userId || !authKey) return;
    setLoading(true);
    setError(null);
    try {
      const data = await userAvatar.nuvioCovers(userId, authKey, { page: next });
      setItems((prev) => (next === 1 ? data.items : [...prev, ...data.items]));
      setMore(!!data.pagination?.hasNextPage);
      setPage(next);
    } catch (e) {
      setError((e as Error)?.message || 'Could not load covers');
    } finally {
      setLoading(false);
    }
  }, [userId, authKey]);

  useEffect(() => { void load(1); }, [load]);

  return (
    <div>
      <p className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>Covers from nuvio.tv</p>
      {error ? (
        <p className="text-xs text-error py-3 text-center">{error}</p>
      ) : (
        <div className="grid grid-cols-4 gap-2 max-h-[220px] overflow-y-auto">
          {items.map((cover) => (
            <button
              key={cover.id}
              type="button"
              onClick={() => onPick(cover.image_url)}
              title={cover.title || 'Use this cover'}
              className="aspect-square rounded-lg overflow-hidden border border-default hover:ring-2 hover:ring-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cover.image_url} alt={cover.title || ''} className="w-full h-full object-cover" loading="lazy" />
            </button>
          ))}
          {loading && Array.from({ length: 8 }).map((_, i) => (
            <div key={`s${i}`} className="aspect-square rounded-lg animate-pulse" style={{ background: 'var(--color-surface-elevated)' }} />
          ))}
        </div>
      )}
      {!loading && !error && more && (
        <Button type="button" variant="ghost" size="sm" className="w-full mt-2" onClick={() => load(page + 1)}>Show more</Button>
      )}
    </div>
  );
}

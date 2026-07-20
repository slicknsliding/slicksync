'use client';

import { useState, useRef } from 'react';
import { Modal, Button } from '@/components/ui';
import { Avatar } from '@/components/ui/Avatar';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';

const COLOR_COUNT = 8;

interface AvatarPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  name: string;
  currentAvatarUrl?: string | null;
  currentColorIndex?: number;
  onSave: (data: { avatarUrl?: string | null; colorIndex?: number }) => Promise<void>;
}

export function AvatarPickerModal({
  isOpen,
  onClose,
  name,
  currentAvatarUrl,
  currentColorIndex,
  onSave,
}: AvatarPickerModalProps) {
  const [tab, setTab] = useState<'color' | 'url' | 'upload'>(currentAvatarUrl ? 'url' : 'color');
  const [urlInput, setUrlInput] = useState(currentAvatarUrl || '');
  const [selectedColor, setSelectedColor] = useState(currentColorIndex ?? 0);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentAvatarUrl || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Change Avatar" size="md">
      <div className="space-y-4">
        <div className="flex justify-center mb-2">
          <Avatar
            name={name}
            src={tab === 'color' ? undefined : (previewUrl || undefined)}
            colorIndex={selectedColor}
            size="2xl"
          />
        </div>

        <div className="flex gap-2 p-1 rounded-xl" style={{ background: 'var(--color-subtle)' }}>
          {(['color', 'url', 'upload'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="flex-1 py-2 text-sm font-medium rounded-lg capitalize transition-all"
              style={{
                background: tab === t ? 'var(--color-primary)' : 'transparent',
                color: tab === t ? 'white' : 'var(--color-textMuted)',
              }}
            >
              {t === 'url' ? 'Image URL' : t}
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

        {currentAvatarUrl && (
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

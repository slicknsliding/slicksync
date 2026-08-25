'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { ExclamationTriangleIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';

// Two-phase share flow, used by every share-code producer (catalogs, Nuvio
// collections, addon templates). Phase one states exactly WHAT the code
// will contain and requires an explicit "Generate code" click - a share is
// never one accidental tap, and never a bare toggle whose effect you have
// to guess (that ambiguity was called out on the older catalog share
// toggle specifically). Phase two shows the code with a copy button.
//
// `warning` renders as a loud callout - addon templates MUST pass one,
// since manifest URLs can embed debrid/API keys and sharing the code
// shares those keys.
interface ShareCodeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Plain statement of what the code will contain, e.g. "the catalog
   * \"Halloween\" and its 42 titles". */
  summary: string;
  warning?: string;
  /** Called on the explicit confirm; returns the code (may fetch). */
  generate: () => Promise<string> | string;
}

export function ShareCodeDialog({ isOpen, onClose, title, summary, warning, generate }: ShareCodeDialogProps) {
  const [code, setCode] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      setCode(await generate());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to generate the code');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast.success('Code copied');
    } catch {
      toast.error('Could not copy - select the text and copy manually');
    }
  };

  const handleClose = () => {
    setCode(null);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="md">
      <div className="space-y-4">
        {!code ? (
          <>
            <p className="text-sm text-muted">
              This will produce a copy-paste code containing <span className="text-default font-medium">{summary}</span>.
              Anyone you give the code to can import it into their own SlickSync.
            </p>
            {warning && (
              <div className="flex items-start gap-2.5 p-3 rounded-xl" style={{ background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--color-warning) 35%, transparent)' }}>
                <ExclamationTriangleIcon className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
                <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text)' }}>{warning}</p>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={handleGenerate} disabled={generating}>
                {generating ? 'Generating…' : 'Generate code'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <textarea
              readOnly
              value={code}
              rows={5}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full px-3 py-2 rounded-lg text-xs font-mono border border-transparent focus:border-primary focus:outline-none resize-none"
              style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text)' }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={handleClose}>Done</Button>
              <Button variant="primary" size="sm" leftIcon={<ClipboardDocumentIcon className="w-4 h-4" />} onClick={handleCopy}>
                Copy code
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// Companion paste box for the import side - one textarea, one validate-on-
// submit callback. The caller owns what "import" means (stage vs create).
interface PasteCodeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  placeholder?: string;
  /** Throws (or returns a rejected promise) with a user-showable message
   * when the pasted text isn't acceptable. Closing happens on success. */
  onImport: (text: string) => Promise<void> | void;
}

export function PasteCodeDialog({ isOpen, onClose, title, placeholder, onImport }: PasteCodeDialogProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const handleClose = () => {
    setText('');
    onClose();
  };

  const handleImport = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onImport(text.trim());
      handleClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That code isn\'t valid');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="md">
      <div className="space-y-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder={placeholder || 'Paste a share code…'}
          spellCheck={false}
          className="w-full px-3 py-2 rounded-lg text-xs font-mono border border-transparent focus:border-primary focus:outline-none resize-none"
          style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text)' }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleImport} disabled={busy || !text.trim()}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

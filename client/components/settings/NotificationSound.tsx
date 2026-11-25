'use client';

import { useNotifySound } from '@/lib/arrange';
import { SOUNDS, playSound } from '@/lib/notifySound';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

/**
 * Settings → Notifications: a short sound when a notification arrives while
 * SlickSync is open - a switch, the sound, and how loud. Saved to the account.
 */
export function NotificationSound() {
  const { sound, setSound } = useNotifySound();
  return (
    <div data-setting="Notification sound">
      <div className="flex items-center gap-3.5">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm text-default">Notification sound</p>
          <p className="text-xs text-muted">A short sound when a notification arrives while SlickSync is open. When it is closed, your device plays its own notification sound.</p>
        </div>
        <ToggleSwitch checked={sound.on} onChange={() => setSound({ on: !sound.on })} />
      </div>
      <div className={sound.on ? '' : 'opacity-50 pointer-events-none'}>
        <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Sound">
          {SOUNDS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={sound.kind === s.id}
              className={`v2-btn sound-pick${sound.kind === s.id ? ' on' : ''}`}
              onClick={() => { setSound({ kind: s.id }); playSound(s.id, sound.volume); }}
            >
              {s.name}
            </button>
          ))}
        </div>
        <label className="mt-3 flex items-center gap-3 text-sm text-default">
          <span className="font-medium">Volume</span>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(sound.volume * 100)}
            aria-label="Notification sound volume"
            className="w-44"
            style={{ accentColor: 'var(--color-primary)' }}
            onChange={(e) => setSound({ volume: Number(e.target.value) / 100 })}
            onPointerUp={(e) => playSound(sound.kind, Number((e.target as HTMLInputElement).value) / 100)}
            onKeyUp={(e) => playSound(sound.kind, Number((e.target as HTMLInputElement).value) / 100)}
          />
        </label>
      </div>
    </div>
  );
}

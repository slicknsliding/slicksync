// The notification sound (Settings → Notifications): a short sound when a
// notification arrives while SlickSync is open. Made on the spot with the
// browser's own tone generator, so there are no sound files to load. A push
// that arrives while SlickSync is closed uses the device's own notification
// sound; a web app cannot choose that one.

export const SOUNDS = [
  { id: 'rise', name: 'Rise' },
  { id: 'ding', name: 'Soft ding' },
  { id: 'chime', name: 'Two-note chime' },
  { id: 'pop', name: 'Pop' },
  { id: 'glass', name: 'Glass' },
  { id: 'bell', name: 'Small bell' },
  { id: 'marimba', name: 'Marimba' },
  { id: 'droplet', name: 'Droplet' },
  { id: 'sparkle', name: 'Sparkle' },
  { id: 'harp', name: 'Harp' },
  { id: 'knock', name: 'Knock' },
  { id: 'blip', name: 'Blip' },
] as const;

export type SoundId = typeof SOUNDS[number]['id'];
export type SoundSetting = { on: boolean; kind: SoundId; volume: number };
/** What is saved: only what differs from the default. */
export type SoundSaved = Partial<SoundSetting>;

export const SOUND_DEFAULT: SoundSetting = { on: true, kind: 'rise', volume: 0.5 };

export function soundChoice(saved: SoundSaved | undefined): SoundSetting {
  const kind = SOUNDS.some((s) => s.id === saved?.kind) ? (saved!.kind as SoundId) : SOUND_DEFAULT.kind;
  const volume = typeof saved?.volume === 'number' && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : SOUND_DEFAULT.volume;
  return { on: typeof saved?.on === 'boolean' ? saved.on : SOUND_DEFAULT.on, kind, volume };
}

export function soundToSave(s: SoundSetting): SoundSaved | undefined {
  const out: SoundSaved = {};
  if (s.on !== SOUND_DEFAULT.on) out.on = s.on;
  if (s.kind !== SOUND_DEFAULT.kind) out.kind = s.kind;
  if (s.volume !== SOUND_DEFAULT.volume) out.volume = s.volume;
  return Object.keys(out).length ? out : undefined;
}

type Ctx = AudioContext;
let ctx: Ctx | null = null;

/**
 * Plays one of the sounds. A browser only lets a page make sound once it has
 * been clicked or tapped since it opened; before that this does nothing.
 */
export function playSound(kind: SoundId, volume = SOUND_DEFAULT.volume): void {
  if (typeof window === 'undefined') return;
  try {
    const Make = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Make) return;
    ctx = ctx || new Make();
    const ac = ctx;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const t = ac.currentTime + 0.01;
    const out = ac.createGain();
    out.gain.value = Math.max(0, Math.min(1, volume));
    out.connect(ac.destination);
    // One note: pitch, when, how long, wave, loudness, a pitch to slide to, and how fast it starts.
    const note = (f: number, at: number, len: number, type: OscillatorType = 'sine', peak = 0.5, to = 0, attack = 0.012) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t + at);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + at + len * 0.8);
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(peak, t + at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + len);
      o.connect(g);
      g.connect(out);
      o.start(t + at);
      o.stop(t + at + len + 0.05);
    };
    switch (kind) {
      case 'ding': note(880, 0, 0.7); note(1760, 0, 0.35, 'sine', 0.15); break;
      case 'chime': note(784, 0, 0.45); note(1047, 0.13, 0.7); note(2094, 0.13, 0.3, 'sine', 0.1); break;
      case 'pop': note(520, 0, 0.14, 'triangle', 0.6, 240); break;
      case 'glass': note(1568, 0, 1.1, 'sine', 0.35); note(2349, 0, 0.8, 'sine', 0.18); note(3136, 0, 0.5, 'sine', 0.08); break;
      case 'bell': note(660, 0, 1.4, 'sine', 0.4); note(660 * 2.76, 0, 0.9, 'sine', 0.2); note(660 * 5.4, 0, 0.45, 'sine', 0.1); note(660 * 8.93, 0, 0.2, 'sine', 0.05); break;
      case 'marimba': note(523, 0, 0.5, 'sine', 0.55, 0, 0.004); note(2093, 0, 0.09, 'sine', 0.2, 0, 0.002); note(659, 0.14, 0.6, 'sine', 0.5, 0, 0.004); note(2637, 0.14, 0.09, 'sine', 0.18, 0, 0.002); break;
      case 'droplet': note(620, 0, 0.11, 'sine', 0.5, 1500); note(1240, 0.1, 0.35, 'sine', 0.18); break;
      case 'sparkle': note(1319, 0, 0.3, 'sine', 0.3); note(1568, 0.07, 0.3, 'sine', 0.3); note(2093, 0.14, 0.55, 'sine', 0.3); note(4186, 0.14, 0.25, 'sine', 0.06); break;
      case 'harp': note(392, 0, 0.9, 'triangle', 0.35, 0, 0.004); note(494, 0.06, 0.9, 'triangle', 0.33, 0, 0.004); note(587, 0.12, 0.9, 'triangle', 0.31, 0, 0.004); note(784, 0.18, 1.1, 'triangle', 0.3, 0, 0.004); break;
      case 'knock': note(190, 0, 0.09, 'sine', 0.8, 90, 0.003); note(190, 0.16, 0.09, 'sine', 0.7, 90, 0.003); break;
      case 'blip': note(880, 0, 0.07, 'triangle', 0.4); note(1175, 0.08, 0.12, 'triangle', 0.4); break;
      default: note(440, 0, 0.28, 'sine', 0.4, 880, 0.06); note(880, 0.26, 0.5, 'sine', 0.3);
    }
  } catch { /* no sound on this device */ }
}

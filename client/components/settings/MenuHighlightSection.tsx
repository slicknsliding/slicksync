'use client';

// Settings → Themes → Menu highlight: the ten styles as tiles, the light
// panel for Orbit and Aurora, colour, strength, a live preview and Reset.
// The choice itself lives in lib/menuHighlight.tsx.

import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowPathIcon, CheckIcon, InformationCircleIcon, PlayIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  useMenuHighlight, menuHighlightFxMarkup, MH_FILLS, MH_EDGES, MH_DEFAULT,
  type MenuHighlight, type MhStyle,
} from '@/lib/menuHighlight';

const STYLES: Record<MhStyle, [string, string]> = {
  soft: ['Soft', 'A tint of the colour behind it'],
  solid: ['Solid', 'Filled with the colour'],
  bar: ['Side bar', 'A tint and a bar on the left'],
  outline: ['Outline', 'A ring around it'],
  edge: ['Edge', 'A bright edge that fades out'],
  edgeGlow: ['Edge and glow', 'The edge, with a glow inside'],
  ringGlow: ['Ring and glow', 'A full ring, with a glow inside'],
  softRing: ['Soft ring', 'A full ring that softens'],
  orbit: ['Orbit', 'A light goes round a thin ring'],
  aurora: ['Aurora', 'A glow of colours runs round the edge'],
};

export function menuHighlightName(style: MhStyle) {
  return STYLES[style][0];
}

const COLOURS: { id: MenuHighlight['colour']; name: string; c: string; dark: boolean }[] = [
  { id: 'accent', name: 'Theme accent', c: 'var(--color-primary)', dark: false },
  { id: 'white', name: 'White', c: '#ffffff', dark: true },
  { id: 'blue', name: 'Blue', c: '#60a5fa', dark: false },
  { id: 'green', name: 'Green', c: '#34d399', dark: true },
  { id: 'amber', name: 'Amber', c: '#fbbf24', dark: true },
  { id: 'pink', name: 'Pink', c: '#f472b6', dark: false },
];

const MUTED = 'var(--color-text-muted)';
const BORDER = 'var(--color-surface-border)';

function CircleArrow({ acw }: { acw?: boolean }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-[15px] h-[15px] shrink-0" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={acw ? 'M5.94 8.5A7 7 0 1 0 12 5M12 5 14.5 2.5M12 5 14.5 7.5' : 'M18.06 8.5A7 7 0 1 1 12 5M12 5 9.5 2.5M12 5 9.5 7.5'} />
    </svg>
  );
}

function Label({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-2.5 flex-wrap">
      <span className="text-sm font-semibold text-default">{text}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold tracking-[.06em] uppercase text-muted mb-2">{children}</div>;
}

/** A row lit in a style, drawn by React (the previews); live menus are lit by lib/menuHighlight. */
function Lit({ style, r, className, children }: { style: MhStyle; r: number; className: string; children: ReactNode }) {
  return (
    <div data-mh={style} className={className} style={{ '--mh-rx': `${r - 0.75}px`, '--mh-r': `${r}px`, borderRadius: r } as CSSProperties}>
      {children}
      {!MH_FILLS.includes(style) && <span className="mh-fx" aria-hidden="true" dangerouslySetInnerHTML={{ __html: menuHighlightFxMarkup() }} />}
    </div>
  );
}

function Pills<T extends string>({ label, value, options, onChange, disabled }: {
  label: string; value: T; options: [T, ReactNode][]; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className="inline-flex flex-wrap gap-0.5 p-[3px] rounded-full max-w-full"
      style={{ border: `1px solid ${BORDER}`, background: 'var(--color-bg-subtle)', opacity: disabled ? 0.45 : undefined }}
    >
      {options.map(([id, name]) => {
        const on = id === value;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(id)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-[7px] rounded-full text-[13px] whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? 'font-semibold' : 'font-medium'} ${disabled ? 'cursor-default' : 'cursor-pointer'}`}
            style={{ background: on ? 'var(--color-primary-solid)' : 'transparent', color: on ? 'var(--color-on-primary-solid, #fff)' : MUTED }}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}

function Tile({ id, on, onPick }: { id: MhStyle; on: boolean; onPick: () => void }) {
  const [name, blurb] = STYLES[id];
  const moves = id === 'orbit' || id === 'aurora';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className="relative flex flex-col gap-2.5 p-3 rounded-[14px] text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      style={{ background: on ? 'var(--color-primary-muted)' : 'var(--color-bg-subtle)', border: on ? '2px solid var(--color-primary)' : `1px solid ${BORDER}` }}
    >
      <div aria-hidden="true" className="flex flex-col gap-[3px] p-[5px] rounded-[10px] w-full" style={{ background: 'var(--color-surface)', border: `1px solid ${BORDER}` }}>
        {(['Resume', 'Details', 'Remove'] as const).map((t, i) => {
          const Icon = i === 0 ? PlayIcon : i === 1 ? InformationCircleIcon : XMarkIcon;
          const body = <><Icon className="w-[13px] h-[13px] shrink-0" style={{ color: MUTED }} />{t}</>;
          const cls = 'flex items-center gap-[7px] px-2 py-1.5 text-xs text-default';
          return i === 1
            ? <Lit key={t} style={id} r={7} className={cls}>{body}</Lit>
            : <div key={t} className={cls} style={{ borderRadius: 7 }}>{body}</div>;
        })}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 flex-wrap text-sm font-semibold text-default">
          {name}
          {id === MH_DEFAULT.style && (
            <span className="text-[10px] font-semibold tracking-[.04em] uppercase text-muted rounded-full px-1.5 py-px" style={{ border: `1px solid ${BORDER}` }}>Default</span>
          )}
          {moves && (
            <span className="text-[10px] font-semibold tracking-[.04em] uppercase rounded-full px-1.5 py-px" style={{ color: 'var(--color-secondary)', border: '1px solid color-mix(in srgb, var(--color-secondary) 40%, transparent)' }}>Moves</span>
          )}
        </span>
        <span className="text-xs text-muted leading-[1.35]">{blurb}</span>
      </div>
      {on && (
        <span className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center z-[2]" style={{ background: 'var(--color-primary-solid)' }}>
          <CheckIcon className="w-3 h-3" strokeWidth={2.5} style={{ color: 'var(--color-on-primary-solid, #fff)' }} />
        </span>
      )}
    </button>
  );
}

function Swatch({ name, c, dark, on, onPick, extra }: { name: string; c: string; dark: boolean; on: boolean; onPick: () => void; extra?: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={name}
      onClick={onPick}
      className="flex flex-col items-center gap-1.5 w-20 cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span
        className="w-[34px] h-[34px] rounded-full flex items-center justify-center"
        style={{ background: c, boxShadow: on ? '0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-primary)' : 'inset 0 0 0 1px rgba(255,255,255,.18)' }}
      >
        {on && <CheckIcon className="w-[15px] h-[15px]" strokeWidth={2.5} style={{ color: dark ? '#0b0b10' : '#fff' }} />}
      </span>
      <span className={`text-[11.5px] leading-[1.25] text-center whitespace-nowrap ${on ? 'font-semibold text-default' : 'text-muted'}`}>
        {name}
        {extra}
      </span>
    </button>
  );
}

/** The bright half of a custom colour decides the check mark's colour. */
function isLight(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

export function MenuHighlightSettings() {
  const [mh, set] = useMenuHighlight();
  const isFill = MH_FILLS.includes(mh.style);
  const picker = useRef<HTMLInputElement>(null);
  // The preview's lit option: Details, or the one the pointer or finger is on.
  const [hover, setHover] = useState<number | null>(null);
  const previewOn = hover ?? 1;
  // A new choice lights the preview again from the start.
  const replay = JSON.stringify(mh);

  const waitOptions: [MenuHighlight['wait'], string][] = [['now', 'Right away'], ['half', 'After a moment'], ['long', 'After a longer wait']];
  const speedOptions: [MenuHighlight['speed'], string][] = [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']];
  const cw: ReactNode = <><CircleArrow />Clockwise</>;
  const acw: ReactNode = <><CircleArrow acw />Anticlockwise</>;

  return (
    <div className="flex flex-col gap-[26px]">
      <div>
        <Label text="Style" />
        <Group>Fills</Group>
        <div role="radiogroup" aria-label="Fills" className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {MH_FILLS.map((id) => <Tile key={id} id={id} on={mh.style === id} onPick={() => set({ style: id })} />)}
        </div>
        <Group>Edges and lights</Group>
        <div role="radiogroup" aria-label="Edges and lights" className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {MH_EDGES.map((id) => <Tile key={id} id={id} on={mh.style === id} onPick={() => set({ style: id })} />)}
        </div>

        {(mh.style === 'orbit' || mh.style === 'aurora') && (
          <div className="mt-3.5 px-4 py-3.5 rounded-[14px] flex flex-col gap-3.5" style={{ border: `1px solid ${BORDER}`, background: 'var(--color-bg-subtle)' }}>
            <div className="text-[13px] font-semibold text-default">{mh.style === 'orbit' ? 'Orbit' : 'Aurora'} light</div>
            {mh.style === 'orbit' ? (
              <>
                <div><Label text="Light starts" hint="how long the pointer rests before the light comes on" /><Pills label="Light starts" value={mh.wait} options={waitOptions} onChange={(v) => set({ wait: v })} /></div>
                <div><Label text="Goes round" /><Pills label="Goes round" value={mh.laps} options={[['four', '4 times, then a still ring'], ['always', 'The whole time']]} onChange={(v) => set({ laps: v })} /></div>
                <div><Label text="Direction" /><Pills label="Direction" value={mh.dir} options={[['cw', cw], ['acw', acw]]} onChange={(v) => set({ dir: v })} /></div>
                <div><Label text="Speed" hint="one lap takes 4, 2.6 or 1.6 seconds" /><Pills label="Speed" value={mh.speed} options={speedOptions} onChange={(v) => set({ speed: v })} /></div>
              </>
            ) : (
              <>
                <div><Label text="Light starts" hint="how long the pointer rests before the light comes on" /><Pills label="Light starts" value={mh.auwait} options={waitOptions} onChange={(v) => set({ auwait: v })} /></div>
                <div><Label text="Goes round" /><Pills label="Goes round" value={mh.aulaps} options={[['always', 'The whole time'], ['four', '4 times, then a still glow']]} onChange={(v) => set({ aulaps: v })} /></div>
                <div><Label text="Direction" /><Pills label="Direction" value={mh.audir} options={[['acw', acw], ['cw', cw]]} onChange={(v) => set({ audir: v })} /></div>
                <div><Label text="Speed" hint="one lap takes 3.2, 2 or 1.25 seconds" /><Pills label="Speed" value={mh.auspeed} options={speedOptions} onChange={(v) => set({ auspeed: v })} /></div>
                <div><Label text="Colours" /><Pills label="Colours" value={mh.aucolours} options={[['warm', 'Warm to cool'], ['own', 'Your colour']]} onChange={(v) => set({ aucolours: v })} /></div>
              </>
            )}
          </div>
        )}
      </div>

      <div>
        <Label text="Colour" />
        <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-x-1.5 gap-y-2.5">
          {COLOURS.map((x) => (
            <Swatch
              key={x.id}
              name={x.name}
              c={x.c}
              dark={x.dark}
              on={mh.colour === x.id}
              onPick={() => set({ colour: x.id })}
              extra={x.id === 'accent' ? <><br /><span className="text-[10px] font-normal text-muted">default</span></> : undefined}
            />
          ))}
          {mh.colour === 'custom' ? (
            <Swatch name="Custom" c={mh.custom} dark={isLight(mh.custom)} on onPick={() => picker.current?.click()} />
          ) : (
            <button
              type="button"
              role="radio"
              aria-checked={false}
              aria-label="Custom colour"
              onClick={() => picker.current?.click()}
              className="flex flex-col items-center gap-1.5 w-20 cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="w-[34px] h-[34px] rounded-full flex items-center justify-center" style={{ background: 'conic-gradient(#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f472b6,#f87171)' }}>
                <span className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: 'var(--color-surface)' }}>
                  <PlusIcon className="w-[13px] h-[13px] text-default" strokeWidth={2.2} />
                </span>
              </span>
              <span className="text-[11.5px] text-muted">Custom</span>
            </button>
          )}
          <input
            ref={picker}
            type="color"
            value={mh.custom}
            onChange={(e) => set({ colour: 'custom', custom: e.target.value })}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>
      </div>

      <div>
        <Label text="Strength" hint={isFill ? 'How much colour shows' : 'For the fills; edges and lights always use the full colour'} />
        <Pills
          label="Strength"
          value={mh.strength}
          options={[['subtle', 'Subtle'], ['medium', 'Medium'], ['strong', 'Strong']]}
          onChange={(v) => set({ strength: v })}
          disabled={!isFill || mh.style === 'solid'}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)] gap-[22px] items-center">
        <div>
          <Label text="Preview" />
          <div
            aria-hidden="true"
            className="w-full max-w-[300px] py-1.5 rounded-xl"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-popup-border, var(--color-surface-border))', boxShadow: '0 20px 50px -14px rgba(0,0,0,.85), 0 3px 10px rgba(0,0,0,.45)' }}
            onPointerLeave={() => setHover(null)}
          >
            <div className="flex items-center justify-between px-4 pt-2 pb-1.5">
              <span className="text-sm font-semibold text-default">Resident Evil</span>
              <XMarkIcon className="w-[18px] h-[18px]" style={{ color: MUTED }} />
            </div>
            {([[PlayIcon, 'Choose an app to resume in'], [InformationCircleIcon, 'Details'], [XMarkIcon, 'Remove from Continue Watching']] as const).map(([Icon, t], i) => {
              const cls = 'mx-2 my-[3px] flex items-center gap-3 px-3 py-2.5 text-[15px] text-default cursor-default';
              const body = <><Icon className="w-[18px] h-[18px] shrink-0" style={{ color: MUTED }} />{t}</>;
              return (
                <div key={t} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
                  {i === previewOn
                    ? <Lit key={replay} style={mh.style} r={10} className={cls}>{body}</Lit>
                    : <div className={cls} style={{ borderRadius: 10 }}>{body}</div>}
                </div>
              );
            })}
            <div className="px-5 pt-1.5 pb-2 text-xs text-muted">Their watch history is kept.</div>
          </div>
        </div>
        <div className="flex flex-col gap-3 items-start">
          <p className="m-0 text-[13px] leading-[1.5] text-muted max-w-[420px]">Used in every menu that pops up: right-click or press-and-hold on a poster, Open in, user and addon menus, pickers. On a phone it shows while your finger is on an option; with a TV remote or keyboard, on the option you are on.</p>
          <p className="m-0 text-[13px] leading-[1.5] text-muted max-w-[420px]">Orbit and Aurora move only on the option you are on, and stand still if your device asks for less motion. Saved to your account, so it follows you to every device.</p>
          <button
            type="button"
            onClick={() => set(null)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[13px] font-medium text-default cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            style={{ border: `1px solid ${BORDER}`, background: 'var(--color-bg-subtle)' }}
          >
            <ArrowPathIcon className="w-4 h-4" style={{ color: MUTED }} />
            Reset to default
          </button>
        </div>
      </div>
    </div>
  );
}

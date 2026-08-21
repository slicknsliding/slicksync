// Wizard hat resting on a stack of three books - the command palette's
// icon. Drawn as inline SVG rather than an emoji so it renders identically
// on every platform (the closest real emoji, 🧙, is wildly different on
// Apple vs. Google vs. Windows) and so the colours stay fixed regardless of
// the active theme - it reads as an illustration, not a UI glyph.
export function WizardBooksIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}

      {/* ---- Books, bottom to top. Each is a slab (cover) + a lighter
           page block, with the spine on the left. ---- */}

      {/* Bottom book - green */}
      <path d="M7 35.5c0-.7.5-1.3 1.2-1.4l24.6-3.4c.4-.1.8 0 1.1.2l6.4 3.4c.5.3.7.8.6 1.3l-.5 3.1c-.1.6-.6 1-1.2 1.1l-24.9 3.4c-.4.1-.8 0-1.1-.2l-5.6-3c-.4-.2-.6-.6-.6-1.1v-3.4z" fill="#2F4A3C" />
      <path d="M14.2 39.9l24.9-3.4c.6-.1 1.1-.5 1.2-1.1l-.5 3.1c-.1.6-.6 1-1.2 1.1l-24.9 3.4c-.4.1-.8 0-1.1-.2l-5.6-3c-.4-.2-.6-.6-.6-1.1l5.6 3c.3.2.7.3 1.1.2z" fill="#22382C" />
      <path d="M13.6 36.6l25.1-3.5.5 2.9-25.1 3.5z" fill="#F2E4C9" />
      {/* ribbon bookmark */}
      <path d="M28.4 39.6l2.6-.4.4 4.6-1.6-1.2-1.7 1.6z" fill="#2F4A3C" />

      {/* Middle book - blue */}
      <path d="M8.5 28.2c0-.7.5-1.3 1.2-1.4l23.6-3.3c.4-.1.8 0 1.1.2l6.1 3.3c.5.3.7.8.6 1.3l-.5 3c-.1.6-.6 1-1.2 1.1l-23.9 3.3c-.4.1-.8 0-1.1-.2l-5.3-2.9c-.4-.2-.6-.6-.6-1.1v-3.3z" fill="#254070" />
      <path d="M14.9 32.5l23.9-3.3c.6-.1 1.1-.5 1.2-1.1l-.5 3c-.1.6-.6 1-1.2 1.1l-23.9 3.3c-.4.1-.8 0-1.1-.2l-5.3-2.9c-.4-.2-.6-.6-.6-1.1l5.3 2.9c.4.2.8.3 1.2.3z" fill="#1B3159" />
      <path d="M14.3 29.3l24.1-3.4.5 2.8-24.1 3.4z" fill="#F2E4C9" />
      <path d="M28.6 32.3l2.5-.3.4 4.4-1.5-1.1-1.6 1.5z" fill="#254070" />

      {/* Top book - purple */}
      <path d="M10 21c0-.7.5-1.3 1.2-1.4l22.3-3.1c.4-.1.8 0 1.1.2l5.8 3.1c.5.3.7.8.6 1.3l-.5 2.9c-.1.6-.6 1-1.2 1.1l-22.6 3.1c-.4.1-.8 0-1.1-.2l-5-2.7c-.4-.2-.6-.6-.6-1.1V21z" fill="#4A2E7A" />
      <path d="M15.6 25.1l22.6-3.1c.6-.1 1.1-.5 1.2-1.1l-.5 2.9c-.1.6-.6 1-1.2 1.1l-22.6 3.1c-.4.1-.8 0-1.1-.2l-5-2.7c-.4-.2-.6-.6-.6-1.1l5 2.7c.4.2.8.3 1.2.4z" fill="#3A2361" />
      <path d="M15.7 22l22.8-3.2.5 2.7-22.8 3.2z" fill="#F2E4C9" />
      {/* gold spine detail */}
      <path d="M13.6 21.3l.4 2.6M15.3 21.1l.4 2.6" stroke="#D9A93A" strokeWidth="0.7" strokeLinecap="round" />

      {/* ---- Wizard hat ---- */}
      {/* brim */}
      <ellipse cx="24.6" cy="16.4" rx="15.1" ry="4.4" fill="#6B44B0" />
      <path d="M9.5 16.4c0 2.4 6.8 4.4 15.1 4.4s15.1-2 15.1-4.4c0 2.4-6.8 4.4-15.1 4.4S9.5 18.8 9.5 16.4z" fill="#553191" />
      {/* cone + curled tip */}
      <path d="M18.2 14.6C19 10.5 21.9 4.6 25.6 2.2c1.5-1 2.9-.5 3.4.9.7 2 .1 4.2-.9 6.1-.6 1.2.4 1.9 1.3 1.1 1.4-1.2 2.5-2.8 3-4.5.2-.7 1.1-.7 1.3.1.6 2.7-.6 5.6-2.9 7.3-1.5 1.1-3.3 1.1-4.4-.1-.5-.6-1.4-.2-1.2.6.3 1.1.7 2.2 1.2 3.2-1.5.2-3.1.3-4.8.3-1.2 0-2.4 0-3.5-.1z" fill="#6B44B0" />
      <path d="M25.6 2.2c-3.7 2.4-6.6 8.3-7.4 12.4 1.1.1 2.3.1 3.5.1-.2-4.3 1.4-9.1 4.5-12.3-.2-.1-.4-.2-.6-.2z" fill="#7C55C4" />
      {/* hat band */}
      <path d="M17.9 14.5c1.9.5 4.2.8 6.7.8s4.8-.3 6.7-.8l.5 2.9c-2 .6-4.5.9-7.2.9s-5.2-.3-7.2-.9z" fill="#1E1B2E" />
      {/* buckle */}
      <rect x="21.9" y="14.3" width="5.4" height="4.2" rx="1" fill="none" stroke="#D9A93A" strokeWidth="1.4" />
      {/* stars */}
      <path d="M24.9 6.1l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" fill="#F0C64B" />
      <path d="M21.4 10.9l.5 1.1 1.1.5-1.1.5-.5 1.1-.5-1.1-1.1-.5 1.1-.5z" fill="#F0C64B" />
      <path d="M27.9 3.9l.4.9.9.4-.9.4-.4.9-.4-.9-.9-.4.9-.4z" fill="#F0C64B" />
    </svg>
  );
}

interface SlickSyncLogoProps {
  className?: string;
}

/**
 * SlickSync's chain-link mark, as an inline SVG rather than a static image.
 * Two simple rounded-rectangle "hooks" overlapping diagonally - deliberately
 * simple geometry (no fine internal detail) so it stays legible when shrunk
 * to a ~28px sidebar icon; a bolder letterform mark (tried in v1.9.15)
 * collapsed to mush at that size even though it read fine in a full-size
 * mockup. Flat white fill so it stays legible against every theme's
 * primary/secondary gradient badge background (all themes use solid,
 * saturated colors) - no separate image assets or light/dark variants
 * needed. (A two-tone primary/secondary version was tried and reverted -
 * white read better against the gradient badge.)
 */
export function SlickSyncLogo({ className = 'w-7 h-7' }: SlickSyncLogoProps) {
  return (
    <svg viewBox="0 0 200 200" className={className} xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="#ffffff" strokeWidth={18} strokeLinecap="round">
        <rect x="30" y="65" width="90" height="50" rx="25" transform="rotate(-35 75 90)" />
        <rect x="80" y="85" width="90" height="50" rx="25" transform="rotate(-35 125 110)" />
      </g>
    </svg>
  );
}


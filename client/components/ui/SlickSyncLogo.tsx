interface SlickSyncLogoProps {
  className?: string;
}

/**
 * SlickSync's chain-link mark, as an inline SVG rather than a static image.
 * Two simple rounded-rectangle "hooks" overlapping diagonally - deliberately
 * simple geometry (no fine internal detail) so it stays legible when shrunk
 * to a ~28px sidebar icon; a bolder letterform mark (tried in v1.9.15)
 * collapsed to mush at that size even though it read fine in a full-size
 * mockup.
 *
 * The two links are colored to match the badge's own background gradient -
 * the upper-left link takes --color-primary (the gradient's "top" color),
 * the lower-right link takes --color-secondary (its "bottom" color) - same
 * two theme variables everywhere else in the app derives its primary/
 * secondary accents from, so this stays correct across all themes without
 * separate variants. A translucent white rim sits behind each colored
 * stroke purely for definition, since a same-hued link against a same-hued
 * patch of the badge's own gradient would otherwise have very little
 * contrast right where the two overlap.
 */
export function SlickSyncLogo({ className = 'w-7 h-7' }: SlickSyncLogoProps) {
  return (
    <svg viewBox="0 0 200 200" className={className} xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="#ffffff" strokeWidth={21} strokeLinecap="round" opacity={0.5}>
        <rect x="30" y="65" width="90" height="50" rx="25" transform="rotate(-35 75 90)" />
        <rect x="80" y="85" width="90" height="50" rx="25" transform="rotate(-35 125 110)" />
      </g>
      <rect x="30" y="65" width="90" height="50" rx="25" transform="rotate(-35 75 90)" fill="none" stroke="var(--color-primary)" strokeWidth={18} strokeLinecap="round" />
      <rect x="80" y="85" width="90" height="50" rx="25" transform="rotate(-35 125 110)" fill="none" stroke="var(--color-secondary)" strokeWidth={18} strokeLinecap="round" />
    </svg>
  );
}


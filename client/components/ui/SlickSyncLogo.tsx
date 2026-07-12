interface SlickSyncLogoProps {
  className?: string;
}

// Real Orbitron Black (900) "S" glyph outline, extracted from the font itself
// so the mark renders identically everywhere regardless of what fonts are
// installed in the browser (no live-text font dependency).
const S_PATH =
  'M202 0Q162 0 128.0 20.0Q94 40 74.0 74.0Q54 108 54 148V215H209V156Q209 156 209.0 156.0Q209 156 209 156H617Q617 156 617.0 156.0Q617 156 617 156V282Q617 282 617.0 282.0Q617 282 617 282H202Q162 282 128.0 302.0Q94 322 74.0 355.5Q54 389 54 430V572Q54 613 74.0 646.5Q94 680 128.0 700.0Q162 720 202 720H626Q666 720 699.5 700.0Q733 680 753.5 646.5Q774 613 774 572V505H617V564Q617 564 617.0 564.0Q617 564 617 564H209Q209 564 209.0 564.0Q209 564 209 564V438Q209 438 209.0 438.0Q209 438 209 438H626Q666 438 699.5 418.0Q733 398 753.5 364.5Q774 331 774 290V148Q774 108 753.5 74.0Q733 40 699.5 20.0Q666 0 626 0Z';

/**
 * SlickSync's mark: two of the same Orbitron "S" glyph, tightly overlapped
 * so the strokes actually cross (not just touching bounding boxes), tilted
 * ~18deg for motion. Flat white fill so it stays legible against every
 * theme's primary/secondary gradient badge background (checked against all
 * 8 themes - all use solid, saturated colors, no low-contrast risk).
 */
export function SlickSyncLogo({ className = 'w-7 h-7' }: SlickSyncLogoProps) {
  return (
    <svg viewBox="0 0 200 200" className={className} xmlns="http://www.w3.org/2000/svg">
      <path transform="matrix(0.1474,-0.0479,-0.0479,-0.1474,34.2139,137.8986)" d={S_PATH} fill="#ffffff" />
      <path transform="matrix(0.1474,-0.0479,-0.0479,-0.1474,78.2139,200.8986)" d={S_PATH} fill="#ffffff" />
    </svg>
  );
}


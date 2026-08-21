// Wizard hat on a stack of books - the command palette's icon.
//
// Matches Heroicons' 24/outline set (24x24, fill:none, 1.5 stroke in
// currentColor, round joins) so it sits beside the dashboard house and the
// notification bell as a peer.
//
// Kept deliberately sparse: at the ~20px this actually renders at, fine
// detail turns to mush and reads as visual noise rather than a shape. Two
// earlier versions failed that way - first a full-colour illustration, then
// an outline one carrying a ribbon, a hat band and three separate rounded
// book bodies. This is the same subject reduced to six strokes: one hat,
// one brim, three book edges, one spine mark.
export function WizardBooksIcon({
  className,
  title,
  style,
}: {
  className?: string;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      style={style}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}

      {/* Hat: one continuous outline - up the left side, over the drooping
          tip, back down the right side to the brim. */}
      <path d="M8.5 9.6c.7-3.2 2.4-5.9 4.4-7 .9-.5 1.6 0 1.5 1.1-.1 1.1-.7 2.2-1.5 3.1.9-.1 1.7-.6 2.2-1.4" />
      <path d="M13 6.8c1 .7 1.9 1.7 2.5 2.8" />

      {/* Brim - a single wide sweep, not a closed ellipse. */}
      <path d="M6 10.2c1.6.8 3.7 1.2 6 1.2s4.4-.4 6-1.2" />

      {/* Books - three edges with clear air between them, which reads as a
          stack far better than three outlined bodies do at this size. */}
      <path d="M6.5 14h11" />
      <path d="M5 17h14" />
      <path d="M6.5 20h11" />

      {/* One spine mark, to stop the three lines reading as a hamburger. */}
      <path d="M9 14v6" />
    </svg>
  );
}

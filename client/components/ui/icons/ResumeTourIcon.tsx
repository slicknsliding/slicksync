// A route marked with a flag - the resume-tour prompt's icon.
//
// Needed to be visually distinct from WizardBooksIcon, which now means "open
// the command palette": the two sit within a few pixels of each other in the
// topbar, so reusing one glyph for both made the prompt read as a second
// search button. A path with a flag planted on it says "a walkthrough you're
// partway through" without needing the label to carry all the meaning.
//
// Same Heroicons 24/outline conventions as its neighbours (24x24, fill:none,
// 1.5 stroke in currentColor, round caps/joins) and kept to five strokes, so
// it stays legible at the ~20px it actually renders at.
export function ResumeTourIcon({
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

      {/* The route: a winding path climbing from bottom-left to the flag. */}
      <path d="M4.5 20c2.4 0 3.2-2.4 5.2-2.4s2.6 1.6 4.6 1.6" />
      <path d="M6.6 15.6c1.8-.5 2.6-1.9 2.6-3.4" />

      {/* Flagpole, planted at the top of the route. */}
      <path d="M14.8 4v9.6" />

      {/* Pennant. */}
      <path d="M14.8 4.6h4.4l-1.4 2.2 1.4 2.2h-4.4" />

      {/* Start marker, so the path reads as a journey with a beginning
          rather than a stray squiggle. */}
      <circle cx="9.2" cy="10.4" r="1.4" />
    </svg>
  );
}

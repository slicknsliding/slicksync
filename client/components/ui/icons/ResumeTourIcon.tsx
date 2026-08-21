// A signpost - the resume-tour prompt's icon.
//
// The pill this sits in already says "Resume tour" in words, so the icon does
// not need to carry the meaning by itself. Its job is to be a visual anchor
// that doesn't promise the wrong action. That rules out most candidates:
//
//   - A winding path with a flag on it (the first attempt). Five thin strokes,
//     two of them disconnected wavy segments plus a loose dot, which collapsed
//     into an illegible squiggle at the size this actually renders. Detail is
//     what kills an icon at 24px.
//   - A flag. Reads as "report this" or "needs attention" - and it would sit
//     directly beside the notification bell, giving two adjacent alert-looking
//     glyphs. Planting it on a ground line softens that but doesn't fix it.
//   - A compass. SlickSync already has a Discover page, so it reads "explore".
//   - A play triangle. In a media app it invites a click expecting playback.
//   - A circular arrow. This is a sync app; that's the sync/refresh glyph.
//   - A checklist. Semantically apt, but needs five or more strokes, which is
//     the exact failure mode of the first attempt.
//
// A signpost carries none of that baggage: "guided route" is the closest
// honest meaning, no other glyph in the app uses that shape - including
// WizardBooksIcon a few pixels away, which means "open the command palette" -
// and three chunky strokes stay readable at the size this renders.
//
// Same Heroicons 24/outline conventions as its neighbours: 24x24, fill:none,
// 1.5 stroke in currentColor, round caps and joins.
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

      {/* The post. */}
      <path d="M12 4.5V20" />

      {/* Upper board, pointing forward. */}
      <path d="M12 6h5.6l2.2 2.4-2.2 2.4H12" />

      {/* Lower board, pointing back - two boards read as a signpost, where a
          single one reads as a flag. */}
      <path d="M12 12.4H6.4l-2.2 2.4 2.2 2.4H12" />
    </svg>
  );
}

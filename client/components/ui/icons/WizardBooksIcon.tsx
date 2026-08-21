// Wizard hat on a stack of books - the command palette's icon.
//
// Deliberately drawn to match Heroicons' 24/outline set (24x24 viewBox,
// fill:none, 1.5 stroke in currentColor, round caps/joins) so it sits
// beside the Dashboard house and the notification bell as a peer. An
// earlier version was a full-colour illustration, which read as a sticker
// dropped into a row of flat line icons - the colour is what made it look
// wrong, not the subject.
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

      {/* Hat: left edge sweeping up to a curled tip, then back down the
          right edge to the brim. */}
      <path d="M9.1 10.3c.5-3 1.9-5.6 3.6-6.9.7-.5 1.4-.2 1.4.7 0 1-.5 2-1.1 2.8" />
      <path d="M13 6.9c.7-.2 1.3-.7 1.7-1.4" />
      <path d="M13.1 7.4c.9 1 1.6 1.9 1.9 2.9" />

      {/* Brim */}
      <path d="M7 10.6c0-.7 2.2-1.2 5-1.2s5 .5 5 1.2-2.2 1.3-5 1.3-5-.6-5-1.3Z" />

      {/* Three stacked books, narrowest on top. */}
      <path d="M6.6 12.9h10.8a.9.9 0 0 1 .9.9v1.1a.9.9 0 0 1-.9.9H6.6a.9.9 0 0 1-.9-.9v-1.1a.9.9 0 0 1 .9-.9Z" />
      <path d="M5.4 15.8h13.2a.9.9 0 0 1 .9.9v1.1a.9.9 0 0 1-.9.9H5.4a.9.9 0 0 1-.9-.9v-1.1a.9.9 0 0 1 .9-.9Z" />
      <path d="M6.2 18.7h11.6a.9.9 0 0 1 .9.9v1.1a.9.9 0 0 1-.9.9H6.2a.9.9 0 0 1-.9-.9v-1.1a.9.9 0 0 1 .9-.9Z" />

      {/* Ribbon bookmark on the middle book - the one detail that keeps it
          reading as "books" rather than three plain bars. */}
      <path d="M15.4 15.8v2l-1-.7-1 .7v-2" />
    </svg>
  );
}

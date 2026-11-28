/**
 * A list of keys and what each does, as the two-column table the shortcut
 * pop-up uses (the `.shortcut-keys` styles in globals.css): the action on the
 * left, its keys as small caps on the right. One column on a phone.
 */
export function KeyTable({ rows }: { rows: { what: string; keys: string[] }[] }) {
  return (
    <div className="shortcut-keys">
      {rows.map((row) => (
        <div key={row.what}>
          <span>{row.what}</span>
          <span>{row.keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>
        </div>
      ))}
    </div>
  );
}

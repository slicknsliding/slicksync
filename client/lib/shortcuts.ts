// The keyboard shortcuts, in one place: the pop-up that `?` opens
// (components/ui/QuickTouches) and the Keyboard shortcuts guide
// (lib/helpContent) both read this list, so they cannot drift apart.

/** Where `g` then a letter goes. */
export const JUMPS: { key: string; label: string; href: string }[] = [
  { key: 'd', label: 'Dashboard', href: '/' },
  { key: 'c', label: 'Activity', href: '/activity' },
  { key: 'u', label: 'Users', href: '/users' },
  { key: 'a', label: 'Addons', href: '/addons' },
  { key: 's', label: 'Settings', href: '/settings' },
];

/** What each key does, in the order it is listed. `list` is the row that opens this very list. */
export const SHORTCUTS: { what: string; keys: string[]; list?: true }[] = [
  { what: 'Search and jump', keys: ['Ctrl', 'K'] },
  { what: 'This list', keys: ['?'], list: true },
  { what: 'Search this page', keys: ['/'] },
  { what: 'Close a window or menu', keys: ['Esc'] },
  ...JUMPS.map((j) => ({ what: `Go to ${j.label}`, keys: ['g', j.key] })),
];

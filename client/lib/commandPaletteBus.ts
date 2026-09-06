// The one thing every page needs from the command palette is the ability to
// open it - a button in the top bar, a keyboard shortcut. That used to mean
// importing the palette module itself, which pulls in the entire guides text
// and the settings index, and mounting it in the shell put all of that in
// every page's first-load bundle. This file is the tiny shared surface; the
// palette proper is loaded after first paint (see AdminClientLayout).
export const COMMAND_PALETTE_OPEN_EVENT = 'slicksync:open-command-palette';

export function openCommandPalette() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
}

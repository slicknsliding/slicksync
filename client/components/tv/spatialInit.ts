import { init } from '@noriginmedia/norigin-spatial-navigation';

// init() wires up the library's own global keydown listener (arrow keys +
// Enter), once per app lifetime. Everything that uses the library calls this
// first: a focusable that measures itself before init() throws ("reading
// 'measureLayout'"), as the menu's did on pages without a TVPageProvider.
// Only ever reached from components already gated behind useIsTV(), so the
// listener is never attached on PC/mobile.
let initialized = false;

export function initSpatialNav() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  init({ debug: false, visualDebug: false, distanceCalculationMethod: 'center' });
}

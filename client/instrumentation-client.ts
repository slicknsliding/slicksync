// Next calls this the moment a page change starts. The loading line
// (components/ui/LoadingLine.tsx) listens for it.
export function onRouterTransitionStart() {
  window.dispatchEvent(new Event('slicksync:nav-start'));
}

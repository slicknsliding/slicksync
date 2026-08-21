export const ONBOARDING_COMPLETED_KEY = 'slicksync-onboarding-completed';

// Which account the flags below belong to. Everything here lives in
// localStorage, which is per-BROWSER, not per-account - so on a public
// instance one account finishing the tour silently marked it finished for
// every account that ever signs in on that browser afterwards. A newly
// registered account got no wizard at all, and no resume prompt either,
// with nothing to indicate why.
//
// Keys are therefore suffixed with the account's uuid. Set the scope via
// setOnboardingAccountScope() before anything reads these; until it's
// known, reads fall back to the unsuffixed legacy key.
let accountScope: string | null = null;

function scopedKey(base: string): string {
  return accountScope ? base + '::' + accountScope : base;
}

/**
 * Binds onboarding state to a specific account. Call once, as early as the
 * account uuid is known.
 *
 * The first call after upgrading also migrates the old unsuffixed flag onto
 * that account, so whoever is already signed in doesn't get the tour thrown
 * at them again just because the storage layout changed. It's a one-way
 * move: the legacy key is deleted, so every OTHER account starts clean and
 * actually sees the wizard. We can't know which account originally
 * completed it, and attributing it to the account present at upgrade time
 * is the only option that doesn't either re-prompt everyone or permanently
 * suppress the tour for everyone.
 */
export function setOnboardingAccountScope(uuid: string | null | undefined) {
  const next = uuid ? String(uuid) : null;
  if (next === accountScope) return;
  accountScope = next;
  if (!next || typeof window === 'undefined') return;
  try {
    const legacy = localStorage.getItem(ONBOARDING_COMPLETED_KEY);
    if (legacy !== null) {
      const target = scopedKey(ONBOARDING_COMPLETED_KEY);
      if (localStorage.getItem(target) === null) localStorage.setItem(target, legacy);
      localStorage.removeItem(ONBOARDING_COMPLETED_KEY);
      const legacyStep = localStorage.getItem(ONBOARDING_PAUSED_STEP_KEY);
      if (legacyStep !== null) {
        const stepTarget = scopedKey(ONBOARDING_PAUSED_STEP_KEY);
        if (localStorage.getItem(stepTarget) === null) localStorage.setItem(stepTarget, legacyStep);
        localStorage.removeItem(ONBOARDING_PAUSED_STEP_KEY);
      }
    }
  } catch { /* see getPausedOnboardingStep */ }
  // Anything already mounted read the pre-scope value; tell it to re-read.
  window.dispatchEvent(new Event(ONBOARDING_PAUSED_CHANGED_EVENT));
}

/** True once an account uuid is known, so callers can avoid acting early. */
export function isOnboardingScopeReady(): boolean {
  return accountScope !== null;
}

// Set when the tour is left mid-way on purpose - the user clicked one of a
// step's own links ("Go to Users", "Read the full guide") rather than
// skipping or finishing. Holds the step index to come back to, so the
// resume prompt can drop them exactly where they were instead of
// restarting from step 1. Cleared when the tour is finished or skipped.
export const ONBOARDING_PAUSED_STEP_KEY = 'slicksync-onboarding-paused-step';

// Reopen from the beginning - what Settings' "Replay" uses.
export const ONBOARDING_OPEN_EVENT = 'slicksync:open-onboarding';
// Reopen at the paused step - what the topbar resume chip uses.
export const ONBOARDING_RESUME_EVENT = 'slicksync:resume-onboarding';
// Fired whenever the paused state changes. The chip lives in the topbar,
// which persists across client-side navigations and therefore never
// remounts - without an explicit signal it would keep showing stale state
// after the wizard pauses or finishes.
export const ONBOARDING_PAUSED_CHANGED_EVENT = 'slicksync:onboarding-paused-changed';

// Fired by the wizard whenever it opens or closes, so the topbar prompt can
// hide itself while the modal is actually up instead of sitting behind it.
export const ONBOARDING_VISIBILITY_EVENT = 'slicksync:onboarding-visibility';

// "Unfinished" means the tour has never been completed OR explicitly
// dismissed - the topbar prompt shows for the whole of that window, not
// only after the tour was paused via one of its own links. Closing the
// wizard with its X is a "not now", not a dismissal; the prompt's own X is
// what ends it for good.
export function isOnboardingUnfinished(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !localStorage.getItem(scopedKey(ONBOARDING_COMPLETED_KEY));
  } catch {
    return false;
  }
}

// Replaying from Settings has to clear the completed flag, not just reopen
// the modal. Without this the tour reopens but is still recorded as "done",
// so closing it leaves no trace and the topbar prompt can never appear
// again for that account - which is exactly how an account that finished
// the tour once ends up unable to see the prompt at all.
export function restartOnboarding() {
  try {
    localStorage.removeItem(scopedKey(ONBOARDING_COMPLETED_KEY));
    localStorage.removeItem(scopedKey(ONBOARDING_PAUSED_STEP_KEY));
  } catch { /* see getPausedOnboardingStep */ }
  window.dispatchEvent(new Event(ONBOARDING_PAUSED_CHANGED_EVENT));
}

export function completeOnboarding() {
  try {
    localStorage.setItem(scopedKey(ONBOARDING_COMPLETED_KEY), '1');
    localStorage.removeItem(scopedKey(ONBOARDING_PAUSED_STEP_KEY));
  } catch { /* see getPausedOnboardingStep */ }
  window.dispatchEvent(new Event(ONBOARDING_PAUSED_CHANGED_EVENT));
}

export function getPausedOnboardingStep(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    if (localStorage.getItem(scopedKey(ONBOARDING_COMPLETED_KEY))) return null;
    const raw = localStorage.getItem(scopedKey(ONBOARDING_PAUSED_STEP_KEY));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    // Private-mode Safari and similar can throw on localStorage access;
    // a missing resume chip is a fine outcome, a crashed topbar isn't.
    return null;
  }
}

export function setPausedOnboardingStep(step: number) {
  try {
    localStorage.setItem(scopedKey(ONBOARDING_PAUSED_STEP_KEY), String(step));
  } catch { /* see getPausedOnboardingStep */ }
  window.dispatchEvent(new Event(ONBOARDING_PAUSED_CHANGED_EVENT));
}

export function clearPausedOnboardingStep() {
  try {
    localStorage.removeItem(scopedKey(ONBOARDING_PAUSED_STEP_KEY));
  } catch { /* see getPausedOnboardingStep */ }
  window.dispatchEvent(new Event(ONBOARDING_PAUSED_CHANGED_EVENT));
}

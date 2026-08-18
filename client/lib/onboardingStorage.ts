// Shared localStorage keys between OnboardingWizard and WhatsNewBanner -
// split out to a shared module rather than one importing from the other,
// which would work (Next.js tolerates circular ES imports used only inside
// effects/handlers, not at module-eval time) but is cleaner to just avoid.
export const ONBOARDING_COMPLETED_KEY = 'slicksync-onboarding-completed';
export const WHATS_NEW_LAST_SEEN_KEY = 'slicksync-last-seen-changelog';

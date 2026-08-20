export const ONBOARDING_COMPLETED_KEY = 'slicksync-onboarding-completed';

// Set when the tour is left mid-way on purpose - the user clicked one of a
// step's own links ("Go to Users", "Read the full guide") rather than
// skipping or finishing. Holds the step index to come back to, so the
// resume prompt can drop them exactly where they were instead of
// restarting from step 1. Cleared when the tour is finished or skipped.
export const ONBOARDING_PAUSED_STEP_KEY = 'slicksync-onboarding-paused-step';

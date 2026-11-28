'use client';

// A small dashed "Reset" beside a page's kept filters. It shows only while
// something is kept that differs from the page's defaults, and puts the page
// back: the saved choices are cleared and the page's own state returns to its
// defaults (a page that was already showing a choice keeps showing it
// otherwise).

import { useResetSaved } from '@/lib/arrange';
import { useIsTV } from '@/lib/hooks/useIsTV';

export function ResetSaved({ ids, atDefault, onReset }: {
  /** The ids the page gave useSavedFilter ('users', 'users:sort', ...). */
  ids: string[];
  /** True while the page already shows its defaults; the button then stays away. */
  atDefault: boolean;
  /** Sets the page's own state back to its defaults. */
  onReset: () => void;
}) {
  const { changed, reset } = useResetSaved(ids);
  const isTV = useIsTV();
  if (!changed || atDefault || isTV) return null;
  return (
    <button
      type="button"
      className="v2-btn reset-saved"
      onClick={() => {
        // Local state first: setting a choice also saves it, and the clear below must come last.
        onReset();
        reset();
      }}
    >
      Reset
    </button>
  );
}

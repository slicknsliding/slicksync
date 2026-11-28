'use client';

// A small list of groups that opens under the button that asked for it ("Add
// to group" in the Users selection bar). Pressing a group picks it.

import { AnchoredPopup } from '@/components/user/AnchoredPopup';

export function GroupPickPopup({ anchorRef, groups, onPick, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  groups: { id: string; name: string }[];
  onPick: (groupId: string) => void;
  onClose: () => void;
}) {
  return (
    <AnchoredPopup anchorRef={anchorRef} onClose={onClose} width={240} align="start" label="Add to group" caret closeButton={false}>
      {groups.length === 0 ? (
        <div className="pop-row text-muted">No groups yet. Make one on the Groups page.</div>
      ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto' }} role="menu" aria-label="Groups">
          {groups.map((g) => (
            <button key={g.id} type="button" role="menuitem" className="pop-row" onClick={() => onPick(g.id)}>
              <span className="text-default">{g.name}</span>
            </button>
          ))}
        </div>
      )}
    </AnchoredPopup>
  );
}

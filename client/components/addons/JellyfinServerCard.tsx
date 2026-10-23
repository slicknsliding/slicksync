'use client';

// A Jellyfin server on the Addons page: which groups it's given to and how
// many of their people have their account yet. Opens its settings.

import { UsersIcon } from '@heroicons/react/24/outline';
import { Badge, Card } from '@/components/ui';
import { JellyfinLogo } from '@/components/jellyfin/JellyfinLogo';
import { TVFocusable } from '@/components/tv/TVFocusable';
import type { HouseholdServer } from '@/lib/api';

export function JellyfinServerCard({ server, onOpen, focusable }: { server: HouseholdServer; onOpen: () => void; focusable?: boolean }) {
  const status = !server.groups.length
    ? 'Not given to a group yet'
    : `${server.people} ${server.people === 1 ? 'person' : 'people'} in ${server.groups.map((g) => g.name).join(', ')}`;
  const card = (
    <Card variant="interactive" padding="none" className="addon-card group relative cursor-pointer tap-card h-full" onClick={onOpen}>
      <div className="addon-card-body">
        <div className="flex items-center gap-2.5">
          <div className="addon-card-icon rounded-xl flex items-center justify-center shrink-0" style={{ background: '#000b25', border: '1px solid rgba(120,130,220,.35)' }}>
            <JellyfinLogo size={26} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="addon-card-name font-semibold transition-all group-hover:text-primary text-default truncate">{server.name}</h3>
            <p className="text-sm text-muted truncate">{server.address}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          <Badge variant="aiostreams" size="sm">Jellyfin server</Badge>
          {server.groups.map((g) => (
            <span key={g.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border border-default text-default">
              <UsersIcon className="w-3 h-3 text-secondary" /> {g.name}
            </span>
          ))}
        </div>
        <p className="mt-2.5 text-sm text-muted">
          {status}
          {server.people > 0 && (
            <>
              {' · '}<span className="quick-approved">{server.withAccounts} {server.withAccounts === 1 ? 'has an account' : 'have accounts'}</span>
              {server.waiting > 0 && ` · ${server.waiting} get theirs on the next sync`}
            </>
          )}
        </p>
      </div>
    </Card>
  );
  return focusable ? <TVFocusable onEnterPress={onOpen}>{card}</TVFocusable> : card;
}

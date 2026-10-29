'use client';

// AIOSync, reached from Tasks: the same page as on a person's own page,
// with a For switcher on top to change person without leaving it.

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDownIcon, CheckIcon } from '@heroicons/react/24/outline';
import { UserAvatar } from '@/components/ui';
import { WatchSyncView } from '@/components/user/WatchSyncView';
import { api, User } from '@/lib/api';
import { providerTypeLabel } from '@/lib/providers';
import { usePageDesign } from '@/lib/arrange';
import { useIsTV } from '@/lib/hooks/useIsTV';

function ForSwitcher({ people, current, onPick, v2 }: { people: User[]; current: User | null; onPick: (id: string) => void; v2?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('touchstart', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className={`flex items-center gap-2.5 ${v2 ? 'mb-4' : 'justify-center mb-5'}`}>
      <span className="text-sm text-muted">For</span>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full border border-default bg-surface-hover text-sm font-semibold text-default"
        >
          {current ? (
            <>
              <UserAvatar userId={current.id} name={current.username} email={current.email} src={current.avatarUrl || undefined} useGravatar={current.useGravatar} colorIndex={current.colorIndex} size="xs" />
              {current.username}
            </>
          ) : <span className="pl-2">Choose a person</span>}
          <ChevronDownIcon className="w-4 h-4 text-muted" />
        </button>
        {open && (
          <div className="absolute left-1/2 -translate-x-1/2 mt-2 w-72 max-w-[calc(100vw-2rem)] z-50 rounded-xl bg-surface border border-default shadow-xl p-2">
            {people.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { setOpen(false); onPick(p.id); }}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-hover text-left"
              >
                <UserAvatar userId={p.id} name={p.username} email={p.email} src={p.avatarUrl || undefined} useGravatar={p.useGravatar} colorIndex={p.colorIndex} size="sm" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-default truncate">{p.username}</span>
                  <span className="block text-xs text-muted truncate">{providerTypeLabel(p.providerType)}</span>
                </span>
                {p.id === current?.id && <CheckIcon className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WatchSyncFromTasks() {
  const router = useRouter();
  const search = useSearchParams();
  const [people, setPeople] = useState<User[] | null>(null);
  useEffect(() => { api.getUsers().then(setPeople).catch(() => setPeople([])); }, []);
  const { design } = usePageDesign();
  const isTV = useIsTV();
  const v2 = design === 'v2' && !isTV;

  const wanted = search.get('person');
  // Nobody is picked for you - the page waits until you choose who.
  const current = people?.find((p) => p.id === wanted) || null;
  if (!people) return null;
  if (!people.length) return <p className="text-center text-muted p-10">Add people first - AIOSync works between their sign-ins.</p>;
  return (
    <WatchSyncView
      key={current?.id || 'nobody'}
      userId={current?.id || ''}
      home="tasks"
      forSlot={<ForSwitcher v2={v2} people={people} current={current} onPick={(id) => router.replace(`/tasks/aiosync?person=${encodeURIComponent(id)}`)} />}
    />
  );
}

export default function WatchSyncPage() {
  return (
    <Suspense fallback={null}>
      <WatchSyncFromTasks />
    </Suspense>
  );
}

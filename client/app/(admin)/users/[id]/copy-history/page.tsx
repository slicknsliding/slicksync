'use client';

// AIOSync from a person's own page (components/user/WatchSyncView.tsx);
// Tasks opens the same page at /tasks/aiosync.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { WatchSyncView } from '@/components/user/WatchSyncView';
import { copyHistoryHeadV2 } from '@/components/v2/PersonV2';
import { usePageDesign } from '@/lib/arrange';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { api, type User } from '@/lib/api';

export default function PersonWatchSyncPage() {
  const params = useParams();
  const userId = String(params?.id || '');
  const isTV = useIsTV();
  const { design } = usePageDesign();
  const v2 = design === 'v2' && !isTV;
  const [person, setPerson] = useState<User | null>(null);
  useEffect(() => {
    if (!v2 || !userId) return;
    let cancelled = false;
    api.getUser(userId).then((u) => { if (!cancelled) setPerson(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [v2, userId]);
  return <WatchSyncView userId={userId} home="person" head={v2 ? copyHistoryHeadV2(person) : undefined} />;
}

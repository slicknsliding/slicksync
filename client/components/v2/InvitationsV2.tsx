'use client';

// Invitations in the v2 page design: people waiting to join come first with
// Approve and Reject; open invites show their code, the group they join,
// uses left and when they end, with Copy link. Both sections can be moved,
// folded and hidden, and single invites hidden, through Arrange.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowTopRightOnSquareIcon, ClipboardDocumentIcon, DocumentDuplicateIcon, EyeIcon, LinkIcon, PencilSquareIcon, QrCodeIcon, TrashIcon,
} from '@heroicons/react/24/outline';
import { UserAvatar } from '@/components/ui';
import { GroupPicture } from './GroupPicture';
import { ArrangeSection } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import { formatRelativeTime } from '@/lib/relativeTime';
import { V2Button, V2Card, V2Grid, V2Item, V2List, V2Status, type V2CardMenuItem } from './V2Bits';

export type V2Request = {
  id: string;
  invitationId: string;
  name: string;
  email?: string;
  groupName?: string;
  createdAt: string;
  status: 'pending' | 'accepted';
};

export type V2Invite = {
  id: string;
  code: string;
  name?: string;
  groupName?: string;
  groupColorIndex?: number;
  groupAvatarUrl?: string | null;
  groupMissing?: boolean;
  uses: number;
  maxUses?: number;
  expiresAt?: string;
  isActive: boolean;
};

export const INVITE_SECTIONS = [
  { key: 's:waiting', label: 'Waiting for you' },
  { key: 's:invites', label: 'Invites' },
] as const;

function ends(inv: V2Invite, now: number) {
  if (!inv.expiresAt) return { text: 'Never ends', over: false };
  const t = new Date(inv.expiresAt).getTime();
  if (!Number.isFinite(t)) return { text: 'Never ends', over: false };
  if (t <= now) return { text: 'Ended', over: true };
  const days = Math.round((t - now) / 86400000);
  if (days >= 2) return { text: `Ends in ${days} days`, over: false };
  const hours = Math.round((t - now) / 3600000);
  if (hours >= 20) return { text: 'Ends tomorrow', over: false };
  return { text: hours >= 1 ? `Ends in ${hours} h` : 'Ends within the hour', over: false };
}

function usesText(inv: V2Invite) {
  return inv.maxUses ? `${inv.uses} of ${inv.maxUses} used` : `${inv.uses} used`;
}

export function InvitationsV2({ requests, invites, arrange, inviteArrange, view, busy, onApprove, onReject, onCopy, onEdit, onDuplicate, onCopyCode, onShowQr, onDelete, now }: {
  requests: V2Request[];
  invites: V2Invite[];
  arrange: PageArrange;
  inviteArrange: PageArrange;
  view: 'grid' | 'list';
  busy: Set<string>;
  onApprove: (r: V2Request) => void;
  onReject: (r: V2Request) => void;
  onCopy: (i: V2Invite) => void;
  onEdit: (i: V2Invite) => void;
  onDuplicate: (i: V2Invite) => void;
  onCopyCode: (i: V2Invite) => void;
  onShowQr: (i: V2Invite) => void;
  /** Asks first (the page's own confirm). */
  onDelete: (i: V2Invite) => void;
  now: number;
}) {
  const router = useRouter();
  const menu = (i: V2Invite): V2CardMenuItem[] => [
    { label: 'Open', icon: <ArrowTopRightOnSquareIcon className="w-4 h-4" />, onClick: () => router.push(`/invitations/${i.id}`) },
    { label: 'Edit', icon: <PencilSquareIcon className="w-4 h-4" />, onClick: () => onEdit(i) },
    { label: 'Duplicate', icon: <DocumentDuplicateIcon className="w-4 h-4" />, onClick: () => onDuplicate(i) },
    { label: 'Copy code', icon: <ClipboardDocumentIcon className="w-4 h-4" />, onClick: () => onCopyCode(i) },
    { label: 'Show QR', icon: <QrCodeIcon className="w-4 h-4" />, onClick: () => onShowQr(i) },
    { label: 'Delete', icon: <TrashIcon className="w-4 h-4" />, danger: true, onClick: () => onDelete(i) },
  ];
  const hidden = new Set(inviteArrange.hidden);
  const hideBtn = (i: V2Invite) => (
    <button type="button" className="arrange-icon" aria-label={`Hide ${i.code}`} title="Hide on this page"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); inviteArrange.hide(i.id); }}>
      <EyeIcon className="w-4 h-4" />
    </button>
  );
  const reqButtons = (r: V2Request) => r.status === 'pending' ? (
    <span className="flex gap-2">
      <V2Button onClick={() => onReject(r)} disabled={busy.has(r.id)}>Reject</V2Button>
      <V2Button primary onClick={() => onApprove(r)} disabled={busy.has(r.id)}>Approve</V2Button>
    </span>
  ) : <V2Button>Open</V2Button>;
  const asked = (r: V2Request) => formatRelativeTime(r.createdAt) ?? 'just now';

  const reqTile = (r: V2Request) => (
    <Link key={r.id} href={`/invitations/${r.invitationId}`} className="v2-link">
      <V2Card footer="" action={reqButtons(r)}>
        <div className="flex items-center gap-3.5 min-w-0">
          <UserAvatar userId={r.id} name={r.name} email={r.email} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-semibold text-default break-words min-w-0">{r.name}</div>
            {r.status === 'accepted'
              ? <div className="mt-1"><V2Status tone="ok">Approved, waiting for them to sign in</V2Status></div>
              : <div className="mt-1"><V2Status tone="warn">Wants to join</V2Status></div>}
          </div>
        </div>
        <div className="text-muted text-[13px]">
          {r.groupName ? <>Joins <b className="text-default">{r.groupName}</b> · </> : null}asked {asked(r)}
        </div>
      </V2Card>
    </Link>
  );
  const reqRow = (r: V2Request) => (
    <Link key={r.id} href={`/invitations/${r.invitationId}`} className="v2-row">
      <UserAvatar userId={r.id} name={r.name} email={r.email} size="md" />
      <b className="text-default truncate w-[160px] shrink-0">{r.name}</b>
      <span className="text-muted text-[13px] flex-1 min-w-0 truncate">
        {r.status === 'accepted' ? 'Approved, waiting for them to sign in' : `wants to join${r.groupName ? ` ${r.groupName}` : ''}`} · {asked(r)}
      </span>
      {reqButtons(r)}
    </Link>
  );

  const inviteAction = (i: V2Invite) => arrange.arranging ? hideBtn(i) : (
    <V2Button onClick={() => onCopy(i)} icon={<LinkIcon className="w-4 h-4" />}>Copy link</V2Button>
  );
  const bar = (i: V2Invite, h: string) => i.groupName && !i.groupMissing
    ? <GroupPicture name={i.groupName} avatarUrl={i.groupAvatarUrl} colorIndex={i.groupColorIndex} size={h === 'h-8' ? 'md' : 'lg'} ring={false} />
    : <span className={`${h === 'h-8' ? 'w-10 h-10' : 'w-12 h-12'} rounded-[30%] shrink-0 border border-dashed border-default`} />;
  const joins = (i: V2Invite) => i.groupMissing ? 'Its group is gone' : i.groupName ? `Joins ${i.groupName}` : 'Joins no group';
  const status = (i: V2Invite) => {
    const e = ends(i, now);
    if (!i.isActive) return <V2Status tone="off">Switched off</V2Status>;
    if (e.over) return <V2Status tone="off">Ended</V2Status>;
    if (i.maxUses && i.uses >= i.maxUses) return <V2Status tone="off">All used</V2Status>;
    return <V2Status tone="live">Open</V2Status>;
  };
  const invTile = (i: V2Invite) => (
    <V2Item key={i.id} view="card" href={`/invitations/${i.id}`} items={menu(i)} menuLabel={`${i.code} options`} arranging={arrange.arranging}>
      <V2Card action={inviteAction(i)}>
        <div className="flex items-center gap-3 min-w-0">
          {bar(i, 'h-10')}
          <div className="flex-1 min-w-0">
            <div className="text-lg font-semibold text-default font-mono tracking-wider truncate">{i.code}</div>
            <div className="text-muted text-[13px] truncate">{joins(i)}</div>
          </div>
        </div>
        {status(i)}
        <div className="flex gap-4 text-[13px] flex-wrap">
          <span className="text-default">{usesText(i)}</span>
          <span className="text-muted">{ends(i, now).text}</span>
        </div>
      </V2Card>
    </V2Item>
  );
  const invRow = (i: V2Invite) => (
    <V2Item key={i.id} view="row" href={`/invitations/${i.id}`} items={menu(i)} menuLabel={`${i.code} options`} arranging={arrange.arranging}>
      {bar(i, 'h-8')}
      <b className="text-default font-mono w-[150px] shrink-0 truncate">{i.code}</b>
      <span className="text-muted text-[13px] w-[140px] shrink-0 truncate max-sm:hidden">{joins(i)}</span>
      <span className="v2-col w-[110px]">{status(i)}</span>
      <span className="v2-col w-[120px] text-[13px]">{usesText(i)}</span>
      <span className="text-muted text-[13px] flex-1 min-w-0 truncate">{ends(i, now).text}</span>
      {inviteAction(i)}
    </V2Item>
  );

  return (
    <div>
      {arrange.shown.map((key) => {
        if (key === 's:waiting') {
          if (requests.length === 0) return null;
          const waiting = requests.filter((r) => r.status === 'pending').length;
          return (
            <ArrangeSection key={key} arrange={arrange} id={key} label="Waiting for you" noun="section" cards
              title={<span className="flex items-center gap-2.5"><span className="w-3 h-3 rounded shrink-0" style={{ background: 'var(--color-warning, #f59e0b)' }} />Waiting for you</span>}
              meta={`${waiting} request${waiting === 1 ? '' : 's'}`}>
              {view === 'grid' ? <V2Grid stretch={{ arrange: arrange, id: key }}>{requests.map(reqTile)}</V2Grid> : <V2List>{requests.map(reqRow)}</V2List>}
            </ArrangeSection>
          );
        }
        if (invites.length === 0) return null;
        const shown = invites.filter((i) => !hidden.has(i.id));
        const open = invites.filter((i) => i.isActive && !ends(i, now).over).length;
        return (
          <ArrangeSection key={key} arrange={arrange} id={key} title="Invites" meta={`${open} open`} noun="section" cards>
            {shown.length === 0
              ? <p className="text-sm text-muted py-2">Every invite is hidden on this page.</p>
              : view === 'grid' ? <V2Grid stretch={{ arrange: arrange, id: key }}>{shown.map(invTile)}</V2Grid> : <V2List>{shown.map(invRow)}</V2List>}
          </ArrangeSection>
        );
      })}
    </div>
  );
}

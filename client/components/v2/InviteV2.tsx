'use client';

// An invite's page in the v2 design: the link front and centre with how many
// uses are left and a QR code, then everyone who used it, each row with its own
// buttons. The header (code, one status, Copy link / Edit / ⋯) comes from
// V2DetailHead; the page keeps the data, the handlers and the modals.

import { formatDistanceToNow } from 'date-fns';
import { ArrowTopRightOnSquareIcon, CheckIcon, ClipboardIcon } from '@heroicons/react/24/outline';
import { UserAvatar } from '@/components/ui';
import { ArrangeSection } from '@/components/ui/Arrange';
import { copyToClipboard } from '@/lib/clipboard';
import { displayEmail } from '@/lib/providers';
import type { PageArrange } from '@/lib/arrange';
import type { InviteRequest } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { V2Button, V2Status, type V2Tone } from './V2Bits';

export type InviteState = 'open' | 'ended' | 'full' | 'off';

export const INVITE_STATE_WORDS: Record<InviteState, { tone: V2Tone; words: string }> = {
  open: { tone: 'live', words: 'Open' },
  ended: { tone: 'bad', words: 'Ended' },
  full: { tone: 'warn', words: 'All used' },
  off: { tone: 'off', words: 'Switched off' },
};

export function InviteStatus({ state }: { state: InviteState }) {
  const s = INVITE_STATE_WORDS[state];
  return <V2Status tone={s.tone}>{s.words}</V2Status>;
}

/** "ends in 3 days", "ended 2 days ago" or "never ends". */
export function inviteEnds(expiresAt: string | null | undefined): string {
  if (!expiresAt) return 'never ends';
  const d = new Date(expiresAt);
  const rel = formatDistanceToNow(d, { addSuffix: true });
  return d.getTime() < Date.now() ? `ended ${rel}` : `ends ${rel}`;
}

function ago(iso: string | undefined | null): string {
  if (!iso) return '';
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

/** The status of one person's request, in words. */
function requestWords(r: InviteRequest): { words: string; tone: 'warn' | 'muted' | 'bad'; when: string } {
  switch (r.status) {
    case 'pending': return { words: 'Wants to join', tone: 'warn', when: `asked ${ago(r.createdAt)}` };
    case 'joined': return { words: 'Joined', tone: 'muted', when: ago(r.respondedAt || r.createdAt) };
    case 'accepted': return { words: 'Approved, not signed in yet', tone: 'muted', when: ago(r.respondedAt || r.createdAt) };
    case 'rejected': return { words: 'Rejected', tone: 'bad', when: ago(r.respondedAt || r.createdAt) };
    default: return { words: String(r.status), tone: 'muted', when: ago(r.createdAt) };
  }
}

const TONE_COLOR = { warn: 'var(--color-warning, #f59e0b)', bad: 'var(--color-error, #ef4444)', muted: 'var(--color-text-muted)' };

type Props = {
  arrange: PageArrange;
  inviteUrl: string;
  used: number;
  max: number | null;
  requests: InviteRequest[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onRemove: (request: InviteRequest) => void;
};

export function InviteV2({ arrange, inviteUrl, used, max, requests, onAccept, onReject, onRemove }: Props) {
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  const people = requests;

  const rowButtons = (r: InviteRequest) => {
    if (r.status === 'pending') {
      return (
        <>
          <V2Button onClick={() => onReject(r.id)}>Reject</V2Button>
          <V2Button primary icon={<CheckIcon className="w-4 h-4" />} onClick={() => onAccept(r.id)}>Approve</V2Button>
        </>
      );
    }
    if (r.status === 'rejected') return <V2Button onClick={() => onAccept(r.id)}>Undo</V2Button>;
    if (r.status === 'accepted' || r.status === 'joined') {
      return (
        <>
          {r.status === 'accepted' && r.oauthLink && (
            <V2Button onClick={() => { copyToClipboard(r.oauthLink!); toast.success('Sign-in link copied'); }} icon={<ClipboardIcon className="w-4 h-4" />}>Copy sign-in link</V2Button>
          )}
          <V2Button onClick={() => onRemove(r)}>Remove</V2Button>
        </>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-6">
      {arrange.shown.map((id) => id === 'link' ? (
      <ArrangeSection key={id} arrange={arrange} id="link" label="Invite link" title="Invite link" noun="section">
        <div className="v2-box v2-box-pad flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[240px]">
            <div className="text-muted text-[12.5px]">Send this link</div>
            <div className="font-mono text-[15px] mt-1 break-all text-default" data-testid="invite-url">{inviteUrl}</div>
            {max ? (
              <div className="h-2 rounded-full mt-3.5 overflow-hidden" style={{ background: 'var(--color-surface-elevated)' }} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used}>
                <div className="h-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }} />
              </div>
            ) : null}
            <div className="text-muted text-[12.5px] mt-1.5">{max ? `${used} of ${max} used` : `${used} used · no limit`}</div>
          </div>
          {/* Served by /api/qr; white behind it keeps it scannable on dark themes. */}
          <div className="shrink-0 p-2 rounded-xl bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/qr?data=${encodeURIComponent(inviteUrl)}`} alt="QR code for this invite link" width={96} height={96} />
          </div>
        </div>
      </ArrangeSection>
      ) : (
      <ArrangeSection key={id} arrange={arrange} id="people" label="People who used it" title="People who used it" meta={String(people.length)} noun="section">
        {people.length > 0 ? (
          <div className="v2-list">
            {people.map((r) => {
              const name = r.username || displayEmail(r.email);
              const w = requestWords(r);
              return (
                <div key={r.id} className="v2-row flex-wrap">
                  <UserAvatar userId={r.id} name={name} email={r.email} size="md" />
                  <div className="flex-1 min-w-[140px]">
                    <div className="font-semibold text-default truncate">{name}</div>
                    <div className="text-[12.5px]" style={{ color: TONE_COLOR[w.tone] }}>
                      {w.words}{w.when && <span className="text-muted"> · {w.when}</span>}
                    </div>
                    {r.oauthCode && r.status === 'accepted' && (
                      <div className="mt-1 flex items-center gap-2">
                        <code className="text-xs font-mono px-2 py-0.5 rounded bg-surface-hover text-default">{r.oauthCode}</code>
                        {r.oauthLink && (
                          <a href={r.oauthLink} target="_blank" rel="noopener noreferrer" className="text-xs text-primary flex items-center gap-1">
                            Open link <ArrowTopRightOnSquareIcon className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">{rowButtons(r)}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="v2-box v2-box-pad text-muted text-center py-8">Nobody has used this invite yet</div>
        )}
      </ArrangeSection>
      ))}
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card, Badge, Button } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { api, HealthStatus } from '@/lib/api';
import {
  HeartIcon, CheckCircleIcon, ExclamationTriangleIcon, ArrowPathIcon,
  ArrowsRightLeftIcon, PuzzlePieceIcon, ShieldCheckIcon, SignalIcon,
} from '@heroicons/react/24/outline';

// System Health board: one glanceable page for "is everything actually
// working right now." Every number here reads state an existing background
// monitor already maintains (Sync Guardian, addon health checker, vault
// monitor, the AIOStreams proxy poller) - this page computes nothing live,
// it just unifies signals that were previously scattered across four
// different admin pages.

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function StatusPill({ ok }: { ok: boolean | null }) {
  if (ok === null) return <Badge variant="default" size="sm">Unknown</Badge>;
  return ok ? <Badge variant="success" size="sm">Healthy</Badge> : <Badge variant="warning" size="sm">Attention</Badge>;
}

function CheckCard({
  icon, title, ok, summary, children,
}: {
  icon: React.ReactNode;
  title: string;
  ok: boolean | null;
  summary: string;
  children?: React.ReactNode;
}) {
  return (
    <Card padding="lg">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${ok === false ? 'bg-warning/15 text-warning' : 'bg-primary/10 text-primary'}`}>
            {icon}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-default">{title}</h3>
            <p className="text-xs text-muted">{summary}</p>
          </div>
        </div>
        <StatusPill ok={ok} />
      </div>
      {children}
    </Card>
  );
}

function IssueRow({ title, detail, meta }: { title: string; detail?: string | null; meta?: string }) {
  return (
    <div className="py-2 border-t border-default first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-default truncate">{title}</p>
        {meta && <span className="text-xs text-subtle flex-shrink-0">{meta}</span>}
      </div>
      {detail && <p className="text-xs text-warning mt-0.5 truncate">{detail}</p>}
    </div>
  );
}

export default function HealthPage() {
  const { layoutMode } = useLayoutMode();
  const [data, setData] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    api.getHealthStatus()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const heading = { title: 'Health', subtitle: 'Is everything actually working right now.' };
  const isHealthy = data?.overall === 'healthy';

  const refreshButton = (
    <Button variant="secondary" size="sm" leftIcon={<ArrowPathIcon className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />} onClick={() => load(true)} disabled={refreshing}>
      Refresh
    </Button>
  );

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={<Breadcrumbs items={[{ label: 'Health' }]} className="text-xl font-semibold" />}
          subtitle={heading.subtitle}
          actions={refreshButton}
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
        {layoutMode === 'nebula' && <NebulaPageHeading title={heading.title} subtitle={heading.subtitle} actions={refreshButton} />}

        {loading ? (
          <PageSection>
            <div className="h-24 rounded-xl bg-surface-hover animate-pulse mb-6" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[...Array(4)].map((_, i) => <div key={i} className="h-40 rounded-xl bg-surface-hover animate-pulse" />)}
            </div>
          </PageSection>
        ) : !data ? (
          <PageSection>
            <Card padding="lg" className="text-center">
              <ExclamationTriangleIcon className="w-10 h-10 mx-auto text-warning mb-3" />
              <p className="text-sm text-muted">Couldn&apos;t load health status.</p>
            </Card>
          </PageSection>
        ) : (
          <>
            {/* Overall banner */}
            <PageSection className="mb-6">
              <Card
                padding="lg"
                className={isHealthy ? 'border-success/30' : 'border-warning/30'}
                style={{
                  background: isHealthy
                    ? 'linear-gradient(120deg, rgba(34,197,94,0.10) 0%, transparent 60%)'
                    : 'linear-gradient(120deg, rgba(234,179,8,0.12) 0%, transparent 60%)',
                }}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 ${isHealthy ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
                    {isHealthy ? <CheckCircleIcon className="w-8 h-8" /> : <ExclamationTriangleIcon className="w-8 h-8" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-xl font-bold font-display text-default">
                      {isHealthy ? 'Everything is running smoothly' : 'Something needs attention'}
                    </h2>
                    <p className="text-sm text-muted">
                      Last checked {timeAgo(data.checkedAt)}
                      {!isHealthy && ' — see the cards below for what to fix.'}
                    </p>
                  </div>
                </div>
              </Card>
            </PageSection>

            <PageSection>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <CheckCard
                  icon={<ArrowsRightLeftIcon className="w-5 h-5" />}
                  title="Sync"
                  ok={data.sync.driftCount === 0}
                  summary={`${data.sync.usersTracked} user${data.sync.usersTracked !== 1 ? 's' : ''} tracked`}
                >
                  {data.sync.driftCount > 0 ? (
                    <div>
                      {data.sync.drifted.map((d, i) => (
                        <IssueRow key={i} title={d.title} detail={d.body} meta={timeAgo(d.since)} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-subtle">No accounts have drifted from their group&apos;s addons.</p>
                  )}
                </CheckCard>

                <CheckCard
                  icon={<PuzzlePieceIcon className="w-5 h-5" />}
                  title="Addons"
                  ok={data.addons.offlineCount === 0}
                  summary={`${data.addons.checked}/${data.addons.total} checked`}
                >
                  {data.addons.offlineCount > 0 ? (
                    <div>
                      {data.addons.offline.map((a, i) => (
                        <IssueRow key={i} title={a.name} detail={a.error} meta={timeAgo(a.lastChecked)} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-subtle">All addon manifests are reachable.</p>
                  )}
                </CheckCard>

                <CheckCard
                  icon={<ShieldCheckIcon className="w-5 h-5" />}
                  title="Vault"
                  ok={data.vault.failingCount === 0 && data.vault.expiringCount === 0}
                  summary={`${data.vault.total} credential${data.vault.total !== 1 ? 's' : ''} tracked`}
                >
                  {data.vault.failingCount > 0 || data.vault.expiringCount > 0 ? (
                    <div>
                      {data.vault.failing.map((v, i) => (
                        <IssueRow key={`f-${i}`} title={v.name} detail={v.message || 'Check failed'} meta={timeAgo(v.lastChecked)} />
                      ))}
                      {data.vault.expiring.map((v, i) => (
                        <IssueRow key={`e-${i}`} title={v.name} detail="Expiring soon" meta={new Date(v.expiresAt).toLocaleDateString()} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-subtle">All credentials are passing checks with no upcoming expiry.</p>
                  )}
                </CheckCard>

                <CheckCard
                  icon={<SignalIcon className="w-5 h-5" />}
                  title="Proxy"
                  ok={!data.proxy.configured ? null : data.proxy.ok}
                  summary={!data.proxy.configured ? 'Not configured' : `Last poll ${timeAgo(data.proxy.at)}`}
                >
                  {!data.proxy.configured ? (
                    <p className="text-xs text-subtle">AIOStreams proxy isn&apos;t configured on this instance.</p>
                  ) : data.proxy.ok === false ? (
                    <IssueRow title="Proxy stats unreachable" detail={data.proxy.error} meta={timeAgo(data.proxy.at)} />
                  ) : (
                    <p className="text-xs text-subtle">Now Playing polling is reaching AIOStreams normally.</p>
                  )}
                </CheckCard>
              </div>

              {data.mismatchCount > 0 && (
                <Card padding="md" className="mt-4 border-warning/30">
                  <div className="flex items-center gap-2">
                    <ExclamationTriangleIcon className="w-4 h-4 text-warning flex-shrink-0" />
                    <p className="text-sm text-default">
                      {data.mismatchCount} title{data.mismatchCount !== 1 ? 's' : ''} streamed but not recorded by any connected account — see the notification bell for details.
                    </p>
                  </div>
                </Card>
              )}
            </PageSection>
          </>
        )}
      </div>
      </div>
    </>
  );
}

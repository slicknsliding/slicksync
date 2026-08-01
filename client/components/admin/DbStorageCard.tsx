'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { CircleStackIcon } from '@heroicons/react/24/outline';
import { api, DbSizeReport } from '@/lib/api';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

const TOOLTIP_STYLE = {
  backgroundColor: 'rgba(20, 20, 35, 0.95)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '12px',
  backdropFilter: 'blur(12px)',
} as const;

const TOOLTIP_LABEL_STYLE = { color: '#fff' } as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

// Read-only reporting card: SQLite file size over time, on a small VPS with
// finite disk this is the only warning you'd otherwise get before the disk
// just fills up. Renders nothing in public/Postgres mode (no single file to
// track) or before at least two samples exist (nothing to chart yet).
export function DbStorageCard() {
  const [report, setReport] = useState<DbSizeReport | null>(null);

  useEffect(() => {
    api.getDbSizeReport().then(setReport).catch(() => setReport({ supported: false }));
  }, []);

  if (!report || !report.supported) return null;

  const samples = report.samples || [];
  const chartData = samples.map((s) => ({ date: s.createdAt, mb: Number(s.bytes) / (1024 * 1024) }));

  return (
    <Card padding="lg" className="mb-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-sky-500/20">
          <CircleStackIcon className="w-5 h-5 text-sky-400" />
        </div>
        <div>
          <h3 className="text-base font-semibold font-display text-default">Database</h3>
          <p className="text-xs text-muted">SQLite file size over time - read-only, no actions here</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-6 mb-4">
        {typeof report.currentBytes === 'number' && (
          <div>
            <p className="text-xs text-muted">Current size</p>
            <p className="text-lg font-semibold text-default">{formatBytes(report.currentBytes)}</p>
          </div>
        )}
        <div>
          <p className="text-xs text-muted">Growth</p>
          <p className="text-sm text-default">
            {report.growthBytesPerDay
              ? report.growthBytesPerDay > 0
                ? `~${formatBytes(report.growthBytesPerDay * 7)}/week`
                : 'Shrinking or flat'
              : 'Not enough history yet'}
          </p>
        </div>
        {typeof report.projectedDaysUntilFull === 'number' && (
          <div>
            <p className="text-xs text-muted">At this rate</p>
            <p className="text-sm text-default">~{report.projectedDaysUntilFull} days until disk is full</p>
          </div>
        )}
      </div>

      {chartData.length >= 2 ? (
        <div style={{ width: '100%', height: 180 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="colorDbSize" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
              <XAxis
                dataKey="date"
                stroke="#64748b"
                fontSize={12}
                tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              />
              <YAxis
                stroke="#64748b"
                fontSize={12}
                tickFormatter={(value) => `${Math.round(value)}MB`}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                labelFormatter={(value: any) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                formatter={(value: any) => [`${Number(value).toFixed(1)} MB`, 'Size']}
              />
              <Area
                type="monotone"
                dataKey="mb"
                stroke="var(--color-chart-1)"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorDbSize)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-xs text-muted">Check back in a bit — need a little more history before there's a trend to chart.</p>
      )}
    </Card>
  );
}

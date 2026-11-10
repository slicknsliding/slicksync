'use client';

// The per-person Watch Time and Content Breakdown charts, loaded apart from the page
// so recharts is not part of its first load. The page keeps the fixed-height box.

import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { CHART_TOOLTIP_STYLE as TOOLTIP_STYLE, CHART_TOOLTIP_LABEL_STYLE as TOOLTIP_LABEL_STYLE } from '@/lib/chartTooltip';

export function WatchTimeChartBody({ data, ticks, formatMinutes }: { data: Array<{ date: string; minutes: number }>; ticks: number[]; formatMinutes: (minutes: number) => string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data}>
        <defs>
          <linearGradient id="colorMinutes" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.4} />
            <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
        <XAxis dataKey="date" stroke="#64748b" fontSize={12} />
        <YAxis 
          stroke="#64748b" 
          fontSize={12} 
          ticks={ticks}
          tickFormatter={(value) => {
            if (value === 0) return '0m';
            const h = Math.floor(value / 60);
            const m = value % 60;
            if (h === 0) return `${m}m`;
            return m === 0 ? `${h}h` : `${h}h${m}m`;
          }}
        />
        <Tooltip 
          contentStyle={TOOLTIP_STYLE} 
          labelStyle={TOOLTIP_LABEL_STYLE}
          formatter={(value: any) => [formatMinutes(value), 'Watch Time']}
        />
        <Area
          type="monotone"
          dataKey="minutes"
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#colorMinutes)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function ContentBreakdownChartBody({ data }: { data: Array<{ date: string; movies: number; series: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
        <XAxis dataKey="date" stroke="#64748b" fontSize={12} />
        <YAxis stroke="#64748b" fontSize={12} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
        <Bar dataKey="movies" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="series" fill="var(--color-chart-2)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

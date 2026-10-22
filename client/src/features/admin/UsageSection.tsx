import { useEffect } from 'preact/hooks';
import { Activity, Radio, RefreshCw, Users } from 'lucide-preact';
import { Button } from '@/components';
import { cn } from '@/lib/cn';
import { formatBytes, formatDuration, formatFullDate } from '@/lib/format';
import { api } from '@/services/socket/api';
import { adminUsage } from '@/state/misc';

const gigabytes = (bytes: number): string => (bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 2) + ' GB';

/** Streaming traffic per month against the budget, plus what is live right now. */
export const UsageSection = () => {
  const usage = adminUsage.value;

  useEffect(() => {
    api.getUsage();
    const timer = window.setInterval(() => api.getUsage(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!usage) return <p className="text-sm text-text-muted">Loading usage…</p>;

  const used = usage.currentMonth.hlsEgressBytes;
  const ratio = usage.budgetBytes > 0 ? Math.min(1, used / usage.budgetBytes) : 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-md bg-base/60 p-3">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-text-bright">
            <Activity size={14} /> This month ({usage.currentMonth.month})
          </p>
          <Button size="sm" variant="ghost" onClick={() => api.getUsage()}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          HLS egress is estimated from each stream's bitrate times its viewers (see ops/README.md, "Keeping the bill small"). When the budget is spent, streaming pauses until next month.
        </p>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-active">
          <div className={cn('h-full rounded-full transition-[width]', ratio > 0.9 ? 'bg-danger' : ratio > 0.7 ? 'bg-warning' : 'bg-success')} style={{ width: Math.round(ratio * 100) + '%' }} />
        </div>
        <p className="mt-1 text-xs text-text tabular-nums">
          {usage.budgetBytes > 0
            ? `${gigabytes(used)} of ${gigabytes(usage.budgetBytes)} (${Math.round(ratio * 100)}%)`
            : `${gigabytes(used)} served, no monthly budget`}{' '}
          · {formatDuration(usage.currentMonth.streamSeconds * 1000)} streamed
        </p>
        <p className="mt-1 text-xs text-text tabular-nums" data-arcade-egress>
          Arcade egress: {formatBytes(usage.currentMonth.arcadeEgressBytes ?? 0)} this month (game traffic, not counted against the streaming budget)
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md bg-base/60 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-text-bright">
            <Users size={14} /> Online now
          </p>
          <p className="mt-1 text-2xl font-bold text-text-bright tabular-nums">{usage.online}</p>
          <p className="text-xs text-text-muted">connected sockets</p>
        </div>
        <div className="rounded-md bg-base/60 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-text-bright">
            <Radio size={14} /> Live streams
          </p>
          {usage.liveStreams.length === 0 ? (
            <p className="mt-1 text-sm text-text-muted">Nobody is streaming.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {usage.liveStreams.map((stream) => (
                <li key={stream.channelId} className="flex items-center gap-2">
                  <span className="live-dot text-[10px] font-bold text-live uppercase">Live</span>
                  <span className="min-w-0 flex-1 truncate text-text-bright">#{stream.channelName}</span>
                  <span className="text-xs text-text-muted tabular-nums" title="Viewers in the channel">
                    {stream.viewerCount} watching · {formatDuration(Date.now() - stream.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-text-faint">
            Limits: {usage.maxViewers > 0 ? `${usage.maxViewers} viewers per stream` : 'no viewer cap'},{' '}
            {usage.maxBitrateKbps > 0 ? `${usage.maxBitrateKbps} kbps ingest` : 'no ingest cap'}.
          </p>
        </div>
      </section>

      <section className="rounded-md bg-base/60 p-3">
        <p className="text-sm font-semibold text-text-bright">Past months</p>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted">
              <th className="py-1 font-medium">Month</th>
              <th className="py-1 text-right font-medium">Egress</th>
              <th className="py-1 text-right font-medium">Streamed</th>
              <th className="py-1 text-right font-medium">Arcade</th>
              <th className="py-1 text-right font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {usage.months.map((month) => (
              <tr key={month.month} className="border-t border-border">
                <td className="py-1 text-text-bright">{month.month}</td>
                <td className="py-1 text-right tabular-nums">{formatBytes(month.hlsEgressBytes)}</td>
                <td className="py-1 text-right tabular-nums">{formatDuration(month.streamSeconds * 1000)}</td>
                <td className="py-1 text-right tabular-nums">{formatBytes(month.arcadeEgressBytes ?? 0)}</td>
                <td className="py-1 text-right text-xs text-text-faint">{month.updatedAt ? formatFullDate(month.updatedAt) : '—'}</td>
              </tr>
            ))}
            {usage.months.length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-text-muted">
                  No streaming yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
};

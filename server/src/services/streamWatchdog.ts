import type { AppContext } from '../context.js';

/** One publishing stream as reported by nginx-rtmp's `/stat` page. */
export interface RtmpStatStream {
  name: string;
  /** Incoming bitrate in bits per second (nginx averages it over the last seconds). */
  bwIn: number;
  bytesIn: number;
  publishing: boolean;
}

const number = (block: string, tag: string): number => {
  const match = block.match(new RegExp('<' + tag + '>([0-9]+)</' + tag + '>'));
  return match ? Number(match[1]) : 0;
};

/** Minimal parser for the XML of `rtmp_stat`; only the fields the watchdog needs. */
export const parseRtmpStat = (xml: string): RtmpStatStream[] => {
  const streams: RtmpStatStream[] = [];
  const live = xml.match(/<live>([\s\S]*?)<\/live>/);
  if (!live) return streams;
  for (const block of live[1].matchAll(/<stream>([\s\S]*?)<\/stream>/g)) {
    const body = block[1];
    const name = body.match(/<name>([^<]*)<\/name>/)?.[1] ?? '';
    if (!name) continue;
    streams.push({ name, bwIn: number(body, 'bw_in'), bytesIn: number(body, 'bytes_in'), publishing: /<publishing\s*\/>/.test(body) });
  }
  return streams;
};

/** What `/api/health` reports about the watchdog. */
export interface StreamWatchdogStatus {
  /** False without RTMP_STAT_URL: nothing to poll. */
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  /** When nginx-rtmp was last asked; null before the first poll. */
  lastPollAt: number | null;
  /** Whether the last poll reached nginx-rtmp and parsed its answer. */
  lastPollOk: boolean | null;
  lastError: string | null;
  /** Publishing streams seen on the last successful poll. */
  publishing: number;
  overBudget: boolean;
}

export interface StreamWatchdogOptions {
  /** Base URL of the nginx-rtmp http server, e.g. http://rtmp:8080. Null disables the watchdog. */
  statUrl: string | null;
  intervalMs?: number;
  maxBitrateKbps: number;
  monthlyEgressBytes: number;
  fetchImpl?: typeof fetch;
}

/**
 * Keeps streaming from running up the cloud bill:
 * - estimates HLS egress (publisher bitrate x viewers) and books it per month;
 * - drops publishers that exceed the configured bitrate for two polls in a row;
 * - once the monthly egress budget is spent, drops every publisher and the
 *   ticket endpoint stops admitting viewers until the next month.
 */
export class StreamWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private readonly strikes = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private budgetNotified = false;
  private lastPollAt: number | null = null;
  private lastPollOk: boolean | null = null;
  private lastError: string | null = null;
  private publishing = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly options: StreamWatchdogOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.intervalMs = options.intervalMs ?? 15_000;
  }

  start(): void {
    if (!this.options.statUrl || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.ctx.log.info({ statUrl: this.options.statUrl, maxBitrateKbps: this.options.maxBitrateKbps, monthlyEgressGb: Math.round(this.options.monthlyEgressBytes / 1e9) }, 'stream watchdog started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(now = Date.now()): StreamWatchdogStatus {
    return {
      enabled: this.options.statUrl !== null,
      running: this.timer !== null,
      intervalMs: this.intervalMs,
      lastPollAt: this.lastPollAt,
      lastPollOk: this.lastPollOk,
      lastError: this.lastError,
      publishing: this.publishing,
      overBudget: this.overBudget(now),
    };
  }

  /** A budget of 0 means there is none (unmetered host). */
  overBudget(now = Date.now()): boolean {
    return this.options.monthlyEgressBytes > 0 && this.ctx.usage.monthEgressBytes(now) >= this.options.monthlyEgressBytes;
  }

  /** One poll of nginx-rtmp; exported for tests. */
  async tick(now = Date.now()): Promise<void> {
    if (!this.options.statUrl) return;
    let streams: RtmpStatStream[];
    this.lastPollAt = now;
    try {
      const response = await this.fetchImpl(this.options.statUrl + '/stat', { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      streams = parseRtmpStat(await response.text());
      this.lastPollOk = true;
      this.lastError = null;
      this.publishing = streams.filter((stream) => stream.publishing).length;
    } catch (error) {
      this.lastPollOk = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.ctx.log.debug({ err: error }, 'stream watchdog: stat unavailable');
      return;
    }

    const seconds = this.intervalMs / 1000;
    const seen = new Set<string>();
    for (const stream of streams) {
      if (!stream.publishing) continue;
      seen.add(stream.name);
      const channel = this.ctx.channels.getByName(stream.name);
      if (!channel) continue;
      if (channel.type === 'stream' && !this.ctx.presence.getStream(channel.id)) {
        // The process restarted while OBS kept publishing: nginx-rtmp still carries the stream
        // but the new process never saw the publish callback. Register it again so the channel
        // shows live and viewers get tickets. Who is streaming is unknown until the next publish.
        this.ctx.presence.startStream(channel.id, { accountId: null, displayName: null, clientId: null, sourceIp: null });
        this.ctx.broadcast.channels();
        this.ctx.log.info({ channelId: channel.id, stream: stream.name }, 'live stream re-registered from nginx-rtmp after a restart');
      }
      const viewers = this.ctx.presence.channelMemberCount(channel.id);
      // Every viewer downloads roughly what the publisher uploads.
      this.ctx.usage.addEgress((stream.bwIn / 8) * seconds * viewers, seconds, now);

      // A cap of 0 means publishers may send whatever OBS is set to.
      if (this.options.maxBitrateKbps > 0 && stream.bwIn > this.options.maxBitrateKbps * 1000) {
        const strikes = (this.strikes.get(stream.name) ?? 0) + 1;
        this.strikes.set(stream.name, strikes);
        if (strikes >= 2) {
          await this.drop(stream.name, 'bitrate');
          this.ctx.broadcast.notifyChannel(channel.id, {
            type: 'warning',
            message: `Stream dropped: ${Math.round(stream.bwIn / 1000)} kbps is above the ${this.options.maxBitrateKbps} kbps limit. Lower the bitrate in OBS and go live again.`,
          });
          this.strikes.delete(stream.name);
        }
      } else {
        this.strikes.delete(stream.name);
      }
    }
    for (const name of Array.from(this.strikes.keys())) if (!seen.has(name)) this.strikes.delete(name);

    if (this.overBudget(now)) {
      for (const stream of streams) {
        if (!stream.publishing) continue;
        await this.drop(stream.name, 'budget');
        const channel = this.ctx.channels.getByName(stream.name);
        if (channel) {
          this.ctx.broadcast.notifyChannel(channel.id, {
            type: 'error',
            message: 'Streaming is paused until next month: the monthly traffic budget of this server is used up.',
          });
        }
      }
      if (!this.budgetNotified) {
        this.ctx.log.warn({ month: this.ctx.usage.get().month, egressGb: (this.ctx.usage.monthEgressBytes(now) / 1e9).toFixed(1) }, 'monthly egress budget exceeded; streaming paused');
        this.budgetNotified = true;
      }
    } else {
      this.budgetNotified = false;
    }
  }

  private async drop(name: string, reason: 'bitrate' | 'budget'): Promise<void> {
    try {
      const url = this.options.statUrl + '/control/drop/publisher?app=live&name=' + encodeURIComponent(name);
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
      this.ctx.log.warn({ stream: name, reason, status: response.status }, 'publisher dropped');
    } catch (error) {
      this.ctx.log.error({ err: error, stream: name, reason }, 'failed to drop publisher');
    }
  }
}

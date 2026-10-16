import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HlsTicketService } from '../src/services/hlsTickets.js';
import { StreamWatchdog, parseRtmpStat } from '../src/services/streamWatchdog.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

const STAT_XML = `<?xml version="1.0" encoding="utf-8" ?>
<rtmp><server><application><name>live</name><live>
<stream><name>main-stream</name><time>12000</time><bw_in>7200000</bw_in><bytes_in>1000000</bytes_in><bw_out>0</bw_out><nclients>1</nclients><publishing/><active/></stream>
<stream><name>idle</name><bw_in>0</bw_in><bytes_in>0</bytes_in><nclients>1</nclients></stream>
<nclients>2</nclients></live></application></server></rtmp>`;

describe('HLS tickets', () => {
  it('issues tickets bound to one channel that expire', () => {
    const service = new HlsTicketService('secret', 1000);
    const { ticket, expiresAt } = service.issue('Main-Stream', 'acc-1', 10_000);
    expect(expiresAt).toBe(11_000);
    expect(service.verify(ticket, 'main-stream', 10_500)).toMatchObject({ channelName: 'main-stream', accountId: 'acc-1' });
    expect(service.verify(ticket, 'other', 10_500)).toBeNull();
    expect(service.verify(ticket, 'main-stream', 11_000)).toBeNull();
    expect(service.verify(ticket.slice(0, -2) + 'xx', 'main-stream', 10_500)).toBeNull();
    expect(new HlsTicketService('another').verify(ticket, 'main-stream', 10_500)).toBeNull();
  });
});

describe('Stream watchdog', () => {
  it('parses the publishing streams out of rtmp_stat', () => {
    expect(parseRtmpStat(STAT_XML)).toEqual([
      { name: 'main-stream', bwIn: 7_200_000, bytesIn: 1_000_000, publishing: true },
      { name: 'idle', bwIn: 0, bytesIn: 0, publishing: false },
    ]);
    expect(parseRtmpStat('<rtmp></rtmp>')).toEqual([]);
  });

  it('books egress per viewer and drops publishers over the bitrate cap after two polls', async () => {
    const ctx = makeContext({ STREAM_MAX_BITRATE_KBPS: '6000', STREAM_MONTHLY_EGRESS_GB: '150' });
    const calls: string[] = [];
    const notices: string[] = [];
    ctx.broadcast = { ...ctx.broadcast, notifyChannel: (_id, n) => void notices.push(n.message) };
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(String(url).includes('/control/') ? 'ok' : STAT_XML, { status: 200 });
    }) as typeof fetch;
    const watchdog = new StreamWatchdog(ctx, { statUrl: 'http://rtmp:8080', intervalMs: 15_000, maxBitrateKbps: 6000, monthlyEgressBytes: 150e9, fetchImpl });

    const channel = ctx.channels.getByName('main-stream')!;
    ctx.presence.startStream(channel.id, { accountId: null, displayName: 'main-stream', clientId: '1', sourceIp: null });

    await watchdog.tick(Date.UTC(2026, 9, 16));
    // No viewers joined the channel, so nothing was served; first strike only.
    expect(ctx.usage.monthEgressBytes(Date.UTC(2026, 9, 16))).toBe(0);
    expect(calls.filter((c) => c.includes('/control/'))).toHaveLength(0);

    await watchdog.tick(Date.UTC(2026, 9, 16));
    expect(calls.filter((c) => c.includes('/control/drop/publisher'))).toHaveLength(1);
    expect(notices[0]).toMatch(/above the 6000 kbps limit/);
    ctx.db.close();
  });

  it('pauses streaming once the monthly budget is spent', async () => {
    const ctx = makeContext({ STREAM_MONTHLY_EGRESS_GB: '1' });
    ctx.usage.addEgress(1.5e9, 60, Date.UTC(2026, 9, 16));
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(STAT_XML, { status: 200 });
    }) as typeof fetch;
    const watchdog = new StreamWatchdog(ctx, { statUrl: 'http://rtmp:8080', maxBitrateKbps: 60_000, monthlyEgressBytes: 1e9, fetchImpl });
    expect(watchdog.overBudget(Date.UTC(2026, 9, 16))).toBe(true);
    await watchdog.tick(Date.UTC(2026, 9, 16));
    expect(calls.some((c) => c.includes('/control/drop/publisher?app=live&name=main-stream'))).toBe(true);
    ctx.db.close();
  });
});

describe('HLS access over HTTP', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer({ STREAM_MAX_VIEWERS: '2' });
  });
  afterEach(async () => {
    await server.close();
  });

  it('only signed-in viewers of a stream channel get tickets, and Caddy auth honours them', async () => {
    const api = request(server.url);
    await api.post('/api/stream/main-stream/ticket').expect(401);

    const account = await server.ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice', inviteCode: null });
    const session = server.ctx.sessions.create(account.id);
    const auth = { Authorization: 'Bearer ' + session.token };

    await api.post('/api/stream/general/ticket').set(auth).expect(404);
    const issued = await api.post('/api/stream/main-stream/ticket').set(auth).expect(200);
    expect(typeof issued.body.ticket).toBe('string');
    expect(issued.headers['set-cookie']?.[0]).toMatch(/^datasetto_hls=.*Path=\/hls\/main-stream\//);

    await api.get('/internal/hls/auth').set('X-Forwarded-Uri', '/hls/main-stream/index.m3u8').expect(401);
    await api.get('/internal/hls/auth').set('X-Forwarded-Uri', '/hls/main-stream/123.ts').set('X-Hls-Ticket', issued.body.ticket).expect(200);
    await api.get('/internal/hls/auth').set('X-Forwarded-Uri', '/hls/other/index.m3u8').set('X-Hls-Ticket', issued.body.ticket).expect(401);
    await api.get('/internal/hls/auth').set('X-Forwarded-Uri', '/hls/main-stream/index.m3u8').set('Cookie', 'datasetto_hls=' + encodeURIComponent(issued.body.ticket)).expect(200);
  });

  it('refuses tickets when the stream is full or the budget is spent', async () => {
    const api = request(server.url);
    const account = await server.ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice', inviteCode: null });
    const session = server.ctx.sessions.create(account.id);
    const auth = { Authorization: 'Bearer ' + session.token };
    const channel = server.ctx.channels.getByName('main-stream')!;
    for (const id of ['s1', 's2', 's3']) {
      server.ctx.presence.addUser(id, account);
      server.ctx.presence.joinChannel(id, channel.id);
    }
    const full = await api.post('/api/stream/main-stream/ticket').set(auth).expect(429);
    expect(full.body.code).toBe('STREAM_FULL');

    server.ctx.usage.addEgress(server.ctx.config.streaming.monthlyEgressBytes + 1, 1);
    const paused = await api.post('/api/stream/main-stream/ticket').set(auth).expect(403);
    expect(paused.body.code).toBe('EGRESS_BUDGET_EXCEEDED');
    await api.get('/internal/hls/auth').set('X-Forwarded-Uri', '/hls/main-stream/index.m3u8').expect(403);
  });

  it('keeps TURN credentials out of the public config', async () => {
    const config = await request(server.url).get('/api/config').expect(200);
    expect(JSON.stringify(config.body.ice)).not.toContain('credential');
  });
});

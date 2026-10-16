import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { healthReport, LATEST_SCHEMA_VERSION } from '../src/http/routes/health.js';
import { migrations } from '../src/db/migrations.js';
import { StreamWatchdog } from '../src/services/streamWatchdog.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

const STAT_XML = `<?xml version="1.0"?><rtmp><server><application><name>live</name><live>
<stream><name>main-stream</name><bw_in>2000000</bw_in><bytes_in>1</bytes_in><publishing/></stream>
</live></application></server></rtmp>`;

describe('health endpoint', () => {
  let server: TestServer | null = null;
  const sockets: Socket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server?.close();
    server = null;
  });

  it('reports the database, the socket counts and no watchdog when none runs', async () => {
    server = await startTestServer();
    const socket = connect(server.url, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

    const response = await request(server.url).get('/api/health').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.status).toBe('ok');
    expect(response.body.shuttingDown).toBe(false);
    expect(response.body.database).toEqual({
      ok: true,
      schemaVersion: LATEST_SCHEMA_VERSION,
      schemaExpected: LATEST_SCHEMA_VERSION,
      journalMode: 'memory',
      error: null,
    });
    expect(LATEST_SCHEMA_VERSION).toBe(Math.max(...migrations.map((migration) => migration.version)));
    expect(response.body.watchdog).toBeNull();
    expect(response.body.sockets).toEqual({ connected: 1, signedIn: 0 });
    expect(typeof response.body.uptime).toBe('number');
    expect(typeof response.body.version).toBe('string');
    // The plain liveness path says the same thing.
    const plain = await request(server.url).get('/health').expect(200);
    expect(plain.body.status).toBe('ok');
  });

  it('shows the watchdog state: enabled, its last poll, and the error when nginx-rtmp is unreachable', async () => {
    server = await startTestServer({ RTMP_STAT_URL: 'http://rtmp.test:8080' });
    let reachable = true;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (!reachable) throw new Error('connect ECONNREFUSED');
      const url = String(input);
      if (url.endsWith('/stat')) return new Response(STAT_XML, { status: 200 });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const watchdog = new StreamWatchdog(server.ctx, { statUrl: 'http://rtmp.test:8080', maxBitrateKbps: 6000, monthlyEgressBytes: 0, fetchImpl, intervalMs: 60_000 });
    server.ctx.runtime.watchdog = watchdog;

    let response = await request(server.url).get('/api/health').expect(200);
    expect(response.body.watchdog).toMatchObject({ enabled: true, running: false, lastPollAt: null, lastPollOk: null, lastError: null, publishing: 0, overBudget: false });

    watchdog.start();
    await watchdog.tick(1_000);
    response = await request(server.url).get('/api/health').expect(200);
    expect(response.body.watchdog).toMatchObject({ enabled: true, running: true, lastPollAt: 1_000, lastPollOk: true, lastError: null, publishing: 1, intervalMs: 60_000 });

    reachable = false;
    await watchdog.tick(2_000);
    response = await request(server.url).get('/api/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.watchdog).toMatchObject({ lastPollAt: 2_000, lastPollOk: false, lastError: 'connect ECONNREFUSED' });
    watchdog.stop();
    expect((await request(server.url).get('/api/health')).body.watchdog.running).toBe(false);
  });

  it('registers a stream that kept publishing through a restart on the first poll', async () => {
    const ctx = makeContext({ RTMP_STAT_URL: 'http://rtmp.test:8080' });
    let channelsBroadcasts = 0;
    ctx.broadcast = { ...ctx.broadcast, channels: () => void (channelsBroadcasts += 1) };
    const fetchImpl = (async () => new Response(STAT_XML, { status: 200 })) as typeof fetch;
    const watchdog = new StreamWatchdog(ctx, { statUrl: 'http://rtmp.test:8080', maxBitrateKbps: 0, monthlyEgressBytes: 0, fetchImpl, intervalMs: 15_000 });
    const channel = ctx.channels.getByName('main-stream')!;
    expect(ctx.presence.getStream(channel.id)).toBeNull();

    await watchdog.tick(1_000);
    const stream = ctx.presence.getStream(channel.id);
    expect(stream).toMatchObject({ channelId: channel.id, accountId: null, displayName: null, clientId: null });
    expect(ctx.presence.channelView(channel).isLive).toBe(true);
    expect(channelsBroadcasts).toBe(1);
    // Later polls leave the registration alone.
    await watchdog.tick(16_000);
    expect(ctx.presence.getStream(channel.id)?.sessionId).toBe(stream!.sessionId);
    expect(channelsBroadcasts).toBe(1);
    ctx.db.close();
  });

  it('is degraded with a 503 when the database no longer answers', () => {
    const ctx = makeContext();
    expect(healthReport(ctx).status).toBe('ok');
    ctx.db.close();
    const report = healthReport(ctx);
    expect(report.status).toBe('degraded');
    expect(report.database.ok).toBe(false);
    expect(report.database.error).toMatch(/closed/);
  });

  it('is "restarting" with a 503 during a graceful shutdown', async () => {
    server = await startTestServer();
    server.ctx.runtime.shuttingDown = true;
    const response = await request(server.url).get('/api/health').expect(503);
    expect(response.body.status).toBe('restarting');
    expect(response.body.database.ok).toBe(true);
  });
});

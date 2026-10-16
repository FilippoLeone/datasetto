import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';

describe('HTTP API', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer({ PUBLIC_RTMP_URL: 'rtmp://example.test/live' });
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves health and public config', async () => {
    const health = await request(server.url).get('/health').expect(200);
    expect(health.body.status).toBe('ok');

    const config = await request(server.url).get('/api/config').expect(200);
    expect(config.headers['cache-control']).toBe('no-store');
    expect(config.body.registration).toEqual({ mode: 'open', requiresInvite: false, acceptsInviteLinks: true });
    expect(config.body.urls.rtmp).toBe('rtmp://example.test/live');
    expect(Array.isArray(config.body.ice.servers)).toBe(true);
  });

  it('authorizes OBS publishes by channel name plus key', async () => {
    const channel = server.ctx.channels.getByName('main-stream')!;
    const token = channel.streamKey!;

    await request(server.url)
      .post('/internal/stream/publish')
      .type('form')
      .send({ app: 'live', name: 'main-stream', key: token, addr: '10.0.0.5', clientid: '7', call: 'publish' })
      .expect(200)
      .expect((res) => expect(res.body.channel).toBe('main-stream'));

    const status = await request(server.url).get('/api/stream/main-stream/status').expect(200);
    expect(status.body.isLive).toBe(true);

    await request(server.url)
      .post('/internal/stream/publish')
      .type('form')
      .send({ app: 'live', name: 'main-stream', key: token, addr: '10.0.0.6', clientid: '8', call: 'publish' })
      .expect(409);

    await request(server.url)
      .post('/internal/stream/done')
      .type('form')
      .send({ app: 'live', name: 'main-stream', addr: '10.0.0.5', clientid: '7', call: 'publish_done' })
      .expect(200)
      .expect((res) => expect(res.body.released).toBe(true));

    const after = await request(server.url).get('/api/stream/main-stream/status').expect(200);
    expect(after.body.isLive).toBe(false);
  });

  it('rejects unknown keys, bare channel names, and keys used under another stream name', async () => {
    const token = server.ctx.channels.getByName('main-stream')!.streamKey!;
    await request(server.url).post('/internal/stream/publish').type('form').send({ name: 'main-stream', key: 'wrong' }).expect(403);
    await request(server.url).post('/internal/stream/publish').type('form').send({ name: 'main-stream' }).expect(403);
    await request(server.url).post('/internal/stream/publish').type('form').send({ name: 'main-stream+' + token }).expect(403);
    await request(server.url).post('/internal/stream/publish').type('form').send({ name: 'general', key: token }).expect(403);
    expect(server.ctx.presence.getStream(server.ctx.channels.getByName('main-stream')!.id)).toBeNull();
    await request(server.url).get('/api/stream/nope/status').expect(404);
  });

  it('blocks disallowed browser origins', async () => {
    const res = await request(server.url).get('/api/config').set('Origin', 'https://evil.example').expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await request(server.url).get('/api/config').set('Origin', 'http://localhost').expect(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost');
  });
});

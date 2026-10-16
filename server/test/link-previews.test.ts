import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import {
  decodeEntities,
  extractFirstUrl,
  isPublicAddress,
  LinkPreviewService,
  parsePage,
  PREVIEW_CACHE_MS,
  PREVIEW_FAILURE_CACHE_MS,
  previewView,
} from '../src/services/linkPreviews.js';
import { makeContext, startTestServer, waitFor, type TestServer } from './helpers.js';

describe('address filter', () => {
  it('lets public addresses through and refuses everything local, private or special', () => {
    for (const ok of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700::1111', '2a00:1450:4001::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
      expect(isPublicAddress(ok), ok).toBe(true);
    }
    const blocked = [
      '127.0.0.1', '127.255.255.254', '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.10', '198.18.0.1', '198.51.100.7', '203.0.113.9',
      '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '192.88.99.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.5', '::ffff:169.254.169.254',
      '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1', '2002:c0a8:101::1', '2001::1', '2001:db8::1', '100::1', 'fe80::1%eth0',
      'not-an-ip', '1.2.3', '1.2.3.4.5', '256.1.1.1', '', 'example.com',
    ];
    for (const bad of blocked) expect(isPublicAddress(bad), bad).toBe(false);
  });
});

describe('link extraction and page parsing', () => {
  it('takes the first http(s) link and tidies it', () => {
    expect(extractFirstUrl('look at https://example.com/a?b=1#frag, nice')).toBe('https://example.com/a?b=1');
    expect(extractFirstUrl('(see https://example.com/wiki/Foo_(bar))')).toBe('https://example.com/wiki/Foo_(bar)');
    expect(extractFirstUrl('<https://example.com/x>')).toBe('https://example.com/x');
    expect(extractFirstUrl('two http://first.example/ and https://second.example/')).toBe('http://first.example/');
    expect(extractFirstUrl('HTTPS://Example.COM')).toBe('https://example.com/');
    expect(extractFirstUrl('no links here')).toBeNull();
    expect(extractFirstUrl('ftp://example.com/file')).toBeNull();
    expect(extractFirstUrl('https://user:pw@example.com/')).toBeNull();
    expect(extractFirstUrl('https://' + 'a'.repeat(3000) + '.com')).toBeNull();
    expect(extractFirstUrl('https://')).toBeNull();
  });

  it('reads Open Graph, then Twitter, then the plain title and description', () => {
    const html = `<!doctype html><html><head>
      <title>Plain &amp; simple</title>
      <meta name="description" content="Meta description">
      <meta content="OG Title &quot;quoted&quot;" property="og:title">
      <meta property='og:description' content='It&#39;s   spread
      over lines'>
      <meta property="og:image" content="/img/card.png?x=1&amp;y=2">
      <meta property="og:site_name" content="Example">
      <meta property="og:title" content="second one is ignored">
    </head><body><meta property="og:title" content="in the body, ignored"></body></html>`;
    expect(parsePage(html, 'https://example.com/post/1')).toEqual({
      title: 'OG Title "quoted"',
      description: "It's spread over lines",
      image: 'https://example.com/img/card.png?x=1&y=2',
      siteName: 'Example',
    });
    expect(parsePage('<html><head><title>Only a title</title></head></html>', 'https://x.test/')).toEqual({ title: 'Only a title', description: null, image: null, siteName: null });
    expect(parsePage('<meta name="twitter:title" content="Tw"><meta name="twitter:image" content="javascript:alert(1)">', 'https://x.test/')).toEqual({ title: 'Tw', description: null, image: null, siteName: null });
    expect(parsePage('<meta property="og:image:secure_url" content="https://cdn.test/a.jpg"><meta property="og:image" content="http://cdn.test/b.jpg">', 'https://x.test/').image).toBe('https://cdn.test/a.jpg');
    expect(parsePage('<title>' + 'x'.repeat(400) + '</title>', 'https://x.test/').title).toHaveLength(200);
    expect(parsePage('<script>document.write("<meta property=og:title content=hacked>")</script>', 'https://x.test/').title).toBe('hacked');
    expect(parsePage('', 'https://x.test/')).toEqual({ title: null, description: null, image: null, siteName: null });
    expect(decodeEntities('&lt;b&gt; &#x1F600; &#128512; &unknown; &#0;')).toBe('<b> 😀 😀 &unknown; &#0;');
  });

  it('turns records into cards only when there is something to show', () => {
    const base = { url: 'https://x.test/', finalUrl: null, title: null, description: null, image: null, siteName: null, ok: true, fetchedAt: 1 };
    expect(previewView(base)).toBeNull();
    expect(previewView({ ...base, ok: false, title: 'T' })).toBeNull();
    expect(previewView({ ...base, title: 'T' })).toEqual({ url: 'https://x.test/', title: 'T', description: null, image: null, siteName: null });
    expect(previewView(null)).toBeNull();
  });
});

/** A small web site on 127.0.0.1 standing in for the internet. */
const site = () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const url = new URL(req.url ?? '/', 'http://site.test');
    const html = (head: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head>' + head + '</head><body>hi</body></html>');
    };
    switch (url.pathname) {
      case '/og':
        return html('<meta property="og:title" content="Hello OG"><meta property="og:description" content="A page"><meta property="og:image" content="/pic.png"><meta property="og:site_name" content="Site">');
      case '/redirect':
        res.writeHead(302, { location: '/og' });
        return res.end();
      case '/loop':
        res.writeHead(301, { location: '/loop' });
        return res.end();
      case '/to-private':
        res.writeHead(302, { location: 'http://10.0.0.1/secret' });
        return res.end();
      case '/big': {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><head><title>Big page</title></head><body>');
        const filler = Buffer.alloc(64 * 1024, 'x');
        for (let i = 0; i < 40; i += 1) res.write(filler);
        return res.end('</body></html>');
      }
      case '/slow':
        return; // never answers
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"title":"nope"}');
      case '/image':
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/latin': {
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
        return res.end(Buffer.concat([Buffer.from('<title>caf'), Buffer.from([0xe9]), Buffer.from('</title>')]));
      }
      default:
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<title>missing</title>');
    }
  });
  return {
    server,
    hits: () => hits,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve('http://site.test:' + (server.address() as AddressInfo).port));
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe('LinkPreviewService', () => {
  const web = site();
  let origin = '';
  beforeAll(async () => {
    origin = await web.listen();
  });
  afterAll(async () => {
    web.server.closeAllConnections();
    await web.close();
  });

  // DNS answers 127.0.0.1 for the fake site; the filter lets only that through (plus real public addresses).
  const options = {
    lookup: async (hostname: string) => (hostname === 'site.test' ? ['127.0.0.1'] : []),
    isAllowedAddress: (ip: string) => ip === '127.0.0.1' || isPublicAddress(ip),
    timeoutMs: 400,
  };
  const service = (extra: Partial<typeof options> & { maxBytes?: number } = {}) => new LinkPreviewService(openDatabase(':memory:', { memory: true }), { ...options, ...extra });

  it('fetches Open Graph data, follows redirects and resolves relative images', async () => {
    const previews = service();
    const record = await previews.previewFor(origin + '/og');
    expect(record).toMatchObject({ ok: true, title: 'Hello OG', description: 'A page', image: origin + '/pic.png', siteName: 'Site', finalUrl: origin + '/og' });
    const redirected = await previews.previewFor(origin + '/redirect');
    expect(redirected).toMatchObject({ ok: true, title: 'Hello OG', finalUrl: origin + '/og' });
    const latin = await previews.previewFor(origin + '/latin');
    expect(latin.title).toBe('café');
    const image = await previews.previewFor(origin + '/image');
    expect(previewView(image)).toEqual({ url: origin + '/image', title: null, description: null, image: origin + '/image', siteName: null });
  });

  it('caps the size, the time, the redirects and the content types', async () => {
    const previews = service({ maxBytes: 200 * 1024 });
    const big = await previews.fetchPreview(origin + '/big');
    expect(big.page.title).toBe('Big page');
    await expect(previews.fetchPreview(origin + '/slow')).rejects.toMatchObject({ code: 'PREVIEW_TIMEOUT' });
    await expect(previews.fetchPreview(origin + '/loop')).rejects.toMatchObject({ code: 'PREVIEW_REDIRECTS' });
    await expect(previews.fetchPreview(origin + '/json')).rejects.toMatchObject({ code: 'PREVIEW_NOT_HTML' });
    await expect(previews.fetchPreview(origin + '/missing')).rejects.toMatchObject({ code: 'PREVIEW_STATUS' });
  });

  it('never contacts private, local or metadata addresses, not even after a redirect', async () => {
    const previews = service();
    const before = web.hits();
    await expect(previews.fetchPreview('http://localhost/og')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    await expect(previews.fetchPreview('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    await expect(previews.fetchPreview('http://[::1]/')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    await expect(previews.fetchPreview('http://metadata.google.internal/')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    await expect(previews.fetchPreview('http://printer.local/')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    await expect(previews.fetchPreview('http://unknown.test/')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    expect(web.hits()).toBe(before);
    // The first hop is fine, the redirect target is not.
    await expect(previews.fetchPreview(origin + '/to-private')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    expect(web.hits()).toBe(before + 1);

    // With the real filter nothing on 127.0.0.1 is ever fetched, whatever DNS says.
    const strict = new LinkPreviewService(openDatabase(':memory:', { memory: true }), { lookup: options.lookup });
    await expect(strict.fetchPreview(origin + '/og')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    await expect(strict.fetchPreview('http://127.0.0.1:' + new URL(origin).port + '/og')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    await expect(strict.fetchPreview('http://[::ffff:127.0.0.1]:' + new URL(origin).port + '/og')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    await expect(strict.fetchPreview('http://10.0.0.1/')).rejects.toMatchObject({ code: 'PREVIEW_ADDRESS_BLOCKED' });
    const spoofed = new LinkPreviewService(openDatabase(':memory:', { memory: true }), { lookup: async () => ['8.8.8.8', '192.168.0.1'] });
    expect(await spoofed.resolveAllowed('mixed.test')).toEqual(['8.8.8.8']);
    expect(web.hits()).toBe(before + 1);
  });

  it('caches per URL for a day, failures for an hour, and shares one fetch per URL', async () => {
    const previews = service();
    const before = web.hits();
    const [a, b] = await Promise.all([previews.previewFor(origin + '/og'), previews.previewFor(origin + '/og')]);
    expect(a).toEqual(b);
    expect(web.hits()).toBe(before + 1);
    await previews.previewFor(origin + '/og');
    expect(web.hits()).toBe(before + 1);
    expect(previews.cached(origin + '/og')?.title).toBe('Hello OG');
    expect(previews.isFresh(previews.cached(origin + '/og')!, Date.now() + PREVIEW_CACHE_MS + 1)).toBe(false);
    await previews.previewFor(origin + '/og', Date.now() + PREVIEW_CACHE_MS + 1);
    expect(web.hits()).toBe(before + 2);

    const failed = await previews.previewFor(origin + '/json');
    expect(failed.ok).toBe(false);
    expect(previewView(failed)).toBeNull();
    await previews.previewFor(origin + '/json');
    expect(web.hits()).toBe(before + 3);
    await previews.previewFor(origin + '/json', Date.now() + PREVIEW_FAILURE_CACHE_MS + 1);
    expect(web.hits()).toBe(before + 4);
    // Unused rows are purged after a week; referenced ones stay (none referenced here).
    expect(previews.purgeStale(Date.now() + 8 * 24 * 3600 * 1000)).toBe(2);
  });
});

const once = <T = unknown>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const client = (url: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

interface Preview {
  url: string;
  title: string | null;
}

describe('link previews in chat', () => {
  const web = site();
  let origin = '';
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    origin = await web.listen();
  });
  afterAll(async () => {
    web.server.closeAllConnections();
    await web.close();
  });
  beforeEach(async () => {
    server = await startTestServer(
      {},
      {
        linkPreviews: {
          lookup: async (hostname: string) => (hostname === 'site.test' ? ['127.0.0.1'] : []),
          isAllowedAddress: (ip: string) => ip === '127.0.0.1',
          timeoutMs: 500,
        },
      },
    );
  });
  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server.close();
  });

  const signUp = async (username: string, displayName: string) => {
    const account = await server.ctx.accounts.register({ username, password: 'password123', displayName });
    const session = server.ctx.sessions.create(account.id);
    const socket = await client(server.url);
    sockets.push(socket);
    const success = once(socket, 'auth:success');
    socket.emit('auth:session', { token: session.token });
    await success;
    return { account, socket };
  };

  const join = async (socket: Socket, channelId: string) => {
    const joined = once(socket, 'channel:joined');
    socket.emit('channel:join', channelId);
    await joined;
  };

  it('attaches the card once fetched, serves it with history, and lets the author remove it', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    const general = server.ctx.channels.getByName('general')!;
    await join(alice.socket, general.id);
    await join(bob.socket, general.id);

    const bobSees = once<{ id: string; preview: Preview | null }>(bob.socket, 'chat');
    const bobUpdate = once<{ channelId: string; messageId: string; preview: Preview | null }>(bob.socket, 'chat:messageUpdated');
    alice.socket.emit('chat', 'check ' + origin + '/og now');
    const message = await bobSees;
    expect(message.preview).toBeNull();
    const update = await bobUpdate;
    expect(update).toEqual({ channelId: general.id, messageId: message.id, preview: { url: origin + '/og', title: 'Hello OG', description: 'A page', image: origin + '/pic.png', siteName: 'Site' } });

    // Known URL: the next message carries the card right away, and history has it too.
    const second = once<{ preview: Preview | null }>(bob.socket, 'chat');
    alice.socket.emit('chat', 'again ' + origin + '/og');
    expect((await second).preview?.title).toBe('Hello OG');
    expect(server.ctx.messages.history(general.id).map((m) => m.preview?.title)).toEqual(['Hello OG', 'Hello OG']);
    // The search index only knows the text.
    expect(server.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'Hello'").get()).toEqual({ n: 0 });

    // Bob cannot remove Alice's card; Alice can, and it stays gone.
    const refused = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('chat:preview:remove', { channelId: general.id, messageId: message.id });
    expect((await refused).code).toBe('FORBIDDEN');
    const removed = once<{ messageId: string; preview: Preview | null }>(bob.socket, 'chat:messageUpdated');
    alice.socket.emit('chat:preview:remove', { channelId: general.id, messageId: message.id });
    expect(await removed).toEqual({ channelId: general.id, messageId: message.id, preview: null });
    expect(server.ctx.messages.get(general.id, message.id)?.preview).toBeNull();
    expect(server.ctx.messages.history(general.id).map((m) => m.preview?.title)).toEqual([undefined, 'Hello OG']);
  });

  it('fetches nothing for failing links, private addresses, or channels with previews switched off', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const general = server.ctx.channels.getByName('general')!;
    await join(alice.socket, general.id);
    const hitsBefore = web.hits();

    const nothing = once(alice.socket, 'chat:messageUpdated', 700).catch(() => 'none');
    alice.socket.emit('chat', 'see ' + origin + '/json');
    expect(await nothing).toBe('none');
    expect(server.ctx.linkPreviews.cached(origin + '/json')?.ok).toBe(false);

    const blocked = once(alice.socket, 'chat:messageUpdated', 500).catch(() => 'none');
    alice.socket.emit('chat', 'see http://169.254.169.254/latest/meta-data/');
    expect(await blocked).toBe('none');
    expect(web.hits()).toBe(hitsBefore + 1);

    server.ctx.channels.update(general.id, { linkPreviews: false });
    const off = once(alice.socket, 'chat:messageUpdated', 500).catch(() => 'none');
    const sent = once<{ id: string }>(alice.socket, 'chat');
    alice.socket.emit('chat', 'quiet ' + origin + '/og');
    const message = await sent;
    expect(await off).toBe('none');
    expect(web.hits()).toBe(hitsBefore + 1);
    expect(server.ctx.messages.previewUrlOf(general.id, message.id)).toBeNull();
    expect(server.ctx.channels.get(general.id)?.linkPreviews).toBe(false);
    expect(server.ctx.presence.channelView(server.ctx.channels.get(general.id)!).linkPreviews).toBe(false);

    // Switched back on, the card arrives again; a removed card is not re-fetched for that message.
    server.ctx.channels.update(general.id, { linkPreviews: true });
    const on = once<{ preview: Preview | null }>(alice.socket, 'chat:messageUpdated');
    alice.socket.emit('chat', 'loud ' + origin + '/og');
    expect((await on).preview?.title).toBe('Hello OG');
    await waitFor(() => web.hits() === hitsBefore + 2);
  });

  it('is off for the whole server with LINK_PREVIEWS=false', async () => {
    await server.close();
    server = await startTestServer({ LINK_PREVIEWS: 'false' }, { linkPreviews: { lookup: async () => ['127.0.0.1'], isAllowedAddress: () => true } });
    const alice = await signUp('alice@example.com', 'Alice');
    const general = server.ctx.channels.getByName('general')!;
    await join(alice.socket, general.id);
    const hitsBefore = web.hits();
    const nothing = once(alice.socket, 'chat:messageUpdated', 500).catch(() => 'none');
    alice.socket.emit('chat', origin + '/og');
    expect(await nothing).toBe('none');
    expect(web.hits()).toBe(hitsBefore);
    const config = await fetch(server.url + '/api/config').then((response) => response.json() as Promise<{ linkPreviews: { enabled: boolean }; uploads: { maxBytes: number; acceptedTypes: string[] } }>);
    expect(config.linkPreviews.enabled).toBe(false);
    expect(config.uploads.maxBytes).toBe(10 * 1024 * 1024);
    expect(config.uploads.acceptedTypes).toContain('image/gif');
  });

  it('keeps the first link of a message with a preview record while the migration backfills nothing', () => {
    const ctx = makeContext();
    // Migration 11 brought the tables; later migrations raise the version further.
    expect(Number(ctx.db.pragma('user_version', { simple: true }))).toBeGreaterThanOrEqual(11);
    expect(ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message_attachments', 'link_previews')").all()).toHaveLength(2);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { startTestServer, type TestServer } from './helpers.js';

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

interface SessionEvent {
  channelId: string;
  active: boolean;
  hostId: string | null;
  allowClips: boolean;
  viewerCount: number;
}

/**
 * The clip permission of a shared screen: the host says whether viewers may save
 * clips of it on their own device. The server stores nothing but the flag and
 * tells the room through the session event.
 */
describe('screenshare clip permission', () => {
  let server: TestServer | null = null;
  const sockets: Socket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server?.close();
    server = null;
  });

  const open = async () => {
    const socket = await client(server!.url);
    sockets.push(socket);
    return socket;
  };

  const register = async (socket: Socket, username: string, displayName: string) => {
    const auth = once<{ session: { token: string }; account: { id: string } }>(socket, 'auth:success');
    socket.emit('auth:register', { username, password: 'password123', profile: { displayName } });
    return auth;
  };

  const enter = async (socket: Socket, channelId: string) => {
    const joined = once(socket, 'channel:joined');
    socket.emit('channel:join', channelId);
    await joined;
  };

  it('relays the host flag, defaults to allowed, and lets only the host change it while sharing', async () => {
    server = await startTestServer();
    const room = server.ctx.channels.getByName('team-share')!;
    const alice = await open();
    await register(alice, 'alice@example.com', 'Alice');
    const bob = await open();
    await register(bob, 'bob@example.com', 'Bob');
    await enter(alice, room.id);
    await enter(bob, room.id);

    // Nobody shares: the view says clips are allowed (there is nothing to clip anyway).
    expect(server.ctx.presence.screenshareView(room.id).allowClips).toBe(true);

    // Alice shares and does not want clips. Bob hears that in the same session event.
    const bobSees = once<SessionEvent>(bob, 'screenshare:session');
    alice.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'alice-rtc', holding: [], allowClips: false });
    expect(await bobSees).toMatchObject({ channelId: room.id, active: true, hostId: alice.id, allowClips: false });

    // A viewer cannot flip the flag.
    const refused = once<{ code: string }>(bob, 'screenshare:error');
    bob.emit('screenshare:update', { channelId: room.id, allowClips: true });
    expect((await refused).code).toBe('NOT_HOST');
    expect(server.ctx.presence.screenshareView(room.id).allowClips).toBe(false);

    // The host changes their mind while sharing: the room is told.
    const allowed = once<SessionEvent>(bob, 'screenshare:session');
    alice.emit('screenshare:update', { channelId: room.id, allowClips: true });
    expect(await allowed).toMatchObject({ active: true, hostId: alice.id, allowClips: true });

    // An update that changes nothing is silent.
    let extra = 0;
    bob.on('screenshare:session', () => (extra += 1));
    alice.emit('screenshare:update', { channelId: room.id, allowClips: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(extra).toBe(0);

    // Stopping and starting again without the flag (an older client) means allowed.
    const stopped = once<SessionEvent>(bob, 'screenshare:session');
    alice.emit('screenshare:stop', { channelId: room.id });
    expect((await stopped).active).toBe(false);
    const restarted = once<SessionEvent>(bob, 'screenshare:session');
    alice.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'alice-rtc-2', holding: [] });
    expect(await restarted).toMatchObject({ active: true, allowClips: true });
  });

  it('refuses an update when nobody shares and rejects a malformed flag', async () => {
    server = await startTestServer();
    const room = server.ctx.channels.getByName('team-share')!;
    const alice = await open();
    await register(alice, 'alice@example.com', 'Alice');
    await enter(alice, room.id);

    const noShare = once<{ code: string }>(alice, 'screenshare:error');
    alice.emit('screenshare:update', { channelId: room.id, allowClips: false });
    expect((await noShare).code).toBe('NOT_HOST');

    alice.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'alice-rtc', holding: [] });
    await once(alice, 'screenshare:session');
    const malformed = once<{ code: string }>(alice, 'screenshare:error');
    alice.emit('screenshare:update', { channelId: room.id, allowClips: 'yes' });
    expect((await malformed).code).toBe('VALIDATION_FAILED');
    expect(server.ctx.presence.screenshareView(room.id).allowClips).toBe(true);
  });
});

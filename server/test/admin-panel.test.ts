import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

interface Usage {
  currentMonth: { month: string; hlsEgressBytes: number; streamSeconds: number };
  months: Array<{ month: string }>;
  budgetBytes: number;
  online: number;
  liveStreams: Array<{ channelName: string; viewerCount: number }>;
}

describe('admin panel data', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer({ ADMIN_EMAILS: 'root@example.com', STREAM_MONTHLY_EGRESS_GB: '2', TURN_URLS: 'turn:turn.example.test:3478', TURN_SECRET: 'shh' });
  });

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server.close();
  });

  const signUp = async (username: string) => {
    const socket = await client(server.url);
    sockets.push(socket);
    const auth = once<{ account: { id: string; roles: string[] } }>(socket, 'auth:success');
    socket.emit('auth:register', { username, password: 'password123' });
    return { socket, account: (await auth).account };
  };

  it('reports usage to admins and the configuration to superusers only', async () => {
    const root = await signUp('root@example.com'); // first account: admin, plus superuser from ADMIN_EMAILS
    const admin = await signUp('admin@example.com');
    server.ctx.accounts.assignRoles(admin.account.id, ['admin']);
    const member = await signUp('bob@example.com');
    expect(root.account.roles).toContain('superuser');

    // Usage: months, budget, online count and live streams with viewers.
    server.ctx.usage.addEgress(1.5e9, 3600);
    const stream = server.ctx.channels.getByName('main-stream')!;
    server.ctx.presence.startStream(stream.id, { accountId: null, displayName: 'main-stream', clientId: '1', sourceIp: null });
    const joined = once(member.socket, 'channel:joined');
    member.socket.emit('channel:join', stream.id);
    await joined;

    // The admin role was assigned after sign-in; refresh the socket's roles by resuming... simpler: root checks, admin re-logs in.
    const usage = once<Usage>(root.socket, 'admin:usage');
    root.socket.emit('admin:usage:get');
    const report = await usage;
    expect(report.currentMonth.hlsEgressBytes).toBe(1.5e9);
    expect(report.currentMonth.streamSeconds).toBe(3600);
    expect(report.months.length).toBeGreaterThanOrEqual(1);
    expect(report.budgetBytes).toBe(2e9);
    expect(report.online).toBe(3);
    expect(report.liveStreams).toEqual([expect.objectContaining({ channelName: 'main-stream', viewerCount: 1 })]);

    const denied = once<{ code: string }>(member.socket, 'admin:error');
    member.socket.emit('admin:usage:get');
    expect((await denied).code).toBe('FORBIDDEN');

    // Server info: superuser only, never leaks secrets.
    const info = once<Record<string, unknown>>(root.socket, 'admin:server:info');
    root.socket.emit('admin:server:info');
    const payload = await info;
    expect(payload.version).toBe(server.ctx.config.version);
    expect(payload.registration).toEqual({ mode: 'open', inviteCodeSet: false, adminEmails: ['root@example.com'] });
    expect(payload.turn).toMatchObject({ enabled: true, urls: ['turn:turn.example.test:3478'] });
    expect(payload.sessions).toEqual({ ttlDays: 30, singlePerAccount: true });
    expect(payload.counts).toMatchObject({ accounts: 3, channels: 6, online: 3 });
    expect(JSON.stringify(payload)).not.toContain('shh');

    const adminSocket = await client(server.url);
    sockets.push(adminSocket);
    const adminAuth = once(adminSocket, 'auth:success');
    adminSocket.emit('auth:login', { username: 'admin@example.com', password: 'password123' });
    await adminAuth;
    const adminDenied = once<{ code: string }>(adminSocket, 'admin:error');
    adminSocket.emit('admin:server:info');
    expect((await adminDenied).code).toBe('FORBIDDEN');
    const adminUsage = once<Usage>(adminSocket, 'admin:usage');
    adminSocket.emit('admin:usage:get');
    expect((await adminUsage).budgetBytes).toBe(2e9);
  });
});

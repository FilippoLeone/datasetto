/**
 * Shared fakes for the online shell tests: a scriptable app socket (`socketClient`), remote hosts
 * the test drives by hand, and an online-ready catalogue around the fake game in
 * fakeGame.test-util.ts. Import only from tests (and from their vi.mock factories).
 */
import type { GameMeta } from '@/arcade/catalog';
import type { FrameView, GameChunk, LobbyView, MatchHost, SeatInfo, TableHost, Welcome } from '@/arcade/runtime/types';
import { fakeChunk, fakeMeta } from './fakeGame.test-util';
import type { ActivityEntry } from './state';

type Handler = (payload: unknown) => void;

/** Stands in for `socketClient` (services/socket/client.ts). */
export const fakeSocket = {
  connected: true,
  id: 'socket-me',
  handlers: new Map<string, Set<Handler>>(),
  requests: [] as { ev: string; payload: unknown }[],
  responders: new Map<string, (payload: unknown) => unknown>(),
  on(ev: string, handler: Handler): () => void {
    let set = this.handlers.get(ev);
    if (!set) this.handlers.set(ev, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  },
  request<T>(ev: string, payload?: unknown): Promise<T> {
    this.requests.push({ ev, payload });
    const respond = this.responders.get(ev);
    return respond ? Promise.resolve(respond(payload) as T) : Promise.reject(new Error('no answer for ' + ev));
  },
  emit(): void {},
  onAck: () => () => undefined,
  lastRequestAt: () => 0,
  ackRtt: () => 0,
  /** A server push to every listener. */
  push(ev: string, payload: unknown): void {
    for (const handler of Array.from(this.handlers.get(ev) ?? [])) handler(payload);
  },
  sent(ev: string): unknown[] {
    return this.requests.filter((r) => r.ev === ev).map((r) => r.payload);
  },
  reset(): void {
    this.requests.length = 0;
    this.responders.clear();
  },
};

export const socketModule = { socketClient: fakeSocket };

/** A remote match host the test drives: `welcome()`, `frame()`, `yieldTo(true)`. */
export interface FakeRemoteHost extends MatchHost {
  readonly args: { lobbyId: string; ticket: string; game: string };
  closed: boolean;
  visible: boolean[];
  welcome(): void;
  frame(): void;
  yieldTo(on: boolean): void;
}

export const fakeRemote = { hosts: [] as FakeRemoteHost[], tables: 0 };

const makeRemoteHost = (args: FakeRemoteHost['args']): FakeRemoteHost => {
  let onWelcome: ((w: Welcome) => void) | null = null;
  let onFrame: ((f: FrameView) => void) | null = null;
  const yieldCbs = new Set<(on: boolean) => void>();
  const host: FakeRemoteHost = {
    mode: 'remote',
    args,
    closed: false,
    visible: [],
    sendUp: () => undefined,
    sendEvent: () => undefined,
    onWelcome: (cb) => void (onWelcome = cb),
    onFrame: (cb) => void (onFrame = cb),
    onKeyframe: () => undefined,
    onPhase: () => undefined,
    onHandover: () => undefined,
    onSeats: (cb: (seats: readonly SeatInfo[]) => void) => {
      cb([]);
      return () => undefined;
    },
    onClosed: () => undefined,
    setVisible: (v) => void host.visible.push(v),
    rttMs: () => 40,
    linkConstrained: () => false,
    estServerTick: () => 0,
    close() {
      host.closed = true;
      onWelcome = onFrame = null;
      yieldCbs.clear();
    },
    welcome: () => onWelcome?.({} as Welcome),
    frame: () => onFrame?.({} as FrameView),
    yieldTo: (on) => yieldCbs.forEach((cb) => cb(on)),
  };
  (host as unknown as { onYield(cb: (on: boolean) => void): () => void }).onYield = (cb) => {
    yieldCbs.add(cb);
    return () => yieldCbs.delete(cb);
  };
  fakeRemote.hosts.push(host);
  return host;
};

const makeTableHost = (): TableHost => {
  fakeRemote.tables += 1;
  return {
    mode: 'remote',
    request: () => Promise.reject(new Error('offline')),
    on: () => () => undefined,
    connected: () => true,
    onConnection: () => () => undefined,
    ackRttMs: () => 0,
    setVisible: () => undefined,
    close: () => undefined,
  };
};

export const remoteHostModule = {
  createRemoteMatchHost: (a: FakeRemoteHost['args']) => makeRemoteHost(a),
  createRemoteTableHost: () => makeTableHost(),
};

const tableChunk: GameChunk = {
  module: { mount: () => ({ pause() {}, resume() {}, unmount() {} }) },
  local: () => {
    throw new Error('not offline');
  },
};

/** The fake action game, ready online (it plays as Fuseyard). */
export const onlineFuseyard: GameMeta = {
  ...fakeMeta,
  name: 'Fuseyard',
  ready: { offline: true, online: true },
  modes: [{ id: 'brawl', label: 'Brawl', online: true, offline: true }],
  watch: true,
  load: async () => fakeChunk,
};

export const onlineGlimmer: GameMeta = {
  id: 'glimmer',
  name: 'Glimmerhall',
  tagline: 'A fake hall',
  icon: 'coins',
  lane: 'table',
  ready: { offline: false, online: true },
  modes: [{ id: 'hall', label: 'The hall', online: true, offline: false }],
  seats: [1, 16],
  watch: false,
  options: [],
  load: async () => tableChunk,
};

/** A table game whose own lobby options choose its bots (as Lamplight does). */
export const onlineLamplight: GameMeta = {
  id: 'lamplight',
  name: 'Lamplight',
  tagline: 'A fake table',
  icon: 'cards',
  lane: 'table',
  ready: { offline: false, online: true },
  modes: [{ id: 'cup', label: 'Cup', online: true, offline: false }],
  seats: [2, 6],
  watch: true,
  hostBots: false,
  options: [],
  load: async () => tableChunk,
};

export const ONLINE_CATALOG: readonly GameMeta[] = [onlineGlimmer, onlineFuseyard, onlineLamplight];

export const lobbyView = (patch: Partial<LobbyView> = {}): LobbyView => ({
  id: 'L1',
  game: 'fuseyard',
  ch: 'c1',
  mode: 'brawl',
  st: 'open',
  host: 'me',
  seats: [
    { a: 'me', bot: false, st: 0 },
    { a: null, bot: false, st: 0 },
    { a: null, bot: false, st: 0 },
    { a: null, bot: false, st: 0 },
  ],
  spec: 0,
  cfg: {},
  v: 1,
  ...patch,
});

export const entry = (patch: Partial<ActivityEntry> = {}): ActivityEntry => ({ g: 'fuseyard', id: 'E1', st: 'lobby', n: 2, max: 4, w: 0, ...patch });

/** Wait (real time, inside act) until `check` holds. */
export const until = async (act: (fn: () => Promise<void>) => Promise<void>, check: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error('timed out waiting for ' + label);
};

/** Tailwind classes that make a touch target at least 44 px tall. */
export const TALL = /(^|\s)(min-h-1[1-9]|min-h-[2-9]\d|h-1[1-9]|h-[2-9]\d|pointer-coarse:h-1[1-9]|pointer-coarse:min-h-1[1-9])(\s|$)/;

/** Fixed widths over 360 px in an element's classes or inline style (none allowed). */
export const wideClasses = (root: Element): string[] => {
  const out: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const cls of Array.from(el.classList)) {
      const scale = /^(?:[a-z-]+:)*(?:w|min-w)-(\d+)$/.exec(cls);
      if (scale && Number(scale[1]) * 4 > 360) out.push(cls);
      const px = /^(?:[a-z-]+:)*(?:w|min-w)-\[(\d+)px\]$/.exec(cls);
      if (px && Number(px[1]) > 360) out.push(cls);
    }
    const style = (el as HTMLElement).style;
    for (const value of [style?.width, style?.minWidth]) {
      const px = value ? /^(\d+)px$/.exec(value) : null;
      if (px && Number(px[1]) > 360) out.push('style:' + value);
    }
  }
  return out;
};

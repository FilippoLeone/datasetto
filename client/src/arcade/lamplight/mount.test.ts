/**
 * The mounted module in jsdom (lamplight.md §18.4), against a scripted host that runs the real
 * engine the way the server does: zero cost after unmount, nothing drawn while hidden and one redraw
 * on return, the action bar's bounds, all-in on a second press, pre-actions, and `myTurn` written at
 * most twice per turn with no platform signal touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDeck } from '@arcade/core/lamplight/cards';
import { act as engineAct, advance, createTable, pendingDelay, seat, startHand, type Action, type EngineEvent, type TableState } from '@arcade/core/lamplight/engine';
import { cashLevel, tableConfig } from '@arcade/core/lamplight/schedule';
import { holeEvent, publicEvent, snapFor, stampMs } from '@arcade/core/lamplight/views';
import { arcadeSignalWrites } from '@/features/arcade/state';
import { installFakeAudio } from '@/features/arcade/fakeGame.test-util';
import { frames } from '../runtime/p0';
import { createPracticeWallet } from '../runtime/practiceWallet';
import { DEFAULT_PREFS } from '../runtime/prefs';
import { installFakeFrames, stubCanvas, trackResources, type FakeFrames } from '../runtime/testing';
import type { GameHandle, MountOpts, TableHost } from '../runtime/types';
import type { BarState } from './bar';
import chunk from './index';
import type { TableModel } from './table';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** A tiny server: the real engine, events sent the way the table room gets them. */
const scriptedHost = () => {
  const cfg = tableConfig({ format: 'open', tier: 'pebble', seats: 3, bots: null });
  const state: TableState = createTable('tbl00001', cfg, cashLevel('pebble'));
  ['me', 'amy', 'bo'].forEach((id, n) => {
    seat(state, n, { accountId: id, botId: null, avatarSeed: n }, 1000);
    state.seats[n].status = 'active';
  });
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const requests: [string, Record<string, unknown>][] = [];
  let now = 0;
  const send = (name: string, data: unknown) => {
    for (const cb of listeners.get(name) ?? []) cb(data);
  };
  const emit = (events: readonly EngineEvent[]) => {
    for (const e of events) {
      const out = publicEvent(e, state.id);
      send(out.name, stampMs(out.data, out.dl, now));
      if (e.ev === 'hand') send('lamplight:hole', holeEvent(state, 0, state.id));
    }
  };
  const drain = () => {
    for (let i = 0; i < 8 && pendingDelay(state) !== null; i++) emit(advance(state, now));
  };
  const host: TableHost = {
    mode: 'remote',
    async request<T>(ev: string, data: unknown) {
      const d = data as Record<string, unknown>;
      requests.push([ev, d]);
      if (ev === 'lamplight:sync') send('lamplight:snap', snapFor(state, 0, state.id, now));
      if (ev === 'lamplight:act') {
        const kinds = { f: 'fold', x: 'check', c: 'call', b: 'bet', r: 'raise', a: 'allin' } as const;
        const kind = kinds[d.k as keyof typeof kinds];
        const action = (kind === 'bet' || kind === 'raise' ? { kind, to: d.a } : { kind }) as Action;
        const r = engineAct(state, 0, action, now, { h: d.h as number, q: d.q as number });
        if (!r.ok) return { ok: false, code: r.code } as T;
        emit(r.events);
        drain();
      }
      return { ok: true } as T;
    },
    on(ev, cb) {
      let set = listeners.get(ev);
      if (!set) listeners.set(ev, (set = new Set()));
      set.add(cb);
      return () => set?.delete(cb);
    },
    connected: () => true,
    onConnection: () => () => undefined,
    ackRttMs: () => 0,
    setVisible: () => undefined,
    close: () => listeners.clear(),
  };
  return {
    state,
    host,
    requests,
    listeners,
    deal(button: number) {
      const r = startHand(state, newDeck(), now, button);
      if (r.ok) emit(r.events);
    },
    other(seatNo: number, action: Action) {
      now += 500;
      const r = engineAct(state, seatNo, action, now);
      if (!r.ok) throw new Error('refused ' + r.code);
      emit(r.events);
      drain();
    },
  };
};

const opts = (o: Partial<MountOpts> = {}): MountOpts => ({
  mode: 'remote',
  lobby: { id: 'tbl00001', game: 'lamplight', ch: 'c1', mode: 'open', st: 'live', host: 'me', seats: [], spec: 0, cfg: {}, v: 1 },
  me: { accountId: 'me', slot: null },
  prefs: DEFAULT_PREFS,
  ptt: null,
  reserved: [],
  reducedMotion: true,
  coarse: false,
  shell: {
    status: () => undefined,
    attention: () => undefined,
    wakeLock: () => undefined,
    minimize: () => undefined,
    leave: () => undefined,
    idleAway: () => undefined,
    names: (ids) => ids.map((id) => 'Name ' + id),
    practice: createPracticeWallet('datasetto.arcade.test.mount'),
  },
  ...o,
});

let fake: FakeFrames;
let canvas: ReturnType<typeof stubCanvas>;
let audio: ReturnType<typeof installFakeAudio>;
let el: HTMLElement;
const size = { w: 360, h: 640 };
const descriptors: [string, PropertyDescriptor | undefined][] = [];

beforeEach(() => {
  fake = installFakeFrames();
  canvas = stubCanvas();
  audio = installFakeAudio();
  for (const key of ['clientWidth', 'clientHeight'] as const) {
    descriptors.push([key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]);
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => (key === 'clientWidth' ? size.w : size.h) });
  }
  el = document.createElement('div');
  document.body.appendChild(el);
});

afterEach(() => {
  fake.restore();
  canvas.restore();
  audio.restore();
  for (const [key, d] of descriptors.splice(0)) {
    if (d) Object.defineProperty(HTMLElement.prototype, key, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
  el.remove();
});

const model = (): TableModel => (window as unknown as { __lamplight: TableModel }).__lamplight;
const bar = (): BarState => (window as unknown as { __lamplightBar: BarState }).__lamplightBar;
const click = (sel: string) => (el.querySelector(sel) as HTMLElement).click();
const key = (code: string, k: string) => el.querySelector('.ll-root')?.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true }));

const mountScripted = async (o: Partial<MountOpts> = {}) => {
  const s = scriptedHost();
  const handle: GameHandle = chunk.module.mount(el, s.host, opts(o));
  await flush();
  fake.advance(50);
  return { ...s, handle };
};

describe('the mounted table', () => {
  it('draws on events and leaves nothing behind after unmount', async () => {
    const resources = trackResources();
    const baseline = resources.live();
    const s = await mountScripted();
    expect(model().view).not.toBeNull();
    expect(model().me).toBe(0);
    s.deal(0);
    await flush();
    fake.advance(400);
    expect(canvas.calls.length).toBeGreaterThan(0);
    // Your turn (you are first after the big blind): the ring timer runs.
    expect(model().turn).not.toBeNull();
    s.handle.unmount();
    s.host.close();
    await flush();
    // Preact's effect scheduler keeps a 100 ms fallback timer for a frame that never comes in jsdom.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(frames.active).toBe(0);
    expect(resources.live()).toEqual(baseline);
    expect(resources.listenerTypes()).toEqual({});
    expect(audio.closed).toBe(audio.contexts);
    expect(el.childNodes.length).toBe(0);
    resources.restore();
  });

  it('applies events while hidden without drawing, and draws once on return', async () => {
    const s = await mountScripted();
    s.deal(0);
    await flush();
    fake.advance(400);
    s.handle.pause();
    expect(frames.active).toBe(0);
    const before = canvas.calls.length;
    await s.host.request('lamplight:act', { t: 'tbl00001', h: 1, q: model().lastQ, k: 'c' });
    s.other(1, { kind: 'call' });
    await flush();
    fake.advance(1000);
    expect(canvas.calls.length).toBe(before);
    expect(model().view?.hand?.toAct).toBe(2);
    s.handle.resume();
    fake.advance(100);
    expect(canvas.calls.length).toBeGreaterThan(before);
    fake.advance(500);
    expect(frames.active).toBe(0);
    s.handle.unmount();
  });

  it('bounds the raise sheet and wants a second press for all-in', async () => {
    const s = await mountScripted();
    s.deal(0);
    await flush();
    const t = bar().myTurn.value!;
    expect(t).toMatchObject({ minTo: 20, maxTo: 1000, toCall: 10 });
    click('[data-ll-raise]');
    await flush();
    expect(el.querySelector('[data-ll-sheet]')).not.toBeNull();
    const plus = el.querySelector('[aria-label="One big blind more"]') as HTMLElement;
    const minus = el.querySelector('[aria-label="One big blind less"]') as HTMLElement;
    for (let i = 0; i < 5; i++) minus.click();
    expect(bar().amount.value).toBe(20);
    plus.click();
    expect(bar().amount.value).toBe(30);
    for (let i = 0; i < 200; i++) plus.click();
    expect(bar().amount.value).toBe(1000);
    // Keyboard: A once arms, A again goes all-in.
    key('KeyA', 'a');
    expect(s.requests.some((r) => r[0] === 'lamplight:act')).toBe(false);
    key('KeyA', 'a');
    await flush();
    const sent = s.requests.filter((r) => r[0] === 'lamplight:act');
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toMatchObject({ k: 'a', h: 1 });
    expect(s.state.seats[0].allIn).toBe(true);
    s.handle.unmount();
  });

  it('never binds the push-to-talk key and ignores keys typed into a field', async () => {
    const s = await mountScripted({ ptt: { code: 'Space', ctrl: false, shift: false, alt: false, meta: false } });
    s.deal(0);
    await flush();
    key('Space', ' ');
    await flush();
    expect(s.requests.some((r) => r[0] === 'lamplight:act')).toBe(false);
    const field = document.createElement('input');
    el.querySelector('.ll-root')?.appendChild(field);
    field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', bubbles: true }));
    await flush();
    expect(s.requests.some((r) => r[0] === 'lamplight:act')).toBe(false);
    key('KeyC', 'c');
    await flush();
    expect(s.requests.find((r) => r[0] === 'lamplight:act')?.[1]).toMatchObject({ k: 'c' });
    s.handle.unmount();
  });

  it('clears a "Call X" pre-action when the amount changes, and fires "Call any" on your turn', async () => {
    const s = await mountScripted();
    s.deal(0);
    await flush();
    // Button 0 with three players: you post nothing and act after the blinds… first: seat 0 acts. Fold to reset.
    expect(model().turn).not.toBeNull();
    await s.host.request('lamplight:act', { t: 'tbl00001', h: 1, q: model().lastQ, k: 'c' });
    await flush();
    s.other(1, { kind: 'call' });
    await flush();
    // Now seat 2 (big blind) acts; it is not your turn and you owe nothing.
    expect(model().turn).toBeNull();
    model().preAction = 'call';
    model().preCall = 0;
    s.other(2, { kind: 'raise', to: 60 });
    await flush();
    expect(model().preAction).toBeNull();
    // Your turn came; nothing was sent for you.
    expect(model().turn).not.toBeNull();
    const acts = s.requests.filter((r) => r[0] === 'lamplight:act').length;
    await s.host.request('lamplight:act', { t: 'tbl00001', h: 1, q: model().lastQ, k: 'c' });
    await flush();
    model().preAction = 'callAny';
    s.other(1, { kind: 'raise', to: 200 });
    await flush();
    s.other(2, { kind: 'call' });
    await flush();
    const after = s.requests.filter((r) => r[0] === 'lamplight:act');
    expect(after.length).toBe(acts + 2);
    expect(after.at(-1)?.[1]).toMatchObject({ k: 'c' });
    s.handle.unmount();
  });

  it('writes myTurn at most twice per turn and no platform signal', async () => {
    const before = { ...arcadeSignalWrites };
    const s = await mountScripted();
    let writes = 0;
    const off = bar().myTurn.subscribe(() => writes++);
    writes = 0;
    let turns = 0;
    let events = 0;
    for (let h = 0; h < 8 && events < 60; h++) {
      s.deal(h % 3);
      await flush();
      for (let g = 0; g < 30 && s.state.hand && s.state.hand.street !== 'done'; g++) {
        const to = s.state.hand.toAct;
        if (to === 0) {
          turns++;
          await s.host.request('lamplight:act', { t: 'tbl00001', h: s.state.hand.handNo, q: model().lastQ, k: model().turn?.canCheck ? 'x' : 'c' });
        } else s.other(to, { kind: s.state.hand.currentBet > s.state.seats[to].streetBet ? 'call' : 'check' });
        events++;
        await flush();
      }
    }
    off();
    expect(events).toBeGreaterThanOrEqual(50);
    expect(turns).toBeGreaterThan(5);
    expect(writes).toBeLessThanOrEqual(turns * 2);
    expect(arcadeSignalWrites).toEqual(before);
    s.handle.unmount();
  });
});

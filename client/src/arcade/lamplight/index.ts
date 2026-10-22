/**
 * Lamplight Hold'em's lazy chunk (lamplight.md §14): `module.mount` draws the table and runs the
 * action bar over a `TableHost` (the server online, `local/localTable.ts` offline), and `local`
 * builds the offline table. One code path for both: the module sends intents and replays events.
 *
 * Zero cost when still or closed: no idle loop (an event or a resize draws one frame, tweens draw
 * while they run), one 10 Hz timer only while a clock runs and the table is visible, nothing at all
 * while hidden, and `unmount` frees every listener, timer, canvas, the Worker and the AudioContext.
 */
import { BOT_LEVELS } from '@arcade/core/lamplight/bots';
import type { BotLevel, Format, Tier } from '@arcade/core/lamplight/engine';
import { CUP_BUY_INS, tierLabel, TIERS, TRIO_BUY_INS } from '@arcade/core/lamplight/schedule';
import { botName } from '@arcade/core/lamplight/bots';
import { formatCard } from '@arcade/core/lamplight/cards';
import { createGameAudio } from '../runtime/audio';
import { createLoop } from '../runtime/loop';
import { practiceWallet } from '../runtime/practiceWallet';
import { readGamePref, writeGamePref } from '../runtime/prefs';
import type { GameChunk, GameHandle, MountOpts, TableHost } from '../runtime/types';
import { chordFor, LAMPLIGHT_GAIN, SOUNDS } from './audio';
import { createBarState, EMPTY_SEAT, mountBar, type BarApi, type SeatSummary } from './bar';
import { createKeys, createPad, type Command } from './input';
import { createLocalTable } from './local/localTable';
import { recordLines, seenOf, subtleSha256, verifyHand, type ServedRecord } from './proofView';
import { createArt, drawEmote, type Art } from './render/art';
import { createScene, type Scene } from './render/draw';
import { createRing } from './render/ring';
import { createTableModel, EVENT_NAMES, type Effect } from './table';
import { VERSION } from '@arcade/core/lamplight/version';
import { effect } from '@preact/signals';
import { arcadeConfig, arcadeWallet } from '@/features/arcade/state';

const CODES: Record<string, string> = {
  not_your_turn: 'Not your turn',
  stale: 'The table moved on; try again',
  illegal: 'That move is not allowed now',
  amount: 'That amount is not allowed',
  busy: 'One moment…',
  funds: 'Not enough chips',
  soon: 'A bot gives you its seat after this hand',
  full: 'The table is full',
  seated: 'You are seated at another table',
};

interface Prefs {
  fast: boolean;
  twoColour: boolean;
}
const parsePrefs = (v: unknown): Prefs | null => (v && typeof v === 'object' ? { fast: (v as Prefs).fast === true, twoColour: (v as Prefs).twoColour === true } : null);

const mount = (el: HTMLElement, host: TableHost, opts: MountOpts): GameHandle => {
  const t = opts.lobby?.id ?? 'local';
  const prefs = readGamePref('lamplight', parsePrefs) ?? { fast: false, twoColour: false };
  const root = document.createElement('div');
  root.className = 'll-root';
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#0d1716;outline:none;touch-action:manipulation;';
  root.tabIndex = 0;
  el.appendChild(root);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;display:block;';
  root.appendChild(canvas);
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  root.appendChild(live);
  const uiEl = document.createElement('div');
  uiEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  root.appendChild(uiEl);

  let disposed = false;
  let visible = true;
  let dpr = Math.min(2, typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);
  let art: Art | null = null;
  let scene: Scene | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number): void => {
    const h = setTimeout(() => {
      timers.delete(h);
      if (!disposed) fn();
    }, ms);
    timers.add(h);
  };

  const config = host.mode === 'remote' ? arcadeConfig.peek() : null;
  const blocked = config && config.proto.lamplight !== VERSION.proto ? 'Update the app to play online.' : null;
  const bar = createBarState();
  bar.fast.value = prefs.fast;
  bar.twoColour.value = prefs.twoColour;
  const audio = createGameAudio({ master: opts.prefs.volume * LAMPLIGHT_GAIN });
  let audioReady = false;
  const unlock = (): void => {
    if (audioReady || disposed) return;
    audioReady = true;
    void audio.unlock().then(() => audio.prerender(SOUNDS));
  };
  const sound = (id: string): void => {
    if (visible) audio.play(id);
  };

  const loop = createLoop({
    draw(now) {
      if (!scene) return;
      const animating = scene.draw(now);
      loop.animate(animating);
      placeRing();
      scheduleExpiry(now);
    },
    maxFps: 60,
  });
  const markDirty = (): void => {
    if (visible) loop.markDirty();
  };

  // ---------------------------------------------------------------- the model
  const announce = (text: string): void => {
    live.textContent = text;
  };
  const request = <T>(ev: string, data: Record<string, unknown>): Promise<T> => host.request<T>(ev, { t, ...data });
  const hint = (code: string | undefined): void => {
    bar.hint.value = CODES[code ?? ''] ?? 'Something went wrong';
  };

  const act = (k: string, a?: number): void => {
    const view = model.view;
    if (!view?.hand) return;
    bar.sheet.value = false;
    bar.allinArmed.value = 0;
    void request<{ ok: boolean; code?: string }>('lamplight:act', { h: view.hand.handNo, q: model.lastQ, k, ...(a !== undefined ? { a } : {}) })
      .then((r) => {
        if (!r.ok) hint(r.code);
      })
      .catch(() => hint('busy'));
  };

  // A sit that waits for a bot to give up its seat is sent again once a seat is free.
  let pendingSit: { buyIn: number; post: 'now' | 'wait' } | null = null;
  const sitDown = (buyIn: number, post: 'now' | 'wait'): void => {
    pendingSit = null;
    void request<{ ok: boolean; code?: string }>(model.view?.config.format === 'open' ? 'lamplight:sit' : 'lamplight:join', { buyIn, post, id: requestId() })
      .then((r) => {
        if (r.ok) return;
        if (r.code === 'soon') pendingSit = { buyIn, post };
        hint(r.code);
      })
      .catch(() => hint('busy'));
  };
  const retrySit = (): void => {
    if (!pendingSit) return;
    const view = model.view;
    if (!view || (model.me !== null && view.seats[model.me]?.player)) pendingSit = null;
    else if (view.seats.some((x) => !x.player)) sitDown(pendingSit.buyIn, pendingSit.post);
  };

  let syncing = false;
  const sync = (since: number): void => {
    if (syncing) return;
    syncing = true;
    void request('lamplight:sync', { since })
      .catch(() => undefined)
      .finally(() => {
        syncing = false;
      });
  };

  const onEffect = (e: Effect): void => {
    if (!visible) return;
    const now = performance.now();
    scene?.effect(e, now);
    if (e.k === 'deal') sound('deal');
    else if (e.k === 'act') sound(e.kind === 'f' ? 'fold' : e.kind === 'x' ? 'check' : 'chip');
    else if (e.k === 'street') sound('deal');
    else if (e.k === 'win') {
      if (model.me !== null && e.pots.some((p) => p.w.includes(model.me as number))) sound('win');
      else sound('chip');
    } else if (e.k === 'trio') {
      sound('flyTick');
      later(() => sound(chordFor(e.mult)), opts.reducedMotion ? 0 : 3000);
    }
    loop.animate(true);
    markDirty();
  };

  const seatSummary = (): SeatSummary => {
    const view = model.view;
    const me = model.me;
    if (!view) return EMPTY_SEAT;
    const s = me !== null ? view.seats[me] : null;
    const hand = view.hand;
    const running = !!hand && hand.street !== 'done';
    return {
      seated: !!s?.player,
      status: s?.status ?? null,
      stack: s?.stack ?? 0,
      inHand: !!s?.inHand && running,
      folded: !!s?.folded,
      format: view.config.format,
      local: host.mode === 'local',
      balance: host.mode === 'local' ? opts.shell.practice.balance() : (arcadeWallet.peek()?.bal ?? model.balance),
      minBuyIn: view.config.buyInMin,
      maxBuyIn: view.config.buyInMax,
      bb: view.level.bb,
      owe: s && hand && running && !s.folded ? Math.min(s.stack, Math.max(0, hand.currentBet - s.streetBet)) : 0,
      handRunning: running,
      showable: !!hand && me !== null && hand.showable === me && !s?.shown,
      result: model.result,
      buyIn: model.buyIn,
      sitOutNext: s?.status === 'sittingOut',
      blocked,
      // Online, a bot gives its seat to a person who sits down.
      joinable: view.config.format === 'open' ? view.seats.some((x) => !x.player || (host.mode === 'remote' && !!x.player.botId)) : model.registering,
      running: view.handsPlayed > 0,
    };
  };
  const writeSeat = (): void => {
    const next = seatSummary();
    const prev = bar.seatState.peek();
    let same = true;
    for (const k of Object.keys(next) as (keyof SeatSummary)[]) if (JSON.stringify(next[k]) !== JSON.stringify(prev[k])) same = false;
    if (!same) bar.seatState.value = next;
  };

  let attention = false;
  const onTurn = (): void => {
    const turn = model.turn;
    bar.myTurn.value = turn;
    if (turn) {
      bar.amount.value = turn.minTo;
      if (visible) sound('turn');
      else {
        attention = true;
        opts.shell.attention(true);
        // One chime: resume the context, play, suspend again.
        if (audioReady) {
          audio.resume();
          audio.play('turn');
          later(() => {
            if (!visible) audio.suspend();
          }, 300);
        }
      }
    } else if (attention) {
      attention = false;
      opts.shell.attention(false);
    }
    startRing();
  };

  const model = createTableModel({
    me: opts.me.accountId ?? (host.mode === 'local' ? 'local:me' : null),
    names: (ids) => opts.shell.names(ids),
    now: () => performance.now(),
    linkMs: () => (host.mode === 'remote' ? host.ackRttMs() / 2 : 0),
    sync,
    onEffect,
    onChange(what) {
      if (what === 'turn') onTurn();
      else {
        retrySit();
        writeSeat();
        updateWake();
        if (what === 'view') startRing();
        markDirty();
      }
    },
    act,
    announce,
  });

  const offs: (() => void)[] = [];
  for (const name of EVENT_NAMES) offs.push(host.on(name, (d) => model.handle(name, d)));
  // Dev builds: the model for browser checks.
  if (import.meta.env.DEV) {
    const w = window as unknown as { __lamplight?: unknown; __lamplightBar?: unknown };
    w.__lamplight = model;
    w.__lamplightBar = bar;
    offs.push(() => {
      delete w.__lamplight;
      delete w.__lamplightBar;
    });
  }
  offs.push(opts.shell.practice.onChange(() => writeSeat()));
  // Online: the chips balance comes from the platform's wallet pushes.
  if (host.mode === 'remote') offs.push(effect(() => {
    void arcadeWallet.value;
    writeSeat();
  }));
  // A reconnect asks for what was missed (the seat was never released).
  let wasUp = host.connected();
  offs.push(
    host.onConnection((up) => {
      if (up && !wasUp && !blocked) sync(model.lastQ);
      wasUp = up;
    }),
  );
  /** Spectators stop the event stream while hidden; seated players keep it (their turn must reach them). */
  const spectating = (): boolean => host.mode === 'remote' && (model.me === null || !model.view?.seats[model.me]?.player);
  let away = false;
  const goAway = (on: boolean): void => {
    if (on === away || host.mode !== 'remote' || !opts.lobby) return;
    if (on && !spectating()) return;
    away = on;
    void host.request(on ? 'arcade:away' : 'arcade:back', on ? { id: t } : { id: t, since: Math.max(0, model.lastQ) }).catch(() => undefined);
  };

  // ---------------------------------------------------------------- clocks, ring, expiry
  const ring = createRing(root);
  let ringKey = '';
  let ringTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTickSecond = -1;
  const pad = createPad({ on: (c) => command(c) });
  const placeRing = (): void => {
    const view = model.view;
    const hand = view?.hand;
    const l = scene?.layout;
    if (!view || !hand || hand.toAct < 0 || !l || hand.pending || !visible) {
      ring.place(null);
      ringKey = '';
      return;
    }
    ring.place(l.seats[hand.toAct]);
    // A new turn, a time bank or a deadline credit restarts the countdown (the compositor runs it).
    const key = hand.handNo + ':' + hand.turnQ + ':' + (hand.bank ? 1 : 0) + ':' + Math.round(hand.deadline);
    if (key === ringKey) return;
    ringKey = key;
    const total = hand.bank ? Math.max(1000, view.seats[hand.toAct].timeBankMs || view.config.timeBankMs) : view.config.actionMs;
    ring.start({ total, remaining: hand.deadline - performance.now(), bank: hand.bank });
  };
  /** The 10 Hz timer: only on your own turn (the last-5-seconds tick and the gamepad). */
  const myTick = (): void => {
    ringTimer = null;
    if (!visible || disposed) return;
    const hand = model.view?.hand;
    if (!hand || hand.toAct < 0 || hand.toAct !== model.me || hand.pending) return;
    const now = performance.now();
    const ms = Math.max(0, hand.deadline - now);
    const second = Math.ceil(ms / 1000);
    if (ms > 0 && ms <= 5000 && second !== lastTickSecond) sound('tick');
    lastTickSecond = second;
    pad.poll(now);
    ringTimer = setTimeout(myTick, 100);
  };
  const startRing = (): void => {
    placeRing();
    if (ringTimer !== null || !visible || disposed) return;
    const hand = model.view?.hand;
    if (hand && hand.toAct >= 0 && hand.toAct === model.me && !hand.pending) myTick();
  };
  const stopRing = (): void => {
    if (ringTimer !== null) clearTimeout(ringTimer);
    ringTimer = null;
    ring.place(null);
    ringKey = '';
  };

  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryAt = 0;
  const scheduleExpiry = (now: number): void => {
    const at = scene?.nextExpiry(now) ?? null;
    if (at === null || (expiryTimer !== null && expiryAt <= at)) return;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryAt = at;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        markDirty();
      },
      Math.max(0, at - now) + 5,
    );
  };

  const updateWake = (): void => {
    const view = model.view;
    const s = model.me !== null ? view?.seats[model.me] : null;
    opts.shell.wakeLock(visible && !!s?.inHand && !!view?.hand && view.hand.street !== 'done');
  };

  // ---------------------------------------------------------------- input
  const command = (c: Command): void => {
    unlock();
    const turn = model.turn;
    switch (c) {
      case 'history':
        bar.drawer.value = !bar.drawer.value;
        return;
      case 'close':
        bar.sheet.value = bar.menu.value = bar.drawer.value = false;
        return;
      default:
        break;
    }
    if (!turn) return;
    const step = (d: number) => {
      bar.sheet.value = true;
      bar.amount.value = Math.max(turn.minTo, Math.min(turn.maxTo, (bar.amount.value || turn.minTo) + d));
    };
    if (c === 'fold') act('f');
    else if (c === 'call') act(turn.canCheck ? 'x' : turn.call >= turn.stack ? 'a' : 'c');
    else if (c === 'raise') {
      if (turn.canRaise) bar.sheet.value = !bar.sheet.value;
    } else if (c === 'up') step(turn.bb);
    else if (c === 'down') step(-turn.bb);
    else if (c === 'upPot') step(Math.round(turn.pot / 4));
    else if (c === 'downPot') step(-Math.round(turn.pot / 4));
    else if (c === 'confirm' && bar.sheet.value && turn.canRaise) {
      const field = root.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
      if (field && document.activeElement === field) {
        const v = Number(field.value.replace(/\D/g, ''));
        if (v) bar.amount.value = Math.max(turn.minTo, Math.min(turn.maxTo, v));
      }
      const amount = bar.amount.value || turn.minTo;
      act(amount >= turn.maxTo ? 'a' : turn.currentBet === 0 ? 'b' : 'r', amount >= turn.maxTo ? undefined : amount);
    } else if (c === 'allin' && (turn.canRaise || turn.call >= turn.stack)) {
      const now = Date.now();
      if (now - bar.allinArmed.value < 2000) act('a');
      else {
        bar.allinArmed.value = now;
        bar.hint.value = 'Press A again for all-in';
      }
    }
  };
  const keys = createKeys(root, { ptt: opts.ptt, reserved: opts.reserved, on: command });
  const onPointer = (): void => {
    unlock();
    if (document.activeElement !== root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  };
  root.addEventListener('pointerdown', onPointer);

  // ---------------------------------------------------------------- the bar
  const api: BarApi = {
    act,
    preAction(p, call) {
      model.preAction = p;
      model.preCall = call;
      bar.pre.value = p;
    },
    sitOut(on) {
      void request<{ ok: boolean; code?: string }>('lamplight:sitOut', { on }).then((r) => !r.ok && hint(r.code));
      bar.menu.value = false;
    },
    topUp(amount) {
      void request<{ ok: boolean; code?: string }>('lamplight:topUp', { amount, id: requestId() }).then((r) => !r.ok && hint(r.code));
    },
    refill() {
      void request('lamplight:refill', {}).then(() => writeSeat());
    },
    join(buyIn, post) {
      unlock();
      // Online, Cup and Trio registration is the platform's lobby join (it escrows the buy-in).
      if (host.mode === 'remote' && model.view?.config.format !== 'open') {
        void host
          .request<{ ok: boolean; code?: string }>('arcade:lobby:join', { id: t, as: 'player' })
          .then((r) => !r.ok && hint(r.code))
          .catch(() => hint('busy'));
        return;
      }
      sitDown(buyIn, post);
    },
    leave() {
      // The table goes at once: the server folds and pays out without waiting, so nothing here waits
      // for its answer, and a failed request (offline, the table already closed) changes nothing on screen.
      try {
        void request('lamplight:leave', { now: true, id: requestId() }).catch(() => undefined);
      } catch {
        // A host that throws instead of rejecting.
      }
      opts.shell.leave();
    },
    show() {
      void request('lamplight:show', { h: model.view?.hand?.handNo ?? 0 });
    },
    fast(on) {
      void request('lamplight:fast', { on });
      writeGamePref('lamplight', { fast: on, twoColour: bar.twoColour.value });
      bar.menu.value = false;
    },
    deck(two) {
      if (scene) scene.deck = two ? 1 : 0;
      writeGamePref('lamplight', { fast: bar.fast.value, twoColour: two });
      bar.menu.value = false;
      markDirty();
    },
    emote(id) {
      void request<{ ok: boolean; code?: string }>('lamplight:emote', { id }).then((r) => !r.ok && hint(r.code));
    },
    paintEmote(c, id) {
      const g = c.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, c.width, c.height);
      drawEmote(g, id, 0, 0, Math.floor(c.width / 8));
    },
    async older(before) {
      const r = await request<{ ok: boolean; rows?: { id: number; t: string; h: number; at: number; f: string; tier: string | null; net: number; pot: number }[] }>('lamplight:hands', before ? { before } : {});
      return (r.rows ?? []).map((x) => ({
        id: x.id,
        t: x.t,
        h: x.h,
        at: x.at,
        net: x.net,
        pot: x.pot,
        label: x.tier && (TIERS as readonly string[]).includes(x.tier) ? tierLabel(x.tier as Tier) : x.f === 'cup' ? 'Lamplight Cup' : 'Firefly Trio',
      }));
    },
    async open(row) {
      const r = await host.request<{ ok: boolean; record?: ServedRecord }>('lamplight:record', { t: row.t, h: row.h });
      const rec = r.record;
      if (!r.ok || !rec) return { lines: ['This hand is no longer available.'], check: async () => 'This hand can no longer be checked.' };
      const me = opts.me.accountId ?? '';
      const ids = rec.seats.map((x) => x[1]).filter((x): x is string => !!x);
      const names = new Map<string, string>(ids.map((id, i) => [id, opts.shell.names(ids)[i] ?? 'Player']));
      const name = (seat: number): string => {
        const x = rec.seats.find((y) => y[0] === seat);
        if (!x) return 'Seat ' + (seat + 1);
        if (x[1] === me) return 'You';
        return x[1] ? (names.get(x[1]) ?? 'Player') : botName(x[2]);
      };
      return {
        lines: recordLines(rec, name, formatCard),
        check: () => verifyHand(host, row.t, { no: row.h, at: row.at, label: row.label, lines: [], net: row.net, pot: row.pot, cr: rec.cr, seen: seenOf(rec, me), seed: null, done: true }, subtleSha256()),
      };
    },
    verify: (rec) => verifyHand(host, t, rec, subtleSha256()),
    history: () => model.history,
    hints: () => keys.hints(),
  };
  const unmountBar = mountBar(uiEl, bar, api);

  // ---------------------------------------------------------------- size and art
  const resize = (): void => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (!scene || w <= 0 || h <= 0) return;
    dpr = Math.min(2, typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);
    scene.resize(w, h, dpr);
    bar.mode.value = scene.layout?.mode ?? 'portrait';
    loop.markDirty();
  };
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => resize());
    observer.observe(root);
  }
  void createArt()
    .then((a) => {
      if (disposed) {
        a.dispose();
        return;
      }
      art = a;
      scene = createScene({ canvas, art: a, model, reducedMotion: opts.reducedMotion });
      scene.deck = prefs.twoColour ? 1 : 0;
      resize();
    })
    .catch(() => announce('The table could not be drawn on this device.'));

  // ---------------------------------------------------------------- start
  opts.shell.status('live');
  if (blocked) writeSeat();
  else void request<{ ok: boolean }>('lamplight:sync', { since: -1 })
    .then(() => {
      if (host.mode === 'local') {
        void request('lamplight:fast', { on: prefs.fast });
        // Offline you sit down at once with the default buy-in (or see the refill offer).
        if (model.me === null || !model.view?.seats[model.me]?.player) api.join(model.view?.config.buyInMax ?? 0, 'wait');
      }
    })
    .catch(() => undefined);

  return {
    pause() {
      goAway(true);
      if (!visible) return;
      visible = false;
      loop.setVisible(false);
      stopRing();
      audio.suspend();
      updateWake();
    },
    resume() {
      goAway(false);
      if (visible) {
        markDirty();
        return;
      }
      visible = true;
      if (attention) {
        attention = false;
        opts.shell.attention(false);
      }
      audio.resume();
      loop.setVisible(true);
      loop.markDirty();
      startRing();
      updateWake();
    },
    back() {
      if (bar.sheet.value || bar.menu.value || bar.drawer.value) {
        bar.sheet.value = bar.menu.value = bar.drawer.value = false;
        return true;
      }
      return false;
    },
    unmount() {
      if (disposed) return;
      // A spectator closing the game stops its stream (the server keeps the slot a minute).
      if (spectating() && !away) goAway(true);
      disposed = true;
      for (const off of offs) off();
      offs.length = 0;
      observer?.disconnect();
      observer = null;
      stopRing();
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      expiryTimer = null;
      for (const h of timers) clearTimeout(h);
      timers.clear();
      loop.dispose();
      keys.dispose();
      pad.dispose();
      root.removeEventListener('pointerdown', onPointer);
      unmountBar();
      ring.dispose();
      scene?.dispose();
      art?.dispose();
      void audio.close();
      if (attention) opts.shell.attention(false);
      opts.shell.wakeLock(false);
      canvas.width = canvas.height = 0;
      root.remove();
    },
  };
};

let reqCounter = 0;
/** Idempotency key for buy-ins, top-ups and leaving. */
const requestId = (): string => {
  reqCounter = (reqCounter + 1) % 1_000_000;
  return Date.now().toString(36) + '-' + reqCounter.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
};

const pick = <T extends string | number>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

const chunk: GameChunk = {
  module: { mount },
  local({ mode, cfg, seed, seats }) {
    const c = (cfg ?? {}) as Record<string, unknown>;
    const format = pick<Format>(mode, ['open', 'cup', 'trio'], 'open');
    const buyIns: readonly number[] = format === 'cup' ? CUP_BUY_INS : TRIO_BUY_INS;
    return createLocalTable({
      mode: format,
      tier: pick<Tier>(c.tier, TIERS, 'pebble'),
      players: Math.max(2, Math.min(9, Math.round(Number(c.players) || 6))),
      bots: pick<BotLevel>(c.bots, BOT_LEVELS, 'regular'),
      buyIn: pick<number>(Number(c.buyIn), buyIns, format === 'cup' ? 2000 : 1000),
      seed,
      me: { accountId: seats[0]?.accountId ?? null },
      practice: practiceWallet,
    });
  },
};
export default chunk;

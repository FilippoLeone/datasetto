/**
 * Bellwick's game module (bellwick.md §8, §10): one canvas, touch/keyboard/gamepad input, synthesized
 * sound and plain-canvas menus around the shared client mirror (core/bellwick/client.ts). Offline the
 * platform's local host runs the tale and the own hero steps once per FRAME; online the hero steps on
 * the client's clock and others are interpolated. Nothing here writes a Preact signal per tick.
 */
import {
  createClientWorld,
  hasFlagC,
  onFrame as applyFrame,
  onKeyframe as applyKeyframe,
  onWelcome as applyWelcome,
  sendInteract,
  stepOwn,
  type ClientSend,
  type ClientWorld,
} from '@arcade/core/bellwick/client';
import { DESPAWN, EV, parseSave, PF, REFUSE, writeBuy, writeGoToAlly, writeRespawn, writeUseBrew, type EvView, type SaveV1 } from '@arcade/core/bellwick/codec';
import type { PartyHandover } from '@arcade/core/bellwick/runtime';
import { UI } from '@arcade/core/bellwick/content/art';
import { T } from '@arcade/core/bellwick/content/legend';
import { screen } from '@arcade/core/bellwick/content/parse';
import { SCREEN_NAME, TEXT, wrap } from '@arcade/core/bellwick/content/text';
import { CUE } from '@arcade/core/bellwick/sim/hero';
import { Item, ItemBit, Kind, Proj, Status } from '@arcade/core/bellwick/types';
import { ByteWriter, utf8Decode } from '@arcade/core/bytes';
import { createStageCanvas } from '@/arcade/runtime/canvas';
import { textWidth } from '@/arcade/runtime/font';
import { ACT, createInput } from '@/arcade/runtime/input';
import { createLoop } from '@/arcade/runtime/loop';
import { readGamePref, writeGamePref } from '@/arcade/runtime/prefs';
import type { GameHandle, MatchHost, MountOpts, SeatInfo } from '@/arcade/runtime/types';
import { createBwAudio, type TrackId } from './audio';
import { KEYS, layout, touchLayout } from './controls';
import { centred, COLOR, drawHud, drawMap, panel, text } from './hud';
import { eraseTale, loadTales, PARTY_COPY, savesAvailable, writeTale, type TaleSlot } from './localSaves';
import { takeLocalTale } from './offline';
import { bakeArt, createEffects, createRoomBake, disposeArt, drawWorld, FX, H, HUD_H, setGotItem, W, type Art, type RoomBake, type View } from './render';

type Mode = 'loading' | 'title' | 'play' | 'dialogue' | 'choice' | 'menu' | 'map';

interface GamePrefs { music: boolean; effects: boolean; calm: boolean }

const parsePrefs = (v: unknown): GamePrefs | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return { music: o.music !== false, effects: o.effects !== false, calm: o.calm === true };
};

const ITEM_TEXT: Readonly<Record<number, string>> = {
  [Item.Sword]: 'got_sword',
  [Item.Buckler]: 'got_buckler',
  [Item.Hook]: 'got_hook',
  [Item.Map]: 'got_map',
  [Item.Compass]: 'got_compass',
  [Item.Key]: 'got_key',
  [Item.BossKey]: 'got_bosskey',
  [Item.Shard]: 'got_shard',
  [Item.Vessel]: 'got_vessel',
  [Item.Brew]: 'got_brew',
  [Item.Glints]: 'got_glints',
};
const ITEM_ICON: Readonly<Record<number, number>> = {
  [Item.Sword]: 0,
  [Item.Buckler]: 1,
  [Item.Hook]: 2,
  [Item.Map]: 3,
  [Item.Compass]: 4,
  [Item.Key]: 5,
  [Item.BossKey]: 6,
  [Item.Shard]: 7,
  [Item.Vessel]: 8,
  [Item.Brew]: 9,
  [Item.Glints]: 11,
};
const SHOP_TEXT: Readonly<Record<number, string>> = { [Item.Buckler]: 'buy_buckler', [Item.Brew]: 'buy_brew', [Item.Shard]: 'buy_shard' };

const fmtTime = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? h + 'h ' + String(m % 60).padStart(2, '0') + 'm' : m + 'm ' + String(sec % 60).padStart(2, '0') + 's';
};

export const mountBellwick = (el: HTMLElement, host: MatchHost, opts: MountOpts): GameHandle => {
  const local = host.mode === 'local';
  const tale = local ? takeLocalTale() : null;
  // The seat; online WELCOME says for sure.
  let slot = opts.me.slot ?? 0;
  let disposed = false;
  let visible = true;

  // ---------------------------------------------------------------- DOM, canvas, input, audio
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:1;pointer-events:none';
  el.appendChild(box);
  const live = document.createElement('div');
  live.setAttribute('aria-live', 'polite');
  live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
  el.appendChild(live);
  const stage = createStageCanvas(box, { logicalW: W, logicalH: H, mode: 'pixelated' });
  const ctx = stage.ctx;
  ctx.imageSmoothingEnabled = false;
  const prefs: GamePrefs = readGamePref('bellwick', parsePrefs) ?? { music: true, effects: true, calm: false };
  const audio = createBwAudio(opts.prefs.volume, prefs.music && (local || opts.prefs.music), prefs.effects);
  const input = createInput(el, { keys: KEYS, ptt: opts.ptt, reserved: opts.reserved, touch: opts.coarse ? touchLayout(opts.prefs) : null, gamepad: true });
  const relayout = (): void => {
    const own = layout(el, box, opts.coarse);
    el.style.setProperty('--arcade-touch-opacity', own ? '1' : '0.45');
    loop.markDirty();
  };
  let observer: ResizeObserver | null = null;
  const onGesture = (): void => audio.unlock();
  el.addEventListener('pointerdown', onGesture, true);
  el.addEventListener('keydown', onGesture, true);

  // ---------------------------------------------------------------- state
  let mode: Mode = 'loading';
  let art: Art | null = null;
  let bake: RoomBake | null = null;
  let oldBake: HTMLCanvasElement | null = null;
  const effects = createEffects();
  const visited = new Uint8Array(64);
  let held = 0;
  let pending = 0;
  let meX0 = 0;
  let meY0 = 0;
  let pages: string[] = [];
  let page = 0;
  let typed = 0;
  let afterDialogue: (() => void) | null = null;
  let choice: { q: string; options: string[]; sel: number; then: (i: number) => void } | null = null;
  let menuSel = 0;
  let titleSel = 0;
  let tales = loadTales();
  let banner = '';
  let bannerT = 0;
  let notice: string | null = null;
  let noticeT = 0;
  let transition: { edge: number; t0: number; fade: boolean } | null = null;
  let lastTickSeen = 0;
  let downedPrompted = false;
  let introPending = false;
  let introShown = false;
  let status: 'connecting' | 'live' | 'lagging' = 'connecting';
  let seats: readonly SeatInfo[] = [];
  let downedAt = 0;
  let ended = false;
  const w = new ByteWriter(32);
  const send: ClientSend = { up: (p) => host.sendUp(p), evt: (p) => host.sendEvent(p) };

  const say = (s: string): void => {
    live.textContent = s;
  };

  const syncSim = (): void => {
    // Offline the world waits while a menu, a dialogue or the title is open.
    if (local) host.setVisible(visible && mode === 'play');
  };

  const setMode = (m: Mode): void => {
    mode = m;
    syncSim();
    loop.markDirty();
  };

  const showBanner = (s: string, ticks = 60): void => {
    banner = s;
    bannerT = ticks;
  };

  const showNotice = (s: string, ticks = 75): void => {
    notice = s;
    noticeT = ticks;
  };

  const dialogue = (pagesIn: readonly string[], then: (() => void) | null = null): void => {
    pages = [];
    for (const p of pagesIn) {
      const lines = wrap(p, 29);
      for (let i = 0; i < lines.length; i += 3) pages.push(lines.slice(i, i + 3).join('\n'));
    }
    page = 0;
    typed = 0;
    afterDialogue = then;
    say(pagesIn.join(' '));
    setMode('dialogue');
  };

  const ask = (q: string, options: string[], then: (i: number) => void): void => {
    choice = { q, options, sel: 0, then };
    say(q + ' ' + options.join(', '));
    setMode('choice');
  };

  // ---------------------------------------------------------------- the client mirror and its hooks
  const onEvent = (e: EvView, tick: number): void => {
    const c = cw;
    switch (e.kind) {
      case EV.Damage: {
        if (e.a >= 128) break;
        const ent = c.ents.find((x) => x.on && x.id === e.a);
        if (ent) effects.add(e.b > 0 ? FX.hit : FX.clink, ent.x, ent.y);
        if (ent && ent.kind === Kind.Boss && e.b > 0) audio.play('bossHurt');
        else audio.play(e.b > 0 ? 'hit' : 'clink', 0.5);
        break;
      }
      case EV.Despawn: {
        if (e.b === DESPAWN.killed) {
          audio.play('kill');
        } else if (e.b === DESPAWN.collected) audio.play('chip', 0.5);
        break;
      }
      case EV.Spawn:
        if (e.b === Kind.Bat) audio.play('bat', 0.4);
        break;
      case EV.Projectile:
        audio.play(e.b === Proj.Note ? 'note' : e.b === Proj.Bounce ? 'bounce' : 'pebble', 0.35);
        break;
      case EV.Tile: {
        const x = (e.a % 12) * 16 + 8;
        const y = Math.floor(e.a / 12) * 16 + 8;
        if (e.b === T.STUBBLE || e.b === T.FLOOR) {
          effects.add(FX.leaf, x, y);
          audio.play('cut', 0.5);
        } else if (e.b === T.CHEST_OPEN) audio.play('chest');
        else if (e.b === T.LOCK_OPEN || e.b === T.BOSSDOOR_OPEN) audio.play('unlock');
        else if (e.b === T.SHUTTER_OPEN) audio.play('shutter');
        else if (e.b === T.BRIDGE_ON) audio.play('bridge', 0.4);
        else if (e.b === T.CRYSTAL_ON) audio.play('crystal');
        else if (e.b === T.LANTERN_LIT) audio.play('lantern');
        else if (e.b === T.CHEST) {
          effects.add(FX.sparkle, x, y);
          audio.play('chest');
        }
        bake?.cell(c, e.a);
        break;
      }
      case EV.BlockSlide:
        audio.play('push');
        break;
      case EV.Shock:
        audio.play('slam');
        audio.play('shock', 0.5);
        break;
      case EV.BossPhase:
        audio.play('bossPhase');
        break;
      case EV.Hp:
        if (e.a === slot && e.b > c.me.hp) audio.play('heart', 0.5);
        break;
      case EV.Downed:
        if (e.a === slot) {
          audio.play('downed');
          audio.jingle('downed');
          downedPrompted = false;
        }
        break;
      case EV.Revived:
        if (e.a === slot) audio.play('revive');
        break;
      case EV.Refused: {
        audio.play('refuse');
        const code = e.c;
        if (code === REFUSE.locked) dialogue(TEXT[c.tiles[e.b] === T.BOSSDOOR ? 'locked_boss' : 'locked'] ?? []);
        else if (code === REFUSE.glints) dialogue(TEXT.no_glints ?? []);
        else if (code === REFUSE.haveBrew) dialogue(TEXT.have_brew ?? []);
        else if (code === REFUSE.soldOut) dialogue(TEXT.sold_out ?? []);
        break;
      }
      case EV.Party:
        if (e.a === PF.purse) loop.markDirty();
        break;
      case EV.Got:
        if (e.a === slot) gotItem(e.b);
        break;
      case EV.Saved:
        audio.jingle('save');
        break;
      case EV.Roster:
        for (let i = 0; i < c.roster.n; i += 1) if (c.roster.rows[i]!.slot === slot) c.me.tunic = c.roster.rows[i]!.tunic;
        break;
      case EV.Victory:
        audio.play('bells');
        audio.jingle('victory');
        dialogue(TEXT.victory ?? []);
        break;
      default:
    }
    void tick;
  };

  const gotItem = (item: number): void => {
    setGotItem(ITEM_ICON[item] ?? 10);
    audio.play('item');
    if (item !== Item.Glints) audio.jingle('item');
    const key = ITEM_TEXT[item];
    let lines = key ? (TEXT[key] ?? []) : [];
    if (item === Item.Shard && cw.shards % 4 === 0) lines = [...lines, 'Four shards! Your hearts grow by one.'];
    if (lines.length) dialogue(lines);
  };

  const interact = (tile: number): void => {
    const c = cw;
    const def = screen(c.room);
    const code = c.tiles[tile] as number;
    switch (code) {
      case T.SIGN: {
        const s = def.signs.find((x) => x.tile === tile);
        if (s) dialogue(TEXT[s.text] ?? []);
        return;
      }
      case T.NPC: {
        const n = def.npcs.find((x) => x.tile === tile);
        if (!n) return;
        const given = n.flag >= 0 && hasFlagC(c, n.flag);
        if (!given && n.gift !== Item.None) sendInteract(send, tile);
        dialogue(given ? (TEXT[n.text + '_after'] ?? TEXT[n.text] ?? []) : (TEXT[n.text] ?? []));
        return;
      }
      case T.CHEST:
        sendInteract(send, tile);
        return;
      case T.LOCK:
        if (c.keys > 0) sendInteract(send, tile);
        else dialogue(TEXT.locked ?? []);
        return;
      case T.BOSSDOOR:
        if ((c.items & ItemBit.bossKey) !== 0) sendInteract(send, tile);
        else dialogue(TEXT.locked_boss ?? []);
        return;
      case T.LANTERN:
      case T.LANTERN_LIT: {
        sendInteract(send, tile);
        // Online, a lantern can take you to a friend.
        const allies = local ? [] : allyRows();
        dialogue(TEXT.lantern ?? [], allies.length === 0 ? null : () =>
          ask('Go to a friend?', ['Stay', ...allies.map((r) => r.name)], (i) => {
            const target = allies[i - 1];
            if (target) host.sendEvent(writeGoToAlly(w.reset(), target.slot).copy());
          }),
        );
        return;
      }
      case T.COUNTER: {
        const s = def.shop.find((x) => x.tile === tile);
        if (!s) {
          dialogue(TEXT[def.talk ?? 'pell'] ?? []);
          return;
        }
        dialogue(TEXT[SHOP_TEXT[s.item] ?? ''] ?? [], () =>
          ask('Buy it for ' + s.price + ' glints?', ['Yes', 'No'], (i) => {
            if (i === 0) {
              host.sendEvent(writeBuy(w.reset(), s.item).copy());
              audio.play('buy');
            }
          }),
        );
        return;
      }
      default:
    }
  };

  /** Other heroes in the session (from the roster), with their names. */
  const allyRows = (): { slot: number; name: string }[] => {
    const out: { slot: number; name: string }[] = [];
    for (let i = 0; i < cw.roster.n; i += 1) {
      const r = cw.roster.rows[i]!;
      if (r.slot === slot || r.status === Status.Resting) continue;
      const name = seats.find((s) => s.slot === r.slot)?.name || 'Friend ' + (r.slot + 1);
      out.push({ slot: r.slot, name: name.length > 14 ? name.slice(0, 13) + '.' : name });
    }
    return out;
  };

  const cw: ClientWorld = createClientWorld(slot, {
    event: onEvent,
    interact,
    cue(cues) {
      if (cues & CUE.swish) audio.play('swish', 0.6);
      if (cues & CUE.spin) audio.play('spin');
      if (cues & CUE.hookThrow) audio.play('hookThrow');
      if (cues & CUE.hookLatch) audio.play('hookLatch');
      if (cues & CUE.hurt) audio.play('hurt');
      if (cues & CUE.block) audio.play('bounce', 0.5);
      if (cues & CUE.fall) audio.play('fall');
      if (cues & CUE.charged) audio.play('crystal', 0.4);
      if (cues & CUE.clinkWall) audio.play('clink', 0.4);
    },
    roomChange(from, to, edge) {
      if (edge < 0 || !bake) return;
      // Keep the old room for the slide (or the fade through a door).
      if (!oldBake) {
        oldBake = document.createElement('canvas');
        oldBake.width = W;
        oldBake.height = H - HUD_H;
      }
      const o = oldBake.getContext('2d');
      o?.drawImage(bake.canvas, 0, 0);
      const fade = edge === 4 || screen(from).exits[edge] !== null;
      transition = { edge, t0: performance.now(), fade };
      void to;
      audio.play(fade ? 'warp' : 'swish', 0.3);
    },
    keyframe() {
      visited[cw.room] = 1;
      bake?.bake(cw);
      const def = screen(cw.room);
      audio.track((def.boss >= 0 && !cw.victory ? 'boss' : def.music) as TrackId);
      if (status !== 'live') {
        status = 'live';
        opts.shell.status('live');
      }
      const name = SCREEN_NAME[def.key];
      if (name) showBanner(name);
      if (introPending || (!local && !introShown && !hasFlagC(cw, 0))) {
        // A new tale (online: nobody has the Rootsword yet), told once per mount.
        introPending = false;
        introShown = true;
        dialogue(['Kettlebrook. The bells are silent. Elder Hesper is waiting in her house, west of the square.']);
      }
      loop.markDirty();
    },
  });

  // ---------------------------------------------------------------- the host
  host.onWelcome((wl) => {
    if (!local && wl.slot < 4) {
      slot = wl.slot;
      cw.slot = wl.slot;
    }
    applyWelcome(cw, wl.cfg);
  });
  host.onKeyframe((k) => {
    applyKeyframe(cw, k.body, k.tick);
    meX0 = cw.me.x;
    meY0 = cw.me.y;
  });
  host.onFrame((f) => {
    applyFrame(cw, f.tick, f.snapshot, f.events);
    lastTickSeen = f.tick;
    effects.step();
    audio.advance();
    if (bannerT > 0) bannerT -= 1;
    if (noticeT > 0 && --noticeT === 0) notice = null;
    if (local && mode === 'play') stepHero(f.tick + 1, f.tick);
    loop.markDirty();
  });
  host.onPhase(() => loop.markDirty());
  host.onClosed(() => {
    ended = true;
    if (!disposed) opts.shell.status('ended');
    loop.markDirty();
  });
  const offSeats = local ? () => undefined : host.onSeats((s) => (seats = s));
  // A restarting server hands the tale over: keep a Party copy on this device (bellwick.md §5.3).
  host.onHandover((body) => {
    if (disposed) return;
    let copied = false;
    try {
      const h = JSON.parse(utf8Decode(body)) as PartyHandover;
      const mine = h.hs.find((x) => x.s === slot);
      const save = parseSave({ ...h.save, heroes: mine ? { solo: { tunic: mine.t, brew: mine.b, downs: mine.d, defeats: mine.f } } : {} });
      copied = save !== null && writeTale(PARTY_COPY, save);
    } catch {
      copied = false;
    }
    dialogue(
      copied
        ? ['The server is restarting. A Party copy of the tale is kept on this device: Solo Tale can carry on from it, and the party can rejoin once the server is back.']
        : ['The server is restarting. The party can rejoin once it is back; the tale was saved.'],
      () => opts.shell.leave(),
    );
  });

  const heroButtons = (): number => {
    const b = (held | pending) & 0x7f;
    pending = 0;
    return b;
  };

  const stepHero = (tick: number, seen: number): void => {
    meX0 = cw.me.x;
    meY0 = cw.me.y;
    stepOwn(cw, heroButtons(), tick, seen, send, local ? 1 : host.linkConstrained() ? 3 : 2);
    if (cw.me.status !== Status.Downed) downedAt = 0;
    else if (downedAt === 0) downedAt = tick;
    if (cw.me.status === Status.Downed && !downedPrompted && mode === 'play' && (local || tick - downedAt > 45)) {
      // Offline nobody can revive you; online a friend may, so waiting is offered too.
      downedPrompted = true;
      if (local) ask(TEXT.rest?.[0] ?? 'Rest at the lantern?', ['Rest'], () => host.sendEvent(writeRespawn(w.reset()).copy()));
      else ask('Wait for a friend, or rest?', ['Wait', 'Rest at the lantern'], (i) => i === 1 && host.sendEvent(writeRespawn(w.reset()).copy()));
    }
  };

  // Online: the own hero runs on the client's clock, a little ahead of the server.
  let heroClock = -1;
  const stepRemote = (now: number): void => {
    if (!cw.hasRoom) return;
    const target = Math.floor(host.estServerTick(now)) + 1;
    if (heroClock < 0 || target - heroClock > 30) heroClock = target - 1;
    for (let i = 0; i < 4 && heroClock < target; i += 1) {
      heroClock += 1;
      // Claims carry the tick of the snapshot whose positions the hero acted on.
      stepHero(heroClock, cw.snapTick);
    }
  };

  // ---------------------------------------------------------------- UI input
  const navigate = (pressed: number): void => {
    if (pressed === 0) return;
    if (mode === 'dialogue') {
      if (pressed & (ACT.a | ACT.b | ACT.menu)) {
        const len = (pages[page] ?? '').length;
        if (typed < len) typed = len;
        else if (page + 1 < pages.length) {
          page += 1;
          typed = 0;
          audio.play('menuMove', 0.3);
        } else {
          const then = afterDialogue;
          afterDialogue = null;
          setMode('play');
          then?.();
        }
      }
      return;
    }
    if (mode === 'choice' && choice) {
      if (pressed & (ACT.up | ACT.left)) choice.sel = (choice.sel + choice.options.length - 1) % choice.options.length;
      if (pressed & (ACT.down | ACT.right)) choice.sel = (choice.sel + 1) % choice.options.length;
      if (pressed & (ACT.up | ACT.down | ACT.left | ACT.right)) audio.play('menuMove', 0.3);
      if (pressed & ACT.a) {
        const c = choice;
        choice = null;
        setMode('play');
        audio.play('menuSelect', 0.4);
        c.then(c.sel);
      } else if (pressed & (ACT.b | ACT.menu) && choice.options.length > 1) {
        choice = null;
        setMode('play');
        audio.play('menuBack', 0.4);
      }
      return;
    }
    if (mode === 'map') {
      if (pressed & (ACT.a | ACT.b | ACT.menu | ACT.map)) setMode('play');
      return;
    }
    if (mode === 'menu') {
      const items = menuItems();
      if (pressed & ACT.up) menuSel = (menuSel + items.length - 1) % items.length;
      if (pressed & ACT.down) menuSel = (menuSel + 1) % items.length;
      if (pressed & (ACT.up | ACT.down)) audio.play('menuMove', 0.3);
      if (pressed & (ACT.b | ACT.menu)) {
        setMode('play');
        audio.play('menuBack', 0.4);
      } else if (pressed & ACT.a) {
        audio.play('menuSelect', 0.4);
        items[menuSel]?.run();
      }
      return;
    }
    if (mode === 'title') {
      const rows = titleRows();
      if (pressed & ACT.up) titleSel = (titleSel + rows.length - 1) % rows.length;
      if (pressed & ACT.down) titleSel = (titleSel + 1) % rows.length;
      if (pressed & (ACT.up | ACT.down)) audio.play('menuMove', 0.3);
      const row = rows[titleSel];
      if (pressed & ACT.a && row) {
        audio.play('menuSelect', 0.4);
        startTale(row.slot, row.save);
      } else if (pressed & ACT.b && row?.save) {
        ask('Erase ' + row.label + '?', ['Keep it', 'Erase'], (i) => {
          if (i === 1) {
            eraseTale(row.slot);
            tales = loadTales();
          }
          setMode('title');
        });
      } else if (pressed & ACT.menu) opts.shell.leave();
      return;
    }
    if (mode === 'play') {
      if (pressed & ACT.menu) {
        menuSel = 0;
        setMode('menu');
        audio.play('menuSelect', 0.3);
      } else if (pressed & ACT.map) setMode('map');
    }
  };

  const titleRows = (): { slot: TaleSlot; save: SaveV1 | null; label: string }[] => {
    const rows: { slot: TaleSlot; save: SaveV1 | null; label: string }[] = [];
    for (let i = 0; i < 3; i += 1) rows.push({ slot: i as TaleSlot, save: tales.slots[i] ?? null, label: 'Tale ' + (i + 1) });
    if (tales.slots[PARTY_COPY]) rows.push({ slot: PARTY_COPY, save: tales.slots[PARTY_COPY] ?? null, label: 'Party copy' });
    return rows;
  };

  const startTale = (s: TaleSlot, save: SaveV1 | null): void => {
    if (!tale) return;
    tale.onSaved = (ok) => {
      if (!ok) showNotice("Saves aren't available in this window", 120);
      else showNotice('Saved', 40);
    };
    tale.start(s, save);
    if (!savesAvailable()) showNotice("Saves aren't available in this window", 150);
    setMode('play');
    introPending = !save;
  };

  const menuItems = (): { label: string; run: () => void }[] => {
    const items: { label: string; run: () => void }[] = [{ label: 'Back to the tale', run: () => setMode('play') }];
    if (cw.me.brew && cw.me.hp < cw.maxHp)
      items.push({
        label: 'Drink the Hearthbrew',
        run: () => {
          host.sendEvent(writeUseBrew(w.reset()).copy());
          audio.play('brew');
          setMode('play');
        },
      });
    items.push({ label: 'Map', run: () => setMode('map') });
    items.push({
      label: 'Music: ' + (prefs.music ? 'on' : 'off'),
      run: () => {
        prefs.music = !prefs.music;
        audio.setMusic(prefs.music);
        writeGamePref('bellwick', prefs);
      },
    });
    items.push({
      label: 'Effects: ' + (prefs.effects ? 'on' : 'off'),
      run: () => {
        prefs.effects = !prefs.effects;
        audio.setEffects(prefs.effects);
        writeGamePref('bellwick', prefs);
      },
    });
    items.push({
      label: 'Reduce flashing: ' + (prefs.calm ? 'on' : 'off'),
      run: () => {
        prefs.calm = !prefs.calm;
        writeGamePref('bellwick', prefs);
      },
    });
    items.push({ label: local ? 'Leave (the tale is saved)' : 'Leave the party', run: () => opts.shell.leave() });
    return items;
  };

  // ---------------------------------------------------------------- drawing
  const view: View = { alphaEnt: 1, alphaMe: 1, meX0: 0, meY0: 0, tick: 0, projTick: 0 };
  let drawTick = 0;

  const draw = (now: number): void => {
    const s = input.sample();
    held = s.held;
    pending |= s.pressed;
    if (mode !== 'play') pending = 0;
    if (s.pressed) audio.unlock();
    navigate(s.pressed);
    if (!local && mode !== 'title' && mode !== 'loading') {
      stepRemote(now);
      const lag = host.rttMs() > 500 ? 'lagging' : 'live';
      if (status !== 'connecting' && status !== lag && !ended) {
        status = lag;
        opts.shell.status(lag);
      }
    }
    drawTick += 1;
    ctx.fillStyle = COLOR.black;
    ctx.fillRect(0, 0, W, H);
    const a = art;
    if (!a || !bake) {
      return;
    }
    if (mode === 'title') {
      drawTitle(a);
      return;
    }
    if (!cw.hasRoom) {
      centred(ctx, a, 'Bellwick', 70, UI.yellow);
      centred(ctx, a, 'Waking the bells...', 84, UI.cream);
      return;
    }
    const est = host.estServerTick(now);
    const frac = Math.max(0, Math.min(1, est - Math.floor(est)));
    view.alphaMe = local ? frac : 1;
    view.alphaEnt = local ? frac : Math.max(0, Math.min(1, (est - 6 - cw.prevSnapTick) / Math.max(1, cw.snapTick - cw.prevSnapTick)));
    view.meX0 = local ? meX0 : cw.me.x;
    view.meY0 = local ? meY0 : cw.me.y;
    view.tick = lastTickSeen;
    view.projTick = local ? lastTickSeen + frac : est;
    // Screen transitions: slide 600 ms (500 vertical), or fade 250 ms each way.
    let ox = 0;
    let oy = HUD_H;
    if (transition) {
      const dur = transition.fade ? 500 : transition.edge >= 2 ? 600 : 500;
      const p = Math.min(1, (now - transition.t0) / dur);
      if (p >= 1 && !cw.awaitingKey) transition = null;
      else if (transition.fade) {
        const o = oldBake;
        if (p < 0.5 || cw.awaitingKey) {
          if (o) ctx.drawImage(o, 0, HUD_H);
          ctx.fillStyle = COLOR.black;
          ctx.globalAlpha = Math.min(1, p * 2);
          ctx.fillRect(0, HUD_H, W, H - HUD_H);
          ctx.globalAlpha = 1;
        } else {
          drawWorld(ctx, a, cw, bake, view, 0, HUD_H, true);
          ctx.fillStyle = COLOR.black;
          ctx.globalAlpha = Math.max(0, 2 - p * 2);
          ctx.fillRect(0, HUD_H, W, H - HUD_H);
          ctx.globalAlpha = 1;
        }
        drawOverlay(a, now);
        return;
      } else {
        const e = transition.edge;
        const sw = e >= 2 ? W : H - HUD_H;
        const q = cw.awaitingKey ? Math.min(p, 0.98) : p;
        const dx = e === 2 ? 1 : e === 3 ? -1 : 0;
        const dy = e === 1 ? 1 : e === 0 ? -1 : 0;
        if (oldBake) ctx.drawImage(oldBake, dx * q * sw, HUD_H + dy * q * sw);
        ox = -dx * (1 - q) * sw;
        oy = HUD_H - dy * (1 - q) * sw;
        if (!cw.awaitingKey) drawWorld(ctx, a, cw, bake, view, ox, oy, true);
        else centred(ctx, a, '...', 140, UI.cream);
        drawOverlay(a, now);
        return;
      }
    }
    drawWorld(ctx, a, cw, bake, view, ox, oy, true);
    effects.draw(ctx, a, ox, oy);
    drawOverlay(a, now);
  };

  const drawOverlay = (a: Art, now: number): void => {
    drawHud(ctx, a, cw, !local && host.rttMs() > 500, null);
    if (bannerT > 0 && mode === 'play' && banner) {
      const wdt = textWidth(banner) + 10;
      panel(ctx, 96 - wdt / 2, 140, wdt, 13);
      centred(ctx, a, banner, 143, UI.cream);
    }
    if (notice) {
      const wdt = Math.min(186, textWidth(notice) + 10);
      panel(ctx, 96 - wdt / 2, 19, wdt, 13);
      centred(ctx, a, notice, 22, UI.cream);
    }
    if (mode === 'dialogue') {
      panel(ctx, 4, 116, 184, 40);
      const p = pages[page] ?? '';
      typed = Math.min(p.length, typed + 2);
      if (typed < p.length && (drawTick & 3) === 0) audio.play('blip', 0.15);
      text(ctx, a, p.slice(0, typed), 9, 121);
      if (typed >= p.length && (drawTick & 16) === 0) a.actors.draw(ctx, 'fx8', 178, 147, { frame: 3 });
      loop.markDirty();
    } else if (mode === 'choice' && choice) {
      const n = choice.options.length;
      panel(ctx, 16, 92, 160, 22 + n * 10);
      centred(ctx, a, choice.q, 97, UI.cream);
      choice.options.forEach((o, i) => {
        const y = 109 + i * 10;
        if (i === choice!.sel) a.actors.draw(ctx, 'fx8', 50, y - 1, { frame: 3 });
        text(ctx, a, o, 60, y, i === choice!.sel ? UI.yellow : UI.white);
      });
    } else if (mode === 'menu') {
      const items = menuItems();
      panel(ctx, 24, 24, 144, 18 + items.length * 11);
      centred(ctx, a, 'Paused', 29, UI.yellow);
      items.forEach((it, i) => {
        const y = 41 + i * 11;
        if (i === menuSel) a.actors.draw(ctx, 'fx8', 30, y - 1, { frame: 3 });
        text(ctx, a, it.label, 40, y, i === menuSel ? UI.yellow : UI.white);
      });
      itemsRow(a, 26 + items.length * 11 + 22);
    } else if (mode === 'map') {
      drawMap(ctx, a, cw, visited, drawTick);
      loop.markDirty();
    }
    void now;
  };

  /** The items you carry, under the pause menu. */
  const itemsRow = (a: Art, y: number): void => {
    const owned: number[] = [];
    if (cw.items & ItemBit.sword) owned.push(0);
    if (cw.items & ItemBit.buckler) owned.push(1);
    if (cw.items & ItemBit.hook) owned.push(2);
    if (cw.items & ItemBit.map) owned.push(3);
    if (cw.items & ItemBit.compass) owned.push(4);
    if (cw.items & ItemBit.bossKey) owned.push(6);
    if (cw.me.brew) owned.push(9);
    if (!owned.length || y > 140) return;
    panel(ctx, 24, y, 144, 22);
    owned.forEach((f, i) => a.actors.draw(ctx, 'items', 30 + i * 19, y + 3, { frame: f }));
    text(ctx, a, cw.shards % 4 + '/4', 30 + owned.length * 19 + 4, y + 8, UI.cream);
  };

  const drawTitle = (a: Art): void => {
    ctx.fillStyle = COLOR.dark;
    ctx.fillRect(0, 0, W, H);
    a.actors.draw(ctx, 'boss', 80, 6, { frame: (drawTick >> 5) & 1 ? 0 : 5 });
    centred(ctx, a, 'Bellwick', 42, UI.yellow);
    centred(ctx, a, 'The Silent Bells', 52, UI.cream);
    const rows = titleRows();
    rows.forEach((r, i) => {
      const y = 70 + i * 16;
      const sel = i === titleSel;
      panel(ctx, 20, y - 3, 152, 14);
      if (sel) a.actors.draw(ctx, 'fx8', 24, y, { frame: 3 });
      text(ctx, a, r.label, 34, y, sel ? UI.yellow : UI.white);
      if (r.save) {
        const hearts = Math.min(6, 3 + r.save.vessels + Math.floor(r.save.shards / 4));
        for (let k = 0; k < hearts; k += 1) a.actors.draw(ctx, 'hud', 94 + k * 7, y - 1, { frame: 0 });
        text(ctx, a, fmtTime(r.save.playSec), 140, y, UI.cream);
      } else text(ctx, a, 'New tale', 94, y, UI.grey);
    });
    const hint = opts.coarse ? 'A: play   B: erase' : 'J or Z: play   K or X: erase';
    centred(ctx, a, hint, 70 + rows.length * 16 + 6, UI.grey);
    if (!savesAvailable()) centred(ctx, a, "Saves aren't available here", 150, UI.red);
    loop.markDirty();
  };

  // ---------------------------------------------------------------- the loop and lifecycle
  const loop = createLoop({ draw: (now) => draw(now), maxFps: opts.prefs.batterySaver ? 30 : 60 });
  loop.animate(true);
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => relayout());
    observer.observe(el);
  }
  relayout();

  void bakeArt().then(
    (a) => {
      if (disposed) {
        disposeArt(a);
        return;
      }
      art = a;
      bake = createRoomBake(a);
      if (cw.hasRoom) bake.bake(cw);
      setMode(local && tale && !tale.match ? 'title' : 'play');
      if (!local) opts.shell.status('connecting');
    },
    () => {
      if (!disposed) showNotice('Bellwick could not draw here', 600);
    },
  );
  syncSim();
  opts.shell.wakeLock(true);
  // Dev builds: a handle for checks in the browser console and CDP tests.
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__bellwick = { cw, tale, host, get mode() { return mode; }, get visible() { return visible; } };

  return {
    pause() {
      tale?.flush();
      visible = false;
      loop.setVisible(false);
      audio.suspend();
      opts.shell.wakeLock(false);
      syncSim();
    },
    resume() {
      visible = true;
      loop.setVisible(true);
      audio.resume();
      opts.shell.wakeLock(true);
      syncSim();
      heroClock = -1;
    },
    back() {
      if (mode === 'menu' || mode === 'map') {
        setMode('play');
        return true;
      }
      if (mode === 'play') {
        menuSel = 0;
        setMode('menu');
        return true;
      }
      return false;
    },
    unmount() {
      if (disposed) return;
      disposed = true;
      opts.shell.wakeLock(false);
      tale?.flush();
      offSeats();
      loop.dispose();
      input.dispose();
      observer?.disconnect();
      el.removeEventListener('pointerdown', onGesture, true);
      el.removeEventListener('keydown', onGesture, true);
      audio.close();
      bake?.dispose();
      if (oldBake) oldBake.width = oldBake.height = 0;
      if (art) disposeArt(art);
      art = null;
      if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__bellwick;
      stage.dispose();
      box.remove();
      live.remove();
    },
  };
};


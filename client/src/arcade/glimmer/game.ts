/**
 * Glimmerhall's hall controller (glimmerhall.md §10.4, §12, §15): the spin flow, features and doors,
 * Dash spins, the feed and friends strip, auto-spin and the reality check, keyboard, gamepad and
 * touch, visibility, and resuming a spin whose answer was lost. Framework-free; it writes only
 * the platform's coarse signals (`arcadeWallet` online, at most once per 2 s) and never per frame.
 */
import { evaluate, windowOf, type Evaluation } from '@arcade/core/glimmer/evaluate';
import { DEFS_BY_IDX, DASH_BET, betLadder, machineDef, type MachineDef, type MachineIdx } from '@arcade/core/glimmer/machines';
import {
  BRAG_X,
  DASH_ST,
  EMOTES,
  SPIN_FLOOR_MS,
  dashRows,
  decodeStops,
  type DashView,
  type EnterOk,
  type FeedView,
  type MemberRow,
  type PickOk,
  type Refused,
  type SpinOk,
  type WireFeature,
} from '@arcade/core/glimmer/wire';
import { arcadeWallet } from '@/features/arcade/state';
import { createGameAudio } from '@/arcade/runtime/audio';
import { frames } from '@/arcade/runtime/p0';
import { isReservedKey, isTyping } from '@/arcade/runtime/input/keyboard';
import type { GameHandle, MountOpts, TableHost } from '@/arcade/runtime/types';
import { bakeMachine, CABINETS, symbolUrl, uiSpriteUrl, type MachineArt } from './art';
import { AUTO_GAP_MS, AUTO_LOSS, AUTO_SPINS, AUTO_STOP_TEXT, autoAfterSpin, autoMayContinue, createRealityCheck, startAuto, type AutoCfg, type AutoRun, type AutoStop } from './auto';
import { dashPanel } from './dashpanel';
import { celebrate, celebrationLevel, doors, plate, wheel, type DoorsState } from './effects';
import { card, createHall, PLAY_MONEY, SHORT_NAMES } from './hall';
import { createGlimmerHost } from './hosts/remote';
import { paytable } from './paytable';
import { createReels, type Reels } from './reels';
import { cryptoRng, newSpinId } from './rng';
import { MACHINE_SOUNDS, machineRecipes, sharedRecipes, type MachineSound, type SoundId } from './sounds';
import { loadGlimmerPrefs, saveGlimmerPrefs } from './store';
import { button, fmt, h, hueOf, listen, onTap, signed, times, type Off } from './ui';

interface Member {
  slot: number;
  acct: string | null;
  m: MachineIdx;
  away: boolean;
  lw: number;
  lx: number;
  el: HTMLButtonElement | null;
}

type Phase = 'idle' | 'spin' | 'feature' | 'doors' | 'busy';

const warned = new Set<string>();
const warnOnce = (key: string, msg: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[glimmerhall] ' + msg);
};

const PRIZE_LABEL = (def: MachineDef, prize: number): string => {
  const f = def.feature;
  if (f.kind !== 'vault') return '';
  const p = f.prizes[prize];
  return p ? p.spins + ' x' + p.mult : '';
};

export const mountHall = (stage: HTMLElement, table: TableHost, opts: MountOpts): GameHandle => {
  const mode = table.mode;
  const gh = createGlimmerHost(table);
  const hall = createHall(stage, { mode });
  const offs: Off[] = [];
  const prefs = loadGlimmerPrefs();
  const rng = cryptoRng();
  const audio = createGameAudio({ master: opts.prefs.volume });
  const arts = new Map<MachineIdx, Promise<MachineArt>>();
  let machine: MachineIdx = prefs.machine;
  let maxBet = 500;
  let bal = mode === 'local' ? opts.shell.practice.balance() : 0;
  let pot: number | null = null;
  let me = -1;
  let entered = false;
  let phase: Phase = 'busy';
  let pending: { m: MachineIdx; bet: number } | null = null;
  let inflight: { id: string; kind: 'spin' | 'pick' | 'dash'; bet: number } | null = null;
  let lastSpinAt = -1e9;
  let reels: Reels | null = null;
  let art: MachineArt | null = null;
  let visible = true;
  let disposed = false;
  let moved = false;
  let auto: AutoRun | null = null;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;
  let lineTimer: ReturnType<typeof setTimeout> | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let walletTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWalletWrite = -1e9;
  let audioUnlocked = false;
  let dash: DashView | null = null;
  let doorsState: DoorsState | null = null;
  let skip = false;
  let sheetKind: 'dash' | 'other' | null = null;
  const reality = createRealityCheck();
  const session = { spins: 0, wagered: 0, won: 0, startedAt: Date.now() };
  const members = new Map<number, Member>();

  const now = (): number => performance.now();
  /** Pauses inside the presentation; unmount resolves and clears them. */
  const sleeps = new Set<{ t: ReturnType<typeof setTimeout>; done: () => void }>();
  const delay = (ms: number): Promise<void> =>
    new Promise<void>((done) => {
      const entry = {
        t: setTimeout(() => {
          sleeps.delete(entry);
          done();
        }, ms),
        done,
      };
      sleeps.add(entry);
    });
  const def = (): MachineDef => machineDef(machine);
  const ladder = (m: MachineIdx = machine): readonly number[] => {
    const l = betLadder(machineDef(m), maxBet);
    return l.length > 0 ? l : [machineDef(m).bets[0] as number];
  };
  const betOf = (m: MachineIdx): number => {
    const l = ladder(m);
    return l[Math.min(prefs.steps[m], l.length - 1)] as number;
  };
  const bet = (): number => betOf(machine);
  const myDashRow = (): [number, number, number] | null => (dash && dash.st === DASH_ST.running ? (dashRows(dash).find((r) => r[0] === me) ?? null) : null);
  const inDash = (): boolean => {
    const row = myDashRow();
    return row !== null && row[2] > 0;
  };

  // ------------------------------------------------------------------ chrome updates

  const savePrefs = (): void => saveGlimmerPrefs(prefs);

  const showBalance = (): void => {
    const row = myDashRow();
    if (row) hall.setBalance(row[1], fmt(row[1]) + ' pts');
    else hall.setBalance(bal);
    hall.setNet(row ? 0 : session.won - session.wagered);
  };

  const showBet = (): void => {
    const row = myDashRow();
    if (row && row[2] > 0) hall.setBet(String(DASH_BET), row[2] + ' left');
    else hall.setBet(fmt(bet()), 'Bet');
    const l = ladder();
    const step = Math.min(prefs.steps[machine], l.length - 1);
    hall.betMinus.disabled = inDash() || step <= 0;
    hall.betPlus.disabled = inDash() || step >= l.length - 1;
  };

  const showSpinState = (): void => {
    const offline = mode === 'remote' && !gh.connected();
    hall.spin.disabled = disposed || moved || offline || (phase === 'busy' && !inflight);
    hall.spin.classList.toggle('busy', phase === 'spin' || phase === 'feature');
    hall.spin.textContent = phase === 'spin' ? 'STOP' : phase === 'feature' ? 'SKIP' : pending ? 'OPEN' : inDash() ? 'DASH' : 'SPIN';
    hall.auto.classList.toggle('on', auto !== null);
    hall.auto.textContent = auto ? String(auto.left) : 'Auto';
    hall.tabs.forEach((t) => (t.disabled = phase !== 'idle' || pending !== null || inDash() || auto !== null));
    if (offline) hall.setSub('Reconnecting…');
  };

  /** `arcadeWallet` for the WalletPill outside the stage: online only, at most once per 2 s. */
  const writeWallet = (): void => {
    if (mode !== 'remote' || disposed) return;
    const due = lastWalletWrite + 2000 - Date.now();
    if (due > 0) {
      if (!walletTimer) {
        walletTimer = setTimeout(() => {
          walletTimer = null;
          writeWallet();
        }, due);
      }
      return;
    }
    lastWalletWrite = Date.now();
    const current = arcadeWallet.peek();
    if (!current || current.bal !== bal) arcadeWallet.value = { bal, esc: current?.esc ?? 0, claim: current?.claim ?? false };
  };

  const clearLines = (): void => {
    if (lineTimer) clearTimeout(lineTimer);
    lineTimer = null;
  };

  const play = (id: SoundId, o?: { gain?: number; detune?: number }): void => {
    if (audioUnlocked && visible) audio.play((MACHINE_SOUNDS as readonly string[]).includes(id) ? machine + ':' + id : id, o);
  };

  const prerender = (m: MachineIdx): void => {
    const own = machineRecipes(m);
    const named: Record<string, (typeof own)[MachineSound]> = { ...sharedRecipes() };
    for (const id of MACHINE_SOUNDS) named[m + ':' + id] = own[id];
    void audio.prerender(named);
  };

  const unlock = (): void => {
    if (audioUnlocked || disposed) return;
    audioUnlocked = true;
    void audio.unlock().then(() => prerender(machine));
  };

  // ------------------------------------------------------------------ friends strip

  const nameOf = (slot: number): string => {
    if (slot === me) return 'You';
    const m = members.get(slot);
    const acct = m?.acct;
    if (!acct) return 'Player';
    if (acct.startsWith('bot:')) return acct.slice(4);
    return opts.shell.names([acct])[0] ?? 'Player';
  };

  const renderMember = (m: Member): void => {
    let el = m.el;
    if (!el) {
      el = button('gh-mem', '');
      el.dataset.slot = String(m.slot);
      const slot = m.slot;
      onTap(el, () => openReact(slot), offs);
      m.el = el;
      hall.friends.append(el);
    }
    const name = nameOf(m.slot);
    el.classList.toggle('me', m.slot === me);
    el.classList.toggle('away', m.away);
    el.setAttribute('aria-label', name + (m.away ? ', away' : '') + ', on ' + (DEFS_BY_IDX[m.m] as MachineDef).name + (m.lw > 0 ? ', last notable win ' + fmt(m.lw) : ''));
    const av = h('span', 'gh-av', name.charAt(0).toUpperCase());
    av.style.background = hueOf(m.acct ?? name);
    const text = h('span', 'gh-mt');
    text.append(h('span', 'gh-mn', name), h('span', 'gh-mw', m.lw > 0 ? fmt(m.lw) + ' ' + (m.lx > 0 ? '×' + Math.round(m.lx / 100) : '') : (SHORT_NAMES[m.m] as string)));
    const icon = h('img');
    icon.alt = '';
    icon.src = symbolUrl(m.m, (DEFS_BY_IDX[m.m] as MachineDef).wild, 1);
    const bubbles = Array.from(el.querySelectorAll('.gh-bub'));
    el.replaceChildren(av, text, icon, ...bubbles);
  };

  const setMembers = (rows: readonly MemberRow[]): void => {
    for (const m of members.values()) m.el?.remove();
    members.clear();
    hall.friends.replaceChildren(hall.fold);
    for (const [slot, acct, m, away, lw, lx] of rows) {
      const member: Member = { slot, acct, m, away: away === 1, lw, lx, el: null };
      members.set(slot, member);
      renderMember(member);
    }
  };

  const bubble = (slot: number, emote: number): void => {
    const el = members.get(slot)?.el;
    const id = EMOTES[emote];
    if (!el || !id) return;
    const img = h('img', 'gh-bub');
    img.alt = '';
    img.src = uiSpriteUrl(id, 2);
    img.addEventListener('animationend', () => img.remove(), { once: true });
    el.append(img);
    hall.say(nameOf(slot) + ': ' + id);
  };

  const openReact = (slot: number): void => {
    if (slot === me) return;
    const body = h('div', 'gh-emo');
    const { el, body: content } = card('React to ' + nameOf(slot), () => hall.closeSheet(), offs);
    EMOTES.forEach((id, e) => {
      const b = button('', '', id);
      const img = h('img');
      img.alt = '';
      img.src = uiSpriteUrl(id, 3);
      b.append(img);
      b.addEventListener('click', () => {
        gh.react(slot, e);
        if (mode === 'remote') bubble(slot, e);
        hall.closeSheet();
      });
      body.append(b);
    });
    content.append(body, h('p', 'muted', 'One reaction every 3 seconds.'));
    sheetKind = 'other';
    hall.sheet(el, () => (sheetKind = null));
  };

  // ------------------------------------------------------------------ reels and machines

  const artFor = (m: MachineIdx): Promise<MachineArt> => {
    let p = arts.get(m);
    if (!p) {
      p = bakeMachine(m);
      arts.set(m, p);
    }
    return p;
  };

  const randomStops = (d: MachineDef): number[] => d.strips.map((s) => rng(s.length));

  const showMachine = async (m: MachineIdx): Promise<void> => {
    machine = m;
    hall.setMachine(m);
    showBet();
    const next = await artFor(m);
    if (disposed || machine !== m) return;
    reels?.dispose();
    art = next;
    const d = machineDef(m);
    reels = createReels(hall.reelHost, d, next, {
      reduced: opts.reducedMotion,
      onReelStop: (r) => {
        play('stop', { gain: 0.6 });
        if (prefs.haptics) navigator.vibrate?.(10);
        void r;
      },
    });
    reels.setVisible(visible);
    reels.rest(randomStops(d));
    if (audioUnlocked) prerender(m);
  };

  const switchMachine = (m: MachineIdx): void => {
    if (m === machine || phase !== 'idle' || pending || inDash() || auto) return;
    prefs.machine = m;
    savePrefs();
    clearLines();
    hall.setMeter('Good luck', 'idle');
    hall.setSub('');
    void showMachine(m);
  };

  // ------------------------------------------------------------------ results

  const announce = (total: number, b: number): void => {
    if (total <= 0) {
      hall.setMeter('No win', 'idle');
      hall.say('No win');
    } else if (total < b) {
      hall.setMeter('Returned ' + fmt(total), 'small');
      hall.say('Returned ' + fmt(total));
      play('soft');
    } else {
      hall.setMeter('Won ' + fmt(total) + ' (' + times(total, b) + ')', 'win');
      hall.say('Won ' + fmt(total) + ' (' + times(total, b) + ')');
    }
  };

  const celebrateWin = (total: number, b: number): void => {
    const level = celebrationLevel(total, b);
    if (level === 0 || !reels || !art) return;
    play(('win' + level) as SoundId);
    const size = reels.size;
    if (!opts.reducedMotion) reels.play(celebrate(def(), size.w, size.h, level, rng(0x7fffffff)));
    if (level >= 2) {
      const title = level === 4 ? 'HUGE WIN' : level === 3 ? 'BIG WIN' : times(total, b);
      reels.play(plate(art, size.w, size.h, level >= 3 ? [title, fmt(total)] : [title], level >= 3 ? 2400 : 1200, CABINETS[machine]?.ink ?? 10));
    }
  };

  /** Win highlights: everything lit, then each win for 1.2 s, at most 3 rounds; one frame per change. */
  const cycleLines = (d: MachineDef, ev: Evaluation, stops: readonly number[]): void => {
    clearLines();
    if (!reels) return;
    const win = windowOf(d, stops);
    const steps: { cells: number; line: readonly number[] | null }[] = [];
    for (const l of ev.lines) {
      const rows = d.lines[l.line] as readonly number[];
      let cells = 0;
      for (let r = 0; r < l.count; r += 1) cells |= 1 << (r * 3 + (rows[r] as number));
      steps.push({ cells, line: rows });
    }
    for (const w of ev.ways) {
      let cells = 0;
      for (let r = 0; r < w.count; r += 1) for (let y = 0; y < 3; y += 1) if (win[r * 3 + y] === w.sym || win[r * 3 + y] === d.wild) cells |= 1 << (r * 3 + y);
      steps.push({ cells, line: null });
    }
    reels.light(ev.cells, null);
    if (steps.length <= 1 || !visible) return;
    let i = 0;
    const total = steps.length * 3;
    const next = (): void => {
      lineTimer = null;
      if (!reels || disposed) return;
      if (i >= total) {
        reels.light(ev.cells, null);
        return;
      }
      const s = steps[i % steps.length] as (typeof steps)[number];
      reels.light(s.cells, s.line);
      i += 1;
      lineTimer = setTimeout(next, 1200);
    };
    lineTimer = setTimeout(next, 1200);
  };

  /** Plays a run of free spins from the wire (Tide Turn or Forge Spins); resolves with the run's win. */
  const playRun = async (d: MachineDef, b: number, f: Extract<WireFeature, { k: 't' | 'v' }>, label: string, mult: number): Promise<number> => {
    const stops = decodeStops(f.r, d, true);
    if (!stops || !reels) {
      warnOnce('fs', 'free-spin stops out of range; showing the total only');
      return f.w;
    }
    const n = stops.length / d.reels;
    let sum = 0;
    let shown = 0;
    let extra = 0;
    for (let i = 0; i < n; i += 1) {
      const s = stops.slice(i * d.reels, (i + 1) * d.reels);
      const ev = evaluate(d, s, b, d.fsStrips);
      sum += ev.win * mult;
      if (ev.trigger) extra += 1;
      if (skip || disposed || !visible) continue;
      reels.start({ turbo: true, fs: true });
      await reels.land(s);
      if (skip || disposed) continue;
      reels.light(ev.cells, null);
      if (ev.trigger) play('scatter', { detune: 400 });
      shown = sum;
      hall.setSub(label + ' ' + (i + 1) + ' / ' + n + ' · ×' + mult + (extra > 0 ? ' · +' + extra * (d.feature.kind === 'wheel' ? 0 : d.feature.retrigger) + ' spins' : ''));
      hall.setMeter(label + ': ' + fmt(shown), 'win');
      if (ev.win > 0) play('win1', { gain: 0.6 });
    }
    if (reels && n > 0) {
      const last = stops.slice((n - 1) * d.reels);
      reels.rest(last, true);
      reels.light(evaluate(d, last, b, d.fsStrips).cells, null);
    }
    if (sum !== f.w) warnOnce('fsw', 'free-spin total differs from the authority; using its total');
    return f.w;
  };

  const playFeature = async (d: MachineDef, b: number, f: WireFeature): Promise<number> => {
    if (!reels || !art) return f.w;
    phase = 'feature';
    skip = false;
    showSpinState();
    if (f.k === 'h') {
      hall.setSub('Harvest Wheel');
      play('reveal');
      const size = reels.size;
      await new Promise<void>((done) => {
        reels?.play(wheel(art as MachineArt, size.w, size.h, f.g, { reduced: opts.reducedMotion, onTick: () => play('wheel'), onDone: done }));
      });
      hall.setSub('Harvest Wheel: ' + times(f.w, b));
      return f.w;
    }
    if (f.k === 't') {
      hall.setSub('Tide Turn: 10 free spins, every win ×2');
      play('reveal');
      return playRun(d, b, f, 'Tide Turn', 2);
    }
    hall.setSub('Forge Spins ×' + f.x);
    return playRun(d, b, f, 'Forge Spins', f.x);
  };

  // ------------------------------------------------------------------ spins

  const refused = (code: string, b: number, kind: 'spin' | 'pick' | 'dash'): void => {
    if (code !== 'lost') inflight = null;
    phase = 'idle';
    if (code !== 'lost') reels?.rest(randomStops(def()));
    switch (code) {
      case 'lost':
        hall.setSub("Your spin will settle when you're back");
        stopAuto('offline');
        phase = 'busy';
        // Still connected (a slow answer): ask again at once; otherwise the reconnect does.
        if (gh.connected()) void refresh();
        break;
      case 'funds':
        hall.setSub(mode === 'local' ? 'Not enough Practice chips' : 'Not enough chips for this bet');
        stopAuto('funds');
        if (mode === 'local') offerRefill();
        break;
      case 'pending':
        hall.setSub('Open the vault first');
        void refresh();
        break;
      case 'moved':
        showMoved();
        break;
      case 'update':
        hall.setSub('Update the app to play online');
        break;
      case 'disabled':
      case 'hidden':
        hall.setSub('Glimmerhall is not available');
        break;
      case 'busy':
        hall.setSub('');
        break;
      default:
        hall.setSub('That spin did not go through');
    }
    if (code !== 'lost' && kind === 'spin') {
      bal += b;
      showBalance();
    }
    if (code !== 'busy' && code !== 'lost') stopAuto('refused');
    showSpinState();
  };

  const settleSpin = async (ack: SpinOk, d: MachineDef, b: number): Promise<void> => {
    let stops = decodeStops(ack.st, d, false);
    if (!stops) {
      warnOnce('stops', 'stops out of range; showing the totals');
      stops = d.strips.map(() => 0);
    }
    const ev = evaluate(d, stops, b);
    if (ev.win !== ack.w) warnOnce('total', 'line total differs from the authority; using its total');
    if (reels) await reels.land(stops);
    if (disposed) return;
    if (ev.scatters >= 2) play('scatter', { detune: 200 * ev.scatters });
    session.spins += 1;
    session.wagered += b;
    let total = ack.w;
    if (ack.pot !== undefined) pot = ack.pot;
    if (ack.f) total += await playFeature(d, b, ack.f);
    if (disposed) return;
    let potWin = 0;
    if (ack.pt) {
      potWin = ack.pt;
      play('pot');
      hall.banner('Glimmer Pot! You won ' + fmt(ack.pt));
    }
    session.won += total + potWin;
    bal = ack.bal;
    hall.setPot(mode === 'remote' && pot !== null ? pot : null);
    if (ack.v) {
      pending = { m: machine, bet: b };
      announce(total, b);
      hall.setSub('Three Vaults: pick a door');
      cycleLines(d, ev, stops);
      reality.onSpin(Date.now(), total - b);
      stopAuto('feature');
      showBalance();
      writeWallet();
      openDoors();
      return;
    }
    phase = 'idle';
    announce(total + potWin, b);
    if (!ack.f) hall.setSub('');
    if (!ack.f || ack.f.k === 'h') cycleLines(d, ev, stops);
    celebrateWin(total + potWin, b);
    reality.onSpin(Date.now(), total + potWin - b);
    showBalance();
    writeWallet();
    afterSettle({ win: total + potWin, bet: b, feature: ack.f !== undefined, pot: potWin > 0 });
  };

  const afterSettle = (o: { win: number; bet: number; feature: boolean; pot: boolean }): void => {
    showSpinState();
    const check = reality.take();
    if (check) {
      stopAuto('check');
      showCheck(check);
      return;
    }
    if (!auto) return;
    const stop = autoAfterSpin(auto, o) ?? autoMayContinue(auto, bal, bet());
    if (stop) {
      stopAuto(stop);
      return;
    }
    const wait = Math.max(0, AUTO_GAP_MS - (now() - lastSpinAt));
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (auto && visible && phase === 'idle') void spinOnce();
    }, wait);
    showSpinState();
  };

  const spinOnce = async (): Promise<void> => {
    if (phase !== 'idle' || disposed || moved) return;
    const t = now();
    if (t - lastSpinAt < SPIN_FLOOR_MS) return;
    if (mode === 'remote' && !gh.connected()) {
      hall.setSub('Reconnecting…');
      return;
    }
    const d = def();
    const b = bet();
    if (bal < b) {
      hall.setSub(mode === 'local' ? 'Not enough Practice chips' : 'Not enough chips for this bet');
      if (mode === 'local') offerRefill();
      stopAuto('funds');
      return;
    }
    lastSpinAt = t;
    phase = 'spin';
    clearLines();
    reels?.clearEffects();
    hall.setMeter('', 'idle');
    hall.setSub('');
    bal -= b;
    showBalance();
    const id = newSpinId();
    inflight = { id, kind: 'spin', bet: b };
    reels?.start({ turbo: prefs.turbo && !auto });
    play('whirr', { gain: 0.5 });
    showSpinState();
    waitTimer = setTimeout(() => hall.setSub('Waiting for the hall…'), 5000);
    const ack = await gh.spin(machine, b, id);
    if (waitTimer) clearTimeout(waitTimer);
    waitTimer = null;
    if (disposed) return;
    if (!ack.ok) {
      refused((ack as Refused).code, b, 'spin');
      return;
    }
    inflight = null;
    hall.setSub('');
    await settleSpin(ack as SpinOk, d, b);
  };

  const dashSpin = async (): Promise<void> => {
    if (!dash || phase !== 'idle' || disposed) return;
    const t = now();
    if (t - lastSpinAt < SPIN_FLOOR_MS) return;
    const d = machineDef(dash.m);
    if (d.idx !== machine) await showMachine(d.idx);
    if (disposed || !dash || phase !== 'idle') return;
    lastSpinAt = t;
    phase = 'spin';
    clearLines();
    reels?.clearEffects();
    const sid = newSpinId();
    inflight = { id: sid, kind: 'dash', bet: DASH_BET };
    reels?.start({ turbo: prefs.turbo });
    play('whirr', { gain: 0.5 });
    showSpinState();
    const ack = await gh.dash.spin(dash.id, sid);
    if (disposed) return;
    if (!ack.ok) {
      refused((ack as Refused).code, 0, 'dash');
      return;
    }
    inflight = null;
    const stops = decodeStops(ack.st, d, false) ?? d.strips.map(() => 0);
    const ev = evaluate(d, stops, DASH_BET);
    if (reels) await reels.land(stops);
    let total = ack.w;
    if (ack.f) {
      if (ack.f.k === 'v' && reels && art) {
        // In a Dash the vault opens at once: every door opens in turn, the drawn one highlighted.
        const st: DoorsState = { labels: [null, null, null], openedAt: [null, null, null], picked: ack.f.d, closed: false };
        st.labels[ack.f.d] = (ack.f.x ? '×' + ack.f.x : '') || null;
        const size = reels.size;
        reels.play(doors(art, size.w, size.h, st));
        const at = now();
        [ack.f.d, (ack.f.d + 1) % 3, (ack.f.d + 2) % 3].forEach((door, i) => (st.openedAt[door] = at + i * 350));
        play('door');
        await delay(1500);
        st.closed = true;
      }
      total += await playFeature(d, DASH_BET, ack.f);
    }
    if (dash) {
      const s = dash.s.slice();
      for (let i = 0; i + 2 < s.length; i += 3) if (s[i] === me) {
        s[i + 1] = ack.sc;
        s[i + 2] = ack.left;
      }
      dash = { ...dash, s };
    }
    phase = 'idle';
    hall.setMeter(total > 0 ? '+' + fmt(total) + ' points' : 'No points', total > 0 ? 'win' : 'idle');
    hall.setSub('Dash: ' + fmt(ack.sc) + ' points · ' + ack.left + ' spins left');
    cycleLines(d, ev, stops);
    if (total >= DASH_BET * 10) celebrateWin(total, DASH_BET);
    showBalance();
    showBet();
    showSpinState();
    refreshDashSheet();
  };

  // ------------------------------------------------------------------ vault doors

  const openDoors = (): void => {
    if (!pending || !reels || !art) return;
    if (pending.m !== machine) {
      void showMachine(pending.m).then(() => openDoors());
      return;
    }
    phase = 'doors';
    doorsState = { labels: [null, null, null], openedAt: [null, null, null], picked: null, closed: false };
    const size = reels.size;
    reels.play(doors(art, size.w, size.h, doorsState));
    hall.hits.hidden = false;
    hall.setSub('Three Vaults: pick a door');
    play('door', { gain: 0.5 });
    showSpinState();
  };

  const pickDoor = async (door: 0 | 1 | 2): Promise<void> => {
    if (phase !== 'doors' || !pending || !doorsState || doorsState.picked !== null) return;
    const st = doorsState;
    const pend = pending;
    st.picked = door;
    hall.hits.hidden = true;
    const id = newSpinId();
    inflight = { id, kind: 'pick', bet: pend.bet };
    phase = 'busy';
    showSpinState();
    const ack = await gh.pick(door, id);
    if (disposed) return;
    if (!ack.ok) {
      st.picked = null;
      if ((ack as Refused).code === 'lost') {
        hall.setSub("Your pick will settle when you're back");
        return;
      }
      inflight = null;
      st.closed = true;
      doorsState = null;
      pending = null;
      phase = 'idle';
      void refresh();
      showSpinState();
      return;
    }
    inflight = null;
    await revealDoors(ack as PickOk, pend);
  };

  const revealDoors = async (ack: PickOk, pend: { m: MachineIdx; bet: number }): Promise<void> => {
    const d = machineDef(pend.m);
    const st = doorsState ?? { labels: [null, null, null], openedAt: [null, null, null], picked: ack.f.d, closed: false };
    if (!doorsState && reels && art) reels.play(doors(art, reels.size.w, reels.size.h, st));
    doorsState = null;
    st.picked = ack.f.d;
    st.labels = ack.dr.map((p) => PRIZE_LABEL(d, p));
    pending = null;
    hall.setSub('Door ' + (ack.f.d + 1) + ': ' + (st.labels[ack.f.d] ?? '').replace(' x', ' spins ×'));
    showSpinState();
    const at = now();
    // The picked door first, then the other two in turn.
    [ack.f.d, (ack.f.d + 1) % 3, (ack.f.d + 2) % 3].forEach((door, i) => (st.openedAt[door] = at + i * 450));
    play('door');
    play('reveal');
    await delay(opts.reducedMotion ? 600 : 1700);
    st.closed = true;
    pending = null;
    const won = await playFeature(d, pend.bet, ack.f);
    if (disposed) return;
    session.won += won;
    bal = ack.bal;
    phase = 'idle';
    const total = won + (d.feature.kind === 'vault' ? d.feature.scatterPay * pend.bet : 0);
    announce(total, pend.bet);
    hall.setSub('Forge Spins: ' + fmt(won));
    celebrateWin(total, pend.bet);
    showBalance();
    writeWallet();
    afterSettle({ win: total, bet: pend.bet, feature: true, pot: false });
  };

  // ------------------------------------------------------------------ hall state

  const applyEnter = (ack: EnterOk): void => {
    entered = true;
    bal = ack.bal;
    maxBet = ack.maxBet;
    me = ack.me;
    pot = mode === 'remote' ? ack.pot : null;
    hall.setPot(pot);
    setMembers(ack.mem);
    hall.friends.hidden = ack.me < 0;
    dash = ack.dash ?? null;
    pending = ack.pend ?? null;
    showBalance();
    showBet();
    writeWallet();
    opts.shell.status('live');
    if (pending && phase !== 'doors') {
      phase = 'idle';
      openDoors();
    } else if (phase === 'busy' && !inflight) phase = 'idle';
    if (ack.me < 0 && mode === 'remote') hall.setSub("You left the call · hall closed");
    showSpinState();
    refreshDashSheet();
  };

  const refresh = async (): Promise<void> => {
    const ack = await gh.enter(opts.lobby?.ch ?? null);
    if (disposed) return;
    if (!ack.ok) {
      const code = (ack as Refused).code;
      hall.setSub(code === 'update' ? 'Update the app to play online' : code === 'hidden' ? 'Glimmerhall is hidden for your account' : code === 'lost' ? 'Reconnecting…' : 'The hall is not available');
      phase = 'busy';
      showSpinState();
      return;
    }
    applyEnter(ack as EnterOk);
    if (inflight) await resumeInflight();
  };

  /** After a reconnect: settle the spin or pick whose answer never arrived. */
  const resumeInflight = async (): Promise<void> => {
    const f = inflight;
    if (!f) return;
    const ack = await gh.resume(f.id);
    if (disposed || !ack.ok) return;
    inflight = null;
    const r = ack as unknown as Record<string, unknown>;
    if (r.found === false) {
      // It never reached the authority: nothing was charged.
      if (f.kind === 'spin') bal = typeof r.bal === 'number' ? r.bal : bal + f.bet;
      phase = 'idle';
      reels?.rest(randomStops(def()));
      hall.setSub('That spin never left: nothing was charged');
    } else if (r.settled) {
      bal = typeof r.bal === 'number' ? r.bal : bal;
      phase = 'idle';
      hall.setSub('Your spin settled');
    } else if (f.kind === 'spin' && typeof r.st === 'string') {
      hall.setSub('');
      await settleSpin(ack as SpinOk, def(), f.bet);
      return;
    } else if (f.kind === 'pick' && Array.isArray(r.dr) && pending) {
      await revealDoors(ack as unknown as PickOk, pending);
      return;
    } else phase = 'idle';
    showBalance();
    showSpinState();
  };

  const onFeed = (f: FeedView): void => {
    if (f.p !== undefined && mode === 'remote') {
      pot = f.p;
      hall.setPot(pot);
    }
    if (f.h) {
      for (const [slot, acct, m, away] of f.h) {
        const cur = members.get(slot);
        if (acct === null) {
          cur?.el?.remove();
          members.delete(slot);
          continue;
        }
        const member: Member = cur ?? { slot, acct, m, away: away === 1, lw: 0, lx: 0, el: null };
        member.acct = acct;
        member.m = m;
        member.away = away === 1;
        members.set(slot, member);
        renderMember(member);
      }
    }
    if (f.e) {
      for (const [slot, m, b, win, k] of f.e) {
        const member = members.get(slot);
        if (member) {
          member.m = m;
          if (k !== 3) {
            member.lw = win;
            member.lx = b > 0 ? Math.floor((win * 100) / b) : 0;
          }
          renderMember(member);
        }
        if (slot !== me && (k === 2 || (k !== 3 && b > 0 && win >= b * BRAG_X))) {
          hall.banner(k === 2 ? nameOf(slot) + ' won the Glimmer Pot · ' + fmt(win) : nameOf(slot) + ' hit ' + fmt(win) + ' on ' + SHORT_NAMES[m] + ' (' + times(win, b) + ')');
        }
      }
    }
    if (f.r) for (const [, to, e] of f.r) bubble(to, e);
    if (f.d) {
      const was = inDash();
      dash = f.d;
      // Joining a running Dash brings its machine up (when nothing else is going on).
      if (!was && inDash() && f.d.m !== machine && phase === 'idle' && !pending) void showMachine(f.d.m);
      if (was !== inDash() || f.d.st === DASH_ST.done) {
        showBet();
        showBalance();
        showSpinState();
        if (f.d.st === DASH_ST.done) {
          hall.setSub('Glimmer Dash finished');
          void refresh();
        }
      }
      refreshDashSheet();
    }
  };

  // ------------------------------------------------------------------ sheets

  const showMoved = (): void => {
    moved = true;
    stopAuto('moved');
    hall.cover('Playing in another window');
    const b = button('gh-go', 'Play here');
    b.addEventListener('click', () => {
      moved = false;
      hall.cover(null);
      void refresh();
    });
    const { el, body } = card('Playing in another window', () => hall.closeSheet(), offs);
    body.append(h('p', '', 'Your seat moved to another window or device.'), b);
    hall.sheet(el);
  };

  const offerRefill = (): void => {
    const min = ladder()[0] as number;
    if (mode !== 'local' || bal >= min) return;
    const { el, body } = card('Out of Practice chips', () => hall.closeSheet(), offs);
    const b = button('gh-go', 'Refill to 10,000 Practice chips');
    b.addEventListener('click', () => {
      opts.shell.practice.refill(min);
      bal = opts.shell.practice.balance();
      showBalance();
      hall.setSub('');
      hall.closeSheet();
      showSpinState();
    });
    body.append(h('p', '', 'Practice chips are free and stay on this device.'), b);
    sheetKind = 'other';
    hall.sheet(el, () => (sheetKind = null));
  };

  const showCheck = (c: { minutes: number; spins: number; net: number }): void => {
    const { el, body } = card('Time for a break?', () => hall.closeSheet(), offs);
    body.append(h('p', '', 'You have played for ' + c.minutes + ' minutes: ' + c.spins + ' spins, ' + signed(c.net) + ' chips.'));
    const keep = button('gh-go', 'Keep playing');
    keep.addEventListener('click', () => hall.closeSheet());
    const leave = button('gh-go alt', 'Leave');
    leave.addEventListener('click', () => opts.shell.leave());
    body.append(keep, leave, h('p', 'muted', PLAY_MONEY));
    sheetKind = 'other';
    hall.sheet(el, () => (sheetKind = null));
  };

  const showSession = (): void => {
    const { el, body } = card('This session', () => hall.closeSheet(), offs);
    const minutes = Math.round((Date.now() - session.startedAt) / 60_000);
    body.append(
      h('p', '', session.spins + ' spins in ' + minutes + ' min · bet ' + fmt(session.wagered) + ' · won ' + fmt(session.won) + ' · net ' + signed(session.won - session.wagered)),
      h('p', 'muted', (mode === 'local' ? 'Practice chips, on this device only. ' : '') + PLAY_MONEY),
    );
    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLButtonElement => {
      const b = button('gh-opt', label);
      b.setAttribute('aria-pressed', String(get()));
      b.addEventListener('click', () => {
        set(!get());
        savePrefs();
        b.setAttribute('aria-pressed', String(get()));
      });
      return b;
    };
    const row = h('div', 'gh-row');
    row.append(
      toggle('Turbo', () => prefs.turbo, (v) => (prefs.turbo = v)),
      toggle('Vibrate', () => prefs.haptics, (v) => (prefs.haptics = v)),
    );
    body.append(h('h4', '', 'Settings'), row);
    if (mode === 'local' && bal < (ladder()[0] as number) * 1) {
      const refill = button('gh-go', 'Refill to 10,000 Practice chips');
      refill.addEventListener('click', () => {
        opts.shell.practice.refill(ladder()[0] as number);
        bal = opts.shell.practice.balance();
        showBalance();
        hall.closeSheet();
      });
      body.append(refill);
    }
    const leave = button('gh-go alt', 'Leave Glimmerhall');
    leave.addEventListener('click', () => opts.shell.leave());
    body.append(leave);
    sheetKind = 'other';
    hall.sheet(el, () => (sheetKind = null));
  };

  const showHelp = (): void => {
    const { el, body } = card('How it works', () => hall.closeSheet(), offs);
    body.append(paytable(machine, betOf, mode, CABINETS[machine]?.accent ?? '#4fd0c8'));
    sheetKind = 'other';
    hall.sheet(el, () => (sheetKind = null));
  };

  const showAuto = (): void => {
    if (auto) {
      stopAuto('user');
      return;
    }
    if (phase !== 'idle' || pending || inDash()) return;
    const cfg: AutoCfg = { spins: 10, lossPct: 25, stopBig: prefs.stopBig };
    const { el, body } = card('Auto-spin', () => hall.closeSheet(), offs);
    const pick = <T extends number>(values: readonly T[], suffix: string, initial: T, set: (v: T) => void): HTMLDivElement => {
      const row = h('div', 'gh-row');
      const all = values.map((v) => {
        const b = button('gh-opt', v + suffix);
        b.setAttribute('aria-pressed', String(v === initial));
        b.addEventListener('click', () => {
          set(v);
          all.forEach((x, i) => x.setAttribute('aria-pressed', String(values[i] === v)));
        });
        row.append(b);
        return b;
      });
      return row;
    };
    body.append(h('h4', '', 'Spins'), pick(AUTO_SPINS, '', 10, (v) => (cfg.spins = v)));
    body.append(h('h4', '', 'Stop after losing'), pick(AUTO_LOSS, ' %', 25, (v) => (cfg.lossPct = v)), h('p', 'muted', 'of your balance now (' + fmt(bal) + ').'));
    const big = button('gh-opt', 'Stop on a win of 50 × or more');
    big.setAttribute('aria-pressed', String(cfg.stopBig));
    big.addEventListener('click', () => {
      cfg.stopBig = !cfg.stopBig;
      prefs.stopBig = cfg.stopBig;
      savePrefs();
      big.setAttribute('aria-pressed', String(cfg.stopBig));
    });
    body.append(h('div', 'gh-row'), big, h('p', 'muted', 'Auto-spin also stops on any feature, when you look away, and at least 1.6 s passes between spins.'));
    const go = button('gh-go', 'Start');
    go.addEventListener('click', () => {
      hall.closeSheet();
      auto = startAuto(cfg, bal);
      const stop = autoMayContinue(auto, bal, bet());
      if (stop) {
        stopAuto(stop);
        return;
      }
      opts.shell.wakeLock(true);
      showSpinState();
      void spinOnce();
    });
    body.append(go);
    sheetKind = 'other';
    hall.sheet(el, () => (sheetKind = null));
  };

  const stopAuto = (why: AutoStop): void => {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    if (!auto) return;
    auto = null;
    opts.shell.wakeLock(false);
    if (why !== 'user') hall.setSub(AUTO_STOP_TEXT[why]);
    showSpinState();
  };

  const dashDeps = () => ({
    dash,
    me,
    inHall: me >= 0,
    mode,
    machine,
    name: nameOf,
    create: (c: { m: MachineIdx; len: number; buy: number }) => {
      void gh.dash.create(c).then((ack) => {
        if (disposed) return;
        if (ack.ok) {
          dash = ack.dash;
          if (typeof ack.bal === 'number') bal = ack.bal;
          showBalance();
        } else hall.setSub((ack as Refused).code === 'funds' ? 'Not enough chips for that buy-in' : 'Could not open a Dash');
        refreshDashSheet();
      });
    },
    join: (id: string) =>
      void gh.dash.join(id).then((ack) => {
        if (!disposed && ack.ok && typeof ack.bal === 'number') {
          bal = ack.bal;
          showBalance();
        }
      }),
    leave: (id: string) =>
      void gh.dash.leave(id).then((ack) => {
        if (!disposed && ack.ok && typeof ack.bal === 'number') {
          bal = ack.bal;
          showBalance();
        }
      }),
    start: (id: string) => void gh.dash.start(id),
  });

  const refreshDashSheet = (): void => {
    if (sheetKind !== 'dash') return;
    const host = hall.root.querySelector('.gh-dash-body');
    if (host) host.replaceChildren(dashPanel(dashDeps()));
  };

  const showDash = (): void => {
    const { el, body } = card('Glimmer Dash', () => hall.closeSheet(), offs);
    body.className = 'gh-dash-body';
    body.append(dashPanel(dashDeps()));
    sheetKind = 'dash';
    hall.sheet(el, () => (sheetKind = null));
  };

  const showNotice = (): void => {
    const { el, body } = card('Welcome to Glimmerhall', () => hall.closeSheet(), offs);
    body.append(
      h('p', '', PLAY_MONEY),
      h('p', 'muted', 'Three machines, a shared Glimmer Pot online and the Glimmer Dash. Every spin is pure luck; "How it works" shows the exact return of each machine.'),
    );
    const ok = button('gh-go', 'Got it');
    ok.addEventListener('click', () => hall.closeSheet());
    body.append(ok);
    sheetKind = 'other';
    hall.sheet(el, () => {
      sheetKind = null;
      prefs.notice = true;
      savePrefs();
    });
  };

  // ------------------------------------------------------------------ input

  const onSpinButton = (): void => {
    unlock();
    if (hall.sheetOpen || moved) return;
    if (phase === 'spin') {
      reels?.slam();
      return;
    }
    if (phase === 'feature') {
      skip = true;
      return;
    }
    if (phase !== 'idle') return;
    if (auto) {
      stopAuto('user');
      return;
    }
    if (pending) {
      openDoors();
      return;
    }
    if (inDash()) {
      void dashSpin();
      return;
    }
    void spinOnce();
  };

  const stepBet = (dir: 1 | -1): void => {
    if (phase !== 'idle' || inDash() || auto) return;
    const l = ladder();
    const next = Math.max(0, Math.min(l.length - 1, Math.min(prefs.steps[machine], l.length - 1) + dir));
    prefs.steps[machine] = next;
    savePrefs();
    showBet();
    play('tap');
  };

  const back = (): boolean => {
    if (hall.sheetOpen) {
      hall.closeSheet();
      return true;
    }
    return false;
  };

  onTap(hall.spin, onSpinButton, offs);
  onTap(hall.betMinus, () => stepBet(-1), offs);
  onTap(hall.betPlus, () => stepBet(1), offs);
  onTap(hall.auto, () => {
    unlock();
    showAuto();
  }, offs);
  onTap(hall.helpBtn, showHelp, offs);
  onTap(hall.dashBtn, showDash, offs);
  onTap(hall.bal, showSession, offs);
  onTap(hall.fold, () => hall.friends.classList.toggle('shut'), offs);
  hall.tabs.forEach((t, i) => onTap(t, () => switchMachine(i as MachineIdx), offs));
  hall.doorButtons.forEach((b, d) => onTap(b, () => void pickDoor(d as 0 | 1 | 2), offs));
  listen(hall.root, 'pointerdown', unlock, offs);

  // A downward swipe on the reels spins.
  let swipe: { id: number; x: number; y: number } | null = null;
  listen<PointerEvent>(hall.reelHost, 'pointerdown', (e) => (swipe = { id: e.pointerId, x: e.clientX, y: e.clientY }), offs);
  listen<PointerEvent>(hall.reelHost, 'pointerup', (e) => {
    const s = swipe;
    swipe = null;
    if (!s || s.id !== e.pointerId) return;
    if (e.clientY - s.y > 40 && Math.abs(e.clientX - s.x) < 50) onSpinButton();
  }, offs);
  listen(hall.reelHost, 'pointercancel', () => (swipe = null), offs);

  listen<KeyboardEvent>(hall.root, 'keydown', (e) => {
    if (e.isComposing || isTyping(e.target)) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!back()) opts.shell.minimize();
      return;
    }
    if (isReservedKey(e, opts.ptt, opts.reserved)) return;
    let handled = true;
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
      if (e.repeat) return e.preventDefault();
      if (e.target instanceof HTMLButtonElement && e.target !== hall.spin) return;
      onSpinButton();
    } else if (e.code === 'ArrowUp') stepBet(1);
    else if (e.code === 'ArrowDown') stepBet(-1);
    else if (e.code === 'KeyA') showAuto();
    else if (e.code === 'KeyP') showHelp();
    else handled = false;
    if (handled) e.preventDefault();
  }, offs);

  // Gamepad: a 10 Hz frame subscription only while a pad is connected and the hall is visible.
  let pads = 0;
  let padOff: (() => void) | null = null;
  let padHeld = 0;
  const poll = (): void => {
    const list = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let held = 0;
    for (const pad of list) {
      if (!pad || pad.mapping !== 'standard') continue;
      [0, 1, 3, 12, 13].forEach((b, i) => {
        if (pad.buttons[b]?.pressed) held |= 1 << i;
      });
    }
    const down = held & ~padHeld;
    padHeld = held;
    if (down & 1) onSpinButton();
    if (down & 2 && !back()) opts.shell.minimize();
    if (down & 4) showHelp();
    if (down & 8) stepBet(1);
    if (down & 16) stepBet(-1);
  };
  const syncPad = (): void => {
    const want = pads > 0 && visible && !disposed;
    if (want && !padOff) padOff = frames.add(poll, { maxFps: 10, label: 'glimmer-pad' });
    else if (!want && padOff) {
      padOff();
      padOff = null;
    }
  };
  listen(window, 'gamepadconnected', () => {
    pads += 1;
    syncPad();
  }, offs);
  listen(window, 'gamepaddisconnected', () => {
    pads = Math.max(0, pads - 1);
    syncPad();
  }, offs);

  // ------------------------------------------------------------------ host events

  offs.push(gh.onFeed(onFeed));
  offs.push(
    gh.onWallet((b) => {
      if (phase === 'idle' && !inflight) {
        bal = b;
        showBalance();
      }
    }),
  );
  offs.push(gh.onMoved(showMoved));
  offs.push(
    gh.onClosed((r) => {
      hall.setSub(r === 'disabled' ? 'Glimmerhall was switched off' : 'The hall closed');
      setMembers([]);
      me = -1;
    }),
  );
  offs.push(
    gh.onConnection((up) => {
      if (!up) stopAuto('offline');
      showSpinState();
      if (up && visible) void refresh();
    }),
  );
  if (mode === 'local') offs.push(opts.shell.practice.onChange((b) => {
    if (phase === 'idle' && !inflight) {
      bal = b;
      showBalance();
    }
  }));

  // ------------------------------------------------------------------ start

  hall.setMachine(machine);
  hall.setPot(null);
  showBalance();
  showBet();
  showSpinState();
  opts.shell.idleAway(10 * 60_000);
  void showMachine(machine);
  void refresh();
  if (!prefs.notice) showNotice();

  return {
    pause() {
      if (!visible) return;
      visible = false;
      reels?.setVisible(false);
      clearLines();
      audio.suspend();
      stopAuto('hidden');
      syncPad();
      if (mode === 'remote') gh.away();
      opts.shell.status('away');
      hall.cover('Paused · tap to return');
    },
    resume() {
      if (visible) return;
      visible = true;
      hall.cover(null);
      reels?.setVisible(true);
      audio.resume();
      syncPad();
      if (entered) opts.shell.status('live');
      if (mode === 'remote' && entered) void refresh();
    },
    back,
    unmount() {
      if (disposed) return;
      disposed = true;
      stopAuto('user');
      clearLines();
      if (waitTimer) clearTimeout(waitTimer);
      if (walletTimer) clearTimeout(walletTimer);
      waitTimer = walletTimer = null;
      padOff?.();
      padOff = null;
      for (const sleep of sleeps) {
        clearTimeout(sleep.t);
        sleep.done();
      }
      sleeps.clear();
      for (const off of offs.splice(0)) off();
      opts.shell.idleAway(null);
      opts.shell.wakeLock(false);
      reels?.dispose();
      reels = null;
      for (const p of arts.values()) void p.then((a) => a.dispose());
      arts.clear();
      void audio.close();
      if (mode === 'remote') gh.leave();
      hall.dispose();
    },
  };
};

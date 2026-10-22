/**
 * The table renderer (lamplight.md §14.3). Nothing runs on its own: an event or a resize marks the
 * table dirty and the loop draws one frame; tweens (deal, flip, chips, winner glow, the Firefly
 * reveal) keep it drawing only while they last. Layers: a cached felt, rail and empty-seat layer
 * (rebuilt on resize) and a dynamic layer for cards, chips and labels. `prefers-reduced-motion` makes
 * every tween instant.
 */
import type { TableState } from '@arcade/core/lamplight/engine';
import { textWidth, drawText } from '../../runtime/font';
import type { Effect, TableModel } from '../table';
import { chips } from '../table';
import { BACK, CARD_H, CARD_W, C, CHIP_COLOURS, css, type Art } from './art';
import { layoutTable, type Layout } from './layout';

interface Tween {
  kind: 'deal' | 'flip' | 'bet' | 'collect' | 'award' | 'glow' | 'trio' | 'board';
  start: number;
  dur: number;
  seat: number;
  /** deal: card index (0/1); board: board index; award: pot amount. */
  n: number;
  x0?: number;
  y0?: number;
}

export interface Scene {
  resize(w: number, h: number, dpr: number): void;
  effect(e: Effect, now: number): void;
  /** Draws one frame; true while tweens still run. */
  draw(now: number): boolean;
  /** Earliest bubble expiry (to redraw once), or null. */
  nextExpiry(now: number): number | null;
  readonly layout: Layout | null;
  /** Your deck colours: 0 four-colour, 1 two-colour. */
  deck: 0 | 1;
  dispose(): void;
}

const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) * (1 - t));

export const createScene = (o: { canvas: HTMLCanvasElement; art: Art; model: TableModel; reducedMotion: boolean }): Scene => {
  const ctx = o.canvas.getContext('2d') as CanvasRenderingContext2D;
  const felt = document.createElement('canvas');
  const fctx = felt.getContext('2d');
  let layout: Layout | null = null;
  let dpr = 1;
  let seatsCount = 0;
  let meSeat: number | null = null;
  const tweens: Tween[] = [];
  const bubbles = new Map<number, { text: string; until: number; colour: number }>();
  const winners = new Set<number>();
  let trio: { mult: number; start: number } | null = null;
  let lastPots: { a: number; w: number[] }[] = [];

  const text = (c: CanvasRenderingContext2D, s: string, x: number, y: number, colour: number, scale: number, align: 'left' | 'center' | 'right' = 'left'): void => {
    const w = textWidth(s) * scale;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    c.save();
    c.translate(Math.round(left), Math.round(y));
    c.scale(scale, scale);
    drawText(c, o.art.atlas, s, 0, 0, colour);
    c.restore();
  };

  const roundRect = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  };

  /** The cached layer: background, rail, felt and empty seats. */
  const buildFelt = (): void => {
    const l = layout;
    if (!l || !fctx) return;
    felt.width = Math.max(1, Math.round(l.w * dpr));
    felt.height = Math.max(1, Math.round(l.h * dpr));
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.imageSmoothingEnabled = false;
    fctx.fillStyle = '#0d1716';
    fctx.fillRect(0, 0, l.w, l.h);
    const glow = fctx.createRadialGradient(l.cx, l.cy, 10, l.cx, l.cy, Math.max(l.rx, l.ry) * 1.4);
    glow.addColorStop(0, 'rgba(242,184,75,0.10)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    fctx.fillStyle = glow;
    fctx.fillRect(0, 0, l.w, l.h);
    // Rail.
    fctx.beginPath();
    fctx.ellipse(l.cx, l.cy, l.rx + 14, l.ry + 14, 0, 0, Math.PI * 2);
    fctx.fillStyle = '#5a4122';
    fctx.fill();
    fctx.beginPath();
    fctx.ellipse(l.cx, l.cy, l.rx + 9, l.ry + 9, 0, 0, Math.PI * 2);
    fctx.fillStyle = css(C.brass);
    fctx.fill();
    // Felt.
    fctx.save();
    fctx.beginPath();
    fctx.ellipse(l.cx, l.cy, l.rx + 4, l.ry + 4, 0, 0, Math.PI * 2);
    fctx.clip();
    const pattern = fctx.createPattern(o.art.felt, 'repeat');
    fctx.fillStyle = pattern ?? css(C.felt);
    fctx.fillRect(l.cx - l.rx - 8, l.cy - l.ry - 8, l.rx * 2 + 16, l.ry * 2 + 16);
    fctx.restore();
    fctx.beginPath();
    fctx.ellipse(l.cx, l.cy, l.rx - 10, l.ry - 10, 0, 0, Math.PI * 2);
    fctx.strokeStyle = 'rgba(242,184,75,0.18)';
    fctx.lineWidth = 2;
    fctx.stroke();
    // Board slots.
    const b = l.board;
    for (let i = 0; i < 5; i++) {
      roundRect(fctx, b.x + i * (CARD_W * b.scale + b.gap), b.y, CARD_W * b.scale, CARD_H * b.scale, 4);
      fctx.strokeStyle = 'rgba(244,234,213,0.12)';
      fctx.lineWidth = 1;
      fctx.stroke();
    }
  };

  const chipStack = (c: CanvasRenderingContext2D, x: number, y: number, amount: number, bb: number): void => {
    // Up to 5 chips, coloured by the biggest denominations in the amount (in big-blind units).
    let rest = Math.max(1, Math.round(amount / Math.max(1, bb / 10)));
    let drawn = 0;
    for (const [value, fill, stripe] of CHIP_COLOURS) {
      let k = Math.floor(rest / value);
      rest -= k * value;
      for (; k > 0 && drawn < 5; k--, drawn++) {
        const cy = y - drawn * 3;
        c.beginPath();
        c.ellipse(x, cy, 7, 3, 0, 0, Math.PI * 2);
        c.fillStyle = fill;
        c.fill();
        c.fillStyle = stripe;
        c.fillRect(x - 2, cy - 3, 4, 1);
        c.fillRect(x - 6, cy - 1, 2, 2);
        c.fillRect(x + 4, cy - 1, 2, 2);
      }
      if (drawn >= 5) break;
    }
  };

  const dealer = (c: CanvasRenderingContext2D, x: number, y: number): void => {
    c.beginPath();
    c.arc(x, y, 8, 0, Math.PI * 2);
    c.fillStyle = css(C.brass);
    c.fill();
    c.beginPath();
    c.arc(x, y, 6, 0, Math.PI * 2);
    c.fillStyle = css(C.cream);
    c.fill();
    text(c, 'D', x, y - 3, C.ink, 1, 'center');
  };

  const drawSeat = (c: CanvasRenderingContext2D, view: TableState, n: number, now: number): void => {
    const l = layout as Layout;
    const spot = l.seats[n];
    const s = view.seats[n];
    if (!spot) return;
    const r = l.avatar / 2;
    if (!s.player) {
      c.beginPath();
      c.arc(spot.x, spot.y, r - 4, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(244,234,213,0.18)';
      c.setLineDash([3, 4]);
      c.lineWidth = 2;
      c.stroke();
      c.setLineDash([]);
      return;
    }
    const hand = view.hand;
    const out = s.folded || s.status === 'sittingOut' || s.status === 'busted' || (hand && hand.street !== 'done' && !s.inHand);
    const toAct = hand?.toAct === n;
    c.globalAlpha = out ? 0.45 : 1;
    // Ring.
    c.beginPath();
    c.arc(spot.x, spot.y, r, 0, Math.PI * 2);
    c.fillStyle = toAct ? css(C.amber) : winners.has(n) ? css(C.glow) : '#2a3b39';
    c.fill();
    const av = o.art.avatar(s.player.avatarSeed);
    const size = l.avatar - 8;
    c.drawImage(av, Math.round(spot.x - size / 2), Math.round(spot.y - size / 2), size, size);
    c.globalAlpha = 1;
    // Name and stack.
    const label = o.model.name(n).slice(0, l.nameChars);
    const ly = spot.y + r + 4;
    c.fillStyle = 'rgba(13,23,22,0.78)';
    const lw = Math.max(textWidth(label), textWidth('00.0k')) * l.text + 8;
    roundRect(c, spot.x - lw / 2, ly - 2, lw, 7 * l.text * 2 + 8, 4);
    c.fill();
    text(c, label, spot.x, ly, out ? C.grey : C.cream, l.text, 'center');
    const status = s.status === 'sittingOut' ? 'Away' : s.status === 'busted' ? 'Out' : s.allIn && s.inHand ? 'All-in' : chips(s.stack);
    text(c, status, spot.x, ly + 7 * l.text + 3, s.allIn ? C.red : C.amber, l.text, 'center');
    if (!s.connected) text(c, '...', spot.x + r - 4, spot.y - r - 2, C.grey, 2, 'center');
    // Cards beside the avatar (not your own: yours are big at the bottom).
    if (hand && s.inHand && !s.folded && n !== meSeat) {
      const sc = (s.shown && s.hole ? 1.5 : 1) * l.seatScale;
      const cw = CARD_W * sc;
      const x = spot.x + (spot.dx > 0.3 ? r + 2 : spot.dx < -0.3 ? -r - cw - 10 : -cw / 2 - 5);
      const y = spot.y - (CARD_H * sc) / 2 - (Math.abs(spot.dx) <= 0.3 ? r + 6 : 0);
      for (let i = 0; i < 2; i++) {
        const dealing = tweens.find((t) => t.kind === 'deal' && t.seat === n && t.n === i);
        if (dealing && now < dealing.start) continue;
        let px = x + i * 10;
        let py = y;
        if (dealing) {
          const k = ease((now - dealing.start) / dealing.dur);
          px = l.cx + (px - l.cx) * k;
          py = l.cy + (py - l.cy) * k;
        }
        const face = s.shown && s.hole ? s.hole[i] : BACK;
        o.art.card(c, face, Math.round(px), Math.round(py), sc, deckRef.deck);
      }
    }
    // Bet in front of the seat.
    if (s.streetBet > 0) {
      const t = tweens.find((x) => x.kind === 'bet' && x.seat === n);
      let bx = spot.betX;
      let by = spot.betY;
      if (t) {
        const k = ease((now - t.start) / t.dur);
        bx = spot.x + (bx - spot.x) * k;
        by = spot.y + (by - spot.y) * k;
      }
      chipStack(c, bx, by, s.streetBet, view.level.bb);
      text(c, chips(s.streetBet), bx + 10, by - 6, C.cream, l.text);
    }
    // The dealer token is a badge on the avatar, so it never covers cards or bets.
    if (hand && hand.button === n) dealer(c, spot.x - r + 3, spot.y - r + 3);
    const bubble = bubbles.get(n);
    if (bubble && bubble.until > now) {
      const bw = textWidth(bubble.text) * 2 + 12;
      const bx = spot.x - bw / 2;
      const by = spot.y - r - 22;
      c.fillStyle = 'rgba(244,234,213,0.95)';
      roundRect(c, bx, by, bw, 18, 6);
      c.fill();
      text(c, bubble.text, spot.x, by + 2, bubble.colour, 2, 'center');
    }
  };

  const deckRef = { deck: 0 as 0 | 1 };

  const drawBoard = (c: CanvasRenderingContext2D, view: TableState, now: number): void => {
    const l = layout as Layout;
    const hand = view.hand;
    if (!hand) return;
    const b = l.board;
    hand.board.forEach((card, i) => {
      const t = tweens.find((x) => x.kind === 'board' && x.n === i);
      const x = b.x + i * (CARD_W * b.scale + b.gap);
      if (t && now < t.start) return;
      if (t) {
        // Flip: the back narrows, then the face widens.
        const k = (now - t.start) / t.dur;
        const w = Math.abs(1 - 2 * Math.min(1, k));
        c.save();
        c.translate(x + (CARD_W * b.scale) / 2, 0);
        c.scale(Math.max(0.05, w), 1);
        o.art.card(c, k < 0.5 ? BACK : card, -(CARD_W * b.scale) / 2, b.y, b.scale, deckRef.deck);
        c.restore();
        return;
      }
      o.art.card(c, card, Math.round(x), Math.round(b.y), b.scale, deckRef.deck);
    });
    // The pot: everything in the middle, plus this street's bets.
    let pot = 0;
    let bets = 0;
    for (const s of view.seats) {
      pot += s.totalBet;
      bets += s.streetBet;
    }
    const middle = pot - bets;
    if (middle > 0 || lastPots.length > 0) {
      const label = hand.street === 'done' || hand.street === 'showdown' ? lastPots.map((p, i) => (i === 0 ? 'Pot ' : 'Side ') + chips(p.a)).join(' · ') : 'Pot ' + chips(middle);
      if (label) text(c, label, l.pot.x, l.pot.y, C.amber, l.text, 'center');
      if (hand.street !== 'done' && middle > 0) chipStack(c, l.pot.x - textWidth(label) * l.text * 0.5 - 12, l.pot.y + 10, middle, view.level.bb);
    }
    // Chips flying to the winners.
    for (const t of tweens) {
      if (t.kind !== 'award' || now < t.start) continue;
      const spot = l.seats[t.seat];
      const k = ease((now - t.start) / t.dur);
      chipStack(c, l.pot.x + (spot.x - l.pot.x) * k, l.pot.y + 10 + (spot.y - l.pot.y - 10) * k, t.n, view.level.bb);
    }
  };

  const drawOwn = (c: CanvasRenderingContext2D, view: TableState, now: number): void => {
    const l = layout as Layout;
    if (meSeat === null) return;
    const s = view.seats[meSeat];
    if (!s?.inHand || !s.hole || !view.hand) return;
    const sc = l.own.scale;
    for (let i = 0; i < 2; i++) {
      const t = tweens.find((x) => x.kind === 'deal' && x.seat === meSeat && x.n === i);
      if (t && now < t.start) continue;
      let x = l.own.x + i * (CARD_W * sc + 6);
      let y = l.own.y;
      if (t) {
        const k = ease((now - t.start) / t.dur);
        x = l.cx + (x - l.cx) * k;
        y = l.cy + (y - l.cy) * k;
      }
      c.globalAlpha = s.folded ? 0.4 : 1;
      o.art.card(c, s.hole[i], Math.round(x), Math.round(y), sc, deckRef.deck);
      c.globalAlpha = 1;
    }
    const words = o.model.myHand();
    if (words && !s.folded) {
      const x = l.own.x + 2 * (CARD_W * sc + 6) + 4;
      if (x + textWidth(words) * 2 < l.w) text(c, words, x, l.own.y + CARD_H * sc - 16, C.cream, 2);
      else text(c, words, l.cx, l.own.y - 18, C.cream, 2, 'center');
    }
  };

  const drawTrio = (c: CanvasRenderingContext2D, now: number): boolean => {
    if (!trio || !layout) return false;
    const l = layout;
    const k = (now - trio.start) / 3000;
    if (k > 1.6) {
      trio = null;
      return false;
    }
    const values = [2, 3, 5, 10, 25, 100, 1000];
    // The values cycle, slowing down onto the draw.
    const shown = k >= 1 ? trio.mult : values[Math.floor((1 - (1 - k) ** 3) * 40) % values.length];
    const label = 'x' + shown;
    c.fillStyle = 'rgba(13,23,22,0.82)';
    roundRect(c, l.cx - 120, l.cy - 46, 240, 92, 12);
    c.fill();
    text(c, 'FIREFLY', l.cx, l.cy - 36, C.amber, 2, 'center');
    text(c, label, l.cx, l.cy - 12, k >= 1 ? C.glow : C.cream, 5, 'center');
    return true;
  };

  return {
    deck: 0,
    get layout() {
      return layout;
    },
    resize(w, h, d) {
      dpr = d;
      const view = o.model.view;
      seatsCount = view?.config.seats ?? 6;
      meSeat = o.model.me;
      layout = layoutTable(w, h, seatsCount, meSeat);
      o.canvas.width = Math.max(1, Math.round(w * dpr));
      o.canvas.height = Math.max(1, Math.round(h * dpr));
      o.canvas.style.width = w + 'px';
      o.canvas.style.height = h + 'px';
      buildFelt();
    },
    effect(e, now) {
      const fast = o.reducedMotion;
      const at = (delay: number) => now + (fast ? 0 : delay);
      const dur = (ms: number) => (fast ? 1 : ms);
      if (e.k === 'deal') {
        winners.clear();
        lastPots = [];
        bubbles.clear();
        tweens.length = 0;
        e.seats.forEach((seat, i) => {
          tweens.push({ kind: 'deal', start: at(i * 60), dur: dur(180), seat, n: 0 });
          tweens.push({ kind: 'deal', start: at((i + e.seats.length) * 60), dur: dur(180), seat, n: 1 });
        });
      } else if (e.k === 'act') {
        // Your own moves need no bubble (it would cover your hand).
        if (e.s === meSeat) {
          if (e.kind !== 'f' && e.kind !== 'x') tweens.push({ kind: 'bet', start: now, dur: dur(250), seat: e.s, n: 0 });
          return;
        }
        bubbles.set(e.s, { text: e.label, until: now + 1500, colour: e.kind === 'f' ? C.grey : e.kind === 'a' || e.kind === 'r' || e.kind === 'b' ? C.red : C.ink });
        if (e.kind !== 'f' && e.kind !== 'x') tweens.push({ kind: 'bet', start: now, dur: dur(250), seat: e.s, n: 0 });
      } else if (e.k === 'street') {
        bubbles.clear();
        const board = o.model.view?.hand?.board.length ?? 0;
        for (let i = board - e.n; i < board; i++) tweens.push({ kind: 'board', start: at((i - (board - e.n)) * 80), dur: dur(150), seat: -1, n: i });
      } else if (e.k === 'win') {
        lastPots = e.pots;
        for (const p of e.pots) {
          for (const w of p.w) {
            winners.add(w);
            tweens.push({ kind: 'award', start: now, dur: dur(400), seat: w, n: Math.floor(p.a / p.w.length) });
          }
        }
        tweens.push({ kind: 'glow', start: now, dur: dur(1200), seat: -1, n: 0 });
      } else if (e.k === 'trio') {
        trio = { mult: e.mult, start: fast ? now - 3000 : now };
        tweens.push({ kind: 'trio', start: now, dur: fast ? 1 : 4800, seat: -1, n: 0 });
      }
    },
    nextExpiry(now) {
      let soonest: number | null = null;
      for (const b of bubbles.values()) if (b.until > now && (soonest === null || b.until < soonest)) soonest = b.until;
      return soonest;
    },
    draw(now) {
      const l = layout;
      const view = o.model.view;
      if (!l) return false;
      if (view && (view.config.seats !== seatsCount || o.model.me !== meSeat)) this.resize(l.w, l.h, dpr);
      deckRef.deck = this.deck;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(felt, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      for (let i = tweens.length - 1; i >= 0; i--) if (now > tweens[i].start + tweens[i].dur) tweens.splice(i, 1);
      for (const [seat, b] of bubbles) if (b.until <= now) bubbles.delete(seat);
      if (view) {
        drawBoard(ctx, view, now);
        for (let n = 0; n < view.seats.length; n++) drawSeat(ctx, view, n, now);
        drawOwn(ctx, view, now);
        // Winner glow: a ring that pulses for 1.2 s, then stays still.
        const glow = tweens.find((t) => t.kind === 'glow');
        for (const w of winners) {
          const spot = (layout as Layout).seats[w];
          if (!spot) continue;
          const pulse = glow ? 0.5 + 0.5 * Math.sin(((now - glow.start) / 300) * Math.PI) : 1;
          ctx.beginPath();
          ctx.arc(spot.x, spot.y, (layout as Layout).avatar / 2 + 4, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,231,163,' + (0.4 + 0.5 * pulse).toFixed(2) + ')';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }
      const trioOn = drawTrio(ctx, now);
      return tweens.length > 0 || trioOn;
    },
    dispose() {
      tweens.length = 0;
      bubbles.clear();
      felt.width = felt.height = 0;
      o.canvas.width = o.canvas.height = 0;
    },
  };
};

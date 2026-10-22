/**
 * The HUD (hearts, glints, keys, the A and B items, ally pins) and the map screen, drawn on the canvas,
 * never in Preact (bellwick.md §8.2, §8.3). Text uses the shared 5 × 7 font.
 */
import type { ClientWorld } from '@arcade/core/bellwick/client';
import { UI } from '@arcade/core/bellwick/content/art';
import { content, screen } from '@arcade/core/bellwick/content/parse';
import { SCREEN_NAME } from '@arcade/core/bellwick/content/text';
import { ItemBit, Status } from '@arcade/core/bellwick/types';
import { drawText, textWidth } from '@/arcade/runtime/font';
import type { Art } from './render';

export const COLOR = {
  black: '#1e161e',
  dark: '#2a2238',
  cream: '#fff0c8',
  shade: 'rgba(30,22,30,0.82)',
} as const;

export const panel = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void => {
  ctx.fillStyle = COLOR.shade;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLOR.cream;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
};

export const text = (ctx: CanvasRenderingContext2D, art: Art, s: string, x: number, y: number, color: number = UI.white): void =>
  drawText(ctx, art.actors, s, x, y, color);

export const centred = (ctx: CanvasRenderingContext2D, art: Art, s: string, y: number, color: number = UI.white, cx = 96): void =>
  drawText(ctx, art.actors, s, Math.round(cx - textWidth(s) / 2), y, color);

/** Ally shape markers (●▲■◆ order) so colour is never the only cue. */
const MARK = [10, 11, 12, 13];

export const drawHud = (ctx: CanvasRenderingContext2D, art: Art, c: ClientWorld, laggy: boolean, notice: string | null): void => {
  ctx.fillStyle = COLOR.black;
  ctx.fillRect(0, 0, 192, 16);
  const me = c.me;
  // Hearts: full, half, empty.
  const hearts = Math.ceil(c.maxHp / 2);
  for (let i = 0; i < hearts; i += 1) {
    const hp = me.hp - i * 2;
    const frame = hp >= 2 ? 0 : hp === 1 ? 1 : 2;
    art.actors.draw(ctx, 'hud', 2 + i * 9, 4, { frame });
  }
  // Glints, keys (in the Bellhouse) and the Hearthbrew.
  let x = 60;
  art.actors.draw(ctx, 'hud', x, 4, { frame: 3 });
  text(ctx, art, String(c.purse), x + 9, 5, UI.cream);
  x += 30;
  if (screen(c.room).dungeon || c.keys > 0) {
    art.actors.draw(ctx, 'hud', x, 4, { frame: 4 });
    text(ctx, art, String(c.keys), x + 9, 5, UI.cream);
    x += 18;
  }
  if ((c.items & ItemBit.bossKey) !== 0) {
    art.actors.draw(ctx, 'hud', x, 4, { frame: 5 });
    x += 10;
  }
  if (me.brew) art.actors.draw(ctx, 'hud', x, 4, { frame: 6 });
  // B and A items.
  const b = (c.items & ItemBit.buckler) !== 0 || (c.items & ItemBit.hook) !== 0;
  if (b) {
    const hookSel = me.item === 1 && (c.items & ItemBit.hook) !== 0;
    const icon = hookSel || (c.items & ItemBit.buckler) === 0 ? 2 : 1;
    box(ctx, 152, 1);
    art.actors.draw(ctx, 'items', 152, 0, { frame: icon });
    art.actors.draw(ctx, 'hud', 145, 0, { frame: 8 });
  }
  if ((c.items & ItemBit.sword) !== 0) {
    box(ctx, 174, 1);
    art.actors.draw(ctx, 'items', 174, 0, { frame: 0 });
    art.actors.draw(ctx, 'hud', 167, 0, { frame: 7 });
  }
  // Allies on other screens: a pin each in the corner of the HUD row.
  let px = 120;
  for (let i = 0; i < c.roster.n; i += 1) {
    const r = c.roster.rows[i]!;
    if (r.slot === c.slot) continue;
    art.actors.draw(ctx, 'hud', px, 0, { frame: MARK[r.slot] ?? 10 });
    if (r.status === Status.Downed) art.actors.draw(ctx, 'fx8', px, 8, { frame: 7 });
    px += 8;
  }
  if (laggy) art.actors.draw(ctx, 'hud', 140, 8, { frame: 9 });
  if (notice) {
    panel(ctx, 16, 20, 160, 13);
    centred(ctx, art, notice, 23, UI.cream);
  }
};

const box = (ctx: CanvasRenderingContext2D, x: number, y: number): void => {
  ctx.strokeStyle = COLOR.cream;
  ctx.strokeRect(x - 0.5, y - 0.5, 16, 15);
};

/**
 * The map: the overworld's 5 × 4 screens, or the Bellhouse's rooms (all of them with the Map, else the
 * ones visited), your room blinking, allies as markers, the boss room and closed chests with the Compass.
 */
export const drawMap = (ctx: CanvasRenderingContext2D, art: Art, c: ClientWorld, visited: Uint8Array, tick: number): void => {
  const here = screen(c.room);
  const dungeon = here.dungeon;
  panel(ctx, 8, 20, 176, 132);
  centred(ctx, art, dungeon ? 'The Drowned Bellhouse' : 'Kettlebrook and around', 24, UI.yellow);
  const cols = dungeon ? 4 : 5;
  const cw = dungeon ? 30 : 30;
  const ch = dungeon ? 20 : 24;
  const x0 = 96 - (cols * cw) / 2;
  const y0 = 36;
  for (const d of content().screens) {
    if (!d || d.gx < 0 || d.dungeon !== dungeon) continue;
    const seen = !dungeon || visited[d.id] === 1 || (c.items & ItemBit.map) !== 0;
    if (!seen) continue;
    const x = x0 + d.gx * cw;
    const y = y0 + d.gy * ch;
    const cleared = dungeon && (c.cleared & (1 << (d.id - 32))) !== 0;
    ctx.fillStyle = visited[d.id] === 1 ? (cleared ? '#3a62b8' : '#2aa898') : '#646878';
    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
    if (d.id === c.room && (tick & 16) === 0) {
      ctx.fillStyle = '#ffd848';
      ctx.fillRect(x + cw / 2 - 3, y + ch / 2 - 3, 6, 6);
    }
    if (dungeon && (c.items & ItemBit.compass) !== 0) {
      if (d.boss >= 0) art.actors.draw(ctx, 'fx8', x + cw - 9, y + 1, { frame: 7 });
      for (const ch2 of d.chests) {
        const f = ch2.flag;
        if (f >= 0 && ((c.flags[f >> 3] as number) & (1 << (f & 7))) === 0) {
          art.actors.draw(ctx, 'fx8', x + 1, y + 1, { frame: 3 });
          break;
        }
      }
    }
  }
  for (let i = 0; i < c.roster.n; i += 1) {
    const r = c.roster.rows[i]!;
    if (r.slot === c.slot) continue;
    const d = screen(r.room);
    if (!d || d.gx < 0 || d.dungeon !== dungeon) continue;
    art.actors.draw(ctx, 'hud', x0 + d.gx * cw + 2 + r.slot * 6, y0 + d.gy * ch + ch - 9, { frame: MARK[r.slot] ?? 10 });
  }
  centred(ctx, art, SCREEN_NAME[here.key] ?? '', 140, UI.cream);
};

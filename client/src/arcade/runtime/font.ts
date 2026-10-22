/**
 * The Arcade's 5 × 7 bitmap font (docs/arcade/platform.md §10.5), drawn for this project.
 *
 * `bakeAtlas` (sprites.ts) bakes every glyph into every atlas, once per colour of `palettes[0]`
 * (the UI palette), so drawing text is one `drawImage` per visible character and
 * never allocates. Glyphs cover ASCII 32–126 with real lower case; anything else draws '?'.
 */
import type { Atlas } from './sprites';

export const GLYPH_W = 5,
  GLYPH_H = 7,
  ADVANCE = 6,
  LINE = 8;

/** The font's entry in every atlas: `rect(FONT_ID, charCode − 32, colourIndex)`. */
export const FONT_ID = '@font';

/** ASCII 32–126, 7 rows per glyph; each row is one base-32 digit whose bit 4 is the left column. */
const ROWS =
  '00000004444404aaa0000aavavaa4fke5u4op248j3cik8lid44800002488842842224804lel40044v4400000cc8000v' +
  '00000000cc11248ggehjlphe4c4444eeh1248veh161he26aiv22vgu11he68guhhev122444ehhehheehhf12c0cc0cc00cc0' +
  'cc8248g84200v0v008421248eh12404ehnlngeehhvhhhuhhuhhuehggghesihhhisvgguggvvggugggehgnhhfhhhvhhhe444' +
  '44e72222ichikokihggggggvhrllhhhhhpljhhehhhhheuhhugggehhhliduhhukihfgge11uv444444hhhhhhehhhhha4hhhl' +
  'llahha4ahhhha4444v1248gve88888egg84211e22222e4ah0000000000v840000000e1fhfgguhhhu00egghe11fhhhf00eh' +
  'vge698s88800fhf1egguhhhh40c444e20622icggikokic44444e00qllll00uhhhh00ehhhe00uhugg00fhf1100mpggg00fg' +
  'e1u88s889600hhhhf00hhha400hhlla00ha4ah00hhf1e00v248v34484434444444o44244o008l200';

let glyphs: Uint8Array[] | null = null;

/** The 95 glyphs as 5 × 7 index maps (1 = ink, 0 = clear), decoded once. */
export const fontGlyphs = (): readonly Uint8Array[] => {
  if (!glyphs) {
    glyphs = [];
    for (let g = 0; g < 95; g++) {
      const px = new Uint8Array(GLYPH_W * GLYPH_H);
      for (let y = 0; y < GLYPH_H; y++) {
        const bits = parseInt(ROWS[g * GLYPH_H + y], 32);
        for (let x = 0; x < GLYPH_W; x++) px[y * GLYPH_W + x] = (bits >> (4 - x)) & 1;
      }
      glyphs.push(px);
    }
  }
  return glyphs;
};

/** Width in px of the longest line: n characters are n × 6 − 1 px wide (no trailing gap). */
export function textWidth(text: string): number {
  let max = 0;
  let n = 0;
  for (const ch of text) {
    if (ch === '\n') n = 0;
    else if (++n > max) max = n;
  }
  return max ? max * ADVANCE - 1 : 0;
}

/**
 * Draws `text` with its top-left corner at (x, y); '\n' starts a new line 8 px lower.
 * `color` indexes `palettes[0]` of the atlas (every entry is usable; past its end nothing draws).
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  atlas: Atlas,
  text: string,
  x: number,
  y: number,
  color: number
): void {
  let cx = x;
  for (const ch of text) {
    if (ch === '\n') {
      cx = x;
      y += LINE;
      continue;
    }
    const code = ch.codePointAt(0) ?? 63;
    if (code !== 32) {
      const r = atlas.rect(FONT_ID, code > 32 && code < 127 ? code - 32 : 31, color);
      if (r) ctx.drawImage(atlas.image, r.x, r.y, r.w, r.h, cx, y, r.w, r.h);
    }
    cx += ADVANCE;
  }
}

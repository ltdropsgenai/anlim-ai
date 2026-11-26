// Text with emojis or symbols as a picture laid over the video (2026-11-25, Londi: emojis "appear as boxes", then
// "even recent emoji packs" and "at any size"). drawtext keeps drawing text its font fully covers (unchanged look);
// anything else goes through wordimg.py (Skia: the text font, then Noto Color Emoji, COLRv1 vector with the newest
// Unicode emojis, then Noto Sans Symbols 2) and comes back as an overlay segment for a filter chain. @anlim
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as glyphs from "./glyphs.js";

const exec = promisify(execFile);
const FONTS = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "assets", "fonts");
export const EMOJI_FONT = path.join(FONTS, "NotoColorEmoji.ttf");
export const SYMBOL_FONT = path.join(FONTS, "NotoSansSymbols2-Regular.ttf");
const WORDIMG = path.join(path.dirname(new URL(import.meta.url).pathname), "wordimg.py");

/** True when `font` lacks a character of `text` (drawtext would draw a box), so it should be a picture. */
export async function needsPicture(font, text) {
  return (await glyphs.missing(font, text)).length > 0;
}

/** Characters that neither `font`, the emoji font nor the symbol font can draw: these still show as boxes. */
export async function undrawable(font, text) {
  const out = [];
  for (const ch of await glyphs.missing(font, text)) {
    if ((await glyphs.missing(EMOJI_FONT, ch)).length && (await glyphs.missing(SYMBOL_FONT, ch)).length) out.push(ch);
  }
  return out;
}

/** Draws `text` to `png`. opts: size (px), font (text font file), color [r,g,b], alpha 0..1, shadow {dx,dy,alpha},
 *  maxWidth (px: a longer line is drawn smaller to fit), style ("fire": flame gradient, ember edge, glow; 2026-11-25). */
export async function render(png, text, opts) {
  const spec = png.replace(/\.png$/, ".json");
  await fs.writeFile(spec, JSON.stringify({
    text, size: opts.size, color: opts.color || [255, 241, 214], alpha: opts.alpha ?? 1,
    fonts: [opts.font, EMOJI_FONT, SYMBOL_FONT], shadow: opts.shadow || { dx: 2, dy: 3, alpha: 0.55 },
    ...(opts.maxWidth ? { max_width: Math.round(opts.maxWidth) } : {}),
    ...(opts.style ? { style: opts.style } : {}),
  }));
  await exec("python3", ["-I", WORDIMG, spec, png], { maxBuffer: 1 << 20, timeout: 60_000 });
  return png;
}

/** A filter-chain segment that lays `png` over the picture: `x`/`y` are overlay expressions (w, h = the picture's size,
 *  W, H = the frame's), shown from `t0` to `t1` (seconds) with fades of `fin`/`fout` seconds. `fps` sets its timeline.
 *  It joins a comma-separated chain: "…,<segment>,…" (its first filter takes the chain's frames, its overlay continues it). */
export function overlay(png, k, { x, y, t0 = 0, t1 = 1e6, fin = 0, fout = 0, fps }) {
  const fades = (fin > 0 ? `,fade=t=in:st=${t0.toFixed(3)}:d=${fin.toFixed(3)}:alpha=1` : "") +
                (fout > 0 ? `,fade=t=out:st=${Math.max(t0, t1 - fout).toFixed(3)}:d=${fout.toFixed(3)}:alpha=1` : "");
  const en = t1 < 1e5 ? `:enable='between(t,${t0.toFixed(3)},${t1.toFixed(3)})'` : "";
  return `null[tpa${k}];movie=${png},loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB,format=rgba${fades}[tpb${k}];` +
         `[tpa${k}][tpb${k}]overlay=shortest=1${en}:x='${x}':y='${y}'`;
}

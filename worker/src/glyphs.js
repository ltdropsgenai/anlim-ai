// 2026-11-24 (Londi, option 2): before text is drawn, check that the font has every character in it. drawtext draws a
// box for a character the font lacks and says nothing, so the cut gets a note instead of silent boxes.
// Reads the font's cmap table (formats 4 and 12, the two every TrueType/OpenType font carries), once per font file.
import fs from "node:fs/promises";

const cache = new Map();

function parseCmap(buf) {
  const u16 = (o) => buf.readUInt16BE(o), u32 = (o) => buf.readUInt32BE(o);
  const tables = u16(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString("latin1", rec, rec + 4) === "cmap") { cmap = u32(rec + 8); break; }
  }
  if (cmap < 0) throw new Error("the font has no cmap table");
  const subs = [];
  for (let i = 0, n = u16(cmap + 2); i < n; i++) {
    const rec = cmap + 4 + i * 8, pid = u16(rec), eid = u16(rec + 2), off = cmap + u32(rec + 4);
    if (pid === 0 || (pid === 3 && (eid === 1 || eid === 10))) subs.push({ off, format: u16(off) });
  }
  // the 32-bit table (format 12) covers everything the 16-bit one does and more, so prefer it
  const sub = subs.find((s) => s.format === 12) || subs.find((s) => s.format === 4);
  if (!sub) throw new Error("the font has no Unicode cmap");
  const ranges = [];
  if (sub.format === 12) {
    for (let i = 0, n = u32(sub.off + 12); i < n; i++) {
      const g = sub.off + 16 + i * 12;
      ranges.push([u32(g), u32(g + 4)]);
    }
  } else {
    const segX2 = u16(sub.off + 6), ends = sub.off + 14, starts = ends + segX2 + 2;
    const deltas = starts + segX2, rangeOffs = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = u16(ends + i * 2), start = u16(starts + i * 2);
      if (start === 0xffff) continue;
      const delta = buf.readInt16BE(deltas + i * 2), ro = u16(rangeOffs + i * 2);
      if (ro === 0) { ranges.push([start, end]); continue; }
      // glyph ids come from the glyph array: a code mapped to glyph 0 is missing
      let runStart = -1;
      for (let c = start; c <= end; c++) {
        const at = rangeOffs + i * 2 + ro + (c - start) * 2;
        const g = at + 1 < buf.length ? u16(at) : 0;
        const ok = g !== 0 && ((g + delta) & 0xffff) !== 0;
        if (ok && runStart < 0) runStart = c;
        if (!ok && runStart >= 0) { ranges.push([runStart, c - 1]); runStart = -1; }
      }
      if (runStart >= 0) ranges.push([runStart, end]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

async function rangesOf(font) {
  if (!cache.has(font)) cache.set(font, fs.readFile(font).then(parseCmap));
  return cache.get(font);
}

const has = (ranges, c) => {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [a, b] = ranges[mid];
    if (c < a) hi = mid - 1; else if (c > b) lo = mid + 1; else return true;
  }
  return false;
};

// characters drawtext never draws as a glyph: spaces, line breaks, joiners, direction marks, variation selectors
const IGNORED = /[\s​-‏‪-‮⁠-⁤︀-️﻿]/u;

/** The distinct characters of `text` that `font` cannot draw, in order of first use. [] when all are there, and []
 *  when the font cannot be read (the check must never stop a cut). */
export async function missing(font, text) {
  let ranges;
  try { ranges = await rangesOf(font); } catch { return []; }
  const out = [];
  for (const ch of String(text || "")) {
    if (IGNORED.test(ch) || out.includes(ch)) continue;
    if (!has(ranges, ch.codePointAt(0))) out.push(ch);
  }
  return out;
}

/** "字, 好 and 3 more": the first few missing characters, for a note. */
export const list = (chars, max = 5) =>
  chars.slice(0, max).join(", ") + (chars.length > max ? ` and ${chars.length - max} more` : "");

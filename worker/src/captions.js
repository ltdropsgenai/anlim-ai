// Captions for a cut (2026-11-23, Londi: "all of the above"). @anlim
// The words of every voiceover and the narration in the cut, timed to the speech and drawn over the picture; also a
// .srt file to upload to YouTube or TikTok. Timing comes from ElevenLabs forced alignment (POST /v1/forced-alignment:
// the audio file and its text in, each word's start and end out; elevenlabs.io/docs/api-reference/forced-alignment,
// read 2026-11-23), on the creator's own ElevenLabs account like the rest of the audio. Each take is aligned once and
// the words are kept on its audio_jobs row (meta.words). Audio tags such as [whispers] are not spoken and are left out.
import fs from "node:fs/promises";
import path from "node:path";
import * as db from "./db.js";

const XI = "https://api.elevenlabs.io";
export const spokenText = (t) => String(t || "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();

/** Words of one voiceover take: [{text, start, end}] in the take's own seconds, or null with the reason in notes. */
// cachedOnly (2026-11-27, the edit style's word_sync): only the words already kept on the take; never asks ElevenLabs.
export async function takeWords(owner, outputPath, localFile, notes, { cachedOnly = false } = {}) {
  const [row] = await db.q("select id, input, meta from studio.audio_jobs where owner = $1 and output_path = $2 limit 1", [owner, outputPath]);
  if (!row) return null;
  if (Array.isArray(row.meta?.words)) return row.meta.words;
  if (cachedOnly) return null;
  const text = spokenText(row.input?.text);
  if (!text) return null;
  const [k] = await db.q("select studio.connection_key($1, 'elevenlabs') as k", [owner]);
  if (!k?.k) { notes.push("Captions need your ElevenLabs account connected (Account > Connections)."); return null; }
  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(localFile)], { type: "audio/mpeg" }), path.basename(localFile));
  form.append("text", text);
  const r = await fetch(`${XI}/v1/forced-alignment`, { method: "POST", headers: { "xi-api-key": k.k }, body: form });
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  if (!r.ok || !Array.isArray(body?.words)) {
    notes.push(`Captions: ElevenLabs could not time the words of one voiceover (${r.status}${body?.detail?.message ? `: ${body.detail.message}` : ""}); it has no captions.`);
    return null;
  }
  const words = body.words.map((w) => ({ text: String(w.text || "").trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && isFinite(w.start) && isFinite(w.end));
  await db.q("update studio.audio_jobs set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('words', $2::jsonb), updated_at = now() where id = $1",
             [row.id, JSON.stringify(words)]);
  return words;
}

/** Lines of at most 6 words / 34 characters, broken at sentence ends and pauses; times in the cut's seconds. */
export function cues(words, total) {
  const all = words.filter((w) => w.start < total).sort((a, b) => a.start - b.start);
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" ") }); cur = []; };
  for (const w of all) {
    const prev = cur[cur.length - 1];
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (cur.length >= 6 || len > 34 || w.start - prev.end > 0.7 || /[.!?…]$/.test(prev.text))) flush();
    cur.push(w);
  }
  flush();
  for (let i = 0; i < out.length; i++) {           // stay up a moment after the last word, never over the next line
    const next = out[i + 1]?.start ?? total;
    out[i].end = Math.min(next, total, Math.max(out[i].end + 0.25, out[i].start + 0.9));
  }
  return out.filter((c) => c.end - c.start > 0.05);
}

const stamp = (s) => {
  const ms = Math.max(0, Math.round(s * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, x = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
export const srt = (list) => list.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join("\n");

/** drawtext filters for the lines, bottom centre, white with a dark outline. Text goes through files, expansion off.
 *  look "story" (2026-11-23, the edit style): the reference edit's captions, a serif with small capitals (font: Cinzel),
 *  4.8% of the short side (smaller for long lines), a soft shadow instead of an outline, at 74% of the height. */
export async function filters(list, dir, font, W, H, look = "plain") {
  const story = look === "story", m = Math.min(W, H);
  const y = Math.round(H * (story ? (H > W ? 0.74 : 0.84) : (H > W ? 0.78 : 0.86)));
  const out = [];
  for (const [i, c] of list.entries()) {
    const file = path.join(dir, `cc_${i}.txt`);
    await fs.writeFile(file, c.text);
    if (story) {
      // the font file holds the regular weight; a thin white border gives the reference's heavier strokes
      const size = Math.round(Math.min(m * 0.048, (W * 0.9) / (c.text.length * 0.62)));
      out.push(`drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=white:borderw=${Math.max(1, Math.round(size / 36))}:bordercolor=white` +
               `:shadowcolor=black@0.7:shadowx=0:shadowy=${Math.max(1, Math.round(size / 14))}:x=(w-tw)/2:y=${y}-th/2` +
               `:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'`);
      continue;
    }
    const size = Math.round(m * 0.052);
    out.push(`drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=white:borderw=${Math.max(2, Math.round(size / 14))}` +
             `:bordercolor=black@0.85:x=(w-tw)/2:y=${y}-th/2:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'`);
  }
  return out;
}

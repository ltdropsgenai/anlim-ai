// ElevenLabs audio for scene cuts (2026-11-19): voiceover (text to speech, eleven_v3, audio tags like [whispers] work),
// sound effects and a generated score. It runs on the creator's own ElevenLabs account: their key is read from Supabase
// Vault (studio.connection_key) for each job and never logged. anlim charges no credits for it. @anlim
// API (checked 2026-11-19, elevenlabs.io/docs/api-reference): POST /v1/text-to-speech/{voice_id}, POST /v1/sound-generation
// (duration 0.5-30 s), POST /v1/music (music_v2_5 since 2026-11-22: a prompt and music_length_ms 3000-600000 with
// force_instrumental, or a composition plan of sections); output_format mp3_44100_128,
// which every plan may use.
// AUDIO_MOCK=1 (tests only): make tones with ffmpeg instead of calling ElevenLabs.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import * as db from "./db.js";
import * as storage from "./storage.js";

const exec = promisify(execFile);
const XI = "https://api.elevenlabs.io", FMT = "mp3_44100_128";
const MOCK = process.env.AUDIO_MOCK === "1";
const log = (j, msg) => console.log(`${new Date().toISOString()} [audio ${String(j.id).slice(0, 8)} ${j.kind}] ${msg}`);

class XiError extends Error { constructor(status, detail) { super(`ElevenLabs ${status}${detail ? `: ${detail}` : ""}`); this.status = status; this.detail = detail || ""; } }

async function xiPost(key, url, body) {
  const r = await fetch(`${XI}${url}?output_format=${FMT}`, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" }, body: JSON.stringify(body),
  });
  if (!r.ok) {
    let d = "";
    try { const j = await r.json(); d = j?.detail?.message || j?.detail?.status || (typeof j?.detail === "string" ? j.detail : JSON.stringify(j)); } catch { /* no body */ }
    throw new XiError(r.status, String(d).slice(0, 300));
  }
  return { buf: Buffer.from(await r.arrayBuffer()),
           meta: { request_id: r.headers.get("request-id"), character_cost: r.headers.get("character-cost"), song_id: r.headers.get("song-id") } };
}

async function mock(j, dest) {
  const i = j.input;
  const secs = j.kind === "voiceover" ? Math.min(30, Math.max(1, i.text.split(/\s+/).length / 2.6))
    : j.kind === "sfx" ? Number(i.duration_s || 2) : Number(i.length_s || 30);
  const src = j.kind === "voiceover" ? `sine=f=440:d=${secs}` : j.kind === "sfx" ? `anoisesrc=c=pink:d=${secs}:a=0.4`
    : `sine=f=220:d=${secs}`;
  await exec("ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", src, "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", dest]);
  return { mock: true };
}

// The score (2026-11-22, the composer): ElevenLabs music_v2_5. A score shaped to the shots is a composition plan with one
// chunk per section (docs: elevenlabs.io/docs/eleven-api/guides/how-to/music/composition-plans): the section name in
// brackets as its text, its length, the whole score's styles plus its own as positive styles (the first chunk sets the
// genre, so it carries all of them), and what to avoid. Instrumental: singing and lyrics are in every chunk's negative
// styles (force_instrumental only works with a prompt). Otherwise a prompt and a length, as before, on music_v2_5.
const STYLE_SPLIT = /[,;\n]+/;
const styleList = (t) => String(t || "").split(STYLE_SPLIT).map((x) => x.trim()).filter(Boolean).slice(0, 25);
export function musicBody(i) {
  const model = i.model || "music_v2_5";
  if (Array.isArray(i.sections) && i.sections.length) {
    const base = styleList(i.styles || i.text);
    const noVocals = i.instrumental !== false ? ["vocals", "singing", "lyrics", "voice", "choir"] : [];
    const chunks = i.sections.map((sec) => ({
      text: `[${String(sec.label || "Section").replace(/[\[\]]/g, "").slice(0, 60)}]`,
      duration_ms: Math.round(Number(sec.seconds) * 1000),
      positive_styles: [...base, ...styleList(sec.styles)].slice(0, 50),
      negative_styles: [...noVocals, ...styleList(sec.avoid)].slice(0, 50),
    }));
    return { model_id: model, composition_plan: { chunks } };
  }
  return { model_id: model, prompt: i.text, music_length_ms: Math.round(Number(i.length_s) * 1000), force_instrumental: i.instrumental !== false };
}

async function make(j, key, dest) {
  if (MOCK) return mock(j, dest);
  const i = j.input;
  let r;
  if (j.kind === "voiceover") r = await xiPost(key, `/v1/text-to-speech/${encodeURIComponent(i.voice_id)}`, { text: i.text, model_id: i.model || "eleven_v3" });
  else if (j.kind === "sfx") r = await xiPost(key, "/v1/sound-generation", { text: i.text, ...(i.duration_s ? { duration_seconds: Number(i.duration_s) } : {}) });
  else r = await xiPost(key, "/v1/music", musicBody(i));
  await fs.writeFile(dest, r.buf);
  return r.meta;
}

async function duration(p) {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-format_whitelist", "mp3,wav,mov,aac,flac,ogg", "-protocol_whitelist", "file,pipe",
    "-show_entries", "format=duration", "-of", "csv=p=0", p]);
  return Number(stdout.trim()) || 0;
}

// What the creator reads when it fails: plain words, and whether trying again can help.
function explain(e) {
  if (!(e instanceof XiError)) return { msg: `Could not reach ElevenLabs (${e.message}).`, retry: true };
  const d = e.detail.toLowerCase();
  if (d.includes("quota") || d.includes("credits") || e.status === 402) return { msg: "Your ElevenLabs plan has run out of credits for this. Top up in ElevenLabs, then try again.", retry: false };
  if (e.status === 401 || e.status === 403) {
    if (d.includes("permission") || d.includes("missing")) return { msg: `Your ElevenLabs key is not allowed to do this (${e.detail}). Give the key this permission in ElevenLabs, or connect a key that has it.`, retry: false };
    return { msg: "ElevenLabs refused your key. Reconnect your account in Account > Connections.", retry: false, invalid: true };
  }
  if (e.status === 429 || e.status >= 500) return { msg: `ElevenLabs was busy (${e.status}).`, retry: true };
  return { msg: `ElevenLabs could not make this: ${e.detail || e.status}`, retry: false };
}

async function handle(j) {
  const dir = path.join(config.workDir, "audio");
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${j.id}.mp3`);
  try {
    const [k] = await db.q("select studio.connection_key($1, 'elevenlabs') as k", [j.owner]);
    if (!k?.k && !MOCK) throw Object.assign(new Error("not connected"), { final: "Your ElevenLabs account is not connected any more. Connect it in Account > Connections." });
    const meta = await make(j, k?.k, dest);
    const secs = await duration(dest);
    if (!secs) throw new Error("ElevenLabs sent an empty file");
    const out = `${j.owner}/audio/${j.kind}/${j.id}.mp3`;
    await storage.upload(dest, out, "audio/mpeg");
    // the newest finished piece is the one the cut uses, for its shot and kind (for the scene, for a score)
    await db.q(`update studio.audio_jobs set in_cut = false, updated_at = now()
                 where scene_id = $1 and kind = $2 and shot_id is not distinct from $3 and in_cut`, [j.scene_id, j.kind, j.shot_id]);
    await db.q(`update studio.audio_jobs set status = 'done', in_cut = true, output_path = $2, duration_s = $3, meta = $4, error = null,
                       locked_by = null, locked_until = null, updated_at = now() where id = $1`, [j.id, out, secs.toFixed(3), JSON.stringify(meta || {})]);
    log(j, `done, ${secs.toFixed(2)} s${MOCK ? " (mock)" : ""}`);
  } catch (e) {
    const x = e.final ? { msg: e.final, retry: false } : explain(e);
    if (x.invalid) await db.q("update studio.connections set status = 'invalid', updated_at = now() where owner = $1 and provider = 'elevenlabs'", [j.owner]);
    const tries = (j.tries || 0) + 1, give = !x.retry || tries >= 3;
    await db.q(`update studio.audio_jobs set tries = $2, error = $3, status = $4, locked_by = null, locked_until = null,
                       next_try_at = now() + make_interval(secs => $5), updated_at = now() where id = $1`,
               [j.id, tries, x.msg.slice(0, 1000), give ? "failed" : "queued", 20 * tries]);
    log(j, `${give ? "failed" : "will retry"}: ${e instanceof XiError ? `${e.status} ${e.detail}` : e.message}`);
  } finally {
    await fs.rm(dest, { force: true }).catch(() => null);
  }
}

export async function tick() {
  const jobs = await db.q("select * from studio.claim_audio_jobs($1, 2, 600)", [config.workerId]);
  await Promise.all(jobs.map(handle));
  return jobs.length;
}
export { handle };

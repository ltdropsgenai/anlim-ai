// ElevenLabs audio for scene cuts (2026-11-19): voiceover (text to speech, eleven_v3, audio tags like [whispers] work),
// sound effects and a generated score. It runs on the creator's own ElevenLabs account: their key is read from Supabase
// Vault (studio.connection_key) for each job and never logged. anlim charges no credits for it. @anlim
// API (checked 2026-11-19, elevenlabs.io/docs/api-reference): POST /v1/text-to-speech/{voice_id}, POST /v1/sound-generation
// (duration 0.5-30 s), POST /v1/music (music_v2_5 since 2026-11-22: a prompt and music_length_ms 3000-600000 with
// force_instrumental, or a composition plan of sections); output_format mp3_44100_128,
// which every plan may use.
// 2026-11-26: songs. With lyrics the score is sung (composition plan from the [Section] tags); provider 'anlim' makes it on
// anlim's fal account (MiniMax Music 3) for anlim credits instead of the creator's ElevenLabs. Lyrics drafts: draft().
// AUDIO_MOCK=1 (tests only): make tones with ffmpeg instead of calling ElevenLabs.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import * as db from "./db.js";
import * as storage from "./storage.js";
import * as moderate from "./moderate.js";
import * as fal from "./providers/fal.js";

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
// A song (2026-11-26): the lyrics carry [Section] tags (written by the creator or by the lyrics writer). Each tagged
// block is one chunk of the composition plan, its lines in the chunk's text as the docs ask (section name in brackets,
// lyric lines on their own lines); its length shares the song's length by the number of lines (a tag with no lines,
// such as [Instrumental break], counts as two). Chunks are 3 to 120 s and at most 30; lyrics with no tags are one
// [Verse]. Styles go in positive_styles (English); the lyrics may be in any language.
export function lyricChunks(lyrics, lengthS) {
  const blocks = [];
  for (const raw of String(lyrics || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const tag = line.match(/^\[([^\]]{1,60})\]$/);
    if (tag) blocks.push({ label: tag[1].trim(), lines: [] });
    else { if (!blocks.length) blocks.push({ label: "Verse", lines: [] }); blocks[blocks.length - 1].lines.push(line.slice(0, 300)); }
  }
  let bs = blocks.slice(0, 30);
  if (!bs.length) bs = [{ label: "Verse", lines: [] }];
  const total = Math.max(3 * bs.length, Math.min(600, Number(lengthS) || 60));
  const w = bs.map((b) => Math.max(2, b.lines.length)), W = w.reduce((a, b) => a + b, 0);
  let secs = w.map((x) => Math.min(120, Math.max(3, (total * x) / W)));
  const scale = total / secs.reduce((a, b) => a + b, 0);          // put back what the 3/120 s limits moved
  secs = secs.map((x) => Math.min(120, Math.max(3, x * scale)));
  return bs.map((b, k) => ({ label: b.label, lines: b.lines, seconds: Math.round(secs[k] * 10) / 10 }));
}

export function musicBody(i) {
  const model = i.model || "music_v2_5";
  if (i.lyrics) {
    const base = styleList(i.styles || i.text);
    return { model_id: model, composition_plan: { chunks: lyricChunks(i.lyrics, i.length_s).map((c, k) => ({
      text: [`[${c.label.replace(/[\[\]]/g, "")}]`, ...c.lines].join("\n"),
      duration_ms: Math.round(c.seconds * 1000),
      positive_styles: (k === 0 ? base : [...base.slice(0, 8), c.label.toLowerCase()]).slice(0, 50),
      negative_styles: [],
    })) } };
  }
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

// A song on anlim's account (2026-11-26): fal queue, MiniMax Music 3 (fal.ai/models/minimax/music-3, read 2026-11-26:
// prompt, lyrics with structure tags each on their own line, duration 1-300 s as an upper bound; 44.1 kHz WAV out).
// Paid in anlim credits: reserved by request_audio, charged here when delivered, released if it fails for good.
async function makeFal(j, dest) {
  const [m] = await db.q("select endpoint from studio.models where id = $1 and kind = 'music'", [j.model_id]);
  if (!m) throw Object.assign(new Error("unknown music model"), { final: "This music model is not available any more. Nothing was charged." });
  const i = j.input;
  const sub = await fal.submit(m.endpoint, { prompt: String(i.styles || i.text).slice(0, 2000), lyrics: i.lyrics,
                                             duration: Math.round(Number(i.length_s) || 60) });
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await fal.pollAudio({ provider_status_url: sub.statusUrl, provider_response_url: sub.responseUrl });
    if (st.state === "done") {
      const raw = `${dest}.src`;
      const r = await fetch(st.audioUrl); if (!r.ok) throw new Error(`song download ${r.status}`);
      await fs.writeFile(raw, Buffer.from(await r.arrayBuffer()));
      await exec("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", raw, "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", dest]);
      await fs.rm(raw, { force: true });
      return { provider: "fal", endpoint: m.endpoint, request_id: sub.requestId };
    }
    if (st.state === "failed") throw Object.assign(new Error(st.error), { fal: true, permanent: /4\d\d|safety|content/i.test(st.error) });
    if (Date.now() - t0 > 9 * 60_000) throw Object.assign(new Error("the song took too long"), { fal: true });
  }
}

async function make(j, key, dest) {
  if (MOCK) return mock(j, dest);
  if (j.provider === "anlim") return makeFal(j, dest);
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
  if (!(e instanceof XiError)) return { msg: /^content check/.test(e.message) ? "The content check could not run; trying again." : `Could not reach ElevenLabs (${e.message}).`, retry: true };
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
    const anlim = j.provider === "anlim";                     // 2026-11-26: a song on anlim's account, paid in credits
    const [k] = anlim ? [null] : await db.q("select studio.connection_key($1, 'elevenlabs') as k", [j.owner]);
    if (!anlim && !k?.k && !MOCK) throw Object.assign(new Error("not connected"), { final: "Your ElevenLabs account is not connected any more. Connect it in Account > Connections." });
    // content check (2026-11-23): the script, the sound or the score's styles, before ElevenLabs is asked
    const inp = j.input || {};
    const words = [inp.text && `${j.kind === "voiceover" ? "Spoken words" : "Sound"}: ${inp.text}`, inp.styles && `Styles: ${[].concat(inp.styles).join(", ")}`,
      ...(inp.sections || []).map((x) => `Section ${x.label || ""}: ${x.styles || ""}`),
      inp.lyrics && `Song lyrics (to be sung):\n${inp.lyrics}`].filter(Boolean).join("\n");
    if (words) await moderate.guard({ kind: inp.lyrics ? "song" : "audio", ref: j.id, owner: j.owner, text: words });
    const meta = (await make(j, k?.k, dest)) || {};
    const secs = await duration(dest);
    if (!secs) throw new Error("ElevenLabs sent an empty file");
    // 2026-11-26: a song keeps its sections (label, lines, start and length in the song), for shots_from_song. ElevenLabs
    // sings the composition plan as asked; MiniMax gets the tags but chooses its own timing, so those are estimates.
    if (inp.lyrics) {
      const cs = lyricChunks(inp.lyrics, inp.length_s), k = secs / cs.reduce((t, c) => t + c.seconds, 0);
      let at = 0;
      meta.sections = cs.map((c) => { const x = { label: c.label, lines: c.lines, start_s: +at.toFixed(2), seconds: +(c.seconds * k).toFixed(2) }; at += c.seconds * k; return x; });
      meta.timing = anlim ? "estimated" : "planned";
    }
    const out = `${j.owner}/audio/${j.kind}/${j.id}.mp3`;
    await storage.upload(dest, out, "audio/mpeg");
    // the newest finished piece is the one the cut uses, for its shot and kind (for the scene, for a score). One
    // transaction, locked per scene/kind/shot: two takes finishing at once used to both end up in the cut (review 2026-11-23).
    const c = await db.pool.connect();
    try {
      await c.query("begin");
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [`audio:${j.scene_id}:${j.kind}:${j.shot_id ?? "scene"}`]);
      await c.query(`update studio.audio_jobs set in_cut = false, updated_at = now()
                      where scene_id = $1 and kind = $2 and shot_id is not distinct from $3 and in_cut`, [j.scene_id, j.kind, j.shot_id]);
      await c.query(`update studio.audio_jobs set status = 'done', in_cut = true, output_path = $2, duration_s = $3, meta = $4, error = null,
                            locked_by = null, locked_until = null, updated_at = now() where id = $1`, [j.id, out, secs.toFixed(3), JSON.stringify(meta || {})]);
      await c.query("commit");
    } catch (err) { await c.query("rollback").catch(() => null); throw err; }
    finally { c.release(); }
    if (j.credits_reserved > 0) await db.q("select studio.settle_audio_job($1, 'charge')", [j.id]);
    log(j, `done, ${secs.toFixed(2)} s${MOCK ? " (mock)" : ""}${j.credits_reserved > 0 ? `, ${j.credits_reserved} credits` : ""}`);
  } catch (e) {
    const x = e.final ? { msg: e.final, retry: false } : e.blocked ? { msg: e.message.replace(" Nothing was charged.", ""), retry: false }
      : e.fal ? { msg: e.permanent ? `The music model could not make this song: ${e.message.slice(0, 200)}` : `The music model was busy (${e.message.slice(0, 120)}).`, retry: !e.permanent }
      : explain(e);
    if (x.invalid) await db.q("update studio.connections set status = 'invalid', updated_at = now() where owner = $1 and provider = 'elevenlabs'", [j.owner]);
    const tries = (j.tries || 0) + 1, give = !x.retry || tries >= 3;
    if (!e.blocked && !e.final) await db.logError(`audio ${j.kind}`, j.id, j.owner, e instanceof XiError ? `${e.status} ${e.detail}` : e, { tries });
    await db.q(`update studio.audio_jobs set tries = $2, error = $3, status = $4, locked_by = null, locked_until = null,
                       next_try_at = now() + make_interval(secs => $5), updated_at = now() where id = $1`,
               [j.id, tries, (x.msg + (give && j.credits_reserved > 0 ? " Nothing was charged." : "")).slice(0, 1000), give ? "failed" : "queued", 20 * tries]);
    if (give && j.credits_reserved > 0) await db.q("select studio.settle_audio_job($1, 'release')", [j.id]).catch((er) => log(j, `release failed: ${er.message}`));
    log(j, `${give ? "failed" : "will retry"}: ${e instanceof XiError ? `${e.status} ${e.detail}` : e.message}`);
  } finally {
    await fs.rm(dest, { force: true }).catch(() => null);
  }
}

// Lyrics drafts (2026-11-26): the creator's description -> original lyrics with [Section] tags (checker /lyrics, Claude).
// The description is checked first (moderate.guard); the lyrics come back checked by the same prompt's rules (no lyrics
// from existing songs, no real singer's name). Free to the creator; studio.request_lyrics limits them to 30 a day.
async function draft(d) {
  try {
    await moderate.guard({ kind: "song", ref: d.id, owner: d.owner, text: `Song description: ${d.brief}${d.styles ? `\nStyle: ${d.styles}` : ""}` });
    const r = await fetch(`${config.checkerUrl}/lyrics`, {
      method: "POST", headers: { Authorization: `Bearer ${config.checkerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ brief: d.brief, language: d.language, styles: d.styles, length_s: d.length_s ? Number(d.length_s) : null }),
    });
    const res = await r.json().catch(() => ({ verdict: "ERROR", error: `checker HTTP ${r.status}` }));
    if (!r.ok || res.verdict === "ERROR" || !res.lyrics) throw new Error(`lyrics: ${res.error || r.status}`);
    await db.q(`update studio.lyrics_drafts set status = 'done', lyrics = $2, title = $3, error = null, locked_until = null, updated_at = now()
                 where id = $1`, [d.id, String(res.lyrics).slice(0, 3500), res.title ? String(res.title).slice(0, 120) : null]);
  } catch (e) {
    const tries = (d.tries || 0) + 1, give = e.blocked || tries >= 3;
    await db.q(`update studio.lyrics_drafts set tries = $2, status = $3, error = $4, locked_until = case when $3 = 'queued' then now() + interval '20 seconds' end,
                       updated_at = now() where id = $1`,
               [d.id, tries, give ? "failed" : "queued", (e.blocked ? e.message.replace(" Nothing was charged.", "") : give ? "The lyrics could not be written; try again." : e.message).slice(0, 500)]);
    console.error(`lyrics ${String(d.id).slice(0, 8)}: ${e.message}`);
  }
}

export async function tick() {
  const [jobs, drafts] = await Promise.all([db.q("select * from studio.claim_audio_jobs($1, 2, 600)", [config.workerId]),
    db.q("select * from studio.claim_lyrics(2, 180)").catch(() => [])]);   // before the migration: no drafts, no harm
  await Promise.all([...jobs.map(handle), ...drafts.map(draft)]);
  return jobs.length + drafts.length;
}
export { handle };

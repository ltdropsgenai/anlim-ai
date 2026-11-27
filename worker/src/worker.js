// Generation worker. @anlim
// Loop: lease due generations -> run the step for their status -> drop the lease. Steps:
//   queued   : compile the request, submit to the provider             -> running
//   running  : poll; when done, download, strip audio, store the clip  -> checking
//   checking : run the checker service, record the QC run, settle credits:
//                PASS          -> charge, status succeeded, shot "review" (the creator still approves the take)
//                FLAG / NOT_REVIEWED -> status review (credits stay reserved until the creator decides)
//                FAIL          -> release (credits back to the creator); no automatic retry: the creator decides
//                                 whether to render again (2026-11-16, Londi: "No free retry"; it cost the app a
//                                 second render on every failure)
// Provider failure or timeout -> release, status failed. Every step is retried MAX_STEP_TRIES times on errors.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { postChecker } from "./checker_post.js";
import * as db from "./db.js";
import * as storage from "./storage.js";
import * as compile from "./compile.js";
import * as fal from "./providers/fal.js";
import * as ad from "./ad.js";
import * as mock from "./providers/mock.js";
import * as higgsfield from "./providers/higgsfield.js";
import * as frames from "./frames.js";
import { watermark, VAULT } from "./watermark.js";
import * as assemble from "./assemble.js";
import * as translate from "./translate.js";
import * as audio from "./audio.js";
import * as moderate from "./moderate.js";
import * as exporter from "./export.js";
import { maybeThumbs } from "./thumbs.js";

const run = promisify(execFile);
const providers = { fal, mock, higgsfield };
const log = (g, msg) => console.log(`${new Date().toISOString()} [${String(g.id).slice(0, 8)}] ${msg}`);
const later = (ms) => new Date(Date.now() + ms);

async function fetchTo(url, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (url.startsWith("file://")) return fs.copyFile(url.slice(7), dest);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

// Frame rate of a clip (ffprobe r_frame_rate "30/1"); 24 if it cannot be read. The checker compares the clip with the
// spec's rate, so the spec carries the model's real rate rather than flagging Wan 2.7 (30 fps) for not being 24.
async function clipFps(file) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
                                             "-of", "csv=p=0", file]);
    const [n, d] = stdout.trim().split("/").map(Number);
    const f = d ? n / d : n;
    return Number.isFinite(f) && f > 0 ? Math.round(f * 1000) / 1000 : 24;
  } catch { return 24; }
}

async function fail(g, error, { release = true } = {}) {
  if (release) await db.settle(g.id, "release");
  await db.unlock(g.id, { status: "failed", error: String(error).slice(0, 1000), finished_at: new Date() });
  if (!isLipsync(g)) await db.setShot(g.shot_id, "ready");   // a lip sync leaves the shot and its kept clip as they were
  log(g, `failed: ${error}`);
}

// Free check before paying for a render: an end frame made by editing the start still must change only the
// characters. 2026-11-12, Phase 0 S3: three end-frame edits squeezed the shelf toys sideways and the video slid the
// toys across the shelf (Londi's catch). END_FRAME_GATE: block (default) fails the job and returns the credits;
// warn only logs; off skips. Returns null when the frame may be used, else the reason.
// 2026-11-19: a project with no characters on file (made from the home prompt) cannot tell a character from the room,
// so every moving character looks like "something else changed". The creator approved the end frame with the
// checker's boxes in view; for such projects the gate only logs.
const APPEARS = /\b(appears?|appearing|reappears?|re-?forms?|re-?forming|materiali[sz]es?|materiali[sz]ing|gathers? (?:together )?into|gathering (?:from [a-z ]+)?into|walks? in(?:to (?:the )?(?:frame|shot))?|enters?|steps? into (?:the )?(?:frame|shot)|comes? into view|fades? in)\b/i;
const LIGHT_CHANGES = /\b(halos?|auras?|glows?|glowing|radiant|radiance|beams? of (?:sun)?light|(?:sun|light) ?rays?|rays? of (?:sun)?light|bursts? of light|light (?:forms|floods|fills|spreads|grows|blazes))\b/i;
async function endFrameGate(g, shot, characters = []) {
  if (!shot.end_frame_path || config.endFrameGate === "off") return null;
  // 2026-11-25 (Number 10 swings): an end frame the creator uploaded (set_end_image) may be a new camera angle, which
  // changes the whole frame by design; this check is for end frames made by editing the start still
  if (shot.end_frame_upload_path && shot.end_frame_upload_path === shot.end_frame_path) {
    log(g, "end frame: uploaded by the creator, not checked against the start image"); return null;
  }
  const dir = path.join(config.workDir, g.id, "end_frame");
  const start = path.join(dir, "start" + path.extname(shot.start_frame_path));
  const end = path.join(dir, "end" + path.extname(shot.end_frame_path));
  await storage.download(shot.start_frame_path, start);
  await storage.download(shot.end_frame_path, end);
  // 2026-11-26: no 300 s fetch timeout here either (the same matting as /compose; checker_post.js)
  const r = await postChecker("/end_frame", { start, end, out: dir, fake_verdict: process.env.FAKE_END_FRAME || undefined });
  const res = r.json || { verdict: "ERROR", error: `checker HTTP ${r.status}` };
  if (!r.ok || res.verdict === "ERROR") throw new Error(`end-frame check: ${res.error || r.status}`);
  if (res.verdict === "PASS") { log(g, "end frame: only the characters change"); return null; }
  const where = (res.drift || []).slice(0, 3).map((d) => `[${d.box.map((v) => Number(v).toFixed(2)).join(",")}]`).join(" ");
  const detail = `end frame drift at ${where}; check image ${path.join(dir, "end_frame_check.png")}`;
  if (config.endFrameGate === "warn") { log(g, `WARNING ${detail}`); return null; }
  if (!characters.length) { log(g, `WARNING (no characters on file; the creator approved this end frame) ${detail}`); return null; }
  // 2026-11-22 (Londi's promo, shot 9f541888): a character who appears during the shot (re-forms from particles, walks in,
  // materialises) is not in the start frame, so their shadow and reflection in the end frame read as "the room changed"
  // (21% of the frame on the wet beach) and the gate blocked a correct end frame. When the shot's words say someone
  // appears, the creator's approval of the end frame stands and the gate only logs.
  if (APPEARS.test(shot.action || "")) { log(g, `WARNING (a character appears during the shot; shadows and reflections are new) ${detail}`); return null; }
  // 2026-11-22 (promo shot 3, 74060ec4): light that the shot's words ask for (a halo forms, beams of sunlight hit him)
  // relights the whole frame, which reads as "the room changed". The creator approved the end frame; the gate only logs.
  if (LIGHT_CHANGES.test(shot.action || "")) { log(g, `WARNING (the shot's words change the light: halo, glow, beams) ${detail}`); return null; }
  log(g, `blocked: ${detail}`);
  return "The end frame changes more than the characters: something in the room or a prop moved. Nothing was charged. " +
         "Make the end frame again (or remove it) and render once more.";
}

// A clip made from the words alone (Home prompt, output video; studio.enqueue_generation sets route_kind 'text'):
// the model's text-to-video endpoint, no start or end image (2026-11-20).
const fromText = (g) => g.route_kind === "text";
// Motion transfer (2026-11-20): the creator's source clip recast with their reference images (studio.motion_create).
const isMotion = (g) => g.route_kind === "motion";
// Lip sync (2026-11-23, studio.lipsync_create): the shot's kept clip with the mouths moved to its voiceover (on fal;
// the model is the generation's model_id: VEED Lipsync v2 since 2026-11-23, after Kling LipSync's mouths "do not match
// the words"). The kept clip stays in the cut until the creator keeps the lip-synced one.
function isLipsync(g) { return g.route_kind === "lipsync"; }

// Kling LipSync takes a 2-10 s video whose width and height are both 720 to 1920 px, and 2-60 s of audio up to 5 MB
// (fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video, read 2026-11-23). VEED's page gives no limits; the same
// 720-1920 px input is what the VEED test take of 2026-11-23 was made from, so both models get it. The voiceover starts where the shot starts
// in the cut, which is trim_start_s into the clip at normal speed (studio.lipsync_quote refuses other speeds), so the
// audio sent is that much silence, then the voice, cut or padded to the clip's length.
async function submitLipsync(g, shot) {
  const dir = path.join(config.workDir, g.id);
  await fs.mkdir(dir, { recursive: true });
  const [src] = await db.q("select output_path from studio.generations where id = $1", [g.lipsync_source]);
  const [vo] = await db.q("select output_path, kind from studio.audio_jobs where id = $1 and status = 'done'", [g.lipsync_audio]);
  if (!src?.output_path) throw Object.assign(new Error("the kept clip to lip-sync is missing; nothing was charged"), { permanent: true });
  if (!vo?.output_path) throw Object.assign(new Error("the voiceover to lip-sync to is missing; nothing was charged"), { permanent: true });
  const clipIn = path.join(dir, "lipsync-src.mp4"), voIn = path.join(dir, "lipsync-voice-src.mp3");
  await storage.download(src.output_path, clipIn);
  await storage.download(vo.output_path, voIn);
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                                           "-of", "json", clipIn]);
  const info = JSON.parse(stdout);
  const w = info.streams?.[0]?.width, h = info.streams?.[0]?.height, secs = parseFloat(info.format?.duration);
  if (!w || !h || !(secs > 0)) throw Object.assign(new Error("the kept clip could not be read; nothing was charged"), { permanent: true });
  if (secs < 2 || secs > 10.05) throw Object.assign(new Error(`lip sync works on clips of 2 to 10 s; this one is ${secs.toFixed(1)} s. Nothing was charged.`), { permanent: true });
  let f = Math.max(1, 720 / Math.min(w, h));
  if (Math.max(w, h) * f > 1920) f = 1920 / Math.max(w, h);
  const W = Math.round((w * f) / 2) * 2, H = Math.round((h * f) / 2) * 2;
  const video = path.join(dir, "lipsync-in.mp4"), voice = path.join(dir, "lipsync-voice.mp3");
  await run("ffmpeg", ["-y", "-v", "error", "-i", clipIn, "-map", "0:v:0", "-an",
    ...(W !== w || H !== h ? ["-vf", `scale=${W}:${H}:flags=lanczos`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p"]
                           : ["-c", "copy"]), "-movflags", "+faststart", video]);
  // The voice starts where the cut plays it: after any trim at the start, plus the cut's speech lead (assemble.js LEAD,
  // 0.15 s). 2026-11-23: without the lead the mouths moved 0.15 s before the voice in the cut.
  // 2026-11-26 (songs): lip-synced to the scene's SONG, the clip hears the part of the song that plays under it in the
  // cut: the song starts with the cut, so this shot starts at the length of the kept shots before it (cut frames, as
  // assemble.js counts them: trims, speed, hold). Clip time 0 is trim_start_s before that point.
  const lead = vo.kind === "music" ? null : Math.max(0, Number(shot.trim_start_s) || 0) + assemble.SPEECH_LEAD;
  let songFrom = null;
  if (vo.kind === "music") {
    const before = await db.q(`select coalesce(g.clip_s, s.duration_s) as clip_s, s.trim_start_s, s.trim_end_s, s.speed, s.hold_end_s
                                 from studio.shots s join studio.generations g on g.id = s.approved_generation_id
                                where s.scene_id = (select scene_id from studio.shots where id = $1)
                                  and s.ord < (select ord from studio.shots where id = $1) and g.output_path is not null`, [g.shot_id]);
    const F = 24, at = before.reduce((t, r) => {
      const frames = Math.round(Number(r.clip_s) * F), skip = Math.max(0, Math.round(Number(r.trim_start_s || 0) * F));
      const cut = Math.max(0, Math.round(Number(r.trim_end_s || 0) * F)), keep = Math.max(Math.min(F, frames), frames - skip - cut);
      const sp = Math.min(2, Math.max(0.5, Number(r.speed) || 1)), held = Math.round(Math.min(5, Math.max(0, Number(r.hold_end_s) || 0)) * F);
      return t + Math.max(1, Math.round(keep / sp)) + held;
    }, 0) / F;
    songFrom = at - Math.max(0, Number(shot.trim_start_s) || 0);       // song time at clip time 0 (may be before the song)
    const pre = Math.max(0, -songFrom);
    await run("ffmpeg", ["-y", "-v", "error", "-ss", Math.max(0, songFrom).toFixed(3), "-i", voIn,
                         "-af", `adelay=${Math.round(pre * 1000)}:all=1,apad`, "-t", secs.toFixed(3),
                         "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", voice]);
  } else
  await run("ffmpeg", ["-y", "-v", "error", "-i", voIn, "-af", `adelay=${Math.round(lead * 1000)}:all=1,apad`, "-t", secs.toFixed(3),
                       "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", voice]);
  // 2026-11-23 (Londi's push-in take: the face was too small to sync): free check before paying. A face too small or
  // missing while the voice plays is refused with nothing charged. When the check cannot run or cannot tell (a cartoon
  // face, say), the lip sync goes ahead and the check after it says what it could not judge.
  try {
    const r = await postChecker("/lipsync", { mode: "face", video, voice });
    const fc = r.json || {};
    log(g, `lip sync face check: ${fc.verdict || `HTTP ${r.status}`} (face found ${fc.face_found_pct ?? "?"}%, ${fc.face_px ?? "?"} px)`);
    if (r.ok && fc.verdict === "TOO_SMALL")
      throw Object.assign(new Error(`${fc.why} Nothing was charged.`), { permanent: true });
  } catch (e) {
    if (e.permanent) throw e;
    log(g, `lip sync face check could not run (${e.message}); going ahead`);
  }
  const vPath = `${g.owner}/lipsync/${g.id}-in.mp4`, aPath = `${g.owner}/lipsync/${g.id}-voice.mp3`;
  await storage.upload(video, vPath, "video/mp4");
  await storage.upload(voice, aPath, "audio/mpeg");
  const input = { video_url: await storage.signedUrl(vPath, 7200), audio_url: await storage.signedUrl(aPath, 7200) };
  const sub = await providers[shot.provider].submit(shot.endpoint, input);
  await db.unlock(g.id, {
    status: "running", request: JSON.stringify({ video_url: vPath, audio_url: aPath, endpoint: shot.endpoint, size: [W, H], voice_from_s: lead,
                              song_from_s: songFrom }),
    provider_request_id: sub.requestId, provider_status_url: sub.statusUrl, provider_response_url: sub.responseUrl,
    submitted_at: new Date(), next_poll_at: later(config.pollMs), tries: 0,
  });
  log(g, `lip sync submitted (${sub.requestId}): ${secs.toFixed(2)} s at ${W}x${H}${W !== w ? ` (from ${w}x${h})` : ""}, ` +
         (songFrom != null ? `song from ${songFrom.toFixed(2)} s` : `voice from ${lead} s`));
}

// The clip was checked when it was made and only the mouths change, so the lip-synced copy gets one check: does the
// mouth follow the voice (checker /lipsync, frame_check/lipsync_check.py, free; 2026-11-23). It only flags: the take is
// charged when made, like any clip, and goes to Review either way, with what the check found; keeping it puts it in
// the cut. A flagged take can be rejected for a refund like any clip.
async function checkLipsync(g) {
  const dir = path.join(config.workDir, g.id);
  const clip = path.join(dir, "clip.mp4"), voice = path.join(dir, "voice.mp3");
  let res;
  try {
    try { await fs.access(clip); } catch { await storage.download(g.output_path, clip); }   // another worker host
    const req = typeof g.request === "string" ? JSON.parse(g.request) : g.request;
    try { await fs.access(voice); } catch { await storage.download(req.audio_url, voice); }
    const r = await postChecker("/lipsync", { mode: "sync", video: clip, voice });
    res = r.json || {};
    if (!r.ok || !["PASS", "FLAG", "NOT_CHECKED"].includes(res.verdict)) throw new Error(res.error || `HTTP ${r.status}`);
  } catch (e) {
    res = { verdict: "NOT_CHECKED", reasons: [`the lip sync check could not run (${String(e.message).slice(0, 120)})`] };
  }
  const verdict = res.verdict === "PASS" ? "PASS" : res.verdict === "FLAG" ? "FLAG" : "NOT_REVIEWED";
  await db.recordQc(g.id, { ...res, verdict, review_usd: 0, models: { lipsync: g.model_id, lipsync_check: "lipsync_check.py" } });
  const reasons = (res.reasons || []).slice(0, 3).join("; ");
  const error = verdict === "PASS" ? null
    : verdict === "FLAG" ? `lip sync check: ${reasons}. Watch it with the sound on before keeping it.`.slice(0, 1000)
    : `lip sync not checked: ${reasons || "the check could not judge this clip"}. Watch it with the sound on.`.slice(0, 1000);
  await db.settle(g.id, "charge");
  await db.unlock(g.id, { status: "review", finished_at: new Date(), error });
  await db.q("update studio.shots set status = case when approved_generation_id is not null then 'approved' else 'review' end where id = $1", [g.shot_id]);
  log(g, `lip sync made; check ${verdict}${reasons ? ` (${reasons})` : ""}; waiting for the creator in Review`);
}

// The billed length is what the app measured in the browser (motion_create p_seconds), so the server must not trust
// it (2026-11-21 review): a 30 s clip sent as "4 s" would be charged 4 s while Higgsfield bills the real length. The
// worker measures the source and, when it runs longer than the seconds charged (or the model's maximum), sends
// Higgsfield a copy cut to exactly that length. Untrusted video: only the container formats an upload can be, local file
// only (same rule as the audio in assemble.js).
const SAFE_VIDEO_IN = ["-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm", "-protocol_whitelist", "file,pipe"];
async function motionSource(g, shot, maxFps = 0) {
  const dir = path.join(config.workDir, g.id);
  await fs.mkdir(dir, { recursive: true });
  const src = path.join(dir, "source-in" + (path.extname(shot.motion_source_path) || ".mp4"));
  try { await fs.access(src); } catch { await storage.download(shot.motion_source_path, src); }
  let secs = NaN;
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", ...SAFE_VIDEO_IN, "-show_entries", "format=duration", "-of", "csv=p=0", src]);
    secs = parseFloat(stdout);
  } catch { /* not a readable video */ }
  if (!isFinite(secs) || secs <= 0) throw Object.assign(new Error("the source clip could not be read as a video; nothing was charged"), { permanent: true });
  const billed = Number(shot.duration_s) || 0;
  // 2026-11-27 (Replace a person, Wan Animate Replace bills frames at 16 a second): its credits assume at most 24 fps
  let fps = 0;
  if (maxFps) {
    try {
      const { stdout } = await run("ffprobe", ["-v", "error", ...SAFE_VIDEO_IN, "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", src]);
      const [a, b] = String(stdout).trim().split("/").map(Number); fps = b ? a / b : a;
    } catch { fps = 0; }
  }
  const tooFast = maxFps && (!isFinite(fps) || fps <= 0 || fps > maxFps + 0.5);
  if (secs <= billed + 0.05 && !tooFast) return shot.motion_source_path;        // within what was charged: send as uploaded
  const cut = `${g.owner}/motion/billed-${g.id}.mp4`;
  const out = path.join(dir, "source-cut.mp4");
  await run("ffmpeg", ["-y", "-v", "error", ...SAFE_VIDEO_IN, "-i", src, "-t", String(billed), "-map", "0:v:0", "-map", "0:a?",
    ...(tooFast ? ["-r", String(maxFps)] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", out],
    { maxBuffer: 1 << 20 });
  await storage.upload(out, cut, "video/mp4");
  log(g, `source is ${secs.toFixed(2)} s${fps ? ` at ${fps.toFixed(1)} fps` : ""}, charged ${billed} s: sending a copy cut to ${billed} s` +
         `${tooFast ? ` at ${maxFps} fps` : ""}`);
  return cut;
}

// Replace a person (2026-11-27, studio.replace_create): one person in the creator's clip becomes the person in the
// reference photo; everything else stays as filmed. MiniMax H3 Max Recast (fal minimax/h3-max/recast: video_url,
// reference_image_urls, prompt, resolution "768P" | "1080P", enable_safety_checker; llms.txt read 2026-11-27) is told who
// in words; Wan 2.2 Animate Replace (fal-ai/wan/v2.2-14b/animate/replace: video_url, image_url, resolution, no prompt)
// replaces the clip's main person. Both providers' safety checkers are on.
const isReplace = (shot) => shot?.model_kind === "replace";
const AI_LABEL_FONT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "assets", "fonts", "SpaceGrotesk-SemiBold.ttf");
export async function aiLabelFilter(video) {
  let h = 720;
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", ...SAFE_VIDEO_IN, "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", video]);
    h = parseInt(String(stdout).trim(), 10) || 720;
  } catch { /* keep 720 */ }
  const size = Math.max(14, Math.round(h * 0.026)), pad = Math.max(4, Math.round(h * 0.008)), low = Math.round(h * 0.04);
  return `drawtext=fontfile='${AI_LABEL_FONT}':text='AI-edited · anlim.ai':fontcolor=white@0.92:fontsize=${size}:` +
         `box=1:boxcolor=black@0.45:boxborderw=${pad}:x=w*0.025:y=h-th-${low}`;
}
const replaceWho = (shot) => String(shot.action || "").replace(/^Replace: /, "") || "the main person";
function replaceInput(shot, videoUrl, refUrl) {
  if (/^minimax\//.test(shot.endpoint))
    return { video_url: videoUrl, reference_image_urls: [refUrl], resolution: shot.resolution, enable_safety_checker: true,
             // 2026-11-27 (first live run, gen 84dc969e): Recast dressed the player in the photo's clothes (white) in the
             // close shot while the wide shots kept the yellow kit. Londi: "Keep the kit". Only face, head and skin change.
             prompt: `Replace ${replaceWho(shot)} with the person in the reference photo, in every shot where they appear. ` +
                     "Change only their face, head, hair and skin to match the reference photo. Keep the clothes, kit, number, " +
                     "boots and accessories they wear in the video exactly as they are, in every shot. Do not use the clothes " +
                     "from the reference photo. Keep everyone else, the place, the camera, the cuts and the sound exactly as in the video." };
  return { video_url: videoUrl, image_url: refUrl, resolution: shot.resolution, enable_safety_checker: true,
           enable_output_safety_checker: true };
}

async function submitMotion(g, shot) {
  let source;
  const wan = isReplace(shot) && !/^minimax\//.test(shot.endpoint);
  try { source = await motionSource(g, shot, wan ? 24 : 0); }
  catch (e) { if (e.permanent) return fail(g, e.message); throw e; }
  const videoUrl = await storage.signedUrl(source, 7200);
  const imageUrls = [];
  for (const p of shot.motion_ref_paths || []) imageUrls.push(await storage.signedUrl(p, 7200));
  const input = isReplace(shot) ? replaceInput(shot, videoUrl, imageUrls[0])
    : { video_url: videoUrl, image_urls: imageUrls, prompt: shot.action === "Motion transfer" ? "" : (shot.action || ""),
        resolution: shot.resolution };
  const sub = await providers[shot.provider].submit(shot.endpoint, input);
  const saved = { video_url: source, image_urls: shot.motion_ref_paths, prompt: input.prompt,
                  resolution: input.resolution, endpoint: shot.endpoint, replace: isReplace(shot) || undefined };
  await db.unlock(g.id, {
    status: "running", request: JSON.stringify(saved), provider_request_id: sub.requestId,
    provider_status_url: sub.statusUrl, provider_response_url: sub.responseUrl,
    submitted_at: new Date(), next_poll_at: later(config.pollMs), tries: 0,
  });
  log(g, `${isReplace(shot) ? "replace a person" : "motion transfer"} submitted to ${shot.provider} (${sub.requestId}), ${imageUrls.length} reference image(s)`);
}

async function stepQueued(g) {
  const ctx = await db.shotContext(g);
  const modDir = path.join(config.workDir, g.id, "moderate");
  if (isLipsync(g)) return submitLipsync(g, ctx.shot);   // the clip and the voiceover were checked when they were made
  if (isMotion(g)) {
    if (!ctx.shot.motion_source_path) return fail(g, "the source clip is missing; nothing was charged");
    // content check (2026-11-23): the words and what the provider would get (the source clip's frames, the references)
    if (isReplace(ctx.shot)) {
      // 2026-11-27: its own rules (moderate.py Job: replace): no public figure put in, no news/political/crime footage
      await moderate.guard({ kind: "replace", ref: g.id, owner: g.owner, look: "photoreal", dir: modDir,
        text: `Replace a person: in the source video (first picture(s)), ${replaceWho(ctx.shot)} is replaced by the person in the ` +
              "reference photo (last picture; the creator confirmed this is them or someone who agreed). Everything else stays as filmed.",
        paths: [ctx.shot.motion_source_path, ...(ctx.shot.motion_ref_paths || [])] });
      return submitMotion(g, ctx.shot);
    }
    await moderate.guard({ kind: "clip", ref: g.id, owner: g.owner, look: ctx.shot.look, dir: modDir,
      text: moderate.shotWords({ ...ctx.shot, action: ctx.shot.action === "Motion transfer" ? "" : ctx.shot.action }, [], "Motion transfer: the source video is recast with the reference pictures"),
      paths: [ctx.shot.motion_source_path, ...(ctx.shot.motion_ref_paths || [])] });
    return submitMotion(g, ctx.shot);
  }
  const characters = ctx.characters;
  const text = fromText(g);
  if (text && !ctx.shot.t2v_endpoint) return fail(g, "this model cannot make a clip from words alone; nothing was charged");
  const shot = text ? { ...ctx.shot, endpoint: ctx.shot.t2v_endpoint, from_text: true } : ctx.shot;
  if (!text) {
    const blocked = await endFrameGate(g, shot, characters);
    if (blocked) return fail(g, blocked);
  }
  // content check (2026-11-23): the shot's words, its cast and the start and end pictures the model would get. A
  // blocked job fails here with its credits released (moderate.Blocked is permanent, see handle()).
  await moderate.guard({ kind: "clip", ref: g.id, owner: g.owner, look: shot.look, dir: modDir,
    text: moderate.shotWords(shot, characters), paths: text ? [] : [shot.start_frame_path, shot.end_frame_path].filter(Boolean) });
  const startUrl = text ? null : await storage.signedUrl(shot.start_frame_path);
  const endUrl = !text && shot.end_frame_path ? await storage.signedUrl(shot.end_frame_path) : null;
  const input = compile.providerInput(shot, characters, startUrl, endUrl);
  const sub = await providers[shot.provider].submit(shot.endpoint, input);
  // signed URLs expire; keep the request without them
  const saved = { ...input, start_image_url: text ? undefined : shot.start_frame_path, end_image_url: endUrl ? shot.end_frame_path : undefined,
                  image_url: undefined, endpoint: shot.endpoint, compiler_version: compile.COMPILER_VERSION };
  await db.unlock(g.id, {
    status: "running", request: JSON.stringify(saved), provider_request_id: sub.requestId,
    provider_status_url: sub.statusUrl, provider_response_url: sub.responseUrl,
    submitted_at: new Date(), next_poll_at: later(config.pollMs), tries: 0,
  });
  log(g, `submitted to ${shot.provider} (${sub.requestId})`);
}

async function stepRunning(g) {
  const { shot } = await db.shotContext(g);
  const p = await providers[shot.provider].poll(g);
  if (p.state === "pending") {
    const limit = isMotion(g) ? config.motionTimeoutMin : config.providerTimeoutMin;
    if (Date.now() - new Date(g.submitted_at).getTime() > limit * 60000)
      return fail(g, `provider timeout after ${limit} min`);
    return db.unlock(g.id, { next_poll_at: later(config.pollMs) });
  }
  if (p.state === "failed") {
    // 2026-11-23 (live test): Kling LipSync found no face in a two-shot on a sofa and the creator saw fal's raw JSON
    if (isLipsync(g) && /face_detection_error|no face detected/i.test(String(p.error)))
      return fail(g, "Lip sync needs a face that is clearly visible and large enough in the clip (a close or medium shot, " +
        "facing the camera). None was found in this clip. Nothing was charged.");
    return fail(g, `provider: ${p.error}`);
  }
  const dir = path.join(config.workDir, g.id);
  const raw = path.join(dir, "raw.mp4"), clip = path.join(dir, "clip.mp4");
  await fetchTo(p.videoUrl, raw);
  if (isMotion(g) && isReplace(shot)) {
    // Replace a person (2026-11-27, safety 4): a visible "AI-edited" label in the picture for the whole clip, on every
    // account, so the result is not passed off as the original footage. Bottom left, about 2.6 % of the height.
    // The size is worked out here in whole pixels: the ffmpeg on Fly refuses expressions for boxborderw (first live
    // run, gen 84dc969e: "Undefined constant or missing '(' in 'h*0.008'"), though newer builds take them.
    await run("ffmpeg", ["-y", "-v", "error", ...SAFE_VIDEO_IN, "-i", raw, "-map", "0:v:0", "-map", "0:a?",
      "-vf", await aiLabelFilter(raw),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", clip],
      { maxBuffer: 1 << 20 });
  } else if (isMotion(g)) {      // motion transfer keeps the source clip's own sound (the creator's audio)
    await run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", clip]);
  } else if (isLipsync(g)) {
    // 2026-11-23 (Londi: "There was no sound on the lip-sync?"): a lip-synced take carries the voice it was synced to
    // (the exact file sent to the provider), so it can be judged in Review. Cuts take only the picture of each clip and
    // mix the voiceover themselves, so the voice is never doubled.
    const req = typeof g.request === "string" ? JSON.parse(g.request) : g.request;
    const voice = path.join(dir, "voice.mp3");
    await storage.download(req.audio_url, voice);
    await run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-i", voice, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                         "-c:a", "aac", "-b:a", "160k", "-shortest", clip]);
  } else {
    await run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-map", "0:v:0", "-c", "copy", "-an", clip]);  // models add speech; strip it
  }
  // Free accounts (never bought credits or a plan) see a watermarked copy; the clean clip goes to a folder they
  // can't read and is shown once they pay (studio.has_paid, watermark.js). output_path is always the clean clip.
  const [{ paid }] = await db.q("select studio.has_paid($1) as paid", [g.owner]);
  let objectPath = `${g.owner}/generations/${g.id}.mp4`, previewPath = null;
  if (!paid) {
    const marked = path.join(dir, "preview.mp4");
    await watermark(clip, marked);                    // fails the step (and retries) rather than store an unmarked copy
    previewPath = objectPath;
    objectPath = `${VAULT}/clean/${g.owner}/${g.id}.mp4`;
    await storage.upload(marked, previewPath);
  }
  await storage.upload(clip, objectPath);
  // A clip made from words has no start frame: its own first frame becomes the shot's (the checker compares against
  // it, the refund page shows it, and the next shot in the project can start from it). Not a creator-approved frame
  // for the head count: confirmed_spec stays false for text clips (stepChecking).
  if ((fromText(g) || isMotion(g)) && (!shot.start_frame_path || shot.start_frame_path.endsWith("/clip-first-frame.png"))) {
    const first = path.join(dir, "clip-first-frame.png");
    await run("ffmpeg", ["-y", "-v", "error", "-i", clip, "-frames:v", "1", first]);
    const framePath = `${g.owner}/frames/gen-${g.id}/clip-first-frame.png`;
    await storage.upload(first, framePath, "image/png");
    await db.q("update studio.shots set start_frame_path = $2, start_frame_approved = true where id = $1", [g.shot_id, framePath]);
    log(g, `first frame stored as the shot's start frame (${framePath})`);
  }
  const usd = shot.usd_per_second * (isLipsync(g) ? (g.lipsync_s || 5) : shot.duration_s);   // lipsync_s: the seconds fal bills
  // 2026-11-23 (review): the clip's real length, so trims and the score's sections use it rather than the asked length
  let clipS = null;
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip]);
    const v = parseFloat(stdout); if (isFinite(v) && v > 0) clipS = Number(v.toFixed(3));
  } catch { /* the length stays unknown; the shot's length is used instead */ }
  await db.unlock(g.id, { status: "checking", output_path: objectPath, preview_path: previewPath, provider_usd: usd,
                          clip_s: clipS, next_poll_at: null, tries: 0 });
  log(g, `clip stored (${objectPath}${previewPath ? `; watermarked copy ${previewPath}` : ""}), provider $${usd.toFixed(3)}`);
}

// Motion transfer (2026-11-20): the clip checker reads the source's camera cuts as faults, so these clips get their own
// check instead: does each shot keep who is who against the source clip (checker /motion_check, one vision call)?
// Never a FAIL; the clip is charged like any made clip and a flag only tells the creator where to look.
// Replace a person (2026-11-27, safety 6): is the person from the reference photo really in the clip? Three frames
// (20 %, 50 %, 80 %) against the photo with the face model (checker /face_start, photoreal; the KAMK-tuned 0.40 rule).
// A frame where no face is found or it does not match is only a FLAG (the creator looks), never a FAIL.
async function replaceFaceCheck(g, shot, dir, clip) {
  const ref = path.join(dir, "rref" + (path.extname(shot.motion_ref_paths?.[0] || "") || ".png"));
  try { await fs.access(ref); } catch { await storage.download(shot.motion_ref_paths[0], ref); }
  let secs = Number(shot.duration_s) || 5;
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip]);
    secs = parseFloat(stdout) || secs;
  } catch { /* keep the shot length */ }
  const frames = [], problems = [], notes = [];
  for (const f of [0.2, 0.5, 0.8]) {
    const png = path.join(dir, `rcheck-${Math.round(f * 100)}.png`);
    await run("ffmpeg", ["-y", "-v", "error", "-ss", (secs * f).toFixed(2), "-i", clip, "-frames:v", "1", png]);
    const r = await postChecker("/face_start", { still: png, refs: { "the creator": [ref] }, look: "photoreal",
                                                 fake_verdict: process.env.FAKE_FACES || undefined });
    const j = r.json || {};
    frames.push({ at_s: +(secs * f).toFixed(2), verdict: j.verdict || "ERROR" });
    if (j.verdict === "FLAG") problems.push(`at ${(secs * f).toFixed(1)} s: ${(j.problems || [])[0] || "the face does not match the photo"}`);
    if (j.verdict === "NOT CHECKED") notes.push(`at ${(secs * f).toFixed(1)} s: ${(j.notes || [])[0] || "no face found"}`);
  }
  const ok = frames.filter((x) => x.verdict === "OK").length;
  const verdict = problems.length ? "FLAG" : ok ? "PASS" : "NOT_REVIEWED";
  return { verdict, reasons: problems.length ? problems : ok ? [] : notes.length ? notes : ["the face check could not run"],
           usd: 0, detail: { model: "sface", frames } };
}

async function checkMotion(g) {
  const { shot } = await db.shotContext(g);
  const dir = path.join(config.workDir, g.id);
  await fs.mkdir(dir, { recursive: true });
  const clip = path.join(dir, "clip.mp4");
  try { await fs.access(clip); } catch { await storage.download(g.output_path, clip); }
  const saved = path.join(dir, "motion_check.json");
  let res;
  try { res = JSON.parse(await fs.readFile(saved, "utf8")); } catch { res = null; }
  if (!res && isReplace(shot)) {
    try { res = await replaceFaceCheck(g, shot, dir, clip); }
    catch (e) { res = { verdict: "NOT_REVIEWED", reasons: [`the face check could not run (${String(e.message).slice(0, 120)})`], usd: 0 }; }
    await fs.writeFile(saved, JSON.stringify(res));
  }
  if (!res) {
    try {
      const source = path.join(dir, "source" + (path.extname(shot.motion_source_path || "") || ".mp4"));
      try { await fs.access(source); } catch { await storage.download(shot.motion_source_path, source); }
      const refs = [];
      for (const [i, p] of (shot.motion_ref_paths || []).entries()) {
        const ref = path.join(dir, `mref-${i}${path.extname(p) || ".png"}`);
        try { await fs.access(ref); refs.push(ref); } catch {
          try { await storage.download(p, ref); refs.push(ref); } catch (e) { log(g, `reference image ${i + 1} not downloaded: ${e.message}`); }
        }
      }
      const who = shot.action && shot.action !== "Motion transfer" ? shot.action : null;
      const r = await postChecker("/motion_check", { render: clip, source, refs, who });
      res = r.json || { verdict: "ERROR", error: `checker HTTP ${r.status}` };
      if (!r.ok || res.verdict === "ERROR") throw new Error(res.error || `HTTP ${r.status}`);
    } catch (e) {
      // the swap check is a helper, not a gate: when it cannot run, the clip still goes to review
      res = { verdict: "NOT_REVIEWED", reasons: [`the swap check could not run (${String(e.message).slice(0, 120)})`], usd: 0 };
    }
    await fs.writeFile(saved, JSON.stringify(res));
  }
  await db.recordQc(g.id, { ...res, review_usd: res.usd || 0, models: { motion_swap: (res.detail && res.detail.model) || null } });
  log(g, `motion swap check ${res.verdict} ($${(res.usd || 0).toFixed(3)})`);
  await db.settle(g.id, "charge");
  const reasons = (res.reasons || []).slice(0, 3).join(" | ");
  const error = res.verdict === "PASS" ? null
    : res.verdict === "FLAG" ? `checker found: ${reasons}`.slice(0, 1000)
    : isReplace(shot) ? `face not confirmed: ${reasons || "no face found"}; check that the right person was replaced`.slice(0, 1000)
    : `not checked: ${reasons || "the swap check could not run"}; look for swapped faces or costumes`.slice(0, 1000);
  await db.unlock(g.id, { status: res.verdict === "PASS" ? "succeeded" : "review", finished_at: new Date(), error });
  await db.setShot(g.shot_id, "review");
}

async function stepChecking(g) {
  if (isLipsync(g)) return checkLipsync(g);
  if (isMotion(g)) return checkMotion(g);
  const { shot, characters } = await db.shotContext(g);
  const dir = path.join(config.workDir, g.id);
  const clip = path.join(dir, "clip.mp4");
  try { await fs.access(clip); } catch { await storage.download(g.output_path, clip); }   // another worker host
  const start = path.join(dir, "start" + path.extname(shot.start_frame_path || ".png"));
  await storage.download(shot.start_frame_path, start);
  const fps = await clipFps(clip);
  const spec = compile.checkerSpec(shot, characters, clip, path.join(dir, "qa"), start, fps);
  // Each cast member's reference image, once: the height check on the clip's last frame (2026-11-16) and, for a
  // photoreal series, face identity of the people (frame_check face_id, "faces"; it was only used by the photoreal
  // benchmarks until 2026-11-17, the app never sent faces).
  const refs = {};
  for (const c of characters) {
    if (!c.ref_front_path) continue;
    const ref = path.join(dir, `ref-${c.id}${path.extname(c.ref_front_path) || ".png"}`);
    try { await fs.access(ref); refs[c.id] = ref; } catch {
      try { await storage.download(c.ref_front_path, ref); refs[c.id] = ref; }
      catch (e) { log(g, `reference image for ${c.name} not downloaded: ${e.message}`); }
    }
  }
  spec.heights = characters.filter((x) => x.height_units != null)
    .map((c) => ({ name: c.name, height: Number(c.height_units), ref: refs[c.id] || null }));
  if (shot.look === "photoreal") {
    const faces = {};
    for (const c of characters) if ((c.kind || "person") === "person" && refs[c.id]) faces[c.name.toUpperCase()] = [refs[c.id]];
    if (Object.keys(faces).length) spec.faces = faces;
  }
  const fake = process.env.FAKE_VERDICT;   // tests (CHECKER_MODE=fake)
  if (fake) spec.fake_verdict = fake;
  // The checker's answer is saved before it is written to the database, so a database error never makes a paid
  // review run again (2026-11-12: a constraint error re-ran the check 5 times; that time it had cost nothing).
  const saved = path.join(dir, "check_result.json");
  let res;
  try { res = JSON.parse(await fs.readFile(saved, "utf8")); } catch { res = null; }
  if (!res) {
    // Crash guard (2026-11-20): a check that runs the machine out of memory takes this worker down with it, so
    // `tries` never moves and the same check restarted after every reboot. check_started_at still set here means the
    // last check of this clip died with the machine; after config.checkerMaxCrashes of those the clip goes to review
    // unchecked, charged like a checker that gave up (policy v2), and the queue moves on.
    if (g.check_started_at) {
      const crashes = (g.check_crashes || 0) + 1;
      await db.update(g.id, { check_crashes: crashes, check_started_at: null });
      log(g, `the last check of this clip never finished (machine restart, likely out of memory); crash ${crashes}`);
      if (crashes >= config.checkerMaxCrashes) {
        await db.settle(g.id, "charge");
        await db.unlock(g.id, { status: "review", finished_at: new Date(),
          error: `not checked: the check stopped the server ${crashes} times (out of memory); have a look yourself` });
        await db.setShot(g.shot_id, "review");
        return log(g, `check skipped after ${crashes} crashes; sent to review unchecked`);
      }
    }
    await db.update(g.id, { check_started_at: new Date() });
    // the creator approved the start still with this shot's cast list: the head count is confirmed
    let r;
    try {
      r = await postChecker("/check", { generation_id: g.id, spec, max_usd: config.checkerMaxUsd,
                                        confirmed_spec: !!shot.start_frame_approved && !fromText(g) });
    } finally {
      await db.update(g.id, { check_started_at: null });   // the checker answered (or the call failed): not a crash
    }
    res = r.json || { verdict: "ERROR", error: `checker HTTP ${r.status}` };
    if (!r.ok || res.verdict === "ERROR") throw new Error(`checker: ${res.error || r.status}`);
    await fs.writeFile(saved, JSON.stringify(res));
  }
  await db.recordQc(g.id, res);
  const cost = (res.review_usd || 0) + (res.verify_usd || 0) + (res.action_usd || 0) + (res.passthrough_usd || 0) + (res.height_usd || 0);
  log(g, `checker ${res.verdict} ($${cost.toFixed(3)})`);
  if (res.verdict === "PASS") {
    await db.settle(g.id, "charge");
    await db.unlock(g.id, { status: "succeeded", finished_at: new Date() });
    await db.setShot(g.shot_id, "review");
  } else if (res.verdict === "FAIL") {
    // 2026-11-20 (Londi): no automatic fails. A FAIL is the strongest flag: the clip was made and is charged; the
    // checker's findings are shown, and the creator can request a refund with a reason (studio.request_refund).
    await db.settle(g.id, "charge");
    await db.unlock(g.id, { status: "review", error: `checker found: ${(res.reasons || []).slice(0, 3).join(" | ")}`.slice(0, 1000),
                            finished_at: new Date() });
    await db.setShot(g.shot_id, "review");
  } else {                                            // FLAG or NOT_REVIEWED: a person looks
    // policy v2 (2026-11-20): a flagged clip is charged when the check finishes; credits come back only through a
    // refund request the creator explains (studio.request_refund)
    await db.settle(g.id, "charge");
    await db.unlock(g.id, { status: "review", finished_at: new Date() });
    await db.setShot(g.shot_id, "review");
  }
}

const steps = { queued: stepQueued, running: stepRunning, checking: stepChecking };

async function handle(g) {
  try {
    await steps[g.status](g);
  } catch (e) {
    const tries = (g.tries || 0) + 1;
    if (!e.blocked) await db.logError(`clip ${g.status}`, g.id, g.owner, e, { tries, route: g.route_kind || null });
    if (e.permanent || tries >= config.maxStepTries) {
      if (g.status === "checking") {                 // the clip exists; a person can still judge it
        await db.settle(g.id, "charge");            // policy v2: the clip was made and delivered
        await db.unlock(g.id, { status: "review", error: `checker unavailable: ${e.message}`.slice(0, 1000), tries });
        if (!isLipsync(g)) await db.setShot(g.shot_id, "review");
        return log(g, `checker gave up after ${tries} tries; sent to review`);
      }
      return fail(g, e.message);
    }
    const backoff = Math.min(300000, 5000 * 2 ** tries);
    await db.unlock(g.id, { tries, error: e.message.slice(0, 1000), next_poll_at: later(backoff) });
    log(g, `step ${g.status} error (try ${tries}): ${e.message}; again in ${backoff / 1000}s`);
  }
}

// Plan credits: annual plans refill monthly and unpaid plans lose their credits at the month boundary
// (studio.refresh_plans, billing migration). Once a minute is plenty.
let lastPlans = 0;
async function refreshPlans() {
  if (Date.now() - lastPlans < 60000) return;
  lastPlans = Date.now();
  try {
    const rows = await db.q("select studio.refresh_plans() as n");
    if (rows[0].n > 0) console.log(`plan credits refreshed for ${rows[0].n} account(s)`);
  } catch (e) { console.error("refresh_plans:", e.message); }
}

// Clip checks take minutes; the tick used to wait for every claimed job, so 4 checks in a batch stopped the worker
// from collecting finished renders for 10+ min (2026-11-19). Checks now run beside the tick, at most checkerSlots at a
// time (the checker service runs CHECKER_MAX_JOBS); a check claimed while all slots are busy is put back for 20 s.
const inflight = new Map();
// Storage clean-up, once a day (the first run 10 minutes after start, so a crash loop cannot run it again and again)
let nextRetention = Date.now() + 10 * 60_000;
function maybeRetention() {
  if (Date.now() < nextRetention) return;
  nextRetention = Date.now() + 24 * 3600_000;
  db.q("select studio.insights_trim() as n").catch((e) => console.error("insights_trim:", e.message));
  storage.retention(30).then((r) => r && console.log(`retention: ${r.done} removed (${r.files} files, ${Math.round((r.bytes || 0) / 1e6)} MB), ` +
    `${r.skipped} skipped, ${r.candidates} due`)).catch((e) => console.error("retention:", e.message));
}
// "Your clip is ready" emails (2026-11-23): the studio-mail function sends what is waiting; once a minute, never awaited
let nextMail = Date.now() + 30_000;
function maybeMail() {
  if (Date.now() < nextMail || config.storage !== "function") return;
  nextMail = Date.now() + 60_000;
  fetch(`${config.supabaseUrl}/functions/v1/studio-mail`, {
    method: "POST", headers: { "x-worker-token": config.storageToken, "Content-Type": "application/json" }, body: JSON.stringify({ op: "flush" }),
  }).then(async (r) => { const j = await r.json().catch(() => ({})); if (j.sent || j.failed || j.error) console.log(`mail: ${JSON.stringify(j)}`); })
    .catch((e) => console.error("mail:", e.message));
}
export async function tick() {
  await refreshPlans();
  maybeRetention();
  maybeMail();
  maybeThumbs();
  const jobs = await db.claim(config.workerId, config.batch, 1500);
  const now = [];
  for (const g of jobs) {
    if (g.status !== "checking") { now.push(g); continue; }
    if (inflight.has(g.id)) continue;
    if (inflight.size >= config.checkerSlots) { await db.unlock(g.id, { next_poll_at: later(20000) }); continue; }
    inflight.set(g.id, handle(g).catch((e) => console.error("check:", e.message)).finally(() => inflight.delete(g.id)));
  }
  const [, nFrames, nCuts, nAudio, nExports] = await Promise.all([Promise.all(now.map(handle)), frames.tick(),   // end-frame jobs (frames.js)
    assemble.tick().catch((e) => { console.error("assemble:", e.message); return 0; }),           // scene cuts (assemble.js)
    audio.tick().catch((e) => { console.error("audio:", e.message); return 0; }),                 // ElevenLabs audio (audio.js)
    exporter.tick().catch((e) => { console.error("export:", e.message); return 0; }),            // project downloads (export.js)
    translate.tick().catch((e) => { console.error("translate:", e.message); return 0; }),       // messages in es/fr (translate.js)
    ad.tick().catch((e) => { console.error("ad:", e.message); return 0; })]);                    // ad scripts (ad.js, 2026-11-27)
  return now.length + nFrames + nCuts + nAudio + nExports;
}

async function main() {
  const once = process.argv.includes("--once");
  console.log(`worker ${config.workerId} up (storage=${config.storage}, checker=${config.checkerUrl}, prompt compiler ${compile.COMPILER_VERSION})`);
  let stop = false;
  process.on("SIGINT", () => { stop = true; console.log("stopping after this tick"); });
  while (!stop) {
    const n = await tick().catch((e) => { console.error("tick error:", e.message); return 0; });
    if (once && n === 0) break;
    if (n === 0) await new Promise((r) => setTimeout(r, config.idleMs));
  }
  await db.pool.end();
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("worker.js")) main();

// Scene assembly engine (2026-11-19). @anlim
// Joins a scene's approved clips, in shot order, into one finished video. The methods come from the content projects:
//   - frame-exact cuts: every clip is conformed to one frame rate (24, what both video models deliver) and encoded
//     with an exact frame count, then the parts are joined without re-encoding; each part's length is checked
//     (The Man in the Booth, tools/edit.py)
//   - formats: 16:9 1920x1080; 9:16 1080x1920 and 4:5 1080x1350 fill the frame with a blurred copy of the shot behind
//     the full picture instead of black bars (Name That Fight shorts; Drive Safe delivered 1080x1350 and 1080x1920)
//   - libx264 crf 18, AAC 192k, +faststart (Drive Safe)
//   - music: the creator's own track or a score made with their ElevenLabs account (2026-11-19, Londi), one constant
//     level, nothing that pumps with the picture (Drive Safe MIX2: ducking pulsed 72 times in 163 s), loudness to
//     -14 LUFS, true peak -1.5 (Name That Fight build_episode.py)
//   - voiceover and sound effects (2026-11-19): each shot's chosen line and effect start with the shot; every stem gets
//     ONE fixed gain (speech -16, effects -22, a music bed under speech -27 LUFS), they are summed, and the mix gets one
//     fixed gain to -14 LUFS with a brickwall at -1.5 dBTP. No ducking: the bed sits lower for the whole cut instead.
//   - after the render: the parts add up to the whole, no unplanned black, size / frame rate / length as asked
//     (Drive Safe FINAL.md QC, frame_check deliver_check.py)
// Unpaid accounts get a watermarked copy; the clean cut goes to the vault (watermark.js, studio.has_paid).
// 2026-11-23: an edit style (options.style, editstyle.js): grade, transitions, push-in, rain, hits under the changes,
// shot changes on the music's beats, serif captions, a title and a handle. Plain ffmpeg, no AI, free like the rest.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import * as db from "./db.js";
import * as storage from "./storage.js";
import { watermark, VAULT, MARK } from "./watermark.js";
import * as captions from "./captions.js";
import * as style from "./editstyle.js";
import * as translate from "./translate.js";
import * as glyphs from "./glyphs.js";

// A shot's voiceover starts this long after the shot does in a cut (worker.js lip-syncs to the same offset)
export const SPEECH_LEAD = 0.15;

const exec = promisify(execFile);
const FPS = 24;
// 2026-11-21: projects can be any of six shapes, so a cut can be too (1x1, 4x3, 3x4, 21x9 added)
const SIZES = { "16x9": [1920, 1080], "9x16": [1080, 1920], "4x5": [1080, 1350], "1x1": [1080, 1080],
                "4x3": [1440, 1080], "3x4": [1080, 1440], "21x9": [2520, 1080] };
const FADE_IN = 0.5, FADE_OUT = 0.8, CARD_S = 3.0, CREDIT_S = 2.0, MUSIC_FADE = 2.0;
const LUFS = -14, TP = -1.5;
const log = (a, msg) => console.log(`${new Date().toISOString()} [cut ${String(a.id).slice(0, 8)}] ${msg}`);

const ff = (args) => exec("ffmpeg", ["-nostdin", "-y", "-v", "error", ...args], { maxBuffer: 64 << 20 });
// Audio a creator uploaded is untrusted: ffmpeg picks a demuxer from the file's content, and a text file named .mp3
// can be a concat or playlist that makes ffmpeg open other local files or URLs on this machine (2026-11-19 review:
// an "ffconcat" file named .m4a was read as a concat list). Only plain audio demuxers and local file reads are allowed.
const SAFE_AUDIO_IN = ["-format_whitelist", "mp3,wav,mov,aac,flac,ogg", "-protocol_whitelist", "file,pipe"];
async function ffErr(args) {           // runs ffmpeg and returns its stderr (analysis filters print there)
  const r = await exec("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", ...args], { maxBuffer: 64 << 20 });
  return r.stderr;
}
async function probe(p) {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", p]);
  const j = JSON.parse(stdout), s = (j.streams || [])[0] || {};
  const [n, d] = String(s.r_frame_rate || "0/1").split("/").map(Number);
  const dur = Number(j.format?.duration || 0), fps = d ? n / d : 0;
  return { w: s.width, h: s.height, fps, dur, frames: Number(s.nb_frames) || Math.round(dur * fps) };
}
async function audioDur(p, untrusted = false) {
  const { stdout } = await exec("ffprobe", ["-v", "error", ...(untrusted ? SAFE_AUDIO_IN : []), "-show_entries", "format=duration", "-of", "csv=p=0", p]);
  return Number(stdout.trim()) || 0;
}

// The picture filter for one clip in the chosen format.
function conform(format) {
  const [W, H] = SIZES[format];
  // Timestamps reset to zero and the last frame held for a moment, so the frame-rate step can never come up a frame
  // short (2026-11-19: a 121-frame clip came out 120); -frames:v then cuts each part to its exact count.
  const head = `[0:v]setpts=PTS-STARTPTS,fps=${FPS},tpad=stop_mode=clone:stop=${FPS}`;
  // 2026-11-21: clips are no longer always 16:9. The whole picture is fitted inside the frame (never cropped) over a
  // blurred fill; a clip already in the cut's shape fills it and the fill never shows. (The 16x9 cut used to crop.)
  return `${head},split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:3,` +
         `eq=brightness=-0.22[bg];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
         `scale=trunc(iw/2)*2:trunc(ih/2)*2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1`;
}

// skip: frames cut off the clip's start (the shot's trim, 2026-11-22); frames: how many are kept after that.
// credit: "Made with anlim.ai" over the end of this (the last) shot. 2026-11-22 (Londi: "Made with anlim.ai belongs on
// the end shot, not on an end card"): it fades in over the last CREDIT_S seconds and stays while the picture fades out.
// speed: below 1 slows the shot down with motion interpolation (2026-11-22, Londi chose it over frame blending for the
// promo: the voiceover needed more time than the dissolve took); above 1 speeds it up by dropping frames. frames is the
// count after the speed change.
// sty (2026-11-23): the cut's edit style and the changes into and out of this shot ({ s, kIn, kOut }), or null. Its
// filters come after the picture is in place and before the words, so the words stay sharp through a transition.
async function part(src, dest, format, frames, fades, skip = 0, credit = false, speed = 1, words = [], srcSize = null, sty = null) {
  const t = frames / FPS;
  const fx = [];
  if (words.length) fx.push(...await wordFilters(words, path.dirname(dest), path.basename(dest, ".mp4"), ...SIZES[format], picRect(format, srcSize)));
  if (fades.in) fx.push(`fade=t=in:st=0:d=${FADE_IN}`);
  if (fades.out) fx.push(`fade=t=out:st=${(t - FADE_OUT).toFixed(3)}:d=${FADE_OUT}`);
  let fc = (sty?.s ? conform(format) + "[sty0];" + style.shotGraph("sty0", ...SIZES[format], frames, sty.s, sty.kIn, sty.kOut, "s", sty.curves || null) : conform(format)) +
           (fx.length ? "," + fx.join(",") : "");
  if (credit) {
    const [W, H] = SIZES[format], mw = Math.round(Math.min(W, H) * 0.5 / 2) * 2, st = Math.max(0, t - CREDIT_S);
    fc += `[pic];[1:v]scale=${mw}:-1,format=rgba,fade=t=in:st=${st.toFixed(3)}:d=0.6:alpha=1[m];` +
          `[pic][m]overlay=(W-w)/2:H*0.87-h/2:shortest=1,format=yuv420p[v]`;
  } else fc += ",format=yuv420p[v]";
  const sp = speed && Math.abs(speed - 1) > 0.001 ? `setpts=PTS/${speed.toFixed(4)},` +
    (speed < 1 ? `minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,` : `fps=${FPS},`) : "";
  const hold = sty?.hold || 0;   // 2026-11-24: beat sync may run a shot a few frames past its clip: hold the last frame
  if (skip > 0 || sp || hold) fc = fc.replace(`fps=${FPS},`, `fps=${FPS},` + (skip > 0 ? `trim=start_frame=${skip},setpts=PTS-STARTPTS,` : "") + sp +
    (hold ? `tpad=stop_mode=clone:stop=${hold},` : ""));
  const inputs = ["-i", src, ...(credit ? ["-loop", "1", "-framerate", String(FPS), "-t", (t + 2).toFixed(3), "-i", typeof credit === "string" ? credit : MADE_WITH] : [])];
  await ff([...inputs, "-filter_complex", fc, "-map", "[v]", "-frames:v", String(frames), "-an", "-c:v", "libx264",
            "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS), dest]);
  const got = await probe(dest);
  if (got.frames !== frames) throw new Error(`part ${path.basename(dest)} has ${got.frames} frames, expected ${frames}`);
}

// "Made with anlim.ai" end card: the words and the anlim mark on black, fading in. 2026-11-22 (Londi: "Video should end
// with a clear Made with Anlim.ai"): the card said only "anlim.ai"; it now says "Made with", is larger and stays 3 s.
const MADE_WITH = path.join(path.dirname(MARK), "made_with.png");
// 2026-11-24 (languages): "Hecho con" / "Créé avec" for a creator who chose Spanish or French (made_with_es/fr.png)
async function madeWithFor(owner) {
  const lang = await translate.ownerLang(owner).catch(() => "en");
  return lang === "es" || lang === "fr" ? path.join(path.dirname(MARK), `made_with_${lang}.png`) : MADE_WITH;
}
const ASSETS = path.dirname(MARK);

// 2026-11-23 (Londi's promo: "actual words falling from him as the VO delivers them"): words drawn over a shot, each
// appearing at a point in the frame at a moment of the shot (cut time, after the speed change), then falling with
// gravity, drifting on the breeze and fading as they land. Drawn here rather than by the video model, which misspelled
// every word it was asked to write. The text goes through a file with expansion off, so nothing in it is interpreted.
const WORD_FONT = path.join(path.dirname(MARK), "fonts", "Montserrat-Bold.ttf");
// 2026-11-23 (ep16 recording): x and y are placed on the shot's picture, as the creator tapped it, not on the whole
// frame: in a cut of another shape (a 16:9 clip in a 9:16 cut) the picture is fitted inside the frame over a blurred
// fill, and a word tapped low on the picture used to land below it, on the fill. picRect is where conform() puts the picture.
function picRect(format, size) {
  const [W, H] = SIZES[format];
  if (!size?.w || !size?.h) return { x: 0, y: 0, w: W, h: H };
  const k = Math.min(W / size.w, H / size.h);
  const w = Math.floor(Math.round(size.w * k) / 2) * 2, h = Math.floor(Math.round(size.h * k) / 2) * 2;
  return { x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2), w, h };
}
async function wordFilters(words, dir, tag, W, H, pic = { x: 0, y: 0, w: W, h: H }) {
  const out = [];
  for (const [k, w] of (words || []).slice(0, 12).entries()) {
    const text = String(w.text || "").trim().slice(0, 40);
    if (!text) continue;
    const file = path.join(dir, `${tag}_word${k}.txt`);
    await fs.writeFile(file, text);
    const t0 = Math.max(0, Number(w.at_s) || 0), d = Math.min(6, Math.max(1, Number(w.dur_s) || 2.6));
    const x0 = pic.x + Math.min(1, Math.max(0, Number(w.x ?? 0.5))) * pic.w, y0 = pic.y + Math.min(1, Math.max(0, Number(w.y ?? 0.4))) * pic.h;
    // size: 6% of the picture's width, smaller for long lines so a line never needs more than 90% of it
    const size = Math.round(Math.min(pic.w * 0.06, (pic.w * 0.9) / (text.length * 0.66)));
    const g = pic.h * 0.09, wind = pic.w * 0.05;               // px/s^2 fall, px/s drift to the right
    const T = `(t-${t0.toFixed(3)})`;
    out.push(`drawtext=fontfile=${WORD_FONT}:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=0xFFF1D6` +
      `:shadowcolor=black@0.55:shadowx=2:shadowy=3:enable='between(t,${t0.toFixed(3)},${(t0 + d).toFixed(3)})'` +
      `:x='max(${Math.round(pic.x + pic.w * 0.03)},min(${Math.round(pic.x + pic.w * 0.97)}-tw,${x0.toFixed(1)}-tw/2+${wind.toFixed(1)}*${T}))'` +
      `:y='${y0.toFixed(1)}-th/2+0.5*${g.toFixed(1)}*${T}*${T}'` +
      `:alpha='if(lt(${T},0.25),${T}/0.25,if(gt(${T},${(d - 0.8).toFixed(3)}),max(0,(${d.toFixed(3)}-${T})/0.8),1))'`);
  }
  return out;
}
async function endCard(dest, format) {
  const [W, H] = SIZES[format], frames = Math.round(CARD_S * FPS), mw = Math.round(Math.min(W, H) * 0.66 / 2) * 2;
  await ff(["-f", "lavfi", "-i", `color=c=0x08080A:s=${W}x${H}:r=${FPS}:d=${CARD_S}`, "-i", MADE_WITH, "-filter_complex",
            `[1:v]scale=${mw}:-1[m];[0:v][m]overlay=(W-w)/2:(H-h)/2,fade=t=in:st=0:d=0.4,setsar=1,format=yuv420p[v]`,
            "-map", "[v]", "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-r", String(FPS), dest]);
  return frames;
}

// One fixed gain to the target, a brickwall limiter only for peaks that would pass -1.5 dBTP, then measured again: when
// the limiter has taken loudness away (a peaky mix of speech and a building score came out at -15.2 LUFS on the
// 2026-11-23 promo), the same single gain is raised by the shortfall and the pass redone. When a dB of gain buys less
// than 0.3 LU the limiter is doing nearly all the work, and more gain would only crush the peaks: it stops there and
// the mix stays a little quiet. Extra gain is capped at 3 dB, at most 4 passes. Still one gain for the whole file and
// no level-riding (the pulsing in Drive Safe came from that).
async function levelTo(src, out, I, tp, target, tail) {
  const limit = Math.pow(10, TP / 20), base = target - I, MAX_EXTRA = 3;
  let gain = base, applied = base, used = false, got = null, prev = null;
  for (let pass = 0; pass < 4; pass++) {
    const lim = tp + gain > TP;
    const chain = [`volume=${gain.toFixed(2)}dB`];
    if (lim) chain.push(`alimiter=limit=${limit.toFixed(4)}:attack=5:release=50:level=disabled`);
    chain.push("aresample=48000", "aformat=sample_fmts=s16:channel_layouts=stereo", ...tail);
    await ff(["-i", src, "-af", chain.join(","), "-c:a", "pcm_s16le", out]);
    used = used || lim; applied = gain;
    got = (await measure(out)).I;
    if (pass === 3 || !lim || !isFinite(got) || Math.abs(target - got) <= 0.3 || gain >= base + MAX_EXTRA) break;
    // LU gained per dB, from the last two passes (assumed 1 before there are two)
    const slope = prev ? Math.min(1, (got - prev.got) / Math.max(0.01, gain - prev.gain)) : 1;
    if (slope < 0.3) break;
    prev = { gain, got };
    gain = Math.min(base + MAX_EXTRA, gain + (target - got) / slope);
  }
  return { gain_db: Number(applied.toFixed(2)), limiter: used, lufs_out: isFinite(got) ? Number(got.toFixed(1)) : null };
}

// The soundtrack: the creator's music at one constant level, normalised to -14 LUFS; silence when there is none
// (platforms expect a sound track).
async function soundtrack(dir, musicPath, total, notes, target = LUFS, name = "audio.wav") {
  const out = path.join(dir, name);
  if (!musicPath) {
    await ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", total.toFixed(3), "-c:a", "pcm_s16le", out]);
    return { out, lufs: null };
  }
  const src = path.join(dir, "music" + (path.extname(musicPath) || ".mp3"));
  await storage.download(musicPath, src);
  // the app allows 30 MB; a bigger file came in some other way and is not opened (security review 2026-11-19)
  if ((await fs.stat(src)).size > 30 * 1024 * 1024) throw new Error("the music file is over 30 MB; use a smaller MP3, WAV or M4A");
  const mlen = await audioDur(src, true);
  const af = [`atrim=0:${total.toFixed(3)}`, "asetpts=PTS-STARTPTS", "aresample=48000", "aformat=channel_layouts=stereo"];
  if (mlen > total + 0.05) af.push(`afade=t=out:st=${Math.max(0, total - MUSIC_FADE).toFixed(3)}:d=${MUSIC_FADE}`);
  else if (mlen < total - 0.05) notes.push(`The music is ${mlen.toFixed(1)} s long and ends before the cut (${total.toFixed(1)} s); the rest is silent.`);
  af.push(`apad=whole_dur=${total.toFixed(3)}`);
  const bed = path.join(dir, "bed.wav");
  await ff([...SAFE_AUDIO_IN, "-i", src, "-af", af.join(","), "-c:a", "pcm_s16le", bed]);
  // Loudness: measure, then ONE fixed gain to -14 LUFS. Not loudnorm's second pass: its "linear" mode silently turns
  // dynamic when the gain would push peaks over the limit, and dynamic gain is the level-riding that pulsed in Drive
  // Safe. A brickwall limiter only catches the few peaks that would pass -1.5 dBTP.
  const m = JSON.parse((await ffErr(["-i", bed, "-af", `loudnorm=I=${LUFS}:TP=${TP}:LRA=11:print_format=json`, "-f", "null", "-"]))
    .match(/\{[\s\S]*\}/)[0]);
  const I = Number(m.input_i), peak = Number(m.input_tp);
  if (!isFinite(I) || I < -70) {                       // a silent track: nothing to level
    notes.push("The music track is silent.");
    await ff(["-i", bed, "-c:a", "pcm_s16le", out]);
    return { out, lufs: null };
  }
  const lv = await levelTo(bed, out, I, peak, target, [`atrim=0:${total.toFixed(3)}`]);
  return { out, lufs: I, ...lv };
}

// Integrated loudness of a file (LUFS) and its true peak (dBTP).
async function measure(src, untrusted = false) {
  const m = JSON.parse((await ffErr([...(untrusted ? SAFE_AUDIO_IN : []), "-i", src, "-af", `loudnorm=I=${LUFS}:TP=${TP}:LRA=11:print_format=json`, "-f", "null", "-"]))
    .match(/\{[\s\S]*\}/)[0]);
  return { I: Number(m.input_i), tp: Number(m.input_tp) };
}
// One stem (a voiceover line or a sound effect) at one fixed gain, 48 kHz stereo; trimmed to maxS with a short fade.
async function stem(src, dest, target, maxS) {
  const { I } = await measure(src, true);
  const gain = isFinite(I) && I > -70 ? target - I : 0;
  const af = [`volume=${gain.toFixed(2)}dB`, "aresample=48000", "aformat=sample_fmts=s16:channel_layouts=stereo"];
  if (maxS) af.push(`atrim=0:${maxS.toFixed(3)}`, `afade=t=out:st=${Math.max(0, maxS - 0.15).toFixed(3)}:d=0.15`);
  await ff([...SAFE_AUDIO_IN, "-i", src, "-af", af.join(","), "-c:a", "pcm_s16le", dest]);
}

// The cut's sound: the music bed plus each shot's voiceover and sound effect, placed where the shot starts, and the
// scene's narration from its start time.
async function mix(dir, a, opts, starts, lens, total, notes, hits = null) {
  const vo = opts.voice !== false ? a.items.map((it, i) => it.vo ? { i, path: it.vo } : null).filter(Boolean) : [];
  const fx = opts.sfx !== false ? a.items.map((it, i) => it.sfx ? { i, path: it.sfx } : null).filter(Boolean) : [];
  // 2026-11-23: the scene's narration, one take over the whole cut from its start time (options.narration, set by
  // studio.request_assembly from the voiceover with no shot); off with the other voiceovers when "voice" is off
  let nar = opts.voice !== false && opts.narration?.path ? { path: opts.narration.path, at: Math.max(0, Number(opts.narration.at_s) || 0) } : null;
  if (nar && nar.at >= total - 0.05) {
    notes.push(`The narration starts at ${nar.at.toFixed(1)} s, after the end of the video (${total.toFixed(1)} s): it is not heard.`);
    nar = null;
  }
  // the style's hits sit under music or speech; alone they would be raised to -14 LUFS and be the whole soundtrack
  if (hits && !vo.length && !fx.length && !nar && !opts.music_path) {
    notes.push("Edit style: the hits under the shot changes are left out because the cut has no music, voice or effects.");
    hits = null;
  }
  if (!vo.length && !fx.length && !nar && !hits) return { ...(await soundtrack(dir, opts.music_path, total, notes)), voiceovers: 0, effects: 0, speech: [] };
  const speech = [];                                             // each voice take and where it starts (captions)
  const bedTarget = vo.length || nar ? -27 : -20;                // under speech, or under effects only
  const bed = await soundtrack(dir, opts.music_path, total, notes, bedTarget, "bed_level.wav");
  const inputs = [bed.out], filters = [];
  const LEAD = SPEECH_LEAD;                                      // speech starts just after the cut, not on it
  for (const [k, v] of vo.entries()) {
    const src = path.join(dir, `vo_${k}${path.extname(v.path) || ".mp3"}`), dest = path.join(dir, `vo_${k}.wav`);
    await storage.download(v.path, src);
    await stem(src, dest, -16, null);
    const len = await audioDur(dest), at = starts[v.i] + LEAD, ord = a.items[v.i].ord;
    // 2026-11-23 (review): the speech starts LEAD after the cut, so a voiceover as long as its shot still ends a little after
    // it; only a real carry-over (more than 0.3 s) is noted, and the note says by how much
    const spill = at + len - (starts[v.i] + lens[v.i]);
    if (spill > 0.3) {
      const next = vo.find((x) => x.i > v.i);
      const overlap = next && at + len > starts[next.i] + LEAD;
      notes.push(`Shot ${ord}'s voiceover ends ${spill.toFixed(1)} s after the shot: it carries into the next shot` +
                 (overlap ? `, and runs into shot ${a.items[next.i].ord}'s voiceover. Shorten one of them.` : "."));
    }
    if (at + len > total + 0.05) notes.push(`Shot ${ord}'s voiceover is cut off at the end of the video.`);
    v.span = [at, at + len];
    speech.push({ path: v.path, local: src, at });
    inputs.push(dest); filters.push(`[${inputs.length - 1}:a]adelay=${Math.round(at * 1000)}:all=1[s${inputs.length - 1}]`);
  }
  if (nar) {
    const src = path.join(dir, `narration${path.extname(nar.path) || ".mp3"}`), dest = path.join(dir, "narration.wav");
    await storage.download(nar.path, src);
    await stem(src, dest, -16, null);
    const len = await audioDur(dest), end = nar.at + len;
    speech.push({ path: nar.path, local: src, at: nar.at });
    if (end > total + 0.05) notes.push(`The narration (${len.toFixed(1)} s from ${nar.at.toFixed(1)} s) runs ${(end - total).toFixed(1)} s past the end of the video and is cut off. Start it earlier, slow shots down, or shorten it.`);
    const clash = vo.filter((v) => v.span && v.span[0] < end && v.span[1] > nar.at).map((v) => a.items[v.i].ord);
    if (clash.length) notes.push(`The narration plays over shot ${clash.join(", ")}'s own voiceover: both are heard at once. Leave one out.`);
    inputs.push(dest); filters.push(`[${inputs.length - 1}:a]adelay=${Math.round(nar.at * 1000)}:all=1[s${inputs.length - 1}]`);
  }
  for (const [k, v] of fx.entries()) {
    const src = path.join(dir, `fx_${k}${path.extname(v.path) || ".mp3"}`), dest = path.join(dir, `fx_${k}.wav`);
    await storage.download(v.path, src);
    await stem(src, dest, -22, lens[v.i]);                        // an effect belongs to its shot: it ends with it
    inputs.push(dest); filters.push(`[${inputs.length - 1}:a]adelay=${Math.round(starts[v.i] * 1000)}:all=1[s${inputs.length - 1}]`);
  }
  // 2026-11-23: the edit style's hits under the shot changes, one track the length of the cut, at the effects' level
  if (hits) {
    const dest = path.join(dir, "hits_level.wav");
    await stem(hits, dest, -20, null);
    inputs.push(dest); filters.push(`[${inputs.length - 1}:a]anull[s${inputs.length - 1}]`);
  }
  const labels = ["[0:a]", ...inputs.slice(1).map((_, k) => `[s${k + 1}]`)].join("");
  const summed = path.join(dir, "summed.wav");
  await ff([...inputs.flatMap((p) => ["-i", p]), "-filter_complex",
            `${filters.join(";")};${labels}amix=inputs=${inputs.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[m]`,
            "-map", "[m]", "-c:a", "pcm_s16le", summed]);
  // the whole mix: one fixed gain to -14 LUFS, a brickwall only for the peaks that would pass -1.5 dBTP
  const { I, tp } = await measure(summed);
  const out = path.join(dir, "audio.wav");
  // a mix that measures silent (-inf) has nothing to level; gain NaN would fail the cut (review 2026-11-23)
  if (!isFinite(I) || I < -70) {
    notes.push("The sound measured silent, so it was left as it is.");
    await ff(["-i", summed, "-c:a", "pcm_s16le", out]);
    return { out, lufs: null, gain_db: 0, limiter: false, lufs_out: null, voiceovers: vo.length, narration: !!nar, effects: fx.length, music_lufs_before: bed.lufs, speech, hits: !!hits };
  }
  const lv = await levelTo(summed, out, I, tp, LUFS, [`atrim=0:${total.toFixed(3)}`]);
  return { out, lufs: I, ...lv, voiceovers: vo.length, narration: !!nar, effects: fx.length, music_lufs_before: bed.lufs, speech, hits: !!hits };
}

async function checks(file, format, expectFrames, quiet, hasMusic) {
  const [W, H] = SIZES[format], p = await probe(file), res = [];
  res.push({ name: "Size and frame rate", ok: p.w === W && p.h === H && Math.abs(p.fps - FPS) < 0.01,
             detail: `${p.w}x${p.h} at ${p.fps.toFixed(2)} fps (asked ${W}x${H} at ${FPS})` });
  res.push({ name: "Every shot is in, end to end", ok: Math.abs(p.frames - expectFrames) <= 1,
             detail: `${p.frames} frames, the parts add up to ${expectFrames} (${(expectFrames / FPS).toFixed(2)} s)` });
  const err = await ffErr(["-i", file, "-vf", "blackdetect=d=0.4:pix_th=0.10", "-an", "-f", "null", "-"]);
  // planned dark spans (fade in, fade out, end card) that touch are one span: a fade-out runs into the card
  const spans = [...quiet].sort((x, y) => x[0] - y[0]).reduce((acc, [qa, qb]) => {
    const last = acc[acc.length - 1];
    if (last && qa <= last[1] + 0.05) last[1] = Math.max(last[1], qb); else acc.push([qa, qb]);
    return acc;
  }, []);
  const blacks = [...err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((x) => [Number(x[1]), Number(x[2])])
    .filter(([a, b]) => !spans.some(([qa, qb]) => a >= qa - 0.05 && b <= qb + 0.05));
  res.push({ name: "No unplanned black", ok: blacks.length === 0,
             detail: blacks.length ? blacks.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)} s`).join(", ") : "none outside fades and the end card" });
  if (hasMusic) {
    const s = await ffErr(["-i", file, "-af", "ebur128=peak=true", "-vn", "-f", "null", "-"]);
    const I = Number((s.match(/I:\s+(-?[\d.]+) LUFS/g) || []).pop()?.match(/-?[\d.]+/)[0]);
    res.push({ name: "Loudness", ok: Math.abs(I - LUFS) <= 1, detail: `${I} LUFS (target ${LUFS})` });
  }
  return res;
}

// 2026-11-23 (review): the claim's lease is 15 minutes; a long cut (slowed shots) renews it before each step, so another
// worker loop never claims the same cut while it is being built. A lease that was lost stops the build.
async function renew(a) {
  const r = await db.q(`update studio.assemblies set locked_until = now() + interval '15 minutes', updated_at = now()
                         where id = $1 and locked_by = $2 and status = 'running' returning id`, [a.id, config.workerId]);
  if (!r.length) throw Object.assign(new Error("the cut's lease was lost (claimed again or cancelled)"), { leaseLost: true });
}

async function build(a) {
  const dir = path.join(config.workDir, "cuts", a.id);
  await fs.mkdir(dir, { recursive: true });
  const opts = a.options || {}, notes = [];
  if ((a.skipped || []).length) notes.push(`Left out shot${a.skipped.length > 1 ? "s" : ""} ${a.skipped.join(", ")}: no approved clip.`);
  const parts = [], quiet = [], starts = [], lens = [];
  let frames = 0;
  // 2026-11-23: every shot's plan first (clip, trims, speed, length), so the edit style can move the shot changes onto
  // the music's beats before anything is rendered
  const plan = [];
  for (let i = 0; i < a.items.length; i++) {
    const it = a.items[i];
    let src = path.join(config.workDir, it.generation_id, "clip.mp4");    // the worker's own copy, when it has one
    try { await fs.access(src); } catch { src = path.join(dir, `src_${i}.mp4`); await storage.download(it.path, src); }
    const p = await probe(src);
    if (!p.frames) throw new Error(`shot ${it.ord}: the clip has no frames`);
    // 2026-11-22: the shot's trims (seconds off the start and the end of its clip); at least 1 s is always kept
    const skip = Math.max(0, Math.round(Number(it.trim_start || 0) * FPS));
    const cut = Math.max(0, Math.round(Number(it.trim_end || 0) * FPS));
    const keep = Math.max(Math.min(FPS, p.frames), p.frames - skip - cut);
    const from = Math.min(skip, p.frames - keep);
    // 2026-11-22: the shot's speed (0.5 to 2); the trims are in the clip's own seconds, before the speed change
    const speed = Math.min(2, Math.max(0.5, Number(it.speed) || 1));
    plan.push({ it, src, p, keep, from, speed, out: Math.max(1, Math.round(keep / speed)) });
  }
  const sty = style.normalize(opts.style);
  const changes = sty ? style.kinds(plan.length, sty.transitions) : [];
  // 2026-11-24 (match this look): the creator's picture, read once; each shot's curves are made from its own clip below
  let lookRef = null;
  if (sty?.look_ref) {
    try {
      if (!sty.look_ref.startsWith(`${a.owner}/`)) throw new Error("the look picture is not yours");
      const f = path.join(dir, "look_ref" + (path.extname(sty.look_ref) || ".png"));
      await storage.download(sty.look_ref, f);
      if ((await fs.stat(f)).size > 20 * 1024 * 1024) throw new Error("the look picture is over 20 MB");
      lookRef = await style.lookOf(f);
    } catch (e) { notes.push(`Edit style: the look could not be matched (${String(e.message || e).slice(0, 120)}); the default grade is used.`); }
  }
  if (sty?.drops) {
    try { sty._drops = await style.dropMaps(dir, ...SIZES[a.format]); }
    catch (e) { notes.push(`Edit style: the drops on the lens could not be made (${String(e.message || e).slice(0, 120)}).`); }
  }
  let synced = 0;
  if (sty?.beat_sync && opts.music_path && plan.length > 1) {
    // the music's onsets; each shot may end up to 8 frames (0.33 s) early to change on the strongest one near its end
    try {
      const src = path.join(dir, "music_beats" + (path.extname(opts.music_path) || ".mp3"));
      await storage.download(opts.music_path, src);
      if ((await fs.stat(src)).size > 30 * 1024 * 1024) throw new Error("the music file is over 30 MB");
      const r = style.snap(plan.map((x) => x.out), await style.onsets(src, dir, SAFE_AUDIO_IN), FPS);
      // a shot made longer than its clip holds its last frame for the difference (part(): hold)
      r.lens.forEach((n, i) => { plan[i].hold = Math.max(0, n - plan[i].out); plan[i].out = n; });
      synced = r.moved;
      if (synced) notes.push(`Edit style: ${synced} shot change${synced > 1 ? "s" : ""} moved to land on a beat of the music (up to 0.33 s earlier${r.held ? `, or up to 0.25 s later with the last frame held` : ""}).`);
    } catch (e) { notes.push(`Edit style: the music's beats could not be found (${String(e.message || e).slice(0, 120)}); the shots change where they end.`); }
  }
  for (let i = 0; i < plan.length; i++) {
    const { it, src, p, keep, from, speed, out, hold = 0 } = plan[i];
    const first = i === 0, last = i === plan.length - 1;
    const fades = { in: opts.fade && first, out: opts.fade && last };
    const dest = path.join(dir, `p${String(i).padStart(3, "0")}.mp4`);
    if (from || keep < p.frames) notes.push(`Shot ${it.ord}: trimmed to ${(keep / FPS).toFixed(2)} s (from ${(from / FPS).toFixed(2)} s).`);
    if (out !== Math.max(1, Math.round(keep / speed)) || out !== keep) notes.push(`Shot ${it.ord}: ${speed !== 1 ? `at ${Math.round(speed * 100)}% speed, ` : ""}${(out / FPS).toFixed(2)} s in the cut.`);
    // 2026-11-22: end_card puts the credit over the last 2 s of the last shot
    const credit = !!opts.end_card && last ? await madeWithFor(a.owner) : false;
    await renew(a);                                                // slowed shots take minutes each: keep the lease
    const words = Array.isArray(it.words) ? it.words : [];
    const look = sty ? { s: sty, kIn: first ? null : changes[i - 1], kOut: last ? null : changes[i], hold } : null;
    if (look && lookRef) {
      try { look.curves = await style.matchCurves(lookRef, src, p.frames); }
      catch (e) { notes.push(`Edit style: shot ${it.ord} keeps the default grade (${String(e.message || e).slice(0, 100)}).`); }
    }
    try {
      await part(src, dest, a.format, out, fades, from, credit, speed, words, { w: p.w, h: p.h }, look);
    } catch (e) {
      if (!look) throw e;
      // the style is a finish: a shot it fails on goes in without it rather than failing the cut
      notes.push(`Edit style: shot ${it.ord} is in the cut without the style (${String(e.message || e).split("\n")[0].slice(0, 160)}).`);
      await part(src, dest, a.format, out, fades, from, credit, speed, words, { w: p.w, h: p.h }, hold ? { s: null, hold } : null);
    }
    if ((it.words || []).length) notes.push(`Shot ${it.ord}: ${it.words.length} word${it.words.length > 1 ? "s" : ""} drawn over it.`);
    // 2026-11-24: a character the font lacks is drawn as a box, silently; say so (glyphs.js)
    const noGlyph = await glyphs.missing(WORD_FONT, (it.words || []).map((w) => String(w.text || "")).join(" "));
    if (noGlyph.length) notes.push(`Shot ${it.ord}: the words over it use characters the font cannot draw (${glyphs.list(noGlyph)}): they show as boxes.`);
    if (fades.in) quiet.push([frames / FPS, frames / FPS + FADE_IN]);
    starts.push(frames / FPS); lens.push(out / FPS);
    frames += out;
    if (fades.out) quiet.push([frames / FPS - FADE_OUT, frames / FPS]);
    parts.push(dest);
  }
  const list = path.join(dir, "list.txt");
  await fs.writeFile(list, parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const picture = path.join(dir, "picture.mp4");
  await ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", picture]);
  const total = frames / FPS;
  await renew(a);
  // 2026-11-23: the edit style's hits, one under each shot change that is not a straight cut
  let hits = null, hitCount = 0;
  if (sty?.hits && changes.length) {
    const at = changes.map((kind, i) => ({ t: starts[i + 1], kind }));
    hits = await style.hitsTrack(dir, at, total);
    hitCount = at.filter((c) => c.kind !== "cut").length;
  }
  const sound = await mix(dir, a, opts, starts, lens, total, notes, hits);
  const audio = sound.out;
  // 2026-11-23: captions from the voiceovers and the narration (options.captions), drawn over the picture, and a .srt;
  // with an edit style, its title and handle are drawn in the same pass
  let shown = picture, cc = null;
  const [W, H] = SIZES[a.format], over = [];
  if (opts.captions) {
    const words = [];
    for (const sp of sound.speech || []) {
      const w = await captions.takeWords(a.owner, sp.path, sp.local, notes);
      if (w) words.push(...w.map((x) => ({ ...x, start: x.start + sp.at, end: x.end + sp.at })));
    }
    const list = captions.cues(words, total);
    if (!(sound.speech || []).length) notes.push("Captions: this cut has no voiceover or narration to caption.");
    else if (!list.length) notes.push("Captions: no words could be timed, so the cut has none.");
    else {
      const ccFont = sty ? style.SERIF(ASSETS) : WORD_FONT;
      over.push(...await captions.filters(list, dir, ccFont, W, H, sty ? "story" : "plain"));
      const noGlyph = await glyphs.missing(ccFont, list.map((c) => c.text).join(" "));
      if (noGlyph.length) notes.push(`Captions: they use characters the caption font cannot draw (${glyphs.list(noGlyph)}): they show as boxes. The .srt file has them right.`);
      const srtFile = path.join(dir, "captions.srt");
      await fs.writeFile(srtFile, captions.srt(list));
      cc = { lines: list.length, srt: `${a.owner}/cuts/${a.id}.srt` };
      await storage.upload(srtFile, cc.srt, "application/x-subrip");
      notes.push(`Captions: ${list.length} line${list.length > 1 ? "s" : ""}, also as a .srt file.`);
    }
  }
  if (sty) over.push(...await style.overlays(sty, dir, ASSETS, W, H, total, notes));
  if (over.length) {
    shown = path.join(dir, "picture_cc.mp4");
    await renew(a);
    await ff(["-i", picture, "-vf", over.join(","), "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
              "-pix_fmt", "yuv420p", "-r", String(FPS), shown]);
  }
  const final = path.join(dir, "cut.mp4");
  await ff(["-i", shown, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-t", total.toFixed(3), "-movflags", "+faststart", final]);
  const hasSound = !!opts.music_path || sound.voiceovers > 0 || !!sound.narration || sound.effects > 0 || !!sound.hits;
  const report = { checks: await checks(final, a.format, frames, quiet, hasSound), notes,
                   shots: a.items.length, music_lufs_before: sound.music_lufs_before ?? sound.lufs, music_gain_db: sound.gain_db ?? null,
                   music_limiter: sound.limiter ?? false, voiceovers: sound.voiceovers, narration: !!sound.narration, effects: sound.effects,
                   music: !opts.music_path ? null : /\/audio\/music\//.test(opts.music_path) ? "score" : "track", fps: FPS, size: SIZES[a.format],
                   captions: cc,
                   style: sty ? { preset: sty.preset, changes: changes.reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {}),
                                  on_beat: synced, hits: sound.hits ? hitCount : 0, grade: sty.grade, rain: sty.rain, drops: !!sty._drops, look_matched: !!lookRef } : null };
  return { final, total, report, dir };
}

export async function handle(a) {
  try {
    const { final, total, report, dir } = await build(a);
    const [{ paid }] = await db.q("select studio.has_paid($1) as paid", [a.owner]);
    let output = `${a.owner}/cuts/${a.id}.mp4`, preview = null;
    if (!paid) {
      const marked = path.join(dir, "cut_preview.mp4");
      await watermark(final, marked, { audio: true });
      preview = output; output = `${VAULT}/clean/${a.owner}/cuts/${a.id}.mp4`;
      await storage.upload(marked, preview);
    }
    await storage.upload(final, output);
    await db.q(`update studio.assemblies set status = 'done', output_path = $2, preview_path = $3, duration_s = $4, report = $5,
                       error = null, locked_by = null, locked_until = null, updated_at = now() where id = $1 and locked_by = $6`,
               [a.id, output, preview, total.toFixed(3), JSON.stringify(report), config.workerId]);
    const bad = report.checks.filter((c) => !c.ok).map((c) => c.name);
    log(a, `done: ${a.items.length} shots, ${total.toFixed(2)} s, ${a.format}${preview ? ", watermarked copy" : ""}` +
           (bad.length ? `; checks to look at: ${bad.join(", ")}` : "; all checks passed"));
  } catch (e) {
    if (e.leaseLost) { log(a, `stopped: ${e.message}`); return; }  // the other claim owns the job now
    const tries = (a.tries || 0) + 1, give = tries >= 3;
    await db.logError("cut", a.id, a.owner, e, { tries });
    await db.q(`update studio.assemblies set tries = $2, error = $3, status = $4, locked_by = null, locked_until = null,
                       next_try_at = now() + make_interval(secs => $5), updated_at = now() where id = $1 and locked_by = $6`,
               [a.id, tries, String(e.message || e).slice(0, 1000), give ? "failed" : "queued", 30 * tries, config.workerId]);
    log(a, `${give ? "failed" : "error, will retry"}: ${e.message}`);
  }
}

export async function tick() {
  const jobs = await db.q("select * from studio.claim_assemblies($1, 1, 900)", [config.workerId]);
  for (const a of jobs) await handle(a);
  return jobs.length;
}

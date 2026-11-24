// Edit style for a cut (2026-11-23, Londi: "analyze this video ... and build the feature into this app"). @anlim
// "story" is the look of the reference edit Londi sent (a 9:16, 39.6 s football voiceover edit, measured 2026-11-23,
// notes in claude/anlim-edit-style-feature-2026-11-23.md). Everything here is plain ffmpeg on the worker: no AI, no credits.
//   - grade: darker, less saturated, teal shadows, a vignette (the reference drops from luma 97 to 55 where it starts)
//   - transitions between shots, done inside each shot's own part so the cut stays frame-exact and is still joined
//     without re-encoding: "flash" (blur and lift to a bright haze and back, 0.2 s each side; the reference has three,
//     0.32-0.36 s long), "whip" (a sideways smear), "glitch" (2-3 frames of RGB split), "punch" (the next shot starts
//     zoomed in and snaps back), "cut" (nothing). "mixed" rotates them in about the reference's proportions.
//   - a slow push-in on every shot, as on the reference's still-like shots
//   - rain: falling streaks over the picture (the reference's rain and lens drops are in its AI shots; the drops on the
//     lens cannot be made this way, only the streaks)
//   - hits: a whoosh, an impact or a digital click under each transition, made here from noise and tones (the reference
//     has a low hit or a high whoosh at its transitions, +10 to +30 dB over the moment before)
//   - beat_sync: with music, each shot may end up to 0.35 s early so the change lands on a strong onset of the music
//   - captions in a serif with small capitals (Cinzel, OFL), small, low in the frame; a title over the first 3.5 s; a
//     small handle tag (the reference carries its maker's tag above the middle)
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ff = (args) => exec("ffmpeg", ["-nostdin", "-y", "-v", "error", ...args], { maxBuffer: 256 << 20 });

export const TRANSITIONS = ["mixed", "flash", "whip", "glitch", "punch", "cut"];
// the reference's 16 shot changes: 3 flashes, 3 whips, 1 glitch, 1 punch, 6-8 straight cuts; "mixed" keeps that feel
const MIXED = ["flash", "whip", "cut", "flash", "punch", "whip", "glitch", "cut"];
const EDGE = 5;            // frames each side of a shot change for flash and whip (0.21 s at 24 fps)

/** The cut's style from its options, checked again here (request_assembly checks it first); null when plain. */
export function normalize(style) {
  if (!style || typeof style !== "object" || style.preset !== "story") return null;
  const b = (v, d) => (typeof v === "boolean" ? v : d);
  const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n) || null;
  return { preset: "story", transitions: TRANSITIONS.includes(style.transitions) ? style.transitions : "mixed",
           grade: b(style.grade, true), push: b(style.push, true), rain: b(style.rain, false), hits: b(style.hits, true),
           beat_sync: b(style.beat_sync, true), title: clean(style.title, 60), handle: clean(style.handle, 30) };
}

/** The kind of each shot change (n shots, n-1 changes). */
export function kinds(n, mode) {
  return Array.from({ length: Math.max(0, n - 1) }, (_, i) => (mode === "mixed" ? MIXED[i % MIXED.length] : mode));
}

/**
 * The style's part of one shot's filter graph. Starts at [inLabel], ends unlabeled so assemble.js can chain on (words,
 * fades). W x H: the cut's size; frames: the shot's length in the cut; kIn / kOut: the change into and out of this shot.
 */
export function shotGraph(inLabel, W, H, frames, s, kIn, kOut, tag = "s") {
  const L = (x) => `${tag}${x}`, f = [];
  let cur = `[${inLabel}]`, chain = [];
  if (s.grade) chain.push("eq=contrast=1.10:brightness=-0.05:saturation=0.80:gamma=0.94",
                          "colorbalance=rs=-0.06:gs=0.02:bs=0.06:rm=-0.03:bm=0.03:rh=0.02:bh=-0.02", "vignette=angle=PI/4.5");
  // push-in and punch in one zoompan (zoompan with d=1 keeps one frame out per frame in; 'on' is the frame number)
  const push = s.push ? 0.05 : 0, punch = kIn === "punch";
  if (push || punch) {
    const z = `(1+${push}*on/${Math.max(1, frames)})*(1+${punch ? 0.22 : 0}*pow(max(0,1-on/6),2))`;
    // zoompan crops on whole pixels, which makes a slow zoom step unevenly; at twice the size the steps are half as big
    // (tested 2026-11-23 on a still: frame-to-frame change min/mean 0.66 at 1x, 0.81 at 2x; about twice the time)
    chain.push(`scale=${W * 2}:${H * 2}`, `zoompan=z='${z}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=24`, "setsar=1");
  }
  if (s.rain) {
    // streaks: sparse noise at a third of the size, smeared downwards, scaled up and added (screen) to the brightness only
    const rw = Math.round(W / 6) * 2, rh = Math.round(H / 6) * 2;
    f.push(`${cur}${chain.length ? chain.join(",") : "null"}[${L("pic")}]`);
    f.push(`color=c=black:s=${rw}x${rh}:r=24,format=yuv420p,noise=c0s=100:c0f=t,lutyuv=y='if(gt(val,247),235,16)':u=128:v=128,` +
           `avgblur=sizeX=1:sizeY=${Math.max(4, Math.round(rh / 40))},rotate=0.12:c=black,scale=${W}:${H},format=yuv420p[${L("rain")}]`);
    // screen at 30% on the brightness; the colour planes stay the picture's (blend's own opacity on "normal" would take
    // the rain layer's grey there: the first test came out black and white)
    f.push(`[${L("pic")}][${L("rain")}]blend=c0_expr='A+(255-A)*(B-16)/219*0.30':c1_expr=A:c2_expr=A:shortest=1[${L("wet")}]`);
    cur = `[${L("wet")}]`; chain = [];
  }
  // glitch: RGB split and grain on the first 3 frames in / last 2 frames out
  const gl = [kIn === "glitch" ? "lt(n,3)" : null, kOut === "glitch" ? `gte(n,${frames - 2})` : null].filter(Boolean);
  if (gl.length) {
    const on = gl.length > 1 ? `bitor(${gl.join(",")})` : gl[0], px = Math.max(4, Math.round(W * 0.012));
    chain.push(`rgbashift=rh=-${px}:bh=${px}:gv=${Math.round(px / 2)}:edge=wrap:enable='${on}'`, `noise=alls=35:allf=t:enable='${on}'`);
  }
  // whip: a sideways smear, the picture sliding out to the left and the next one sliding in from the right
  const step = 0.08;                                              // of the width per frame: 40% over the EDGE frames
  if (kOut === "whip") chain.push(`scroll=h=${step}:enable='gte(n,${frames - EDGE})'`);
  if (kIn === "whip") chain.push(`scroll=h=${step}:hpos=${(1 - EDGE * step).toFixed(2)}:enable='lt(n,${EDGE})'`);
  const wh = [kIn === "whip" ? `lt(n,${EDGE})` : null, kOut === "whip" ? `gte(n,${frames - EDGE})` : null].filter(Boolean);
  if (wh.length) chain.push(`avgblur=sizeX=${Math.round(W / 14)}:sizeY=1:enable='${wh.length > 1 ? `bitor(${wh.join(",")})` : wh[0]}'`);
  // flash: mixes towards a blurred, brighter copy: fully at the change, nothing EDGE frames from it
  const fIn = kIn === "flash", fOut = kOut === "flash";
  if (fIn || fOut) {
    const t = frames / 24, d = EDGE / 24, T = "T";
    const k = [fIn ? `max(0,1-${T}/${d.toFixed(4)})` : "0", fOut ? `max(0,(${T}-${(t - d).toFixed(4)})/${d.toFixed(4)})` : "0"];
    const sig = Math.max(8, Math.round(Math.min(W, H) * 0.035));
    f.push(`${cur}${chain.length ? chain.join(",") + "," : ""}split[${L("a")}][${L("b")}]`);
    f.push(`[${L("b")}]gblur=sigma=${sig},eq=brightness=0.24:saturation=0.65[${L("haze")}]`);
    // ease the mix (k^0.7) so the haze holds a little at the change, as the reference's does
    f.push(`[${L("a")}][${L("haze")}]blend=all_expr='A+(B-A)*pow(min(1,max(${k[0]},${k[1]})),0.7)'`);
    return f.join(";");
  }
  f.push(`${cur}${chain.length ? chain.join(",") : "null"}`);
  return f.join(";");
}

// ---- music onsets (for beat_sync): spectral flux on a mono 22.05 kHz copy, in plain JS (no numpy on the worker)
function fft(re, im) {                       // in place, radix 2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], xr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, xi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + xr; im[i + k] = ui + xi; re[i + k + len / 2] = ur - xr; im[i + k + len / 2] = ui - xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
/** Onsets of a music file: [{t, s}] (seconds, strength). safeIn: the input whitelist for untrusted audio. */
export async function onsets(file, dir, safeIn, maxS = 600) {
  const raw = path.join(dir, "onsets.f32");
  await ff([...safeIn, "-i", file, "-t", String(maxS), "-ac", "1", "-ar", "22050", "-f", "f32le", raw]);
  const buf = await fs.readFile(raw), x = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  return onsetsOf(x, 22050);
}
export function onsetsOf(x, sr) {
  const N = 1024, hop = 256, win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const flux = [];
  let prev = null;
  for (let p = 0; p + N <= x.length; p += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[p + i] * win[i];
    fft(re, im);
    const mag = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) mag[i] = Math.log1p(10 * Math.hypot(re[i], im[i]));
    let s = 0;
    if (prev) for (let i = 0; i < N / 2; i++) s += Math.max(0, mag[i] - prev[i]);
    flux.push(s); prev = mag;
  }
  // a peak: the largest within +-3 frames and above the median + 1.5 x spread of the second around it
  const w = Math.round(0.5 * sr / hop), out = [];
  for (let i = 1; i < flux.length - 1; i++) {
    const lo = Math.max(0, i - w), hi = Math.min(flux.length, i + w), seg = flux.slice(lo, hi).sort((a, b) => a - b);
    const med = seg[seg.length >> 1], mean = seg.reduce((a, b) => a + b, 0) / seg.length;
    const sd = Math.sqrt(seg.reduce((a, b) => a + (b - mean) ** 2, 0) / seg.length);
    let top = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(flux.length - 1, i + 3); j++) if (flux[j] > flux[i]) top = false;
    if (top && flux[i] > med + 1.5 * sd) {
      const t = i * hop / sr;
      if (!out.length || t - out[out.length - 1].t > 0.12) out.push({ t, s: (flux[i] - med) / (sd || 1) });
    }
  }
  return out;
}

/**
 * beat_sync: frames per shot, each shot ending up to maxCut frames early so the change lands on the strongest onset
 * in that window (never longer: the clip may have no more frames). A shot keeps at least minF frames.
 */
export function snap(lens, ons, fps = 24, maxCut = 8, minF = 24) {
  const out = [...lens];
  let at = 0, moved = 0;
  for (let i = 0; i < out.length - 1; i++) {
    const end = at + out[i];
    const win = ons.filter((o) => o.t * fps <= end + 0.5 && o.t * fps >= end - maxCut && o.s >= 1.5);
    if (win.length) {
      const best = win.reduce((a, b) => (b.s > a.s ? b : a));
      const cut = Math.min(end - Math.round(best.t * fps), out[i] - minF);
      if (cut > 0) { out[i] -= cut; moved++; }
    }
    at += out[i];
  }
  return { lens: out, moved };
}

// ---- hits under the transitions: made from noise and tones with ffmpeg, one track the length of the cut
const HIT = {
  // whoosh: band-passed pink noise rising to the change and falling away after it (peak 0.45 s in)
  whoosh: { lead: 0.45, src: "anoisesrc=d=0.9:c=pink:a=0.9:r=48000",
            af: "highpass=f=700,lowpass=f=7000,volume='if(lt(t,0.45),pow(t/0.45,2),exp(-(t-0.45)*9))':eval=frame" },
  // impact: a falling low tone (55 Hz down) with a short click on top
  impact: { lead: 0, src: "aevalsrc='0.9*sin(2*PI*(58*t-14*t*t))*exp(-3.2*t)+0.35*(random(0)-0.5)*exp(-90*t)':d=1.4:s=48000", af: "lowpass=f=4000" },
  // glitch: a short digital buzz
  glitch: { lead: 0, src: "aevalsrc='0.5*sgn(sin(2*PI*1400*t))*lt(mod(t,0.06),0.03)*exp(-8*t)':d=0.25:s=48000", af: "highpass=f=300" },
};
const HIT_FOR = { flash: "impact", punch: "impact", whip: "whoosh", glitch: "glitch" };

/** A track of the cut's length with a hit at each change; null when there is none. changes: [{t, kind}] in seconds. */
export async function hitsTrack(dir, changes, total) {
  const use = changes.filter((c) => HIT_FOR[c.kind]);
  if (!use.length) return null;
  const files = {};
  for (const k of new Set(use.map((c) => HIT_FOR[c.kind]))) {
    files[k] = path.join(dir, `hit_${k}.wav`);
    await ff(["-f", "lavfi", "-i", HIT[k].src, "-af", `${HIT[k].af},aformat=sample_fmts=s16:channel_layouts=stereo`, "-c:a", "pcm_s16le", files[k]]);
  }
  const inputs = [], filters = [];
  for (const c of use) {
    const k = HIT_FOR[c.kind], at = Math.max(0, c.t - HIT[k].lead);
    inputs.push("-i", files[k]);
    filters.push(`[${inputs.length / 2 - 1}:a]adelay=${Math.round(at * 1000)}:all=1[h${inputs.length / 2 - 1}]`);
  }
  const out = path.join(dir, "hits.wav"), n = inputs.length / 2;
  await ff([...inputs, "-filter_complex", `${filters.join(";")};${Array.from({ length: n }, (_, i) => `[h${i}]`).join("")}` +
            `amix=inputs=${n}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[m]`,
            "-map", "[m]", "-c:a", "pcm_s16le", out]);
  return out;
}

// ---- words over the whole cut: the title and the handle (drawn with the captions, after the transitions, so they stay sharp)
export const SERIF = (assets) => path.join(assets, "fonts", "Cinzel.ttf");
export async function overlays(s, dir, assets, W, H, total, notes) {
  const out = [], v = H > W, m = Math.min(W, H);
  if (s.handle) {
    const file = path.join(dir, "style_handle.txt");
    await fs.writeFile(file, s.handle);
    out.push(`drawtext=fontfile=${SERIF(assets)}:textfile=${file}:expansion=none:fontsize=${Math.round(m * 0.024)}:fontcolor=white@0.55` +
             `:shadowcolor=black@0.4:shadowx=0:shadowy=1:x=(w-tw)/2:y=${Math.round(H * (v ? 0.30 : 0.12))}`);
  }
  if (s.title) {
    const file = path.join(dir, "style_title.txt"), end = Math.min(3.5, total);
    await fs.writeFile(file, s.title);
    if (/[^\u0000-ɏ -⁯]/.test(s.title)) notes.push("The title font has Latin letters only: other letters in the title may show as boxes.");
    const size = Math.round(Math.min(m * 0.062, (W * 0.88) / (s.title.length * 0.62)));
    out.push(`drawtext=fontfile=${path.join(assets, "fonts", "Montserrat-Bold.ttf")}:textfile=${file}:expansion=none:fontsize=${size}` +
             `:fontcolor=white:shadowcolor=black@0.6:shadowx=0:shadowy=3:x=(w-tw)/2:y=${Math.round(H * (v ? 0.42 : 0.40))}-th/2` +
             `:enable='lt(t,${end.toFixed(3)})':alpha='min(1,min(t/0.25,max(0,(${end.toFixed(3)}-t)/0.4)))'`);
  }
  return out;
}

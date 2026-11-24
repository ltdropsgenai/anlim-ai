// Edit style for a cut (2026-11-23, Londi: "analyze this video ... and build the feature into this app"). @anlim
// "story" is the look of the reference edit Londi sent (a 9:16, 39.6 s football voiceover edit, measured 2026-11-23,
// notes in claude/anlim-edit-style-feature-2026-11-23.md). Everything here is plain ffmpeg on the worker: no AI, no credits.
//   - grade: darker, less saturated, teal shadows, a vignette (the reference drops from luma 97 to 55 where it starts)
//   - transitions between shots, done inside each shot's own part so the cut stays frame-exact and is still joined
//     without re-encoding: "flash" (blur and lift to a bright haze and back, 0.2 s each side; the reference has three,
//     0.32-0.36 s long), "whip" (a sideways smear), "glitch" (2-3 frames of RGB split), "punch" (the next shot starts
//     zoomed in and snaps back), "cut" (nothing). "mixed" rotates them in about the reference's proportions.
//   - a slow push-in on every shot, as on the reference's still-like shots
//   - rain: falling streaks over the picture; drops (2026-11-24): water drops on the lens that bend the picture behind
//     them (displace through generated maps), with a dark rim and a highlight
//   - zoom and spin (2026-11-24): the reference's zoom whip and spin whip, in the zoompan of the push-in
//   - look_ref (2026-11-24): every shot's colours matched to a picture the creator chose (matchCurves)
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

export const TRANSITIONS = ["mixed", "flash", "whip", "zoom", "spin", "glitch", "punch", "cut"];
// the reference's 16 shot changes: 3 flashes, 3 whips (one sideways, one zooming, one spinning), 1 glitch, 1 punch, 6-8
// straight cuts; "mixed" keeps that feel. 2026-11-24: "zoom" and "spin" added (the reference's whips at 23 s and 26.6 s).
const MIXED = ["flash", "whip", "cut", "flash", "punch", "zoom", "glitch", "cut", "spin", "cut"];
const EDGE = 5;            // frames each side of a shot change for flash and whip (0.21 s at 24 fps)

/** The cut's style from its options, checked again here (request_assembly checks it first); null when plain. */
export function normalize(style) {
  if (!style || typeof style !== "object" || style.preset !== "story") return null;
  const b = (v, d) => (typeof v === "boolean" ? v : d);
  const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n) || null;
  // look_ref (2026-11-24, "match this look"): a picture in the creator's own folder whose colours every shot is matched to
  const ref = typeof style.look_ref === "string" && /^[0-9a-f-]{36}\/[\w./-]+\.(png|jpe?g|webp)$/i.test(style.look_ref)
    && !style.look_ref.includes("..") ? style.look_ref : null;
  return { preset: "story", transitions: TRANSITIONS.includes(style.transitions) ? style.transitions : "mixed",
           grade: b(style.grade, true), push: b(style.push, true), rain: b(style.rain, false), hits: b(style.hits, true),
           beat_sync: b(style.beat_sync, true), title: clean(style.title, 60), handle: clean(style.handle, 30),
           drops: b(style.drops, false), look_ref: ref };
}

/** The kind of each shot change (n shots, n-1 changes). */
export function kinds(n, mode) {
  return Array.from({ length: Math.max(0, n - 1) }, (_, i) => (mode === "mixed" ? MIXED[i % MIXED.length] : mode));
}

/**
 * The style's part of one shot's filter graph. Starts at [inLabel], ends unlabeled so assemble.js can chain on (words,
 * fades). W x H: the cut's size; frames: the shot's length in the cut; kIn / kOut: the change into and out of this shot.
 */
export function shotGraph(inLabel, W, H, frames, s, kIn, kOut, tag = "s", curves = null) {
  const L = (x) => `${tag}${x}`, f = [];
  let cur = `[${inLabel}]`, chain = [];
  // a matched look (matchCurves) takes the place of the default grade; the vignette stays with the grade setting
  if (curves) chain.push(curves, ...(s.grade ? ["vignette=angle=PI/4.5"] : []));
  else if (s.grade) chain.push("eq=contrast=1.10:brightness=-0.05:saturation=0.80:gamma=0.94",
                          "colorbalance=rs=-0.06:gs=0.02:bs=0.06:rm=-0.03:bm=0.03:rh=0.02:bh=-0.02", "vignette=angle=PI/4.5");
  // push-in, punch, zoom whip and spin whip in one zoompan (zoompan with d=1 keeps one frame out per frame in; 'on' is
  // the frame number). The spin rotates the (doubled) picture first; the zoom of the same window crops its corners away.
  const push = s.push ? 0.05 : 0, punch = kIn === "punch";
  const zIn = kIn === "zoom", zOut = kOut === "zoom", spIn = kIn === "spin", spOut = kOut === "spin";
  const pIn = (v) => `max(0,1-${v}/${EDGE})`, pOut = (v) => `max(0,(${v}-${frames - EDGE})/${EDGE})`;
  if (push || punch || zIn || zOut || spIn || spOut) {
    const terms = [`(1+${push}*on/${Math.max(1, frames)})`, `(1+${punch ? 0.22 : 0}*pow(max(0,1-on/6),2))`];
    // zoom whip: the picture rushes in, 1 to 2.2x over the EDGE frames (out), and the next settles from 2.2x (in)
    if (zOut) terms.push(`(1+1.2*pow(${pOut("on")},2))`);
    if (zIn) terms.push(`(1+1.2*pow(${pIn("on")},2))`);
    // spin: up to 0.45 rad; 1.85x zoom hides the rotated corners at 9:16 (cos a + 1.78 sin a = 1.67)
    if (spOut) terms.push(`(1+0.85*${pOut("on")})`);
    if (spIn) terms.push(`(1+0.85*${pIn("on")})`);
    // zoompan crops on whole pixels, which makes a slow zoom step unevenly; at twice the size the steps are half as big
    // (tested 2026-11-23 on a still: frame-to-frame change min/mean 0.66 at 1x, 0.81 at 2x; about twice the time)
    chain.push(`scale=${W * 2}:${H * 2}`);
    const ang = [spOut ? `0.45*pow(${pOut("n")},1.6)` : null, spIn ? `-0.45*pow(${pIn("n")},1.6)` : null].filter(Boolean);
    if (ang.length) {
      const win = [spIn ? `lt(n,${EDGE})` : null, spOut ? `gte(n,${frames - EDGE})` : null].filter(Boolean);
      chain.push(`rotate=a='${ang.join("+")}':c=black:enable='${win.length > 1 ? `bitor(${win.join(",")})` : win[0]}'`);
    }
    chain.push(`zoompan=z='${terms.join("*")}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=24`, "setsar=1");
    // motion blur for the whips, strongest on the frames next to the change (gblur cannot change per frame, so two
    // windows: light over the EDGE frames, heavy over the 2 nearest). A spin keeps it light, or the turn cannot be seen
    // (tested 2026-11-24: at sigma 19 the 14-degree turn was lost in the blur).
    const zw = (k) => [zIn || (k === "light" && spIn) ? `lt(n,${k === "light" ? EDGE : 2})` : null,
                       zOut || (k === "light" && spOut) ? `gte(n,${frames - (k === "light" ? EDGE : 2)})` : null].filter(Boolean);
    const en = (w) => (w.length > 1 ? `bitor(${w.join(",")})` : w[0]);
    if (zw("light").length) chain.push(`gblur=sigma=${Math.max(3, Math.round(Math.min(W, H) * 0.006))}:enable='${en(zw("light"))}'`);
    if (zw("heavy").length) chain.push(`gblur=sigma=${Math.max(5, Math.round(Math.min(W, H) * 0.012))}:enable='${en(zw("heavy"))}'`);
  }
  // drops on the lens (2026-11-24): the picture is bent through each drop (displace, with maps made once per cut by
  // dropMaps), then darkened at the rim and lit at one edge (an overlay of the drops' shading)
  if (s.drops && s._drops) {
    f.push(`${cur}${chain.length ? chain.join(",") : "null"}[${L("dry")}]`);
    f.push(`movie=${s._drops.x},loop=loop=-1:size=1:start=0,setpts=N/24/TB,format=yuv420p[${L("dx")}]`);
    f.push(`movie=${s._drops.y},loop=loop=-1:size=1:start=0,setpts=N/24/TB,format=yuv420p[${L("dy")}]`);
    f.push(`movie=${s._drops.shade},loop=loop=-1:size=1:start=0,setpts=N/24/TB,format=rgba[${L("ds")}]`);
    f.push(`[${L("dry")}][${L("dx")}][${L("dy")}]displace=edge=smear[${L("bent")}]`);
    f.push(`[${L("bent")}][${L("ds")}]overlay=0:0:shortest=1,format=yuv420p[${L("drop")}]`);
    cur = `[${L("drop")}]`; chain = [];
  }
  if (s.rain) {
    // streaks: sparse noise at a third of the size, smeared downwards, scaled up and added (screen) to the brightness only
    const rw = Math.round(W / 6) * 2, rh = Math.round(H / 6) * 2;
    f.push(`${cur}${chain.length ? chain.join(",") : "null"}[${L("pic")}]`);
    f.push(`color=c=black:s=${rw}x${rh}:r=24,format=yuv420p,noise=c0s=100:c0f=t,lutyuv=y='if(gt(val,247),255,0)':u=128:v=128,` +
           `avgblur=sizeX=1:sizeY=${Math.max(4, Math.round(rh / 40))},rotate=0.12:c=black,scale=${W}:${H},format=yuv420p[${L("rain")}]`);
    // screen at 30% on the brightness; the colour planes stay the picture's (blend's own opacity on "normal" would take
    // the rain layer's grey there: the first test came out black and white).
    // 2026-11-23 (review): blend's built-in screen mode instead of a per-pixel expression, which on the worker's ffmpeg
    // 5.1 took minutes per shot (the flash had the same problem). The streaks are drawn 0..255 rather than 16..235 so
    // screen gives the same mix as the expression did (A + (255-A) x B/255 x 0.30); tested on a Kijan shot: luma PSNR
    // 46 dB against the old version, mean brightness within 0.3, 9.8 s against 17.9 s locally.
    f.push(`[${L("pic")}][${L("rain")}]blend=c0_mode=screen:c0_opacity=0.30:c1_mode=normal:c1_opacity=1:c2_mode=normal:c2_opacity=1:shortest=1[${L("wet")}]`);
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
    // 2026-11-23 (first story cut on the worker): blend's expression runs per pixel and gblur on every frame, so a shot
    // with a flash took 5.7 min on ffmpeg 5.1. Both now run only in the EDGE frames around the change (timeline
    // 'enable'); outside it k is 0, blend passes its first input through and the haze branch is never shown.
    const win = [fIn ? `lt(t,${d.toFixed(4)})` : null, fOut ? `gte(t,${(t - d - 1 / 24).toFixed(4)})` : null].filter(Boolean);
    const en = `:enable='${win.length > 1 ? `gt(${win.join("+")},0)` : win[0]}'`;
    f.push(`[${L("b")}]gblur=sigma=${sig}${en},eq=brightness=0.24:saturation=0.65${en}[${L("haze")}]`);
    // ease the mix (k^0.7) so the haze holds a little at the change, as the reference's does
    f.push(`[${L("a")}][${L("haze")}]blend=all_expr='A+(B-A)*pow(min(1,max(${k[0]},${k[1]})),0.7)'${en}`);
    return f.join(";");
  }
  f.push(`${cur}${chain.length ? chain.join(",") : "null"}`);
  return f.join(";");
}

// ---- drops on the lens (2026-11-24): displacement maps and shading, made once per cut, the same on every shot
// (a camera standing in the rain keeps its drops). Seeded, so a cut made again looks the same.
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
export async function dropMaps(dir, W, H, seed = 7) {
  const r = rng(seed), m = Math.min(W, H), n = Math.round(14 * (W * H) / (1080 * 1920)) + 8;
  const drops = Array.from({ length: n }, () => ({ x: r() * W, y: r() * H, r: m * (0.012 + 0.03 * r() * r()) }));
  const Y = new Uint8Array(W * H).fill(128), X = new Uint8Array(W * H).fill(128);
  const shade = new Uint8Array(W * H * 4);                           // RGBA, transparent
  for (const d of drops) {
    const x0 = Math.max(0, Math.floor(d.x - d.r)), x1 = Math.min(W - 1, Math.ceil(d.x + d.r));
    const y0 = Math.max(0, Math.floor(d.y - d.r)), y1 = Math.min(H - 1, Math.ceil(d.y + d.r * 1.15));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = (x - d.x) / d.r, dy = (y - d.y) / (d.r * 1.15), u2 = dx * dx + dy * dy;   // a little taller than wide
      if (u2 >= 1) continue;
      const k = 1.5 * Math.sqrt(1 - u2), i = y * W + x;   // past 1: the view through a drop is upside down, like a real one
      // a drop is a small lens: it samples the picture closer to its centre (magnified, compressed at the rim)
      X[i] = Math.max(1, Math.min(255, Math.round(128 - (x - d.x) * k)));
      Y[i] = Math.max(1, Math.min(255, Math.round(128 - (y - d.y) * k)));
      const u = Math.sqrt(u2), o = i * 4;
      let a = 0.06, c = 0;                                           // a slight darkening over the whole drop
      if (u > 0.78) a = 0.06 + 0.34 * (u - 0.78) / 0.22;             // a darker rim
      const hx = dx + 0.38, hy = dy + 0.42, h = hx * hx + hy * hy;   // a highlight up and to the left
      if (h < 0.045) { c = 255; a = 0.55 * (1 - h / 0.045); }
      if (a * 255 > shade[o + 3]) { shade[o] = shade[o + 1] = shade[o + 2] = c; shade[o + 3] = Math.round(a * 255); }
    }
  }
  // the maps as one-frame YUV4MPEG files: displace reads each plane of a map for the same plane of the picture, so the
  // colour planes (half size) carry half the displacement
  const y4m = async (file, plane) => {
    const cw = W >> 1, ch = H >> 1, u = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) u[y * cw + x] = Math.round(128 + (plane[(2 * y) * W + 2 * x] - 128) / 2);
    await fs.writeFile(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F24:1 Ip A1:1 C420jpeg\nFRAME\n`), plane, u, u]));
  };
  const out = { x: path.join(dir, "drops_x.y4m"), y: path.join(dir, "drops_y.y4m"), shade: path.join(dir, "drops_shade.png") };
  await y4m(out.x, X); await y4m(out.y, Y);
  const raw = path.join(dir, "drops_shade.rgba");
  await fs.writeFile(raw, shade);
  await ff(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-i", raw, "-frames:v", "1", out.shade]);
  return out;
}

// ---- match this look (2026-11-24): every shot's colours matched to a picture the creator chose. In YUV: the brightness
// by histogram matching (tones), the two colour planes by mean and spread (Reinhard-style colour transfer: a sepia
// picture pulls every shot's colours towards its warm, narrow range, which per-RGB-channel matching could not; tested
// 2026-11-24, a blue shirt stayed blue that way). Eased 15% back towards the shot's own values, applied with lutyuv.
const IMG_IN = ["-format_whitelist", "image2,png_pipe,jpeg_pipe,webp_pipe", "-protocol_whitelist", "file"];
async function yuvStats(args, w, h) {
  const { stdout } = await exec("ffmpeg", ["-nostdin", "-v", "error", ...args, "-f", "rawvideo", "-pix_fmt", "yuv444p", "pipe:1"],
    { encoding: "buffer", maxBuffer: 64 << 20 });
  const px = w * h, frames = Math.floor(stdout.length / (px * 3)), hist = new Float64Array(256);
  const m = [0, 0], q = [0, 0];
  for (let f = 0; f < frames; f++) {
    const o = f * px * 3;
    for (let i = 0; i < px; i++) {
      hist[stdout[o + i]]++;
      for (let c = 0; c < 2; c++) { const v = stdout[o + px * (c + 1) + i]; m[c] += v; q[c] += v * v; }
    }
  }
  const n = Math.max(1, frames * px), tot = hist.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const cdf = Array.from(hist, (v) => (acc += v) / tot);
  const mean = m.map((v) => v / n), sd = q.map((v, c) => Math.sqrt(Math.max(1, v / n - mean[c] ** 2)));
  return { cdf, mean, sd };
}
export async function lookOf(refFile) {
  return yuvStats([...IMG_IN, "-i", refFile, "-vf", "scale=240:240", "-frames:v", "1"], 240, 240);
}
export async function matchCurves(ref, clipFile, frames) {
  const step = Math.max(1, Math.floor(frames / 8));
  const src = await yuvStats(["-i", clipFile, "-vf", `select='not(mod(n,${step}))',scale=160:160`, "-frames:v", "8",
    "-fps_mode", "passthrough"], 160, 160);
  // brightness: 17 points of the matched tone curve, as a piecewise-linear lutyuv expression
  const map = [];
  for (let v = 0, u = 0; v < 256; v++) { while (u < 255 && ref.cdf[u] < src.cdf[v]) u++; map.push(u); }
  const pts = [];
  for (let k = 0; k <= 16; k++) {
    const x = Math.min(255, k * 16), y = 0.85 * map[x] + 0.15 * x;
    pts.push([x, Math.max(pts.length ? pts[pts.length - 1][1] : 0, y)]);
  }
  let yExpr = `${pts[16][1].toFixed(2)}`;
  for (let k = 15; k >= 0; k--) {
    const [x0, y0] = pts[k], [x1, y1] = pts[k + 1], a = (y1 - y0) / (x1 - x0);
    yExpr = `if(lt(val,${x1}),${y0.toFixed(2)}+${a.toFixed(4)}*(val-${x0}),${yExpr})`;
  }
  // colour: shift and scale each colour plane to the picture's mean and spread (spread ratio kept within 0.25-2.5)
  const c = (i) => {
    const k = Math.min(2.5, Math.max(0.15, ref.sd[i] / src.sd[i])), mean = ref.mean[i];
    const kk = 0.92 * k + 0.08;
    return `clip(${mean.toFixed(2)}+${kk.toFixed(4)}*(val-${src.mean[i].toFixed(2)}),16,240)`;
  };
  return `format=yuv420p,lutyuv=y='clip(${yExpr},16,235)':u='${c(0)}':v='${c(1)}'`;
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
 * beat_sync: frames per shot, each shot ending up to maxCut frames early, or (2026-11-24) up to maxHold frames late, so
 * the change lands on the strongest onset in that window. Running late holds the shot's last frame (assemble.js pads
 * it before the style, so the push-in keeps moving over it). A shot keeps at least minF frames.
 */
export function snap(lens, ons, fps = 24, maxCut = 8, minF = 24, maxHold = 6) {
  const out = [...lens];
  let at = 0, moved = 0, held = 0;
  for (let i = 0; i < out.length - 1; i++) {
    const end = at + out[i];
    const win = ons.filter((o) => o.t * fps <= end + maxHold && o.t * fps >= end - maxCut && o.s >= 1.5);
    if (win.length) {
      const best = win.reduce((a, b) => (b.s > a.s ? b : a));
      const to = Math.round(best.t * fps);
      if (to < end) {
        const cut = Math.min(end - to, out[i] - minF);
        if (cut > 0) { out[i] -= cut; moved++; }
      } else if (to > end) { out[i] += to - end; moved++; held++; }
    }
    at += out[i];
  }
  return { lens: out, moved, held };
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
const HIT_FOR = { flash: "impact", punch: "impact", whip: "whoosh", zoom: "whoosh", spin: "whoosh", glitch: "glitch" };

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
const TITLE_FONTS = [[/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/, "NotoSansArabic-Bold.ttf"],
  [/[\u0590-\u05ff]/, "NotoSansHebrew-Bold.ttf"], [/[\u0900-\u097f]/, "NotoSansDevanagari-Bold.ttf"], [/[\u0e00-\u0e7f]/, "NotoSansThai-Bold.ttf"]];
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
    // 2026-11-24: the title's script picks the font (Noto, OFL); drawtext shapes and orders right-to-left text itself
    // (text_shaping, on by default where ffmpeg has fribidi). Latin, Cyrillic and Vietnamese stay in Montserrat.
    const font = TITLE_FONTS.find(([re]) => re.test(s.title))?.[1] || "Montserrat-Bold.ttf";
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(s.title))
      notes.push("The title has Chinese, Japanese or Korean letters, which the title fonts do not have: they may show as boxes.");
    const size = Math.round(Math.min(m * 0.062, (W * 0.88) / (s.title.length * 0.62)));
    out.push(`drawtext=fontfile=${path.join(assets, "fonts", font)}:textfile=${file}:expansion=none:fontsize=${size}` +
             `:fontcolor=white:shadowcolor=black@0.6:shadowx=0:shadowy=3:x=(w-tw)/2:y=${Math.round(H * (v ? 0.42 : 0.40))}-th/2` +
             `:enable='lt(t,${end.toFixed(3)})':alpha='min(1,min(t/0.25,max(0,(${end.toFixed(3)}-t)/0.4)))'`);
  }
  return out;
}

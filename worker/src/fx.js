// Shot effects (2026-11-27, Londi: "I want to build the same effects and more cinematic production effects into
// anlim.ai", from a short-form VFX reference; tiers 1 and 2 of claude/anlim-vfx-effects-plan-2026-11-27.md). @anlim
// All plain ffmpeg on the worker plus a CPU person matte (matte.py, MediaPipe): no AI model, no credits.
//
// A shot's fx (studio.shots.fx, checked by studio.set_shot_fx):
//   tier 1  look      moody | bw | warm | cool | teal_orange | vivid        a colour preset for this shot
//           title     { text, at_s, dur_s, color, y }                     big words that pop in ("HYPER SPEED EFFECT")
//           stickers  [{ kind, text, at_s, dur_s, x, y, size }]           pow, boom, wow, zap, arrow, circle, star
//           frame     { kind: "phone", views, bg, x, size, pop_out }       the clip playing on a phone, a view count under it
//           layout    { kind: pip | split | compare, labels }             with another shot's clip (item.with_path)
//   tier 2  behind    { text, color, y }                                  big words behind the person
//           ghost     { copies, delay_s, opacity }                        see-through copies a moment behind
//           trails    { copies, gap }                                     after-images of a fast move
//           clone     { x, delay_s, mirror }                              a second copy of the person beside them
//           frame.pop_out                                                 the person comes out over the phone's edge
// The clip-level effects (tier 2, look, frame, layout) are a pass over the clip before the cut takes it (prepass): the
// trims, speed, edit style and words then apply to the result as to any clip. The title and stickers are timed in the
// cut (after the speed change), like the words over a shot, and are drawn in the shot's own pass (overlays).
// Bold captions (options.caption_style "bold"): two or three words at a time, the word being said in yellow (assCaptions).
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as textpic from "./textpic.js";

const exec = promisify(execFile);
const ff = (args) => exec("ffmpeg", ["-nostdin", "-y", "-v", "error", ...args], { maxBuffer: 256 << 20 });
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FONTS = path.join(HERE, "..", "assets", "fonts");
const FONT = path.join(FONTS, "Montserrat-Bold.ttf");
const FXIMG = path.join(HERE, "fximg.py"), MATTE = path.join(HERE, "matte.py");
const POSE = path.join(process.env.FRAME_CHECK_DIR || path.join(HERE, "..", "..", "checker", "frame_check"), "models", "pose_landmarker_full.task");
const FPS = 24;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export const LOOKS = {
  moody: "eq=contrast=1.12:brightness=-0.06:saturation=0.78,colorbalance=rs=-0.05:bs=0.06:rh=0.03,vignette=angle=PI/4",
  bw: "hue=s=0,eq=contrast=1.18:brightness=-0.02,vignette=angle=PI/5",
  warm: "colorbalance=rm=0.08:gm=0.02:bm=-0.08:rh=0.05:bh=-0.05,eq=saturation=1.1",
  cool: "colorbalance=rm=-0.06:bm=0.08:bs=0.05,eq=saturation=0.95",
  teal_orange: "colorbalance=rs=-0.08:gs=0.02:bs=0.10:rh=0.10:gh=0.02:bh=-0.10,eq=saturation=1.15:contrast=1.06",
  vivid: "eq=saturation=1.35:contrast=1.08",
};
export const STICKERS = ["pow", "boom", "wow", "zap", "arrow", "circle", "star"];
const COLORS = { yellow: [255, 214, 0], white: [255, 255, 255], red: [235, 38, 38], green: [60, 220, 90], blue: [60, 160, 255] };

// ASS text: no override blocks or escapes from the creator's words
const assText = (s) => String(s || "").replace(/[\u0000-\u001f]/g, " ").replace(/[{}]/g, "").replace(/\\/g, "/").trim();
const bgr = ([r, g, b]) => `&H00${[b, g, r].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}&`;
const assTime = (s) => {
  const cs = Math.max(0, Math.round(s * 100)), h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, x = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
async function assFile(file, W, H, styles, events) {
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n` +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n";
  const st = styles.map((s) => `Style: ${s.name},Montserrat,${Math.round(s.size)},${s.color || "&H00FFFFFF&"},&H00FFFFFF&,&H00000000&,&H90000000&,-1,0,0,0,100,100,0,0,1,` +
    `${Math.max(1, Math.round(s.size * (s.outline ?? 0.09)))},${Math.max(0, Math.round(s.size * (s.shadow ?? 0.05)))},${s.align || 2},${s.ml || 30},${s.mr || 30},${Math.round(s.mv || 0)},1`).join("\n");
  const ev = events.map((e) => `Dialogue: ${e.layer || 0},${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`).join("\n");
  await fs.writeFile(file, `${head}${st}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev}\n`);
  return `ass=${file}:fontsdir=${FONTS}`;
}
async function img(spec, png) {
  const file = png.replace(/\.png$/, ".json");
  await fs.writeFile(file, JSON.stringify(spec));
  const { stdout } = await exec("python3", ["-I", FXIMG, file, png], { maxBuffer: 1 << 20, timeout: 60_000 });
  return JSON.parse(stdout.trim().split("\n").pop());
}
async function probe(p) {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", p]);
  const j = JSON.parse(stdout), s = (j.streams || [])[0] || {};
  return { w: s.width, h: s.height, dur: Number(j.format?.duration || 0) };
}

/** The shot's fx with every value in range, or null when it has none. Unknown keys are dropped. */
export function normalize(fx) {
  if (!fx || typeof fx !== "object") return null;
  const o = {};
  if (LOOKS[fx.look]) o.look = fx.look;
  if (fx.title?.text) o.title = { text: assText(fx.title.text).slice(0, 40), at_s: clamp(fx.title.at_s, 0, 600, 0), dur_s: clamp(fx.title.dur_s, 0.5, 10, 2.2),
                                  color: COLORS[fx.title.color] ? fx.title.color : "yellow", y: clamp(fx.title.y, 0.05, 0.95, 0.35) };
  if (Array.isArray(fx.stickers)) {
    const s = fx.stickers.filter((x) => STICKERS.includes(x?.kind)).slice(0, 6).map((x) => ({ kind: x.kind, text: assText(x.text).slice(0, 10) || null,
      at_s: clamp(x.at_s, 0, 600, 0), dur_s: clamp(x.dur_s, 0.3, 10, 1.5), x: clamp(x.x, 0, 1, 0.5), y: clamp(x.y, 0, 1, 0.3), size: clamp(x.size, 0.3, 3, 1) }));
    if (s.length) o.stickers = s;
  }
  if (fx.frame?.kind === "phone") o.frame = { kind: "phone", views: assText(fx.frame.views).slice(0, 10) || null,
    bg: ["blur", "dark", "grid"].includes(fx.frame.bg) ? fx.frame.bg : "blur", x: clamp(fx.frame.x, 0, 1, 0.5), size: clamp(fx.frame.size, 0.5, 0.95, 0.82),
    pop_out: !!fx.frame.pop_out };
  else if (["pip", "split", "compare"].includes(fx.layout?.kind)) o.layout = { kind: fx.layout.kind,
    labels: Array.isArray(fx.layout.labels) ? fx.layout.labels.slice(0, 2).map((t) => assText(t).slice(0, 24)) : [] };
  if (fx.behind?.text) o.behind = { text: assText(fx.behind.text).slice(0, 20), color: COLORS[fx.behind.color] ? fx.behind.color : "white", y: clamp(fx.behind.y, 0.05, 0.95, 0.3) };
  if (fx.ghost) o.ghost = { copies: Math.round(clamp(fx.ghost.copies, 1, 3, 1)), delay_s: clamp(fx.ghost.delay_s, 0.2, 2, 0.6), opacity: clamp(fx.ghost.opacity, 0.15, 0.8, 0.45) };
  if (fx.trails) o.trails = { copies: Math.round(clamp(fx.trails.copies, 2, 8, 5)), gap: Math.round(clamp(fx.trails.gap, 1, 6, 2)) };
  if (fx.clone) o.clone = { x: clamp(fx.clone.x, -0.6, 0.6, 0.3), delay_s: clamp(fx.clone.delay_s, 0, 3, 0), mirror: !!fx.clone.mirror };
  return Object.keys(o).length ? o : null;
}

export const needsMatte = (fx) => !!(fx && (fx.behind || fx.ghost || fx.trails || fx.clone || fx.frame?.pop_out));
const needsPrepass = (fx) => !!(fx && (needsMatte(fx) || fx.look || fx.frame || fx.layout));

/** The people in a clip as a grey video (matte.py). Returns { file, frames, found }. */
export async function matte(src, dest) {
  const { stdout } = await exec("python3", ["-I", MATTE, src, dest, POSE], { maxBuffer: 4 << 20, timeout: 20 * 60_000 });
  return { file: dest, ...JSON.parse(stdout.trim().split("\n").pop()) };
}

/** The clip with its clip-level effects, at 24 fps: the clip's own size, or the cut's (W x H) with a frame or layout.
 *  item.with_path: the other shot's clip for a layout (downloaded by the caller as `second`). Returns the new file or
 *  the clip itself when nothing applies; what was done goes into notes. */
export async function prepass({ src, dir, tag, fx, W, H, second = null, notes, label }) {
  if (!needsPrepass(fx)) return src;
  const p = await probe(src);
  const w0 = even(p.w), h0 = even(p.h), dur = p.dur, m0 = Math.min(w0, h0);
  const inputs = ["-i", src], f = [];
  const loopImg = (png) => { inputs.push("-loop", "1", "-framerate", String(FPS), "-t", (dur + 1).toFixed(3), "-i", png); return (inputs.filter((x) => x === "-i").length - 1); };
  f.push(`[0:v]setpts=PTS-STARTPTS,fps=${FPS},scale=${w0}:${h0},format=yuv420p[a0]`);
  let cur = "a0", person = null, done = [];
  if (needsMatte(fx)) {
    const mt = await matte(src, path.join(dir, `${tag}_matte.mp4`));
    if (!mt.found) notes.push(`${label}: no person was found in the clip, so the cut-out effects show nothing.`);
    else if (mt.found < mt.frames * 0.6) notes.push(`${label}: a person was found in ${mt.found} of ${mt.frames} frames; the cut-out effects drop out where there is none.`);
    inputs.push("-i", mt.file);
    const mi = inputs.filter((x) => x === "-i").length - 1;
    const onTop = !!(fx.behind || fx.trails || fx.ghost), pop = !!fx.frame?.pop_out;
    const copies = (fx.ghost?.copies || 0) + (fx.trails?.copies || 0) + (fx.clone ? 1 : 0) + (onTop ? 1 : 0) + (pop ? 1 : 0);
    f.push(`[${mi}:v]setpts=PTS-STARTPTS,fps=${FPS},scale=${w0}:${h0},format=gray[mt]`,
           `[a0]split=2[base0][pc]`, `[pc]format=rgba[pcr]`, `[pcr][mt]alphamerge,split=${Math.max(1, copies)}${Array.from({ length: Math.max(1, copies) }, (_, k) => `[p${k}]`).join("")}`);
    cur = "base0";
    let k = 0;
    const take = () => `p${k++}`;
    if (fx.behind) {
      const size = Math.min(m0 * 0.24, (w0 * 0.92) / Math.max(1, fx.behind.text.length * 0.68));
      const seg = await assFile(path.join(dir, `${tag}_behind.ass`), w0, h0, [{ name: "B", size, color: bgr(COLORS[fx.behind.color]), outline: 0.04, shadow: 0.06, align: 5 }],
        [{ start: 0, end: dur + 1, style: "B", text: `{\\pos(${Math.round(w0 / 2)},${Math.round(fx.behind.y * h0)})}${fx.behind.text.toUpperCase()}` }]);
      f.push(`[${cur}]${seg}[bh]`); cur = "bh"; done.push("words behind the person");
    }
    const lay = (layer, x = 0) => { const out = `l${k}_${layer}`; f.push(`[${cur}][${layer}]overlay=x=${x}:y=0:shortest=1[${out}]`); cur = out; };
    if (fx.trails) {
      // oldest first, fading out; a little blur so they read as motion
      for (let c = fx.trails.copies; c >= 1; c--) {
        const src2 = take(), op = (0.55 * (1 - c / (fx.trails.copies + 1))).toFixed(3);
        f.push(`[${src2}]tpad=start=${c * fx.trails.gap}:start_mode=clone,gblur=sigma=${Math.max(1, Math.round(m0 / 400))},colorchannelmixer=aa=${op}[tr${c}]`);
        lay(`tr${c}`);
      }
      done.push(`${fx.trails.copies} after-images`);
    }
    if (fx.ghost) {
      for (let c = fx.ghost.copies; c >= 1; c--) {
        const src2 = take();
        f.push(`[${src2}]tpad=start=${Math.round(c * fx.ghost.delay_s * FPS)}:start_mode=clone,colorchannelmixer=aa=${(fx.ghost.opacity / c).toFixed(3)}[gh${c}]`);
        lay(`gh${c}`);
      }
      done.push(`${fx.ghost.copies} ghost${fx.ghost.copies > 1 ? "s" : ""}`);
    }
    if (fx.clone) {
      const src2 = take();
      f.push(`[${src2}]${fx.clone.delay_s > 0 ? `tpad=start=${Math.round(fx.clone.delay_s * FPS)}:start_mode=clone,` : ""}${fx.clone.mirror ? "hflip," : ""}null[cl]`);
      lay("cl", Math.round(fx.clone.x * w0));
      done.push("a clone");
    }
    // the person as filmed goes back on top, in front of the words, the copies and the ghosts
    if (onTop) lay(take());
    if (pop) person = take();                         // the person alone, for stepping out of the phone
    if (!copies) f.push("[p0]nullsink");
  }
  if (fx.look) { f.push(`[${cur}]${LOOKS[fx.look]}[lk]`); cur = "lk"; done.push(`the ${fx.look.replace("_", " ")} look`); }
  if (fx.frame) {
    const tall = H >= W;
    const sh = even(H * fx.frame.size), sw = even(sh * 9 / 19.5);
    const ph = await img({ mode: "phone", w: sw, h: sh }, path.join(dir, `${tag}_phone.png`));
    const px = Math.round(Math.min(W - ph.w, Math.max(0, fx.frame.x * W - ph.w / 2))), py = Math.round((H - ph.h) / 2);
    const sx = px + ph.screen_x, sy = py + ph.screen_y;
    // stepping out: the clip is laid out a little wider and taller than the screen; the screen shows its middle and the
    // person, drawn again over the phone, shows past the screen's edge where they reach it
    const ex = fx.frame.pop_out ? even(sw * 0.16) : 0, eu = fx.frame.pop_out ? even(sh * 0.14) : 0;
    const CW = sw + 2 * ex, CH = sh + eu;
    const iMask = loopImg(path.join(dir, `${tag}_phone_mask.png`)), iPhone = loopImg(path.join(dir, `${tag}_phone.png`));
    f.push(`[${cur}]scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH},split=2[fc][fb]`);
    f.push(`[fc]crop=${sw}:${sh}:${ex}:${eu},format=rgba[fs]`, `[${iMask}:v]format=gray,scale=${sw}:${sh}[fm]`, `[fs][fm]alphamerge[scr]`);
    if (fx.frame.bg === "blur") f.push(`[fb]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:3,eq=brightness=-0.25,setsar=1[bg]`);
    else if (fx.frame.bg === "grid") {
      await img({ mode: "grid", w: W, h: H }, path.join(dir, `${tag}_grid.png`));
      const ig = loopImg(path.join(dir, `${tag}_grid.png`));
      f.push(`[fb]nullsink`, `[${ig}:v]scale=${W}:${H},format=yuv420p[bg]`);
    } else f.push(`[fb]nullsink`, `color=c=0x0b0b0e:s=${W}x${H}:r=${FPS}:d=${(dur + 1).toFixed(3)}[bg]`);
    f.push(`[bg][scr]overlay=${sx}:${sy}:shortest=1[f1]`, `[f1][${iPhone}:v]overlay=${px}:${py}:shortest=1[f2]`);
    cur = "f2";
    if (fx.frame.views) {
      const bs = Math.round(Math.min(W, H) * 0.034);
      const b = await img({ mode: "badge", text: fx.frame.views, size: bs, font: FONT }, path.join(dir, `${tag}_badge.png`));
      const ib = loopImg(path.join(dir, `${tag}_badge.png`));
      f.push(`[${cur}][${ib}:v]overlay=${Math.round(sx + sw * 0.06)}:${Math.round(sy + sh - b.h - sh * 0.05)}:shortest=1[f3]`);
      cur = "f3";
    }
    if (fx.frame.pop_out && person) {
      f.push(`[${person}]scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH}[pp]`,
             `[${cur}][pp]overlay=${sx - ex}:${sy - eu}:shortest=1[f4]`);
      cur = "f4"; done.push("the person stepping out of the phone");
    }
    done.push(`on a phone${fx.frame.views ? ` with ${fx.frame.views} views` : ""} (${fx.frame.bg} background)`);
    if (!tall) done.push("placed in a wide frame");
  } else if (fx.layout && second) {
    inputs.push("-i", second);
    const si = inputs.filter((x) => x === "-i").length - 1;
    const frames = Math.round(dur * FPS);
    f.push(`[${si}:v]setpts=PTS-STARTPTS,fps=${FPS},tpad=stop_mode=clone:stop=${frames}[b0]`);
    const tall = H >= W;
    if (fx.layout.kind === "pip") {
      const bw = even(tall ? W * 0.5 : W * 0.34), bh = even(tall ? bw * 0.75 : bw * 9 / 16);
      await img({ mode: "round", w: bw, h: bh, r: 0.1 }, path.join(dir, `${tag}_round.png`));
      const ir = loopImg(path.join(dir, `${tag}_round.png`));
      const bx = tall ? (W - bw) / 2 : W - bw - W * 0.04, by = tall ? H * 0.60 : H - bh - H * 0.06;
      f.push(`[${cur}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[lm]`,
             `[b0]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},format=rgba[bb]`, `[${ir}:v]format=gray[rm]`, `[bb][rm]alphamerge[bx]`,
             `[lm][bx]overlay=${Math.round(bx)}:${Math.round(by)}:shortest=1[ly]`);
      done.push("the other shot in a box over it");
    } else {
      const hw = tall ? W : even(W / 2), hh = tall ? even(H / 2) : H;
      f.push(`[${cur}]scale=${hw}:${hh}:force_original_aspect_ratio=increase,crop=${hw}:${hh},setsar=1[ha]`,
             `[b0]scale=${hw}:${hh}:force_original_aspect_ratio=increase,crop=${hw}:${hh},setsar=1[hb]`,
             `[ha][hb]${tall ? "vstack" : "hstack"}=inputs=2:shortest=1,scale=${W}:${H},drawbox=${tall ? `x=0:y=${H / 2 - 3}:w=${W}:h=6` : `x=${W / 2 - 3}:y=0:w=6:h=${H}`}:color=white:t=fill[ly0]`);
      let last = "ly0";
      if (fx.layout.kind === "compare" && fx.layout.labels.some(Boolean)) {
        const size = Math.min(W, H) * 0.06;
        const ev = fx.layout.labels.map((t, i) => t ? { start: 0, end: dur + 1, style: "L",
          text: `{\\pos(${Math.round(tall ? W / 2 : W / 4 + i * W / 2)},${Math.round(tall ? H * 0.06 + i * H / 2 : H * 0.08)})}${t.toUpperCase()}` } : null).filter(Boolean);
        const seg = await assFile(path.join(dir, `${tag}_labels.ass`), W, H, [{ name: "L", size, color: bgr(COLORS.yellow), align: 8 }], ev);
        f.push(`[${last}]${seg}[ly1]`); last = "ly1";
      }
      f.push(`[${last}]null[ly]`);
      done.push(fx.layout.kind === "split" ? "split with the other shot" : "side by side with the other shot");
    }
    cur = "ly";
  } else if (fx.layout && !second) notes.push(`${label}: the layout needs the other shot's kept clip; it is left out.`);
  f.push(`[${cur}]format=yuv420p[v]`);
  const out = path.join(dir, `${tag}_fx.mp4`);
  await ff([...inputs, "-filter_complex", f.join(";"), "-map", "[v]", "-t", dur.toFixed(3), "-an", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS), out]);
  if (done.length) notes.push(`${label}: ${done.join(", ")}.`);
  return out;
}

/** Filter segments for the shot's own pass (times in the cut, after the speed change): the title and the stickers.
 *  pic: where the picture sits in the frame (as for words). */
export async function overlays(fx, dir, tag, W, H, pic = { x: 0, y: 0, w: W, h: H }) {
  const out = [];
  if (!fx) return out;
  if (fx.title) {
    const m = Math.min(pic.w, pic.h), t = fx.title;
    const size = Math.min(m * 0.16, (pic.w * 0.9) / Math.max(4, Math.min(t.text.length, 10) * 0.62));
    const x = Math.round(pic.x + pic.w / 2), y = Math.round(pic.y + t.y * pic.h);
    // pops in: from 40% to 112% in 0.12 s, settles at 100%; fades out over the last 0.2 s
    const text = `{\\pos(${x},${y})\\fad(0,200)\\fscx40\\fscy40\\t(0,120,\\fscx112\\fscy112)\\t(120,220,\\fscx100\\fscy100)}${t.text.toUpperCase()}`;
    out.push(await assFile(path.join(dir, `${tag}_title.ass`), W, H,
      [{ name: "T", size, color: bgr(COLORS[t.color]), outline: 0.07, shadow: 0.06, align: 5, ml: Math.round(pic.x + pic.w * 0.05), mr: Math.round(W - pic.x - pic.w * 0.95) }],
      [{ start: t.at_s, end: t.at_s + t.dur_s, style: "T", text }]));
  }
  for (const [k, s] of (fx.stickers || []).entries()) {
    const size = Math.round(Math.min(pic.w, pic.h) * 0.30 * s.size);
    const png = path.join(dir, `${tag}_st${k}.png`);
    await img({ mode: "sticker", kind: s.kind, text: s.text, size, font: FONT }, png);
    const T = `(t-${s.at_s.toFixed(3)})`;
    const x0 = pic.x + s.x * pic.w, y0 = pic.y + s.y * pic.h;
    // drops in from a little above with a springy bounce, then holds
    out.push(textpic.overlay(png, `fx${k}`, { fps: FPS, t0: s.at_s, t1: s.at_s + s.dur_s, fin: 0.08, fout: 0.15,
      x: `${x0.toFixed(1)}-w/2`, y: `${y0.toFixed(1)}-h/2-${(size * 0.35).toFixed(1)}*exp(-12*${T})*cos(18*${T})` }));
  }
  return out;
}

/** Bold captions (options.caption_style "bold"): the reference's look. Two or three words at a time in bold capitals
 *  with a heavy outline; the word being said is yellow and the line pops in. words: [{text, start, end}] in cut time. */
export async function assCaptions(words, dir, W, H, total) {
  const all = words.filter((w) => w.start < total && String(w.text || "").trim()).sort((a, b) => a.start - b.start);
  const lines = [];
  let cur = [];
  const flush = () => { if (cur.length) lines.push(cur); cur = []; };
  for (const w of all) {
    const prev = cur[cur.length - 1];
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (cur.length >= 3 || len > 18 || w.start - prev.end > 0.6 || /[.!?…,]$/.test(prev.text))) flush();
    cur.push({ ...w, text: assText(w.text).toUpperCase() });
  }
  flush();
  const m = Math.min(W, H), size = m * 0.078, ev = [];
  lines.forEach((ln, i) => {
    const end = Math.min(lines[i + 1]?.[0].start ?? total, total, Math.max(ln[ln.length - 1].end + 0.3, ln[0].start + 0.6));
    ln.forEach((w, j) => {
      const s = j === 0 ? ln[0].start : w.start, e = j === ln.length - 1 ? end : ln[j + 1].start;
      if (e - s < 0.02) return;
      const pop = j === 0 ? "{\\fscx70\\fscy70\\t(0,90,\\fscx105\\fscy105)\\t(90,160,\\fscx100\\fscy100)}" : "";
      const text = ln.map((x, q) => q === j ? `{\\c${bgr(COLORS.yellow)}}${x.text}{\\c&H00FFFFFF&}` : x.text).join(" ");
      ev.push({ start: s, end: e, style: "C", text: pop + text });
    });
  });
  if (!ev.length) return null;
  const mv = H > W ? H * 0.27 : H * 0.10;          // above TikTok's and Reels' caption and button area in 9x16
  return { seg: await assFile(path.join(dir, "captions_bold.ass"), W, H, [{ name: "C", size, outline: 0.11, shadow: 0.06, align: 2, mv }], ev), lines: lines.length };
}

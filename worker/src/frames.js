// Frame jobs: stills the image model makes for a shot, approved by the creator before use. @anlim
//   end   : how the shot ends: this shot's start still, edited.
//   start : the shot's start still. mode continue   = last frame of the previous approved clip (no image model, free);
//                                   mode reposition = a still (or the previous clip's last frame), edited;
//                                   mode new_setup  = the location's empty-room plate + each character's reference image;
//                                   mode prompt     = drawn from the shot's description alone (text to image, 2026-11-19).
//   plate : a location's empty room: every character removed from a shot's start still.
//   height: an uploaded start still, height-checked only (frame_check height_check.py; no image model, 0 credits).
//   cutout: each character of a shot's start still cut out onto white (frame_check cutout.py, with the location's
//           plate when it fits). No image model, free; the creator then picks which cut-out is which character.
// Every edit is rebuilt with frame_check end_frame.compose onto its base (source_path: the edited still, or the
// plate for new_setup): the room stays pixel-for-pixel, only characters come from the edit; then it is checked.
//   queued    : (clip -> last frame) ; prompt -> fal image edit                   -> running   (continue: -> ready)
//   running   : poll; when done, download + store the raw edit                   -> composing
//   composing : checker /compose -> store the result + check, charge             -> ready
// Edit model: 2026-11-13 bake-off (Londi): Nano Banana 2 was the only one of three that changed nothing but the
// characters (GPT Image 2.6 and Seedream 5.0 Lite moved props or the whole picture), and the fastest.
// Photoreal new setups (2026-11-17 bake-off, Londi approved): GPT Image 2.6 Sunburst edit - it kept the room's layout
// every time and seated / sized the people right, where Nano Banana 2 moved or zoomed the room and drew standing people
// giant-sized. The endpoint is chosen by studio.request_start_frame from the series' look.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import * as db from "./db.js";
import * as storage from "./storage.js";
import * as moderate from "./moderate.js";
import * as fal from "./providers/fal.js";
import * as mock from "./providers/mock.js";
import { GAZE, lookWords, subjects, wantsExtras, wantsText } from "./compile.js";

const providers = { fal, mock };
const provider = () => providers[process.env.IMAGE_PROVIDER || "fal"];
const log = (j, msg) => console.log(`${new Date().toISOString()} [frame ${String(j.id).slice(0, 8)}] ${msg}`);
const later = (ms) => new Date(Date.now() + ms);

// What every checker frame route is told about the shot (2026-11-16): the look and the cast's kinds, which pick the
// detector classes and the matting model (frame_check end_frame.subjects).
const who = (look, characters) => { if (!look) throw new Error("no look for this job"); return { look, subjects: subjects(characters || []) }; };

// A cast member in a prompt: name, what it is, how it looks ("Rex (golden retriever): red collar").
const castText = (c) => [c.what ? `${c.name} (${c.what})` : c.name, c.wardrobe].filter(Boolean).join(": ");
// What must stay the same about each kind: clothes for people, fur and markings for animals, shape and colours for objects.
const sameLooks = (chars) => {
  const k = new Set(chars.map((c) => c.kind || "person"));
  return [k.has("person") ? "same clothes" : null, k.has("animal") ? "same fur and markings" : null,
          k.has("object") ? "same shape and colours" : null].filter(Boolean).join(", ") || "same clothes";
};

// Same wording as the bake-off prompts that worked: say what changes, then pin everything else.
export function editPrompt(instruction, chars, look) {
  const cast = chars.map(castText).join("; ");
  return `Edit this image. ${instruction.trim().replace(/\.?$/, ".")} ` +
    "Only the characters change: where they are, their poses and where they look. Keep the setting (room or outdoors), " +
    `its layout, the props, the colors, the lighting, the ${lookWords(look)} and the camera framing ` +
    `exactly the same. Same characters${cast ? ` (${cast})` : ""}, same size, ${sameLooks(chars)}. ` +
    `${wantsExtras(instruction) ? "Add only the extras the instruction asks for." : "Nobody else appears."} ${wantsText(instruction) ? "Only the text the instruction asks for." : "No new text."}`;
}

// Plate: the 2026-11-13 feasibility prompt, without the room's own furniture named.
// 2026-11-13 live (S1 hand-off): "remove every character" left the toy truck Layana was holding floating in mid-air,
// so anything a character holds or carries goes with them.
// 2026-11-16: people and animals always go; a cast member that is an object (a robot, a toy that is a character) too.
export function platePrompt(look, chars = []) {
  const objs = chars.filter((c) => c.kind === "object").map(castText);
  return "Edit this image. Remove every person and every animal completely, together with anything they are holding " +
    "or carrying (a toy in a character's hands goes too; nothing is left floating in the air)" +
    (objs.length ? `, and also remove ${objs.join("; ")}` : "") + ". Show the same empty setting " +
    "exactly as it is: the same layout, furniture or landscape, the props that stand on the ground, shelves or furniture, " +
    `the colors, lighting, ${lookWords(look)} and camera framing. Fill in whatever was covered. Nobody left in it. No new text.`;
}
export const PLATE_PROMPT = platePrompt("cartoon");     // the cartoon wording, kept for tests

// what a new setup keeps of each reference: faces, hair and clothes for people; fur and markings for animals; shape,
// colours and details for objects.
// 2026-11-22 (Londi's promo, first chat-made setup): a person with wardrobe set came out in the blazer and dress shoes of
// their reference photo, because "same clothes" won over the wardrobe. 
// When any person in the shot has a wardrobe, only faces and hair are kept from the references and the lines below say
// what each person wears: their wardrobe, or the clothes of their reference image.
const dressed = (c) => (c?.kind || "person") === "person" && !!String(c?.wardrobe || "").trim();
function setupSame(names, chars) {
  const cs = names.map((n) => chars.find((c) => c.name === n));
  const kinds = new Set(cs.map((c) => c?.kind || "person"));
  const people = cs.filter((c) => (c?.kind || "person") === "person");
  const clothes = people.some(dressed) ? "faces, hair" : "faces, hair, clothes";
  const keep = [kinds.has("person") ? clothes : null, kinds.has("animal") ? "fur, markings" : null,
                kinds.has("object") ? "shape, colours, details" : null].filter(Boolean);
  return `same ${keep.join(", ")}`;
}
// "Londi wears a dark hooded jacket, hood up (not the clothes in his reference image)."
function setupWardrobe(names, chars) {
  const cs = names.map((n) => chars.find((c) => c.name === n) || { name: n });
  if (!cs.some(dressed)) return "";
  return cs.filter((c) => (c.kind || "person") === "person")
    .map((c) => dressed(c) ? `${c.name} wears ${String(c.wardrobe).trim().replace(/\.$/, "")} (not the clothes or shoes in the reference image).`
                           : `${c.name} wears the same clothes as in their reference image.`).join(" ");
}

// New setup: image 1 is the plate, then one reference image per character (2026-11-13 feasibility prompt).
export function setupPrompt(instruction, names, heights = [], look, chars = []) {
  const who = names.map((n, i) => `image ${i + 2} is ${n}`).join(", ");
  const h = names.map((n, i) => ({ n, v: Number(heights[i]) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  const sizes = h.slice(1).map((x, i) => (x.v < h[i].v * 0.97 ? `${x.n} is shorter than ${h[i].n}.` : `${x.n} is about as tall as ${h[i].n}.`));
  return `Image 1 is the setting. ${who[0].toUpperCase()}${who.slice(1)}: draw ${names.length > 1 ? "them" : "this character"} ${setupWardrobe(names, chars) ? "as" : "exactly as"} in ${names.length > 1 ? "those images" : "that image"}, ` +
    `${setupSame(names, chars)}, proportions and ${lookWords(look)}, at the same scale relative to the setting. ` +
    (setupWardrobe(names, chars) ? setupWardrobe(names, chars) + " " : "") +
    `Place ${names.length > 1 ? "them" : "the character"} in the setting of image 1: ${instruction.trim().replace(/\.?$/, ".")} ` +
    (sizes.length ? sizes.join(" ") + " " : "") +
    `Keep the setting of image 1 exactly as it is: same layout, props, colors, lighting, ${lookWords(look)} and camera ` +
    `framing. ${GAZE} ${wantsExtras(instruction) ? "Add only the extras the instruction asks for." : "Nobody else."} ${wantsText(instruction) ? "Only the text the instruction asks for." : "No new text."}`;
}

// Start frame from the description (mode "prompt", 2026-11-19): a new project's first shot has no room, cast or
// previous clip to start from, so the still is drawn from the shot's words alone (text to image, 16:9). The creator
// can then cut character references out of it, and later shots continue from its clip.
export function framePrompt(instruction, look, style = null, chars = [], aspect = "16:9") {
  // 2026-11-19 held-out test: the first wording ("everyone in their starting positions", "real people and places",
  // "a wide or medium shot that shows the whole setting") made Nano Banana 2 add people who were never asked for on
  // 9 of 20 first-time-user prompts (a family around the cat, a film crew next to the horse, four gardeners and no
  // hummingbird). The frame now shows only what the description names, at the framing it asks for.
  const cast = chars.map(castText).join("; ");
  const looks = look === "photoreal"
    ? "A real photograph: natural light, a real camera lens, not drawn, not 3D, not animated."
    : "A clean cartoon illustration with a consistent drawing style, clear shapes and readable faces.";
  const shape = { "16:9": "16:9 landscape", "9:16": "9:16 vertical", "1:1": "1:1 square", "4:3": "4:3", "3:4": "3:4 portrait", "21:9": "21:9 widescreen" }[aspect] || aspect;
  return `The first frame of a short video clip, ${shape}, composed for that shape. The clip: ${instruction.trim().replace(/\.?$/, ".")} ` +
    "Draw only the moment the clip starts, before the action happens. Show exactly the subjects the description names " +
    "and no other people, animals or characters: if it names one subject, show only that one (background extras only " +
    "if the description asks for a crowd or a busy place). Keep the main subject fully inside the frame. Use the framing " +
    `the description asks for (close-up, wide shot...); if it asks for none, a medium shot of the subject. ${GAZE} ${looks}` +
    (style ? ` Style: ${style.trim().replace(/\.?$/, ".")}` : "") +
    (cast ? ` Characters: ${cast}.` : "") +
    (wantsText(instruction) ? " Only the text the description asks for, spelled correctly; no captions, no logos, no watermark."
      : " No text, no captions, no logos, no watermark.");
}

// "Recreate this frame" (2026-11-24): an uploaded picture (a frame of a video, a photo) redrawn in the project's look.
// The composition is the picture's: same camera, framing, poses, number of people and where they stand; only the look
// changes (and, when the project has a cast, each person becomes the cast member the creator's words name).
export function restylePrompt(instruction, look, style = null, chars = []) {
  const cast = chars.map(castText).join("; ");
  const looks = look === "photoreal"
    ? "a real photograph: natural light, a real camera lens, not drawn, not 3D, not animated"
    : "a cartoon (or the animated style below): drawn or rendered, clearly not a photograph";
  return `Redraw this exact picture as ${looks}. Keep its composition exactly: the same camera angle, framing and lens, ` +
    "the same number of people, each in the same place and the same pose, the same motion and the same setting. " +
    "Change only the look of everything in it. Keep it the first frame of a video clip: no frame, border or caption." +
    (style ? ` Style: ${style.trim().replace(/\.?$/, ".")}` : "") +
    (cast ? ` The people become these characters, matched by the creator's words: ${cast}.` : "") +
    (instruction ? ` The creator's notes: ${instruction.trim().replace(/\.?$/, ".")}` : "") +
    " No logos, no brand marks, no text, no watermark.";
}

// Nano Banana 2 takes an aspect ratio, not a size: pick the supported ratio nearest the start still's.
const RATIOS = ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"];
export function nearestRatio(w, h) {
  const r = w / h;
  return RATIOS.reduce((best, s) => {
    const [a, b] = s.split(":").map(Number);
    return Math.abs(Math.log(a / b / r)) < Math.abs(Math.log(best.v)) ? { s, v: a / b / r } : best;
  }, { s: "16:9", v: 1e9 }).s;
}
async function pngSize(file) {
  const b = await fs.readFile(file);
  if (b.slice(1, 4).toString() !== "PNG") return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function fetchTo(url, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (url.startsWith("file://")) return fs.copyFile(url.slice(7), dest);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

async function fail(j, error) {
  await db.settleFrame(j.id, "release");
  await db.updateFrame(j.id, { status: "failed", error: String(error).slice(0, 1000), locked_by: null, locked_until: null });
  log(j, `failed: ${error}`);
}

const ext = (p) => (path.extname(p || "").toLowerCase() || ".png");
const isClip = (p) => /\.(mp4|mov|webm)$/i.test(p || "");

async function checker(route, body) {
  const r = await fetch(`${config.checkerUrl}${route}`, {
    method: "POST", headers: { Authorization: `Bearer ${config.checkerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await r.json().catch(() => ({ verdict: "ERROR", error: `checker HTTP ${r.status}` }));
  if (!r.ok || res.verdict === "ERROR") throw new Error(`${route.slice(1)}: ${res.error || r.status}`);
  return res;
}

// The job's base still on local disk (the compose base). A clip is turned into its last frame first, stored once
// under the job's folder, and source_path then points at that still.
async function baseStill(j, shot) {
  const dir = path.join(config.workDir, "frames", j.id);
  let src = j.source_path || shot?.start_frame_path;          // end jobs made before 2026-11-13 have no source_path
  if (!src) throw Object.assign(new Error("the job has no still to start from"), { permanent: true });
  if (isClip(src)) {
    const clip = path.join(dir, "source" + ext(src)), png = path.join(dir, "source.png");
    await storage.download(src, clip);
    await checker("/last_frame", { video: clip, out_png: png });
    src = `${j.owner}/frames/${j.id}/source.png`;
    await storage.upload(png, src, "image/png");
    await db.updateFrame(j.id, { source_path: src });
    j.source_path = src;
    return png;
  }
  const local = path.join(dir, "base" + ext(src));
  try { await fs.access(local); } catch { await storage.download(src, local); }
  return local;
}

// 2026-11-16: the height check on every new start still (frame_check height_check.py). Standing pairs are measured
// (free); seated, cut-off or different-distance pairs are one AI question (about $0.01, paid by us, not the creator).
// It never blocks the still: on any error the result says the height was not checked.
async function heightCheck(j, characters, still, plate, look) {
  const cast = characters.filter((c) => c.height_units);
  if (cast.length < 2) return { verdict: "NOT CHECKED", problems: [], notes: ["fewer than two characters with a height on their card"] };
  const dir = path.join(config.workDir, "frames", j.id);
  try {
    const list = [];
    for (const c of cast) {
      let ref = null;
      if (c.ref_front_path) {
        ref = path.join(dir, `ref-${c.id}${ext(c.ref_front_path)}`);
        try { await fs.access(ref); } catch { await storage.download(c.ref_front_path, ref); }
      }
      list.push({ name: c.name, height: Number(c.height_units), ref });
    }
    const r = await checker("/height", { still, cast: list, plate: plate || null, out: path.join(dir, "height"), ...who(look, characters),
                                          fake_verdict: process.env.FAKE_HEIGHT || undefined });
    log(j, `height ${r.verdict}${r.usd ? ` ($${r.usd})` : ""}`);
    return { verdict: r.verdict, problems: r.problems || [], notes: r.notes || [], usd: r.usd || 0 };
  } catch (e) {
    log(j, `height check skipped: ${e.message}`);
    return { verdict: "NOT CHECKED", problems: [], notes: [`the height check did not run: ${e.message.slice(0, 200)}`] };
  }
}

// Physical staging of a made still: seated people really on the seat, feet on the floor, hands holding (2026-11-17,
// Kijan: "not even sitting on the sofa"). Never blocks the still; on any error the result says it was not checked.
async function stagingCheck(j, characters, still, look) {
  const dir = path.join(config.workDir, "frames", j.id);
  try {
    const r = await checker("/still_check", { still, instruction: j.instruction, out: path.join(dir, "staging"), ...who(look, characters),
                                              fake_verdict: process.env.FAKE_STAGING || undefined });
    log(j, `staging ${r.verdict}${r.usd ? ` ($${r.usd})` : ""}`);
    return { verdict: r.verdict, problems: r.problems || [], usd: r.usd || 0 };
  } catch (e) {
    log(j, `staging check skipped: ${e.message}`);
    return { verdict: "NOT CHECKED", problems: [], notes: [`the staging check did not run: ${e.message.slice(0, 200)}`] };
  }
}

// 2026-11-26 (KAMK face test, Londi's labels): 13 of 21 face failures already had the wrong face in the start image, and
// the clip check compares each clip with its own start image, so they passed. Before animate: does each person in a made
// start or end image look like their uploaded photo? Photoreal only (the face model cannot tell drawn faces apart), the
// shot's named cast only. Free (no API). A FLAG for the creator to look at, never a block: animate then needs their
// explicit approval, as for any flagged start image.
async function faceCheck(j, shot, characters, still, look) {
  if (look !== "photoreal") return null;
  if (!(shot?.cast_ids || []).length) return { verdict: "NOT CHECKED", problems: [], notes: ["the shot names no cast"] };
  const cast = characters.filter((c) => (c.kind || "person") === "person" && c.ref_front_path);
  if (!cast.length) return { verdict: "NOT CHECKED", problems: [], notes: ["no one in this shot has an uploaded photo"] };
  const dir = path.join(config.workDir, "frames", j.id);
  try {
    const refs = {};
    for (const c of cast) {
      const ref = path.join(dir, `ref-${c.id}${ext(c.ref_front_path)}`);
      try { await fs.access(ref); } catch { await storage.download(c.ref_front_path, ref); }
      refs[c.name] = [ref];
    }
    const r = await checker("/face_start", { still, refs, look, fake_verdict: process.env.FAKE_FACES || undefined });
    log(j, `faces ${r.verdict}`);
    return { verdict: r.verdict, problems: r.problems || [], notes: r.notes || [], people: r.people || {} };
  } catch (e) {
    log(j, `face check skipped: ${e.message}`);
    return { verdict: "NOT CHECKED", problems: [], notes: [`the face check did not run: ${e.message.slice(0, 200)}`] };
  }
}

// A face flag makes the whole image FLAG (animate then waits for the creator's approval) and says why first.
function withFaces(check, faces) {
  if (!faces) return check;
  check.faces = faces;
  if (faces.verdict === "FLAG") {
    // the room/layout check's own verdict and words stay for the app's room badge
    check.room_verdict = check.verdict; check.room_why = check.why ?? null;
    check.verdict = "FLAG";
    check.why = [faces.problems.join("; "), check.why].filter(Boolean).join(". ");
  }
  return check;
}

// The location's plates (one per camera framing, latest first) on local disk; one that cannot be downloaded is skipped.
async function localPlates(j, paths) {
  const dir = path.join(config.workDir, "frames", j.id), out = [];
  for (const [i, p] of (paths || []).entries()) {
    const local = path.join(dir, `plate-${i}${ext(p)}`);
    try { await fs.access(local); out.push(local); continue; } catch { /* download below */ }
    try { await storage.download(p, local); out.push(local); } catch (e) { log(j, `plate ${p} not downloaded: ${e.message}`); }
  }
  return out;
}

// where the finished still goes: start stills under stills/ (where set_start_frame expects them), plates under locations/
const outPath = (j) => j.kind === "start" ? `${j.owner}/stills/sf-${j.id}.png`
  : j.kind === "plate" ? `${j.owner}/locations/plate-${j.id}.png` : `${j.owner}/frames/${j.id}/end.png`;

// 2026-11-16: reference images cut out of a still (matting + still-minus-plate), uploaded under characters/ where
// set_character_ref expects them; check_result.cutouts lists them left to right with their warnings.
async function stepCutout(j, shot, base, look, characters) {
  const dir = path.join(config.workDir, "frames", j.id);
  const plates = await localPlates(j, j.ref_paths || []);       // every plate of the location (2026-11-16)
  const res = await checker("/cutouts", { image: base, plates, out_dir: path.join(dir, "cutouts"), ...who(look, characters) });
  const list = [];
  for (const c of res.cutouts || []) {
    const dest = `${j.owner}/characters/cut-${j.id}-${c.index}.png`;
    await storage.upload(c.path, dest, "image/png");
    list.push({ index: c.index, path: dest, box: c.box, warnings: c.warnings || [], plate_used: !!c.plate_used });
  }
  await db.settleFrame(j.id, "release");                         // nothing was reserved; marks it settled
  const check = { verdict: list.length ? "PASS" : "FLAG", cutouts: list, drift: [],
                  why: list.length ? `${list.length} character(s) cut out` : "no character found in the still" };
  await db.updateFrame(j.id, { status: "ready", check_result: JSON.stringify(check), locked_by: null, locked_until: null });
  log(j, `cutouts ready: ${list.length}`);
}

async function stepQueued(j) {
  const { shot, characters, look, stylePrompt, aspect } = await db.frameContext(j);
  if (j.kind === "start" && j.mode === "prompt") {
    // no image to start from: text to image only
    const prompt = framePrompt(j.instruction || shot?.action || "", look, stylePrompt, characters, aspect);
    // content check (2026-11-23) before the image model is paid
    await moderate.guard({ kind: "frame", ref: j.id, owner: j.owner, look, text: moderate.shotWords({ ...shot, style_prompt: stylePrompt }, characters, j.instruction) });
    // 2026-11-21: the project's shape (was always 16:9)
    const sub = await provider().submit(j.endpoint, { prompt, num_images: 1, aspect_ratio: aspect, resolution: "1K", output_format: "png" });
    await db.updateFrame(j.id, { status: "running", prompt, provider_request_id: sub.requestId, provider_status_url: sub.statusUrl,
      provider_response_url: sub.responseUrl, submitted_at: new Date(), next_poll_at: later(5000), tries: 0,
      locked_by: null, locked_until: null });
    return log(j, `start/prompt submitted to ${j.endpoint} (${sub.requestId})`);
  }
  const base = await baseStill(j, shot);
  if (j.kind === "cutout") return stepCutout(j, shot, base, look, characters);
  if (j.kind === "height") {
    // an uploaded start still (2026-11-16): only the height check; nothing reserved, nothing charged
    const height = await heightCheck(j, characters, base, null, look);
    await db.settleFrame(j.id, "release");
    const check = withFaces({ verdict: "PASS", drift: [], why: "height check only", height }, await faceCheck(j, shot, characters, base, look));
    await db.updateFrame(j.id, { status: "ready", check_result: JSON.stringify(check),
      locked_by: null, locked_until: null });
    return log(j, `uploaded start still: height ${height.verdict}`);
  }
  if (j.kind === "start" && j.mode === "continue") {
    // no image model: the previous clip's last frame is the start still
    const out = outPath(j);
    await storage.upload(base, out, "image/png");
    await db.settleFrame(j.id, "release");                       // nothing was reserved; marks it settled
    // the face check here catches drift carried from shot to shot (the previous clip's last face becomes this start)
    const check = withFaces({ verdict: "PASS", drift: [], why: "last frame of the previous approved clip",
                              height: await heightCheck(j, characters, base, null, look) }, await faceCheck(j, shot, characters, base, look));
    await db.updateFrame(j.id, { status: "ready", composed_path: out, check_result: JSON.stringify(check),
      locked_by: null, locked_until: null });
    return log(j, "start still = previous clip's last frame; ready");
  }
  if (j.kind === "start" && j.mode === "reposition") {
    // 2026-11-16 (live, job ed5bee77): from a close-up the characters cover most of the room, so moving them makes the
    // image model invent the room behind them, and no location plate of that framing can stand in. Refused before
    // paying: nothing is charged.
    const { platePaths } = await db.frameContext(j);
    const fit = await checker("/reposition_fit", { start: base, plates: await localPlates(j, platePaths), ...who(look, characters) });
    if (fit.verdict !== "PASS")
      return fail(j, `this still is a close-up (${fit.why}). Use "New setup from the location", or start from a wider still`);
  }
  // content check (2026-11-23): the instruction, the cast and every picture the image model would get. Plates (an empty
  // room made from a location) have no instruction of their own and are checked like any edit.
  await moderate.guard({ kind: "frame", ref: j.id, owner: j.owner, look,
    text: moderate.shotWords({ ...shot, style_prompt: stylePrompt }, characters, j.kind === "plate" ? "The same place with nobody in it"
      : j.mode === "restyle" ? `Redraw the uploaded picture as ${look === "photoreal" ? "a photograph" : "a cartoon"}, same composition. ${j.instruction || ""}` : j.instruction),
    paths: [j.source_path || shot?.start_frame_path, ...(j.mode === "new_setup" ? (j.ref_paths || []) : [])].filter(Boolean) });
  const size = await pngSize(base);
  let prompt, urls = [await storage.signedUrl(j.source_path || shot.start_frame_path)];
  if (j.kind === "plate") prompt = platePrompt(look, characters);
  else if (j.mode === "new_setup") {
    prompt = setupPrompt(j.instruction, j.ref_names || [], j.ref_heights || [], look, characters);
    for (const r of j.ref_paths || []) urls.push(await storage.signedUrl(r));
  } else if (j.mode === "restyle") prompt = restylePrompt(j.instruction, look, stylePrompt, characters);
  else prompt = editPrompt(j.instruction, characters, look);
  // GPT Image 2.6 (photoreal new setups since 2026-11-17) takes its size from the input images and a quality level;
  // Nano Banana 2 takes an aspect ratio and a resolution.
  const input = /^openai\/gpt-image/.test(j.endpoint)
    ? { prompt, image_urls: urls, quality: "medium", image_size: "auto", output_format: "png" }
    : { prompt, image_urls: urls, num_images: 1,
        // a restyled picture takes the project's shape (a 16:9 video frame in a 9:16 project is recomposed), 2026-11-24
        aspect_ratio: j.mode === "restyle" ? aspect : size ? nearestRatio(size.w, size.h) : "auto", resolution: "1K", output_format: "png" };
  const sub = await provider().submit(j.endpoint, input);
  await db.updateFrame(j.id, { status: "running", prompt, provider_request_id: sub.requestId, provider_status_url: sub.statusUrl,
    provider_response_url: sub.responseUrl, submitted_at: new Date(), next_poll_at: later(5000), tries: 0,
    locked_by: null, locked_until: null });
  log(j, `${j.kind}${j.mode ? "/" + j.mode : ""} submitted to ${j.endpoint} with ${urls.length} image(s) (${sub.requestId})`);
}

async function stepRunning(j) {
  const p = await provider().pollImage(j);
  if (p.state === "pending") {
    if (Date.now() - new Date(j.submitted_at).getTime() > 10 * 60000) return fail(j, "image edit timed out after 10 min");
    return db.updateFrame(j.id, { next_poll_at: later(5000), locked_by: null, locked_until: null });
  }
  if (p.state === "failed") {
    // fal's content filter sometimes refuses a picture of children and lets the same request through next time
    // (2026-11-13 live: plate from S1 refused, the identical request a minute later went through): one automatic retry.
    if (/content_policy_violation/.test(p.error) && !/\[filter retry\]/.test(j.error || "")) {
      await db.updateFrame(j.id, { status: "queued", error: "[filter retry] the image model's content filter refused it once; trying again",
        next_poll_at: null, locked_by: null, locked_until: null });
      return log(j, "content filter refused the edit; resubmitting once");
    }
    return fail(j, /content_policy_violation/.test(p.error)
      ? "the image model's content filter refused this picture twice (it happens with pictures of children); nothing was charged, try again or use another still"
      : `image edit: ${p.error}`);
  }
  const raw = path.join(config.workDir, "frames", j.id, "raw.png");
  await fetchTo(p.imageUrl, raw);
  const rawPath = `${j.owner}/frames/${j.id}/raw.png`;
  await storage.upload(raw, rawPath, "image/png");
  await db.updateFrame(j.id, { status: "composing", raw_path: rawPath, next_poll_at: null, tries: 0, locked_by: null, locked_until: null });
  log(j, "edit stored; composing");
}

// Home "Video" (2026-11-20, Londi: the first prompt makes a still and/or a short clip). The creator asked for a clip,
// not a frame to review, so the drawn frame is approved and the render starts at once with Auto's model. A refusal
// (not enough credits, a length the model cannot make) is kept on the frame job and shown on the result card; the
// still stays theirs either way.
async function renderNow(j) {
  try {
    await db.q("select studio.decide_frame($1, 'approve')", [j.id]);
    // render_model: the model a paid creator picked at the Home prompt (null = Auto), 2026-11-20
    const [g] = await db.q("select studio.enqueue_generation($1, $2) as id", [j.shot_id, j.render_model || null]);
    log(j, `render started (${g.id})`);
  } catch (e) {
    await db.updateFrame(j.id, { render_error: String(e.message || e).slice(0, 500) });
    log(j, `render not started: ${e.message}`);
  }
}

async function stepComposing(j) {
  const { shot, characters, platePaths, look } = await db.frameContext(j);
  const dir = path.join(config.workDir, "frames", j.id);
  if (j.kind === "start" && (j.mode === "prompt" || j.mode === "restyle")) {
    // nothing to compose onto: the drawn still is the start frame; the creator approves or discards it (a restyled
    // picture is redrawn whole, so it is not composed onto the uploaded one either, 2026-11-24)
    const raw = path.join(dir, "raw.png");
    try { await fs.access(raw); } catch { await storage.download(j.raw_path, raw); }
    const composedPath = outPath(j);
    await storage.upload(raw, composedPath, "image/png");
    await db.settleFrame(j.id, "charge");
    // no room or cast to compare against; the one check that applies is staging (anyone floating, sitting on
    // nothing, passing through furniture). Not a check of faces or of how well it matches the words.
    const staging = j.instruction ? await stagingCheck(j, characters, raw, look).catch((e) => ({ verdict: "NOT CHECKED", problems: [], error: e.message })) : null;
    const check = withFaces({ verdict: staging?.verdict === "OK" ? "PASS" : "FLAG", drift: [], why: j.mode === "restyle" ? "redrawn from your picture" : "drawn from your description", staging },
                            await faceCheck(j, shot, characters, raw, look));
    await db.updateFrame(j.id, { status: "ready", composed_path: composedPath, check_result: JSON.stringify(check),
      locked_by: null, locked_until: null });
    log(j, "start frame from the description ready");
    if (j.then_render) await renderNow(j);
    return;
  }
  const base = await baseStill(j, shot);
  const raw = path.join(dir, "raw.png"), out = path.join(dir, "out.png");
  try { await fs.access(raw); } catch { await storage.download(j.raw_path, raw); }
  // 2026-11-16: the room a character LEFT is not in the base still; it comes from the location's empty-room plate when
  // the plate fits this still (otherwise from the edit, and the area is shown to the creator). Not for new_setup (its
  // base IS the plate) or plate jobs.
  const plates = [];
  // 2026-11-23 (review): an end frame with the cast (kind end, mode new_setup) builds on the approved start still, which
  // has people in it, so it uses the room plates like any edit; only a START new setup sits on the empty plate itself.
  const onPlate = j.kind === "start" && j.mode === "new_setup";
  if (j.kind !== "plate" && !onPlate) plates.push(...await localPlates(j, platePaths));
  const res = await checker("/compose", { start: base, edited: raw, out_png: out, out: path.join(dir, "check"), plates, ...who(look, characters),
                                          // the shot's cast, when it names one (an empty cast_ids means "anyone in the series": no count)
                                          expect: j.kind === "plate" ? undefined : ((shot?.cast_ids || []).length || undefined),
                                          fake_verdict: process.env.FAKE_END_FRAME || undefined });
  const composedPath = outPath(j);
  await storage.upload(out, composedPath, "image/png");
  // The edit was made and paid for: charge whatever the check says; the creator decides with the check in view.
  await db.settleFrame(j.id, "charge");
  const check = { verdict: res.verdict, drift: res.drift || [], align: res.align || null, why: res.why || null,
                  revealed: res.revealed || [], plate_used: !!res.plate_used };
  // a start new_setup's base is the location's empty-room plate: it helps cut the characters out
  // start stills and (2026-11-16) end frames: the video keeps the sizes of both
  if (j.kind === "start" || j.kind === "end") check.height = await heightCheck(j, characters, out, onPlate ? base : null, look);
  // 2026-11-17: is anyone sitting on nothing, floating, or passing through furniture? (frame_check still_check, ~$0.01)
  if ((j.kind === "start" || j.kind === "end") && j.instruction) check.staging = await stagingCheck(j, characters, out, look);
  if (res.room_diff) check.room_diff = res.room_diff;
  if (j.kind === "start" || j.kind === "end") withFaces(check, await faceCheck(j, shot, characters, out, look));
  await db.updateFrame(j.id, { status: "ready", composed_path: composedPath, check_result: JSON.stringify(check),
    locked_by: null, locked_until: null });
  log(j, `${j.kind} frame ready (check ${res.verdict})`);
}

const steps = { queued: stepQueued, running: stepRunning, composing: stepComposing };

export async function handle(j) {
  try {
    await steps[j.status](j);
  } catch (e) {
    const tries = (j.tries || 0) + 1;
    if (!e.blocked) await db.logError(`picture ${j.kind} ${j.status}`, j.id, j.owner, e, { tries, mode: j.mode || null });
    if (e.permanent || tries >= config.maxStepTries) return fail(j, e.message);
    const backoff = Math.min(300000, 5000 * 2 ** tries);
    await db.updateFrame(j.id, { tries, error: e.message.slice(0, 1000), next_poll_at: later(backoff), locked_by: null, locked_until: null });
    log(j, `step ${j.status} error (try ${tries}): ${e.message}; again in ${backoff / 1000}s`);
  }
}

export async function tick() {
  const jobs = await db.claimFrames(config.workerId, config.batch, 300);
  await Promise.all(jobs.map(handle));
  return jobs.length;
}

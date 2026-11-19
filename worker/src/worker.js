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
import http from "node:http";
import { promisify } from "node:util";
import { config } from "./config.js";
import * as db from "./db.js";
import * as storage from "./storage.js";
import * as compile from "./compile.js";
import * as fal from "./providers/fal.js";
import * as mock from "./providers/mock.js";
import * as frames from "./frames.js";
import { watermark, VAULT } from "./watermark.js";
import * as assemble from "./assemble.js";
import * as audio from "./audio.js";

const run = promisify(execFile);
const providers = { fal, mock };
const log = (g, msg) => console.log(`${new Date().toISOString()} [${String(g.id).slice(0, 8)}] ${msg}`);
const later = (ms) => new Date(Date.now() + ms);

// POST to the checker without Node fetch's 300 s headers timeout (undici): a check that waited in the checker's queue
// past 5 min came back as "fetch failed" and was retried from scratch (2026-11-19, 100-clip held-out run). 20 min cap.
function postChecker(route, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${config.checkerUrl}${route}`);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", timeout: 20 * 60000,
      headers: { Authorization: `Bearer ${config.checkerToken}`, "Content-Type": "application/json", "Content-Length": data.length } },
      (res) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8"); let json; try { json = JSON.parse(text); } catch { json = null; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json }); }); });
    req.on("timeout", () => req.destroy(new Error("checker timeout after 20 min")));
    req.on("error", reject);
    req.end(data);
  });
}

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
  await db.setShot(g.shot_id, "ready");
  log(g, `failed: ${error}`);
}

// Free check before paying for a render: an end frame made by editing the start still must change only the
// characters. 2026-11-12, Phase 0 S3: three end-frame edits squeezed the shelf toys sideways and the video slid the
// toys across the shelf (Londi's catch). END_FRAME_GATE: block (default) fails the job and returns the credits;
// warn only logs; off skips. Returns null when the frame may be used, else the reason.
// 2026-11-19: a project with no characters on file (made from the home prompt) cannot tell a character from the room,
// so every moving character looks like "something else changed". The creator approved the end frame with the
// checker's boxes in view; for such projects the gate only logs.
async function endFrameGate(g, shot, characters = []) {
  if (!shot.end_frame_path || config.endFrameGate === "off") return null;
  const dir = path.join(config.workDir, g.id, "end_frame");
  const start = path.join(dir, "start" + path.extname(shot.start_frame_path));
  const end = path.join(dir, "end" + path.extname(shot.end_frame_path));
  await storage.download(shot.start_frame_path, start);
  await storage.download(shot.end_frame_path, end);
  const r = await fetch(`${config.checkerUrl}/end_frame`, {
    method: "POST", headers: { Authorization: `Bearer ${config.checkerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ start, end, out: dir, fake_verdict: process.env.FAKE_END_FRAME || undefined }),
  });
  const res = await r.json().catch(() => ({ verdict: "ERROR", error: `checker HTTP ${r.status}` }));
  if (!r.ok || res.verdict === "ERROR") throw new Error(`end-frame check: ${res.error || r.status}`);
  if (res.verdict === "PASS") { log(g, "end frame: only the characters change"); return null; }
  const where = (res.drift || []).slice(0, 3).map((d) => `[${d.box.map((v) => Number(v).toFixed(2)).join(",")}]`).join(" ");
  const detail = `end frame drift at ${where}; check image ${path.join(dir, "end_frame_check.png")}`;
  if (config.endFrameGate === "warn") { log(g, `WARNING ${detail}`); return null; }
  if (!characters.length) { log(g, `WARNING (no characters on file; the creator approved this end frame) ${detail}`); return null; }
  log(g, `blocked: ${detail}`);
  return "The end frame changes more than the characters: something in the room or a prop moved. Nothing was charged. " +
         "Make the end frame again (or remove it) and render once more.";
}

async function stepQueued(g) {
  const { shot, characters } = await db.shotContext(g);
  const blocked = await endFrameGate(g, shot, characters);
  if (blocked) return fail(g, blocked);
  const startUrl = await storage.signedUrl(shot.start_frame_path);
  const endUrl = shot.end_frame_path ? await storage.signedUrl(shot.end_frame_path) : null;
  const input = compile.providerInput(shot, characters, startUrl, endUrl);
  const sub = await providers[shot.provider].submit(shot.endpoint, input);
  // signed URLs expire; keep the request without them
  const saved = { ...input, start_image_url: shot.start_frame_path, end_image_url: shot.end_frame_path || undefined,
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
    if (Date.now() - new Date(g.submitted_at).getTime() > config.providerTimeoutMin * 60000)
      return fail(g, `provider timeout after ${config.providerTimeoutMin} min`);
    return db.unlock(g.id, { next_poll_at: later(config.pollMs) });
  }
  if (p.state === "failed") return fail(g, `provider: ${p.error}`);
  const dir = path.join(config.workDir, g.id);
  const raw = path.join(dir, "raw.mp4"), clip = path.join(dir, "clip.mp4");
  await fetchTo(p.videoUrl, raw);
  await run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-map", "0:v:0", "-c", "copy", "-an", clip]);  // models add speech; strip it
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
  const usd = shot.usd_per_second * shot.duration_s;
  await db.unlock(g.id, { status: "checking", output_path: objectPath, preview_path: previewPath, provider_usd: usd,
                          next_poll_at: null, tries: 0 });
  log(g, `clip stored (${objectPath}${previewPath ? `; watermarked copy ${previewPath}` : ""}), provider $${usd.toFixed(3)}`);
}

async function stepChecking(g) {
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
    // the creator approved the start still with this shot's cast list: the head count is confirmed
    const r = await postChecker("/check", { generation_id: g.id, spec, max_usd: config.checkerMaxUsd,
                                             confirmed_spec: !!shot.start_frame_approved });
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
    await db.settle(g.id, "release");
    await db.unlock(g.id, { status: "failed", error: `checker FAIL: ${(res.reasons || []).slice(0, 3).join(" | ")}`.slice(0, 1000), finished_at: new Date() });
    await db.setShot(g.shot_id, "ready");
  } else {                                            // FLAG or NOT_REVIEWED: a person looks
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
    if (e.permanent || tries >= config.maxStepTries) {
      if (g.status === "checking") {                 // the clip exists; a person can still judge it
        await db.unlock(g.id, { status: "review", error: `checker unavailable: ${e.message}`.slice(0, 1000), tries });
        await db.setShot(g.shot_id, "review");
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
export async function tick() {
  await refreshPlans();
  const jobs = await db.claim(config.workerId, config.batch, 1500);
  const now = [];
  for (const g of jobs) {
    if (g.status !== "checking") { now.push(g); continue; }
    if (inflight.has(g.id)) continue;
    if (inflight.size >= config.checkerSlots) { await db.unlock(g.id, { next_poll_at: later(20000) }); continue; }
    inflight.set(g.id, handle(g).catch((e) => console.error("check:", e.message)).finally(() => inflight.delete(g.id)));
  }
  const [, nFrames, nCuts, nAudio] = await Promise.all([Promise.all(now.map(handle)), frames.tick(),   // end-frame jobs (frames.js)
    assemble.tick().catch((e) => { console.error("assemble:", e.message); return 0; }),           // scene cuts (assemble.js)
    audio.tick().catch((e) => { console.error("audio:", e.message); return 0; })]);               // ElevenLabs audio (audio.js)
  return now.length + nFrames + nCuts + nAudio;
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

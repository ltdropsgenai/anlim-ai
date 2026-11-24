// Content check before anything is sent to a paid model (2026-11-23, Londi: "all of the above need to be fixed"). @anlim
// One question to the checker's /moderate (frame_check/moderate.py: Claude, words plus the pictures the job would send).
// BLOCK: the job fails with nothing charged and the creator sees why; every answer is kept in studio.moderation_log, and
// a job already allowed is not asked again (retries, another worker host). If the check cannot run, the step throws and
// is retried like any other step, then the job fails with nothing charged: nothing is made unchecked.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import * as db from "./db.js";
import * as storage from "./storage.js";

const run = promisify(execFile);
const SAFE_VIDEO_IN = ["-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm", "-protocol_whitelist", "file,pipe"];

export class Blocked extends Error {
  constructor(reason) {
    super(`anlim can't make this: ${reason || "it goes against the content rules in the Terms"}. Nothing was charged.`);
    this.blocked = true;
    this.permanent = true;
  }
}

// Stored files to local paths for the check (pictures only; a video gives three frames).
async function localImages(dir, paths) {
  await fs.mkdir(dir, { recursive: true });
  const out = [];
  for (const [i, p] of paths.filter(Boolean).slice(0, 8).entries()) {
    const ext = (path.extname(p) || ".png").toLowerCase();
    const local = path.join(dir, `mod-${i}${ext}`);
    try { await fs.access(local); } catch { await storage.download(p, local); }
    if (/\.(mp4|mov|webm|m4v)$/.test(ext)) {
      let secs = 0;
      try {
        const { stdout } = await run("ffprobe", ["-v", "error", ...SAFE_VIDEO_IN, "-show_entries", "format=duration", "-of", "csv=p=0", local]);
        secs = parseFloat(stdout) || 0;
      } catch { /* unreadable: the job's own step reports it */ }
      for (const f of [0.15, 0.5, 0.85]) {
        const png = path.join(dir, `mod-${i}-${Math.round(f * 100)}.png`);
        try {
          await run("ffmpeg", ["-y", "-v", "error", ...SAFE_VIDEO_IN, "-ss", String((secs * f).toFixed(2)), "-i", local,
                               "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", png]);
          out.push(png);
        } catch { /* a frame that does not decode is skipped */ }
      }
    } else out.push(local);
  }
  return out.slice(0, 6);
}

async function post(body) {
  const r = await fetch(`${config.checkerUrl}/moderate`, {
    method: "POST", headers: { Authorization: `Bearer ${config.checkerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await r.json().catch(() => ({ verdict: "ERROR", error: `checker HTTP ${r.status}` }));
  if (!r.ok || !["ALLOW", "BLOCK"].includes(res.verdict)) throw new Error(`content check: ${res.error || r.status}`);
  return res;
}

/** Throws Blocked when the job may not be made. kind: clip | frame | audio; ref: the job's id. */
export async function guard({ kind, ref, owner, look, text, paths = [], dir }) {
  const [prev] = await db.q("select verdict from studio.moderation_log where kind = $1 and ref_id = $2 order by id desc limit 1", [kind, ref]);
  if (prev?.verdict === "ALLOW") return;
  const images = paths.length ? await localImages(path.join(dir || path.join(config.workDir, "moderate"), String(ref)), paths) : [];
  const res = await post({ text, images, look: look || "cartoon", kind, fake_verdict: process.env.FAKE_MODERATION || undefined });
  await db.q(`insert into studio.moderation_log(kind, ref_id, owner, verdict, category, reason, model, usd, images)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
             [kind, ref, owner, res.verdict, res.category || null, res.reason || null, res.model || null, res.usd || 0, images.length]);
  console.log(`${new Date().toISOString()} [${String(ref).slice(0, 8)}] content check ${res.verdict}` +
              `${res.verdict === "BLOCK" ? ` (${res.category}): ${res.reason}` : ""} ($${Number(res.usd || 0).toFixed(4)})`);
  if (res.verdict === "BLOCK") throw new Blocked(res.reason);
}

// The words of a clip or still job: what the shot says, who is in it and how they are described, and the project's style.
export function shotWords(shot, characters = [], extra = "") {
  const cast = characters.map((c) => [c.name, c.kind, c.what, c.wardrobe].filter(Boolean).join(", ")).join("; ");
  return [extra && `Instruction: ${extra}`, shot?.action && `Shot: ${shot.action}`, shot?.dialogue && `Dialogue: ${shot.dialogue}`,
          cast && `Characters: ${cast}`, shot?.location_name && `Location: ${shot.location_name}`,
          shot?.style_prompt && `Style: ${shot.style_prompt}`].filter(Boolean).join("\n");
}

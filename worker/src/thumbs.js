// Picture previews (2026-11-25 launch audit). Supabase image transforms ran out of the Pro quota (108 of 100 origin
// images in the cycle, spend cap on), so the app's grids now use a small JPEG the worker writes beside each picture:
// <owner>/thumbs/<path>.jpg (or <vault>/clean/<owner>/thumbs/<path>.jpg), longest side 640 px. The studio-storage
// function names the pictures that have none ("thumbs_due"); studio-api hands out the preview when it exists and the
// picture itself until then. Once a minute, at most 20, never awaited by the tick. @anlim
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import * as storage from "./storage.js";

const run = promisify(execFile);
const failed = new Map();   // path -> tries; a picture ffmpeg cannot read is left alone after 3 tries (until a restart)
let next = Date.now() + 45_000, busy = false;

async function due(limit) {
  const r = await fetch(`${config.supabaseUrl}/functions/v1/studio-storage`, {
    method: "POST", headers: { "x-worker-token": config.storageToken, "Content-Type": "application/json" },
    body: JSON.stringify({ op: "thumbs_due", limit }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`studio-storage thumbs_due: ${r.status} ${j.error || ""}`);
  return j.due || [];
}

async function one({ path: src, thumb }) {
  const dir = path.join(config.workDir, "thumbs", String(Date.now()) + Math.random().toString(36).slice(2, 8));
  const inFile = path.join(dir, "in" + path.extname(src).toLowerCase());
  const outFile = path.join(dir, "out.jpg");
  try {
    await storage.download(src, inFile);
    await run("ffmpeg", ["-y", "-v", "error", "-i", inFile, "-frames:v", "1",
      "-vf", "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease", "-q:v", "4", outFile]);
    await storage.upload(outFile, thumb, "image/jpeg");
    failed.delete(src);
    return true;
  } catch (e) {
    failed.set(src, (failed.get(src) || 0) + 1);
    console.error(`thumb ${src}: ${e.message}`);
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function maybeThumbs() {
  if (busy || Date.now() < next || config.storage !== "function") return;
  busy = true; next = Date.now() + 60_000;
  (async () => {
    const list = (await due(20)).filter((d) => (failed.get(d.path) || 0) < 3);
    let made = 0;
    for (const d of list) if (await one(d)) made++;
    if (list.length) console.log(`thumbs: ${made} of ${list.length} made`);
  })().catch((e) => console.error("thumbs:", e.message)).finally(() => { busy = false; });
}

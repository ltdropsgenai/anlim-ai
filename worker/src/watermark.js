// Watermark for clips made by accounts that have never paid (2026-11-18, Londi: "watermark is critical for free
// accounts"). A large semi-transparent "anlim.ai" in the middle (hard to crop out) and a small solid one in the
// bottom-right corner. The mark is one still image; overlay repeats it on every frame (eof_action=repeat). The clean clip is kept where the creator can't read it and is shown once they buy. @anlim
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const MARK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "watermark.png");

// Storage folder no creator owns: the bucket's read policy only lets a creator read paths that start with their own
// user id, and no user has the all-zero id. studio-storage accepts it (its paths must start with a uuid).
export const VAULT = "00000000-0000-0000-0000-000000000000";

async function size(video) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x", video]);
  const [w, h] = stdout.trim().split("x").map(Number);
  if (!w || !h) throw new Error(`watermark: cannot read the clip size (${stdout.trim()})`);
  return { w, h };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// opts.audio: keep the source sound (cuts have a music track; clips are silent).
export async function watermark(src, dest, opts = {}) {
  const { w, h } = await size(src);
  const short = Math.min(w, h);
  const center = even(w * (w >= h ? 0.42 : 0.7));     // wide clips: 42% of the width; tall clips: 70%
  const corner = even(short * 0.22), margin = Math.round(short * 0.03);
  const filter =
    `[1:v]format=rgba,split[a][b];` +
    `[a]scale=${center}:-1,colorchannelmixer=aa=0.38[c];` +
    `[b]scale=${corner}:-1,colorchannelmixer=aa=0.85[s];` +
    `[0:v][c]overlay=(W-w)/2:(H-h)/2[v1];[v1][s]overlay=W-w-${margin}:H-h-${margin},format=yuv420p[out]`;
  await run("ffmpeg", ["-y", "-v", "error", "-i", src, "-i", MARK, "-filter_complex", filter,
    "-map", "[out]", ...(opts.audio ? ["-map", "0:a?", "-c:a", "copy"] : ["-an"]), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-movflags", "+faststart", dest]);
}

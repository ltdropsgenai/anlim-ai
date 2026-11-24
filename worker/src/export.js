// Download a whole project (2026-11-23): studio.export_manifest lists the files with their names inside the zip; they are
// fetched, packed into zips of at most 100 MB with Python's zipfile, stored
// uncompressed (video does not shrink), and uploaded to <owner>/exports/<project>-partN.zip, replacing the last export of
// the project. A README.txt lists what is inside. @anlim
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import * as db from "./db.js";
import * as storage from "./storage.js";

const run = promisify(execFile);
// 100 MB parts: an upload is read into memory whole (storage.upload) on a 4 GB machine that also runs the checker
const PART = 100 * 1024 * 1024, MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const log = (e, m) => console.log(`${new Date().toISOString()} [export ${String(e.id).slice(0, 8)}] ${m}`);

const ZIP_PY = `import json, sys, zipfile
spec = json.load(open(sys.argv[1]))
with zipfile.ZipFile(spec["out"], "w", zipfile.ZIP_STORED, allowZip64=True) as z:
    for f in spec["files"]:
        z.write(f["local"], f["name"])
`;

async function handle(e) {
  const dir = path.join(config.workDir, "exports", e.id);
  try {
    await fs.mkdir(dir, { recursive: true });
    const list = await db.q("select path, name from studio.export_manifest($1)", [e.id]);
    if (!list.length) throw Object.assign(new Error("This project has nothing to download yet."), { final: true });
    const [{ name: project }] = await db.q("select name from studio.series where id = $1", [e.series_id]);
    const got = [], missing = [];
    let total = 0;
    for (const [i, f] of list.entries()) {
      const local = path.join(dir, `f${i}${path.extname(f.path) || ""}`);
      try { await storage.download(f.path, local); } catch { missing.push(f.name); continue; }
      const { size } = await fs.stat(local);
      total += size;
      if (total > MAX_TOTAL) throw Object.assign(new Error("This project is over 2 GB; download its scenes' cuts and clips one by one instead."), { final: true });
      got.push({ local, name: f.name, size });
    }
    const readme = path.join(dir, "README.txt");
    await fs.writeFile(readme, `${project}: downloaded from anlim.ai on ${new Date().toISOString().slice(0, 10)}\n\n` +
      "Each scene has a folder: its kept clips, start and end frames, its 3 newest cuts (with captions when the cut had them) " +
      "and the audio in its cut. cast/ and places/ hold the project's character and place pictures.\n" +
      (missing.length ? `\nThese could not be read and are not included:\n${missing.map((m) => `  ${m}`).join("\n")}\n` : ""));
    got.unshift({ local: readme, name: "README.txt", size: (await fs.stat(readme)).size });
    const parts = [];
    let cur = [], size = 0;
    for (const f of got) {
      if (cur.length && size + f.size > PART) { parts.push(cur); cur = []; size = 0; }
      cur.push(f); size += f.size;
    }
    if (cur.length) parts.push(cur);
    const slug = String(project).replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "project";
    const out = [];
    for (const [k, files] of parts.entries()) {
      const zip = path.join(dir, `part${k + 1}.zip`), spec = path.join(dir, `part${k + 1}.json`), py = path.join(dir, "zip.py");
      await fs.writeFile(py, ZIP_PY);
      await fs.writeFile(spec, JSON.stringify({ out: zip, files: files.map((f) => ({ local: f.local, name: `${slug}/${f.name}` })) }));
      await run("python3", ["-I", py, spec], { maxBuffer: 1 << 20 });
      for (const f of files) if (f.name !== "README.txt") await fs.rm(f.local, { force: true });   // disk: the sources of a packed part
      const p = `${e.owner}/exports/${e.series_id}-part${k + 1}.zip`;
      await storage.upload(zip, p, "application/zip");
      out.push({ path: p, bytes: (await fs.stat(zip)).size, files: files.length, name: `${slug}${parts.length > 1 ? `-part${k + 1}` : ""}.zip` });
    }
    await db.q(`update studio.exports set status = 'done', parts = $2, files = $3, bytes = $4, error = $5, locked_by = null, locked_until = null,
                updated_at = now() where id = $1`,
               [e.id, JSON.stringify(out), got.length - 1, out.reduce((n, x) => n + x.bytes, 0),
                missing.length ? `${missing.length} file(s) could not be read and are listed in README.txt` : null]);
    log(e, `done: ${got.length - 1} files in ${out.length} zip(s), ${Math.round(out.reduce((n, x) => n + x.bytes, 0) / 1e6)} MB`);
  } catch (err) {
    const give = err.final || (e.tries || 1) >= 3;
    if (!err.final) await db.logError("export", e.id, e.owner, err);
    await db.q(`update studio.exports set status = $2, error = $3, locked_by = null, locked_until = null, updated_at = now() where id = $1`,
               [e.id, give ? "failed" : "queued", String(err.message).slice(0, 500)]);
    log(e, `${give ? "failed" : "will retry"}: ${err.message}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => null);
  }
}

// One export at a time, beside the worker's tick (an export takes minutes; renders must keep being collected meanwhile)
let running = null;
export async function tick() {
  if (running) return 0;
  const jobs = await db.q("select * from studio.claim_exports($1, 1800)", [config.workerId]);
  if (!jobs.length) return 0;
  running = (async () => { for (const e of jobs) await handle(e); })().catch((err) => console.error("export:", err.message)).finally(() => { running = null; });
  return jobs.length;
}

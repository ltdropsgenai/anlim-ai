// Held-out model test (2026-11-19): download start frames / clips of the HELDOUT projects for review. @anlim
import fs from "node:fs";
import path from "node:path";
const env = Object.fromEntries(fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
Object.assign(process.env, env, { CHECKER_TOKEN: env.CHECKER_TOKEN || "x" });
const storage = await import("../src/storage.js");
const pg = (await import("pg")).default;
const out = process.argv[2], what = process.argv[3] || "frames";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
if (what === "frames") {
  const { rows } = await c.query(`select distinct on (se.name) se.name, coalesce(fj.composed_path, fj.raw_path) as output_path
    from studio.frame_jobs fj join studio.shots sh on sh.id=fj.shot_id
    join studio.scenes sc on sc.id=sh.scene_id join studio.series se on se.id=sc.series_id
    where se.name like 'HELDOUT %' and fj.status = 'ready' and coalesce(fj.composed_path, fj.raw_path) is not null
      and fj.created_at > now() - interval '30 minutes' order by se.name, fj.created_at desc`);
  for (const r of rows) {
    const f = path.join(out, `start_${r.name.slice(8, 10)}${path.extname(r.output_path)}`);
    if (!fs.existsSync(f)) await storage.download(r.output_path, f);
    console.log(f);
  }
} else {
  const { rows } = await c.query(`select se.name, g.id, g.model_id, g.status, g.output_path from studio.generations g join studio.shots sh on sh.id=g.shot_id
    join studio.scenes sc on sc.id=sh.scene_id join studio.series se on se.id=sc.series_id
    where se.name like 'HELDOUT %' and g.output_path is not null order by se.name, g.model_id`);
  for (const r of rows) {
    const f = path.join(out, `clip_${r.name.slice(8, 10)}_${r.model_id}.mp4`);
    if (!fs.existsSync(f)) await storage.download(r.output_path, f);
    console.log(f);
  }
}
await c.end();

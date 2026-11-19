// Database access. The worker connects as role studio_worker, so it calls the studio.* functions
// that creators cannot. @anlim
import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
});

export async function q(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}

export const claim = (worker, n, leaseS) =>
  q("select * from studio.claim_generations($1, $2, $3)", [worker, n, leaseS]);

export async function update(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q(`update studio.generations set ${sets}, updated_at = now() where id = $1`, [id, ...keys.map((k) => fields[k])]);
}

// Finish a step: drop the lease so the next due step can be claimed.
export const unlock = (id, extra = {}) => update(id, { ...extra, locked_by: null, locked_until: null });

export const settle = (id, outcome) => q("select studio.settle_generation($1, $2) as s", [id, outcome]);
export const setShot = (shotId, status) => q("update studio.shots set status = $2 where id = $1", [shotId, status]);

export async function shotContext(gen) {
  const [row] = await q(
    `select sh.*, sc.blocking, sc.title as scene_title, se.name as series_name, se.style_prompt, se.look,
            l.name as location_name, l.description as location_description, m.endpoint, m.provider,
            m.resolution, m.usd_per_second
       from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
       left join studio.locations l on l.id = sc.location_id join studio.models m on m.id = $2
      where sh.id = $1`, [gen.shot_id, gen.model_id]);
  const chars = await q(
    `select c.* from studio.characters c join studio.scenes sc on sc.series_id = c.series_id
      join studio.shots sh on sh.scene_id = sc.id
      where sh.id = $1 and (cardinality(sh.cast_ids) = 0 or c.id = any(sh.cast_ids))
      order by c.height_units desc nulls last, c.name`,
    [gen.shot_id]);
  return { shot: row, characters: chars };
}

// End-frame jobs (frames.js)
export const claimFrames = (worker, n, leaseS) =>
  q("select * from studio.claim_frame_jobs($1, $2, $3)", [worker, n, leaseS]);
export async function updateFrame(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q(`update studio.frame_jobs set ${sets}, updated_at = now() where id = $1`, [id, ...keys.map((k) => fields[k])]);
}
export const settleFrame = (id, outcome) => q("select studio.settle_frame_job($1, $2) as s", [id, outcome]);
export async function frameContext(job) {
  const [shot] = await q("select * from studio.shots where id = $1", [job.shot_id]);
  const chars = await q(
    `select c.* from studio.characters c join studio.scenes sc on sc.series_id = c.series_id
      join studio.shots sh on sh.scene_id = sc.id
      where sh.id = $1 and (cardinality(sh.cast_ids) = 0 or c.id = any(sh.cast_ids))
      order by c.height_units desc nulls last, c.name`, [job.shot_id]);
  // the location's empty-room plate (compose takes the room a character left from it, 2026-11-16)
  // the series' look (cartoon | photoreal, 2026-11-16): prompt wording, detector classes and matting model
  const [se] = shot ? await q(
    `select se.look, se.style_prompt from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = $1`,
    [shot.scene_id])
    : job.location_id ? await q(        // a plate made for a location, not from a shot
      `select se.look, se.style_prompt from studio.locations l join studio.series se on se.id = l.series_id where l.id = $1`,
      [job.location_id]) : [];
  const [loc] = shot ? await q(
    `select l.layout_path, l.other_plates from studio.scenes sc join studio.locations l on l.id = sc.location_id where sc.id = $1`,
    [shot.scene_id]) : [];
  // every plate of the location, one per camera framing, latest first (2026-11-16, migration studio_location_framings)
  const platePaths = loc ? [loc.layout_path, ...[...(loc.other_plates || [])].reverse()].filter(Boolean) : [];
  return { shot, characters: chars, platePath: loc?.layout_path || null, platePaths, look: se?.look || "cartoon",
           stylePrompt: se?.style_prompt || null };
}

export async function recordQc(genId, r) {
  await q(
    `insert into studio.qc_runs(generation_id, verdict, flags, review_usd, verify_usd, action_usd, passthrough_usd, models, raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [genId, r.verdict, JSON.stringify(r.frame_flags || []), r.review_usd || 0, r.verify_usd || 0, r.action_usd || 0,
     r.passthrough_usd || 0, JSON.stringify(r.models || {}), JSON.stringify(r)]);
}

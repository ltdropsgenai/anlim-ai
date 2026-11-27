// Database access. The worker connects as role studio_worker, so it calls the studio.* functions
// that creators cannot. @anlim
import { englishContext } from "./translate.js";
import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // 2026-11-27: the role studio_worker may hold at most 10 connections (pg_roles.rolconnlimit). With 3 machines at 5
  // each the pools asked for 15, and a new connection past the 10th failed ("too many connections for role
  // studio_worker"): an ad draft's result could not be saved and the job stayed "running". 3 a machine = 9.
  max: Number(process.env.DB_POOL_MAX || 3),
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
    `select sh.*, sc.blocking, sc.title as scene_title, se.name as series_name, se.style_prompt, se.look, se.aspect,
            l.name as location_name, l.description as location_description, m.endpoint, m.t2v_endpoint, m.provider,
            m.resolution, m.usd_per_second, m.kind as model_kind,
            -- 2026-11-23: the shot already has its voiceover, so the clip is made for a lip sync (compile.prompt MOUTHS)
            exists (select 1 from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'voiceover' and a.status = 'done'
                     and a.in_cut) as has_voiceover
       from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
       left join studio.locations l on l.id = sc.location_id join studio.models m on m.id = $2
      where sh.id = $1`, [gen.shot_id, gen.model_id]);
  const chars = await q(
    `select c.* from studio.characters c join studio.scenes sc on sc.series_id = c.series_id
      join studio.shots sh on sh.scene_id = sc.id
      where sh.id = $1 and (cardinality(sh.cast_ids) = 0 or c.id = any(sh.cast_ids))
      order by c.height_units desc nulls last, c.name`,
    [gen.shot_id]);
  // 2026-11-24: a Spanish or French creator's words go to the compiler and the models in English (translate.js)
  if (row) await englishContext(gen.owner, row, chars);
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
    `select se.look, se.style_prompt, se.aspect from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = $1`,
    [shot.scene_id])
    : job.location_id ? await q(        // a plate made for a location, not from a shot
      `select se.look, se.style_prompt, se.aspect from studio.locations l join studio.series se on se.id = l.series_id where l.id = $1`,
      [job.location_id]) : [];
  const [loc] = shot ? await q(
    `select l.layout_path, l.other_plates from studio.scenes sc join studio.locations l on l.id = sc.location_id where sc.id = $1`,
    [shot.scene_id]) : [];
  // every plate of the location, one per camera framing, latest first (2026-11-16, migration studio_location_framings)
  const platePaths = loc ? [loc.layout_path, ...[...(loc.other_plates || [])].reverse()].filter(Boolean) : [];
  // 2026-11-23 (Londi): no default look; a job whose project cannot be found fails instead of being drawn as a cartoon
  if (!se?.look) throw new Error("the project of this job was not found (no look)");
  // 2026-11-24: the creator's words in English for the image model (translate.js); the job's instruction too, once
  const extra = { style_prompt: se?.style_prompt || null, instruction: job.instruction || null };
  await englishContext(job.owner, shot, chars, extra);
  if (!job._en) { job.instruction = extra.instruction ?? job.instruction; job._en = true; }
  se.style_prompt = extra.style_prompt;
  return { shot, characters: chars, platePath: loc?.layout_path || null, platePaths, look: se.look,
           stylePrompt: se?.style_prompt || null, aspect: se?.aspect || "16:9" };
}

export async function recordQc(genId, r) {
  await q(
    `insert into studio.qc_runs(generation_id, verdict, flags, review_usd, verify_usd, action_usd, passthrough_usd, models, raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [genId, r.verdict, JSON.stringify(r.frame_flags || []), r.review_usd || 0, r.verify_usd || 0, r.action_usd || 0,
     r.passthrough_usd || 0, JSON.stringify(r.models || {}), JSON.stringify(r)]);
}

// Error monitoring (2026-11-23, migration studio_insights): a job step that threw, kept in studio.app_errors for the
// admin Insights page. Best effort: a failed write is only printed, never thrown.
export async function logError(place, ref, owner, error, detail = null) {
  try {
    await q("insert into studio.app_errors(source, owner, place, message, ref, detail) values ('worker', $1, $2, $3, $4, $5)",
            [owner || null, String(place).slice(0, 200), String(error?.message || error).slice(0, 2000), ref ? String(ref) : null,
             detail ? JSON.stringify(detail) : null]);
  } catch (e) { console.error("logError:", e.message); }
}

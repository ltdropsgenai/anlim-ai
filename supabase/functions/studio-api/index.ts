// studio-api: the app's backend for signed-in creators (home, review queue, clips, shots, start/end frames, plates, library, cut-outs, assets, ElevenLabs audio). @anlim
// Every query runs inside a transaction as role "authenticated" with the caller's user id, so the studio
// schema's row-level security decides what each creator can see; the studio schema stays off the public API.
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const BUCKET = "studio";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });

const cors = {
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Run fn as the signed-in user: RLS applies, auth.uid() = uid.
function asUser<T>(uid: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true),
                    set_config('request.jwt.claim.sub', ${uid}, true)`;
    await tx`set local role authenticated`;
    return fn(tx);
  });
}

// Signing is batched and throttled (2026-11-19): the Assets list asked Storage for 100+ links at once, one request
// each, and Storage answered 429 (rate limited), leaving blank cards. Plain links now go out as one
// createSignedUrls call per expiry per tick; resized previews (which need their own call each) run at most 6 at a time
// and fall back to the plain link when Storage refuses.
const signQueue = new Map<number, Map<string, Array<(u: string | null) => void>>>();
let signFlush: Promise<void> | null = null;
function sign(path: string | null, seconds = 3600): Promise<string | null> {
  if (!path) return Promise.resolve(null);
  return new Promise((resolve) => {
    const byPath = signQueue.get(seconds) ?? new Map();
    signQueue.set(seconds, byPath);
    byPath.set(path, [...(byPath.get(path) ?? []), resolve]);
    signFlush ??= new Promise<void>((r) => setTimeout(() => r(flushSigns()), 0));   // gather every link asked for in this turn
  });
}
async function flushSigns() {
  const batches = [...signQueue.entries()];
  signQueue.clear(); signFlush = null;
  for (const [seconds, byPath] of batches) {
    const paths = [...byPath.keys()];
    for (let i = 0; i < paths.length; i += 200) {
      const part = paths.slice(i, i + 200);
      const { data, error } = await admin.storage.from(BUCKET).createSignedUrls(part, seconds);
      const got = new Map<string, string | null>();
      if (!error) for (const d of data ?? []) got.set(d.path ?? "", d.error ? null : d.signedUrl);
      for (const p of part) for (const r of byPath.get(p) ?? []) r(got.get(p) ?? null);
    }
  }
}

let thumbsRunning = 0;
const thumbWaiters: Array<() => void> = [];
async function thumb(path: string | null) {
  if (!path) return null;
  if (thumbsRunning >= 6) await new Promise<void>((r) => thumbWaiters.push(r));
  thumbsRunning++;
  try {
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, 3600, { transform: { width: 480, height: 270, resize: "cover", quality: 70 } });
    if (!error) return data.signedUrl;
  } finally {
    thumbsRunning--; thumbWaiters.shift()?.();
  }
  return sign(path);   // preview refused (rate limit or not an image): the full picture still shows
}

// Remove stored files a delete function returned. Only the caller's own folder and their clean copies are touched,
// whatever the list says (2026-11-19).
async function removeFiles(uid: string, paths: string[]) {
  const mine = [...new Set(paths)].filter((p) => p.startsWith(`${uid}/`) || p.startsWith(`00000000-0000-0000-0000-000000000000/clean/${uid}/`));
  for (let i = 0; i < mine.length; i += 100) {
    const { error } = await admin.storage.from(BUCKET).remove(mine.slice(i, i + 100));
    if (error) console.error(`remove files for ${uid}: ${error.message}`);
  }
  return mine.length;
}

// ---- ElevenLabs (2026-11-19): the creator's own account. The key lives in Supabase Vault; it is read here only to
// check it and to list voices, and by the worker to make the audio. It is never sent back to the app.
const XI = "https://api.elevenlabs.io";
async function xiKey(uid: string) {
  const [r] = await sql`select studio.connection_key(${uid}, 'elevenlabs') as k`;
  return (r?.k as string | null) ?? null;
}
async function xiGet(key: string, path: string) {
  const r = await fetch(`${XI}${path}`, { headers: { "xi-api-key": key } });
  let body: any = null; try { body = await r.json(); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, body };
}
// What the key may read about the account; a key limited to some features may not read the subscription.
async function xiCheck(key: string) {
  const sub = await xiGet(key, "/v1/user/subscription");
  if (sub.ok) return { ok: true, account: { tier: sub.body?.tier ?? null, character_count: sub.body?.character_count ?? null,
    character_limit: sub.body?.character_limit ?? null, next_reset_unix: sub.body?.next_character_count_reset_unix ?? null } };
  const v = await xiGet(key, "/v2/voices?page_size=1");
  if (v.ok) return { ok: true, account: { tier: null, note: "This key cannot read your plan; that is fine." } };
  return { ok: false, status: v.status || sub.status, detail: v.body?.detail?.message ?? sub.body?.detail?.message ?? null };
}

// 2026-11-21 (global audit): no camera given means no camera instruction (the model's choice), not "locked". Locking
// it when nothing was said came from Londi's fixed-camera episodes; the worker's compile.js only locks a camera the
// creator asked to lock. (The CAMERA_WORDS test that used to decide this is gone with it.)

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !who?.user) return json({ error: "sign in first" }, 401);
  const uid = who.user.id;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  try {
    switch (body.op) {
      case "me": {
        const [acc] = await asUser(uid, async (tx) => {
          await tx`select studio.refresh_my_plan()`;           // a month boundary nobody else has crossed yet
          return tx`select balance, reserved, plan_credits, plan_id, plan_status, welcome_status, debt, studio.is_admin() as is_admin
                      from studio.accounts where owner = ${uid}`;
        });
        // paid: has ever bought credits or a plan (no watermark); the app's account label uses it (2026-11-23)
        const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
        return json({ user_id: uid, email: who.user.email, balance: acc?.balance ?? 0, reserved: acc?.reserved ?? 0, paid: !!paid,
          plan_credits: acc?.plan_credits ?? 0, plan_id: acc?.plan_id ?? null, plan_status: acc?.plan_status ?? null,
          welcome_status: acc?.welcome_status ?? null, debt: acc?.debt ?? 0, is_admin: !!acc?.is_admin });
      }
      case "queue": {
        // newest first; "review" = waiting for the creator. Includes the latest checker run and decision.
        const rows = await asUser(uid, (tx) => tx`
          select g.id, g.status, g.created_at, g.finished_at, g.free_retry, g.credits_reserved, g.credits_charged,
                 g.settled, g.error, g.provider_usd, sh.id as shot_id, sh.ord as shot_ord, sh.action, sh.status as shot_status,
                 sh.start_frame_path, g.model_id,
                 sc.title as scene_title, se.name as series_name,
                 q.verdict, q.review_usd + q.verify_usd + q.action_usd + q.passthrough_usd as check_usd,
                 jsonb_array_length(coalesce(q.flags, '[]'::jsonb)) as flag_count,
                 r.decision, r.created_at as decided_at
            from studio.generations g
            join studio.shots sh on sh.id = g.shot_id join studio.scenes sc on sc.id = sh.scene_id
            join studio.series se on se.id = sc.series_id
            left join lateral (select * from studio.qc_runs q where q.generation_id = g.id order by created_at desc limit 1) q on true
            left join lateral (select * from studio.reviews r where r.generation_id = g.id order by created_at desc limit 1) r on true
           order by (g.status = 'review') desc, g.created_at desc limit 100`);
        const items = await Promise.all(rows.map(async ({ start_frame_path, ...r }) => ({ ...r, thumb_url: await thumb(start_frame_path) })));
        return json({ items });
      }
      case "clip": {
        const id = String(body.generation_id || "");
        const [g] = await asUser(uid, (tx) => tx`
          select g.id, g.status, g.output_path, g.preview_path, g.settled, g.credits_reserved, g.free_retry, g.error,
                 g.model_id, g.route_kind, g.route_reason, sh.id as shot_id,
                 sh.action, sh.camera, sh.start_frame_path, sh.duration_s, sc.title as scene_title, se.name as series_name,
                 q.verdict, q.flags, q.raw -> 'reasons' as reasons, q.raw -> 'action' as action_check,
                 q.review_usd, q.verify_usd, q.action_usd, q.passthrough_usd, q.raw -> 'passthrough' as passthrough, q.models,
                 (select r.decision from studio.reviews r where r.generation_id = g.id order by r.created_at desc limit 1) as decision,
                 (select json_build_object('status', rr.status, 'created_at', rr.created_at, 'decision_note', rr.decision_note)
                    from studio.refund_requests rr where rr.generation_id = g.id) as refund
            from studio.generations g
            join studio.shots sh on sh.id = g.shot_id join studio.scenes sc on sc.id = sh.scene_id
            join studio.series se on se.id = sc.series_id
            left join lateral (select * from studio.qc_runs q where q.generation_id = g.id order by created_at desc limit 1) q on true
           where g.id = ${id}`);
        if (!g) return json({ error: "not found" }, 404);        // RLS: not yours or not there
        // free accounts see the watermarked copy; once the account has paid, every clip shows clean (2026-11-18)
        const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
        const marked = !paid;   // 2026-11-21 review: free accounts get the watermarked copy or nothing, never the clean clip
        const { output_path: _clean, preview_path: _preview, ...rest } = g;
        return json({ ...rest, watermarked: marked, clip_url: marked ? (g.preview_path ? await sign(g.preview_path) : null) : await sign(g.output_path),
          start_url: await sign(g.start_frame_path) });
      }
      case "shots": {
        // every shot, by series / scene / order, with its latest render and end-frame state
        const rows = await asUser(uid, (tx) => tx`
          select sh.id, sh.ord, sh.action, sh.status, sh.duration_s, sh.camera, sh.end_frame_path is not null as has_end_frame,
                 sh.end_frame_approved, sh.start_frame_path is not null as has_start_frame, sh.start_frame_approved,
                 sc.id as scene_id, sc.title as scene_title, sc.ord as scene_ord, se.id as series_id, se.name as series_name,
                 g.status as gen_status, g.id as gen_id, f.status as frame_status, f.kind as frame_kind,
                 sh.start_frame_path, sh.approved_generation_id is not null as has_approved_clip,
                 sh.trim_start_s, sh.trim_end_s, sh.speed, sh.words,
                 (select a.clip_s from studio.generations a where a.id = sh.approved_generation_id) as clip_s,
                 coalesce((select a.model_id from studio.generations a where a.id = sh.approved_generation_id), g.model_id) as gen_model
            from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
            left join lateral (select id, status, model_id from studio.generations where shot_id = sh.id order by created_at desc limit 1) g on true
            left join lateral (select status, kind from studio.frame_jobs where shot_id = sh.id and kind in ('start', 'end')
                                order by created_at desc limit 1) f on true
           order by se.name, sc.ord, sh.ord limit 300`);
        const items = await Promise.all(rows.map(async ({ start_frame_path, ...r }) => ({ ...r, thumb_url: await thumb(start_frame_path) })));
        return json({ items });
      }
      case "shot": {
        const id = String(body.shot_id || "");
        const [sh] = await asUser(uid, (tx) => tx`
          select sh.id, sh.ord, sh.action, sh.status, sh.duration_s, sh.camera, sh.start_frame_path, sh.start_frame_approved,
                 sh.end_frame_path, sh.end_frame_approved, sh.end_instruction, sc.title as scene_title, se.name as series_name, se.look, se.aspect,
                 se.quality, se.id as series_id
            from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
           where sh.id = ${id}`);
        if (!sh) return json({ error: "not found" }, 404);
        const [job] = await asUser(uid, (tx) => tx`
          select id, status, instruction, check_result, composed_path, error, created_at from studio.frame_jobs
           where shot_id = ${id} and kind = 'end' order by created_at desc limit 1`);
        const [sjob] = await asUser(uid, (tx) => tx`
          select id, status, mode, instruction, check_result, composed_path, error, created_at from studio.frame_jobs
           where shot_id = ${id} and kind = 'start' order by created_at desc limit 1`);
        // what the start-still modes need: a previous approved clip (continue), a location plate and references (new setup)
        const [ctx] = await asUser(uid, (tx) => tx`
          select sc.id as scene_id, sc.series_id, sc.location_id, l.name as location_name, l.layout_path is not null as has_plate,
                 p.id as prev_id, p.approved_generation_id is not null as prev_clip_approved, p.start_frame_approved as prev_start_approved,
                 sh.cast_ids,
                 (select coalesce(json_agg(json_build_object('id', c.id, 'name', c.name, 'has_ref', c.ref_front_path is not null,
                         'in_shot', cardinality(sh.cast_ids) = 0 or c.id = any(sh.cast_ids)) order by c.name), '[]')
                    from studio.characters c where c.series_id = sc.series_id) as characters
            from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id left join studio.locations l on l.id = sc.location_id
            left join lateral (select * from studio.shots p where p.scene_id = sh.scene_id and p.ord < sh.ord order by p.ord desc limit 1) p on true
           where sh.id = ${id}`);
        let route: Record<string, unknown> | undefined, routeError: string | null = null;   // route_model refuses a length no model can make
        try {
          [route] = await asUser(uid, (tx) => tx`
            select r.kind, r.model_id, r.reason, r.evidence, m.label, m.credits_per_second * ${sh.duration_s}::int as credits
              from studio.route_model(${id}) r join studio.models m on m.id = r.model_id`);
        } catch (e) {   // only messages written for creators (P0001) are shown (2026-11-21 review)
          routeError = (e as { code?: string })?.code === "P0001" && e instanceof Error ? e.message : "No model can make this shot right now.";
        }
        const [gen] = await asUser(uid, (tx) => tx`
          select id, status from studio.generations where shot_id = ${id} order by created_at desc limit 1`);
        // every model a creator may pick by hand, with its price for this shot's length (override chips)
        // models.looks (2026-11-20): Seedance 2.0 is cartoon only (fal refuses real-person likenesses)
        const models = await sql`select id, label, credits_per_second * ${sh.duration_s}::int as credits from studio.models
                                  where active and provider <> 'mock' and kind = 'clip' and (looks is null or ${sh.look} = any(looks))
                                  order by usd_per_second desc`;
        const [{ paid: canPick }] = await sql`select studio.has_paid(${uid}) as paid`;   // free accounts use Auto (2026-11-20)
        // height check of the current start still when it was uploaded (frame_jobs kind 'height', 2026-11-16)
        const [hjob] = sh.start_frame_path ? await asUser(uid, (tx) => tx`
          select id, status, check_result, error from studio.frame_jobs
           where shot_id = ${id} and kind = 'height' and source_path = ${sh.start_frame_path} order by created_at desc limit 1`) : [];
        return json({ ...sh, start_url: await sign(sh.start_frame_path), end_url: await sign(sh.end_frame_path),
          job: job ? { ...job, composed_url: await sign(job.composed_path) } : null, route: route ?? null, route_error: routeError,
          start_job: sjob ? { ...sjob, composed_url: await sign(sjob.composed_path) } : null, context: ctx ?? null,
          latest: gen ?? null, height_job: hjob ?? null, owner: uid, models, can_pick: canPick });
      }
      // ---- quick create from the Home prompt (2026-11-20): an image, or an image and a clip, in a new "Untitled project"
      // (or the project the creator picked); the result card polls "creation" and offers download or the Workspace
      case "quick_create": {
        const prompt = String(body.prompt || "");
        const camera = null;
        const [r] = await asUser(uid, (tx) => tx`select studio.quick_create(${prompt}, ${body.look == null ? null : String(body.look)},
          ${Number(body.duration_s || 5)}::int, ${String(body.output || "video")}, ${camera},
          ${body.series_id ? String(body.series_id) : null}::uuid, ${body.model ? String(body.model) : null}::text,
          ${String(body.aspect || "16:9")}::text) as r`);
        return json(r.r);
      }
      // Motion transfer (2026-11-20): the creator's clip recast with their reference images; paid accounts only.
      case "motion_models": {
        const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
        const [{ admin }] = await sql`select exists (select 1 from studio.admins where user_id = ${uid}) as admin`;
        const models = await sql`select id, label, resolution, credits_per_second, min_duration_s, max_duration_s
                                   from studio.models where active and kind = 'motion' and (provider <> 'mock' or ${admin})
                                  order by provider = 'mock', max_duration_s desc, credits_per_second desc`;
        return json({ paid, models });
      }
      case "motion_create": {
        const refs = Array.isArray(body.ref_paths) ? body.ref_paths.map((x: unknown) => String(x)).slice(0, 8) : [];
        const [r] = await asUser(uid, (tx) => tx`select studio.motion_create(${String(body.source_path || "")}, ${refs}::text[],
          ${String(body.prompt || "")}, ${Number(body.seconds || 0)}::numeric, ${String(body.model || "")},
          ${body.series_id ? String(body.series_id) : null}::uuid, ${body.look == null ? null : String(body.look)}::text) as r`);
        return json(r.r);
      }
      case "prompt_models": {
        // the video models a paid account may pick at the Home prompt (2026-11-20); free accounts use Auto
        const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
        const models = await sql`select id, label, credits_per_second, min_duration_s, max_duration_s, looks
                                   from studio.models where active and provider <> 'mock' and t2v_endpoint is not null
                                  order by usd_per_second desc`;
        return json({ paid, models });
      }
      case "creation": {
        const id = String(body.shot_id || "");
        const [x] = await asUser(uid, (tx) => tx`
          select sh.id as shot_id, sh.action, sh.duration_s, sh.from_text, sh.motion_source_path is not null as motion, sh.start_frame_path, sc.id as scene_id, se.id as series_id, se.name as series_name, se.look, se.aspect,
                 f.id as job_id, f.status as frame_status, f.composed_path, f.error as frame_error, f.then_render, f.render_error,
                 g.id as gen_id, g.status as gen_status, g.output_path, g.preview_path, g.error as gen_error, g.model_id,
                 g.credits_reserved, g.settled
            from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
            left join lateral (select * from studio.frame_jobs where shot_id = sh.id and kind = 'start' order by created_at desc limit 1) f on true
            left join lateral (select * from studio.generations where shot_id = sh.id order by created_at desc limit 1) g on true
           where sh.id = ${id}`);
        if (!x) return json({ error: "not found" }, 404);
        const [m] = x.model_id ? await sql`select label from studio.models where id = ${x.model_id}` : [];
        const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
        const marked = !paid;   // fail closed (2026-11-21 review)
        // the clip can be watched while it is checked; it can be downloaded (kept) once the check is done
        const ready = x.gen_status === "checking" || x.gen_status === "review" || x.gen_status === "succeeded";
        const { composed_path, output_path, preview_path, start_frame_path, ...rest } = x;
        return json({ ...rest, model_label: m?.label ?? null, watermarked: marked,
          image_url: x.frame_status === "ready" || x.frame_status === "approved" ? await sign(composed_path) : null,
          video_url: ready && output_path ? (marked ? (preview_path ? await sign(preview_path) : null) : await sign(output_path)) : null,
          // a clip made from words: its first frame, as the player's poster only (not offered as an image download)
          poster_url: (x.from_text || x.motion) && start_frame_path ? await sign(start_frame_path) : null });
      }
      case "creation_keep": {
        // keeping (or downloading) a clip that waits for review approves it (it was charged on delivery, 2026-11-21)
        const id = String(body.generation_id || "");
        const [g] = await asUser(uid, (tx) => tx`select status from studio.generations where id = ${id}`);
        if (!g) return json({ error: "not found" }, 404);
        if (g.status === "review") await asUser(uid, (tx) => tx`select studio.review_generation(${id}, 'approve', ${[]}, ${"kept from the Home result"})`);
        return json({ ok: true });
      }
      // ---- refunds (v3, 2026-11-21): same as Reject; the credits come back only when an admin upholds the request
      case "refund_request": {
        const reasons = Array.isArray(body.reasons) ? body.reasons.map(String).slice(0, 10) : [];
        const at = body.at_s == null || body.at_s === "" ? null : Number(body.at_s);
        const [r] = await asUser(uid, (tx) => tx`select studio.request_refund(${String(body.generation_id || "")}, ${reasons},
          ${String(body.note || "")}, ${at != null && isFinite(at) ? at : null}) as id`);
        return json({ ok: true, id: r.id });
      }
      case "notifications": {
        const rows = await asUser(uid, (tx) => tx`
          select id, kind, title, body, link, created_at from studio.notifications where read_at is null order by created_at desc limit 10`);
        return json({ items: rows });
      }
      case "notifications_read": {
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50) : [];
        await asUser(uid, (tx) => tx`select studio.mark_notifications_read(${ids}::uuid[])`);
        return json({ ok: true });
      }
      case "admin_refunds": {
        // studio.admin_refunds refuses anyone who is not in studio.admins; the clip links are signed here (service role)
        const st = body.status == null ? null : String(body.status);
        const rows = await asUser(uid, (tx) => tx`select * from studio.admin_refunds(${st})`);
        const items = await Promise.all(rows.map(async ({ output_path, start_frame_path, ...r }) => ({ ...r,
          clip_url: await sign(output_path), start_url: await sign(start_frame_path) })));
        return json({ items });
      }
      case "admin_refund_decide": {
        await asUser(uid, (tx) => tx`select studio.decide_refund(${String(body.id || "")}, ${String(body.decision || "")}, ${body.note ? String(body.note) : null})`);
        return json({ ok: true });
      }
      case "end_frame": {
        const id = String(body.shot_id || ""), instruction = String(body.instruction || "");
        const [r] = await asUser(uid, (tx) => tx`select studio.request_end_frame(${id}, ${instruction}) as job_id`);
        return json({ ok: true, job_id: r.job_id });
      }
      case "end_frame_decide": {
        const job = String(body.job_id || ""), decision = String(body.decision || "");
        await asUser(uid, (tx) => tx`select studio.decide_end_frame(${job}, ${decision})`);
        return json({ ok: true, decision });
      }
      case "end_frame_clear": {
        await asUser(uid, (tx) => tx`select studio.clear_end_frame(${String(body.shot_id || "")})`);
        return json({ ok: true });
      }
      case "render": {
        // model: null = the app picks (studio.model_routes); a model id = the creator's override
        const id = String(body.shot_id || ""), model = body.model ? String(body.model) : null;
        const [r] = await asUser(uid, (tx) => tx`select studio.enqueue_generation(${id}, ${model}) as generation_id`);
        return json({ ok: true, generation_id: r.generation_id });
      }
      // ---- authoring (studio.create_scene / create_shot / update_shot / set_start_frame / approve_start_frame / delete_shot)
      case "series": {
        const rows = await asUser(uid, (tx) => tx`
          select se.id, se.name, se.look, se.aspect, se.quality, se.genre, se.style_prompt, coalesce(json_agg(json_build_object('id', sc.id, 'title', sc.title, 'ord', sc.ord, 'location_id', sc.location_id)
                   order by sc.ord) filter (where sc.id is not null), '[]') as scenes,
                 (select coalesce(json_agg(json_build_object('id', l.id, 'name', l.name, 'has_plate', l.layout_path is not null)
                   order by l.name), '[]') from studio.locations l where l.series_id = se.id) as locations,
                 exists (select 1 from studio.characters ch where ch.series_id = se.id) as has_cast
            from studio.series se left join studio.scenes sc on sc.series_id = se.id
           group by se.id, se.name, se.look, se.aspect, se.quality, se.genre, se.style_prompt order by se.name`);
        return json({ items: rows });
      }
      case "scene_create": {
        const [r] = await asUser(uid, (tx) => tx`select studio.create_scene(${String(body.series_id || "")}, ${String(body.title || "")}) as id`);
        return json({ ok: true, id: r.id });
      }
      case "shot_create": {
        // No camera given: none (see the note at the top); a camera the creator types ("locked", "slow pan") is kept
        const action = String(body.action || "");
        const camera = body.camera != null && String(body.camera).trim() ? String(body.camera) : null;
        const [r] = await asUser(uid, (tx) => tx`select studio.create_shot(${String(body.scene_id || "")}, ${action},
          ${camera}, ${Number(body.duration_s || 5)}::int) as id`);
        return json({ ok: true, id: r.id });
      }
      case "shot_update": {
        await asUser(uid, (tx) => tx`select studio.update_shot(${String(body.shot_id || "")}, ${String(body.action || "")},
          ${body.camera == null ? null : String(body.camera)}, ${Number(body.duration_s || 5)}::int)`);
        return json({ ok: true });
      }
      case "shot_cut_edit": {
        // How a kept shot plays in the scene cut (2026-11-23): speed, trims and the words drawn over it. Only the fields
        // sent change; each goes through its studio function, which checks the owner and the limits.
        const id = String(body.shot_id || "");
        await asUser(uid, async (tx) => {
          if (body.speed !== undefined) await tx`select studio.set_shot_speed(${id}, ${Number(body.speed)})`;
          if (body.trim_start_s !== undefined || body.trim_end_s !== undefined) {
            // a trim that was not sent keeps its current value (review 2026-11-23: it used to be reset to 0)
            const [cur] = await tx`select trim_start_s, trim_end_s from studio.shots where id = ${id}`;
            const ts = body.trim_start_s !== undefined ? Number(body.trim_start_s || 0) : Number(cur?.trim_start_s ?? 0);
            const te = body.trim_end_s !== undefined ? Number(body.trim_end_s || 0) : Number(cur?.trim_end_s ?? 0);
            await tx`select studio.set_shot_trim(${id}, ${ts}, ${te})`;
          }
          // studio.set_shot_words refuses anything that is not a list, with a message for the creator. tx.json, not
          // JSON.stringify + ::jsonb: a stringified value arrives as one jsonb string ("words must be a list", 2026-11-23 test)
          if (body.words !== undefined)
            await tx`select studio.set_shot_words(${id}, ${tx.json(body.words as postgres.JSONValue)})`;
        });
        return json({ ok: true });
      }
      case "shot_start_frame": {
        // the app uploaded the file to <uid>/stills/... with the creator's own session (storage policy studio_files_write)
        await asUser(uid, (tx) => tx`select studio.set_start_frame(${String(body.shot_id || "")}, ${String(body.path || "")})`);
        return json({ ok: true });
      }
      case "shot_start_approve": {
        await asUser(uid, (tx) => tx`select studio.approve_start_frame(${String(body.shot_id || "")})`);
        return json({ ok: true });
      }
      case "shot_delete": {
        await asUser(uid, (tx) => tx`select studio.delete_shot(${String(body.shot_id || "")})`);
        return json({ ok: true });
      }
      // ---- start stills, plates, library (studio.request_start_frame / request_plate / decide_frame / ...)
      case "start_frame": {
        const [r] = await asUser(uid, (tx) => tx`select studio.request_start_frame(${String(body.shot_id || "")}, ${String(body.mode || "")},
          ${body.instruction == null ? null : String(body.instruction)}, ${body.source == null ? null : String(body.source)}) as job_id`);
        return json({ ok: true, job_id: r.job_id });
      }
      case "frame_decide": {
        const job = String(body.job_id || ""), decision = String(body.decision || "");
        await asUser(uid, (tx) => tx`select studio.decide_frame(${job}, ${decision})`);
        return json({ ok: true, decision });
      }
      case "plate": {
        const [r] = await asUser(uid, (tx) => tx`select studio.request_plate(${String(body.location_id || "")}, ${String(body.shot_id || "")}) as job_id`);
        return json({ ok: true, job_id: r.job_id });
      }
      case "height_request": {
        const [r] = await asUser(uid, (tx) => tx`select studio.request_height_check(${String(body.shot_id || "")}) as job_id`);
        return json({ ok: true, job_id: r.job_id });
      }
      // ---- reference cut-outs (frame_jobs kind 'cutout', 2026-11-16): characters cut out of a shot's start still
      case "cutout_request": {
        const [r] = await asUser(uid, (tx) => tx`select studio.request_cutouts(${String(body.shot_id || "")}) as job_id`);
        return json({ ok: true, job_id: r.job_id });
      }
      case "cutouts": {
        // the shot's latest cut-out job, with a signed link per cut-out
        const [j] = await asUser(uid, (tx) => tx`
          select id, status, error, check_result from studio.frame_jobs
           where shot_id = ${String(body.shot_id || "")} and kind = 'cutout' order by created_at desc limit 1`);
        if (!j) return json({ job: null });
        const list = (j.check_result?.cutouts || []) as { index: number; path: string; box: number[]; warnings: string[] }[];
        return json({ job: { id: j.id, status: j.status, error: j.error,
          cutouts: await Promise.all(list.map(async (c) => ({ ...c, url: await sign(c.path) }))) } });
      }
      case "cutout_use": {
        const [r] = await asUser(uid, (tx) => tx`select studio.use_cutout(${String(body.job_id || "")}, ${Number(body.index || 0)}::int,
          ${String(body.character_id || "")}) as path`);
        return json({ ok: true, path: r.path });
      }
      case "library": {
        // a series' characters (with reference images) and locations (with plates and the latest plate job)
        const sid = String(body.series_id || "");
        const chars = await asUser(uid, (tx) => tx`
          select id, name, kind, what, height_units, wardrobe, ref_front_path from studio.characters where series_id = ${sid} order by name`);
        const locs = await asUser(uid, (tx) => tx`
          select l.id, l.name, l.description, l.layout_path, cardinality(l.other_plates) as other_plates, j.id as job_id, j.status as job_status, j.composed_path as job_path,
                 j.check_result as job_check, j.error as job_error,
                 (select coalesce(json_agg(sc.id), '[]') from studio.scenes sc where sc.location_id = l.id) as scene_ids
            from studio.locations l
            left join lateral (select * from studio.frame_jobs f where f.location_id = l.id order by created_at desc limit 1) j on true
           where l.series_id = ${sid} order by l.name`);
        return json({
          characters: await Promise.all(chars.map(async (c) => ({ ...c, ref_url: await sign(c.ref_front_path) }))),
          locations: await Promise.all(locs.map(async (l) => ({ ...l, plate_url: await sign(l.layout_path), job_url: await sign(l.job_path) }))),
          owner: uid,
        });
      }
      case "series_create": {
        const [r] = await asUser(uid, (tx) => tx`select studio.create_series(${String(body.name || "")}, ${body.style == null ? null : String(body.style)},
                                                   ${body.look == null ? null : String(body.look)}) as id`);
        if (body.genre) await asUser(uid, (tx) => tx`select studio.set_series_genre(${r.id}, ${String(body.genre)})`);
        if (body.aspect) await asUser(uid, (tx) => tx`select studio.set_series_aspect(${r.id}, ${String(body.aspect)})`);
        return json({ ok: true, id: r.id });
      }
      case "series_aspect": {
        // the project's shape (2026-11-21): 16:9, 9:16, 1:1, 4:3, 3:4 or 21:9; applies to images and clips made afterwards
        await asUser(uid, (tx) => tx`select studio.set_series_aspect(${String(body.series_id || "")}, ${String(body.aspect || "")})`);
        return json({ ok: true });
      }
      case "series_update": {
        // the look (cartoon | photoreal) and free-text style; they apply to frames and renders made afterwards (2026-11-16)
        await asUser(uid, (tx) => tx`select studio.update_series(${String(body.series_id || "")}, ${body.look == null ? null : String(body.look)},
                                                                ${body.style == null ? null : String(body.style)})`);
        return json({ ok: true });
      }
      case "series_quality": {
        // best | balanced | economy: which tested route Auto uses for this series (2026-11-19)
        await asUser(uid, (tx) => tx`select studio.set_series_quality(${String(body.series_id || "")}, ${String(body.quality || "")})`);
        return json({ ok: true });
      }
      // ---- scene cuts (studio.assemblies, worker assemble.js, 2026-11-19)
      case "assembly_create": {
        const opts = { fade: body.fade !== false, end_card: !!body.end_card, music_path: body.music_path ? String(body.music_path) : null,
                       voice: body.voice !== false, sfx: body.sfx !== false };
        const [r] = await asUser(uid, (tx) => tx`select studio.request_assembly(${String(body.scene_id || "")}, ${String(body.format || "16x9")},
          ${tx.json(opts)}) as id`);   // tx.json: a JSON object (a stringified one arrives as one jsonb string and every option is lost)
        return json({ ok: true, id: r.id });
      }
      case "assemblies": {
        // a scene's latest cuts; free accounts see the watermarked copy until they have paid (as with clips)
        const rows = await asUser(uid, (tx) => tx`
          select id, format, options, status, duration_s, report, error, skipped, jsonb_array_length(items) as shots,
                 output_path, preview_path, created_at
            from studio.assemblies where scene_id = ${String(body.scene_id || "")} order by created_at desc limit 5`);
        const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
        const items = await Promise.all(rows.map(async (a) => {
          const marked = !paid;   // fail closed (2026-11-21 review)
          const { output_path: _o, preview_path: _p, ...rest } = a;
          return { ...rest, watermarked: marked,
                   url: a.status === "done" ? (marked ? (a.preview_path ? await sign(a.preview_path, 3600) : null) : await sign(a.output_path, 3600)) : null };
        }));
        return json({ items });
      }
      case "character_create": {
        const h = body.height == null || body.height === "" ? null : Number(body.height);
        const [r] = await asUser(uid, (tx) => tx`select studio.create_character(${String(body.series_id || "")}, ${String(body.name || "")},
          ${h}, ${body.wardrobe == null ? null : String(body.wardrobe)}, ${body.kind == null ? "person" : String(body.kind)},
          ${body.what == null ? null : String(body.what)}) as id`);
        return json({ ok: true, id: r.id });
      }
      case "character_update": {
        // edit a character's card (2026-11-18); new frames and renders use it, finished ones keep what they were given
        const h = body.height == null || body.height === "" ? null : Number(body.height);
        await asUser(uid, (tx) => tx`select studio.update_character(${String(body.character_id || "")}, ${String(body.name || "")},
          ${h}, ${body.wardrobe == null ? null : String(body.wardrobe)}, ${body.kind == null ? "person" : String(body.kind)},
          ${body.what == null ? null : String(body.what)})`);
        return json({ ok: true });
      }
      case "character_ref": {
        await asUser(uid, (tx) => tx`select studio.set_character_ref(${String(body.character_id || "")}, ${String(body.path || "")})`);
        return json({ ok: true });
      }
      case "location_create": {
        const [r] = await asUser(uid, (tx) => tx`select studio.create_location(${String(body.series_id || "")}, ${String(body.name || "")},
          ${body.description == null ? null : String(body.description)}) as id`);
        return json({ ok: true, id: r.id });
      }
      case "location_plate": {
        await asUser(uid, (tx) => tx`select studio.set_location_plate(${String(body.location_id || "")}, ${String(body.path || "")})`);
        return json({ ok: true });
      }
      case "scene_location": {
        await asUser(uid, (tx) => tx`select studio.set_scene_location(${String(body.scene_id || "")}, ${body.location_id ? String(body.location_id) : null})`);
        return json({ ok: true });
      }
      case "shot_cast": {
        const ids = Array.isArray(body.cast) ? body.cast.map(String) : [];
        if (ids.length > 20 || ids.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) return json({ error: "bad cast" }, 400);
        await asUser(uid, (tx) => tx`select studio.set_shot_cast(${String(body.shot_id || "")}, ${"{" + ids.join(",") + "}"}::uuid[])`);
        return json({ ok: true });
      }
      case "decide": {
        const id = String(body.generation_id || ""), decision = String(body.decision || "");
        if (!["approve", "reject"].includes(decision)) return json({ error: "decision must be approve or reject" }, 400);
        const reasons = Array.isArray(body.reasons) ? body.reasons.map(String).slice(0, 10) : [];
        const note = body.note ? String(body.note).slice(0, 1000) : null;
        const atRaw = body.at_s == null || body.at_s === "" ? null : Number(body.at_s);
        const at = atRaw != null && isFinite(atRaw) ? atRaw : null;
        // 2026-11-21: Reject needs a reason and opens a refund request that anlim reviews (studio.review_generation v3)
        await asUser(uid, (tx) => tx`select studio.review_generation(${id}, ${decision}, ${reasons}, ${note}, ${at})`);
        return json({ ok: true, decision });
      }
      case "series_genre": {
        // optional genre, used only to file and filter work in Assets (2026-11-19)
        await asUser(uid, (tx) => tx`select studio.set_series_genre(${String(body.series_id || "")}, ${body.genre ? String(body.genre) : null})`);
        return json({ ok: true });
      }
      // ---- Assets: everything the creator has made, filtered (studio.my_assets + music in storage, 2026-11-19)
      case "assets": {
        const kind = body.kind ? String(body.kind) : null, series = body.series_id ? String(body.series_id) : null;
        const look = body.look ? String(body.look) : null, genre = body.genre ? String(body.genre) : null;
        const status = body.status ? String(body.status) : null, q = body.q ? `%${String(body.q).slice(0, 80)}%` : null;
        const asc = body.sort === "oldest", limit = Math.min(Math.max(Number(body.limit) || 48, 1), 96), offset = Math.max(Number(body.offset) || 0, 0);
        const rows = await asUser(uid, (tx) => tx`
          select * from studio.my_assets() a
           where (${series}::uuid is null or a.series_id = ${series}::uuid) and (${look}::text is null or a.look = ${look})
             and (${genre}::text is null or a.genre = ${genre}) and (${status}::text is null or a.status = ${status})
             and (${q}::text is null or a.title ilike ${q} or a.series_name ilike ${q} or coalesce(a.scene_title, '') ilike ${q} or coalesce(a.subtitle, '') ilike ${q})`);
        // music: the creator's own uploaded tracks (no series, so series / look / genre / status filters leave it out)
        let music: Record<string, unknown>[] = [];
        if (!series && !look && !genre && (!status || status === "kept")) {
          const { data } = await admin.storage.from(BUCKET).list(`${uid}/music`, { limit: 200, sortBy: { column: "created_at", order: "desc" } });
          music = (data || []).filter((f) => f.id && (!q || f.name.toLowerCase().includes(String(body.q).toLowerCase())))
            .map((f) => ({ kind: "music", id: f.id, created_at: f.created_at, title: f.name, subtitle: "Your track",
                           path: `${uid}/music/${f.name}`, status: "kept" }));
        }
        const all = [...rows, ...music] as Record<string, any>[];
        const counts: Record<string, number> = { all: all.length };
        for (const a of all) counts[a.kind] = (counts[a.kind] || 0) + 1;
        const list = all.filter((a) => !kind || a.kind === kind)
          .sort((a, b) => (asc ? 1 : -1) * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()));
        const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
        const page = await Promise.all(list.slice(offset, offset + limit).map(async (a) => {
          const marked = !paid && (a.kind === "clip" || a.kind === "cut");   // fail closed (2026-11-21 review)
          const { path, preview_path: _p, thumb_path, ...rest } = a;
          const [thumb_url, url] = await Promise.all([thumb(thumb_path ?? null), (marked ? (a.preview_path ? sign(a.preview_path, 3600) : Promise.resolve(null)) : sign(path, 3600))]);
          return { ...rest, watermarked: marked, thumb_url, url,
                   upload_path: a.kind === "music" && !a.series_id ? path : null };   // an uploaded track: deleted by its path
        }));
        return json({ items: page, total: list.length, counts });
      }
      // ---- Home: what anlim can do, the models it uses, and where the creator left off (2026-11-19)
      case "home": {
        const models = await sql`
          select m.id, m.label, m.resolution, m.credits_per_second, m.min_duration_s, m.max_duration_s, m.looks,
                 coalesce((select json_agg(json_build_object('look', r.look, 'kind', r.kind) order by r.look, r.kind)
                             from studio.model_routes r where r.model_id = m.id), '[]') as auto_for
            from studio.models m where m.active and m.provider <> 'mock' and m.kind = 'clip' order by m.credits_per_second desc`;
        const [counts] = await asUser(uid, (tx) => tx`
          select (select count(*) from studio.series)::int as series,
                 (select count(*) from studio.shots)::int as shots,
                 (select count(*) from studio.shots where approved_generation_id is not null)::int as kept,
                 (select count(*) from studio.my_assets() a where a.kind = 'clip' and a.status = 'to_review')::int as to_review,
                 (select count(*) from studio.assemblies where status = 'done')::int as cuts`);
        const recent = await asUser(uid, (tx) => tx`
          select kind, id, title, series_name, scene_title, shot_id, scene_id, thumb_path, created_at from studio.my_assets()
           where kind in ('clip', 'cut') and status <> 'rejected' order by created_at desc limit 6`);
        const [last] = await asUser(uid, (tx) => tx`
          select sh.id as shot_id, sh.ord, sh.action, sc.id as scene_id, sc.title as scene_title, se.id as series_id, se.name as series_name,
                 sh.start_frame_path
            from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
            left join lateral (select max(created_at) t from studio.generations g where g.shot_id = sh.id) g on true
            left join lateral (select max(created_at) t from studio.frame_jobs f where f.shot_id = sh.id) f on true
           order by greatest(coalesce(g.t, sh.created_at), coalesce(f.t, sh.created_at), sh.created_at) desc limit 1`);
        return json({ models, counts,
          recent: await Promise.all(recent.map(async ({ thumb_path, ...r }) => ({ ...r, thumb_url: await thumb(thumb_path) }))),
          last: last ? { ...last, start_frame_path: undefined, thumb_url: await thumb(last.start_frame_path) } : null });
      }
      // ---- connections (ElevenLabs, 2026-11-19)
      case "connections": {
        const rows = await asUser(uid, (tx) => tx`select provider, key_hint, account, status, checked_at, created_at from studio.connections`);
        return json({ items: rows });
      }
      case "connection_set": {
        if (body.provider !== "elevenlabs") return json({ error: "unknown service" }, 400);
        const key = String(body.key || "").trim();
        if (!/^[A-Za-z0-9_\-]{20,200}$/.test(key)) return json({ error: "That does not look like an ElevenLabs API key." }, 400);
        // 10 key tries an account an hour (connects and checks), so the form cannot test other people's keys in bulk (review 2026-11-19)
        const [{ n }] = await sql`select count(*)::int as n from studio.connection_attempts where owner = ${uid} and at > now() - interval '1 hour'`;
        if (n >= 10) return json({ error: "Too many tries. Wait an hour, then connect again." }, 429);
        const chk = await xiCheck(key);
        await sql`insert into studio.connection_attempts(owner, ok) values (${uid}, ${chk.ok})`;
        if (!chk.ok) return json({ error: chk.status === 401 ? "ElevenLabs refused this key. Copy it again from ElevenLabs > Developers > API Keys."
          : `ElevenLabs did not accept the key (${chk.status}${chk.detail ? `: ${String(chk.detail).slice(0, 120)}` : ""}).` }, 400);
        const hint = `…${key.slice(-4)}`;
        // one transaction, locked per account: two quick "Connect" clicks cannot leave a second copy of the key in Vault
        await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${"xi:" + uid}))`;
          const [old] = await tx`select secret_id from studio.connections where owner = ${uid} and provider = 'elevenlabs'`;
          if (old) {
            await tx`select vault.update_secret(${old.secret_id}, ${key})`;
            await tx`update studio.connections set key_hint = ${hint}, account = ${tx.json(chk.account)}, status = 'ok', checked_at = now(),
                        updated_at = now() where owner = ${uid} and provider = 'elevenlabs'`;
          } else {
            const [sec] = await tx`select vault.create_secret(${key}, ${"elevenlabs:" + uid}, 'anlim creator ElevenLabs key') as id`;
            await tx`insert into studio.connections(owner, provider, secret_id, key_hint, account, status, checked_at)
                      values (${uid}, 'elevenlabs', ${sec.id}, ${hint}, ${tx.json(chk.account)}, 'ok', now())`;
          }
        });
        return json({ ok: true, key_hint: hint, account: chk.account });
      }
      case "connection_check": {
        const key = await xiKey(uid);
        if (!key) return json({ error: "not connected" }, 400);
        const [{ n }] = await sql`select count(*)::int as n from studio.connection_attempts where owner = ${uid} and at > now() - interval '1 hour'`;
        if (n >= 20) return json({ error: "Checked too often. Try again in an hour." }, 429);
        await sql`insert into studio.connection_attempts(owner, ok) values (${uid}, true)`;
        const chk = await xiCheck(key);
        if (chk.ok) await sql`update studio.connections set status = 'ok', account = ${sql.json(chk.account)}, checked_at = now(), updated_at = now()
                               where owner = ${uid} and provider = 'elevenlabs'`;
        else await sql`update studio.connections set status = 'invalid', checked_at = now(), updated_at = now()
                        where owner = ${uid} and provider = 'elevenlabs'`;
        return json({ ok: chk.ok, account: chk.ok ? chk.account : null });
      }
      case "connection_remove": {
        const [old] = await sql`delete from studio.connections where owner = ${uid} and provider = 'elevenlabs' returning secret_id`;
        if (old) await sql`delete from vault.secrets where id = ${old.secret_id}`;
        return json({ ok: true });
      }
      case "voices": {
        // the voices in the creator's ElevenLabs library (their own, saved and default voices)
        const key = await xiKey(uid);
        if (!key) return json({ error: "connect your ElevenLabs account first" }, 400);
        const q = body.search ? `&search=${encodeURIComponent(String(body.search).slice(0, 60))}` : "";
        const r = await xiGet(key, `/v2/voices?page_size=100&sort=name&sort_direction=asc${q}`);
        if (!r.ok) return json({ error: r.status === 401 ? "ElevenLabs refused your key; reconnect it in Account." : `ElevenLabs error ${r.status}` }, 400);
        return json({ items: (r.body?.voices || []).map((v: any) => ({ id: v.voice_id, name: v.name, category: v.category,
          gender: v.labels?.gender ?? null, accent: v.labels?.accent ?? null, age: v.labels?.age ?? null,
          description: v.labels?.description ?? v.description ?? null, preview_url: v.preview_url ?? null })) });
      }
      // ---- audio for scene cuts (studio.audio_jobs, worker audio.js)
      case "audio_create": {
        // 2026-11-22: a score may carry its style and sections (one per shot), checked by studio.request_audio
        const input = { text: body.text ?? null, voice_id: body.voice_id ?? null, voice_name: body.voice_name ?? null,
                        duration_s: body.duration_s ?? null, length_s: body.length_s ?? null, instrumental: body.instrumental ?? null,
                        styles: body.styles ?? null, sections: Array.isArray(body.sections) ? body.sections.slice(0, 30) : null,
                        at_s: body.at_s ?? null };   // 2026-11-23: a voiceover with no shot is the scene's narration, from at_s
        const [r] = await asUser(uid, (tx) => tx`select studio.request_audio(${String(body.scene_id || "")}, ${body.shot_id ? String(body.shot_id) : null},
          ${String(body.kind || "")}, ${tx.json(input)}) as id`);
        return json({ ok: true, id: r.id });
      }
      case "audio_list": {
        const rows = await asUser(uid, (tx) => tx`
          select id, shot_id, kind, input, status, in_cut, duration_s, error, output_path, created_at from studio.audio_jobs
           where scene_id = ${String(body.scene_id || "")} order by created_at desc limit 200`);
        return json({ items: await Promise.all(rows.map(async ({ output_path, ...a }) => ({ ...a, url: await sign(output_path) }))) });
      }
      case "narration_start": {
        await asUser(uid, (tx) => tx`select studio.set_narration_start(${String(body.id || "")}, ${Number(body.at_s)})`);
        return json({ ok: true });
      }
      case "audio_use": {
        await asUser(uid, (tx) => tx`select studio.use_audio(${String(body.id || "")}, ${!!body.on})`);
        return json({ ok: true });
      }
      // ---- managing work (2026-11-19): rename / delete series and scenes, reorder shots, delete assets
      case "series_rename": {
        await asUser(uid, (tx) => tx`select studio.rename_series(${String(body.series_id || "")}, ${String(body.name || "")})`);
        return json({ ok: true });
      }
      case "scene_rename": {
        await asUser(uid, (tx) => tx`select studio.rename_scene(${String(body.scene_id || "")}, ${String(body.title || "")})`);
        return json({ ok: true });
      }
      case "series_delete": {
        const rows = await asUser(uid, (tx) => tx`select studio.delete_series(${String(body.series_id || "")}) as p`);
        return json({ ok: true, files: await removeFiles(uid, rows.map((r) => r.p)) });
      }
      case "scene_delete": {
        const rows = await asUser(uid, (tx) => tx`select studio.delete_scene(${String(body.scene_id || "")}) as p`);
        return json({ ok: true, files: await removeFiles(uid, rows.map((r) => r.p)) });
      }
      case "shot_move": {
        await asUser(uid, (tx) => tx`select studio.move_shot(${String(body.shot_id || "")}, ${Number(body.dir) < 0 ? -1 : 1}::int)`);
        return json({ ok: true });
      }
      case "asset_delete": {
        const kind = String(body.kind || "");
        if (kind === "music" && body.path) {
          // an uploaded track: only a file in the caller's own music folder
          const p = String(body.path);
          if (!p.startsWith(`${uid}/music/`) || p.includes("..")) return json({ error: "not found" }, 404);
          return json({ ok: true, files: await removeFiles(uid, [p]) });
        }
        const rows = await asUser(uid, (tx) => tx`select studio.delete_asset(${kind}, ${String(body.id || "")}) as p`);
        return json({ ok: true, files: await removeFiles(uid, rows.map((r) => r.p)) });
      }
      // ---- what finished lately, for the app's notices (2026-11-19)
      case "activity": {
        const since = new Date(Number(body.since) || Date.now() - 5 * 60_000).toISOString();
        const rows = await asUser(uid, (tx) => tx`
          select 'clip' as kind, g.id, g.status, g.updated_at, sh.ord, sc.title as scene_title, sc.id as scene_id, sh.id as shot_id
            from studio.generations g join studio.shots sh on sh.id = g.shot_id join studio.scenes sc on sc.id = sh.scene_id
           where g.updated_at > ${since} and g.status in ('review', 'succeeded', 'failed')
          union all
          select 'frame', f.id, f.status, f.updated_at, sh.ord, sc.title, sc.id, sh.id
            from studio.frame_jobs f join studio.shots sh on sh.id = f.shot_id join studio.scenes sc on sc.id = sh.scene_id
           where f.updated_at > ${since} and f.status in ('ready', 'failed') and f.kind in ('start', 'end')
          union all
          select 'cut', a.id, a.status, a.updated_at, null, sc.title, sc.id, null
            from studio.assemblies a join studio.scenes sc on sc.id = a.scene_id
           where a.updated_at > ${since} and a.status in ('done', 'failed')
          union all
          select 'audio', a.id, a.status, a.updated_at, sh.ord, sc.title, sc.id, sh.id
            from studio.audio_jobs a join studio.scenes sc on sc.id = a.scene_id left join studio.shots sh on sh.id = a.shot_id
           where a.updated_at > ${since} and a.status in ('done', 'failed')
          order by 4 limit 30`);
        return json({ items: rows, now: Date.now() });
      }
      default:
        return json({ error: "unknown op" }, 400);
    }
  } catch (e) {
    // Messages written for creators (raise exception in studio.* functions, SQLSTATE P0001) are shown as they are;
    // anything else (a database or network error) is logged here and the app gets a plain message with a reference.
    const msg = e instanceof Error ? e.message : String(e);
    if ((e as { code?: string })?.code === "P0001") return json({ error: msg.slice(0, 300) }, 400);
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`studio-api ${String(body?.op)} ref ${ref}: ${msg}`);
    return json({ error: `Something went wrong (ref ${ref}). Try again; if it keeps happening, contact support with this reference.` }, 500);
  }
}

// CORS (review 2026-11-19): only the app's own web origins (APP_URLS) may call this from a browser; the iOS / Android
// app sends no Origin and is not affected.
const APP_ORIGINS = (Deno.env.get("APP_URLS") || "http://localhost:8081").split(",").map((s) => s.trim()).filter(Boolean);
Deno.serve(async (req) => {
  const res = await handle(req);
  const origin = req.headers.get("Origin");
  if (origin && APP_ORIGINS.includes(origin)) { res.headers.set("Access-Control-Allow-Origin", origin); res.headers.set("Vary", "Origin"); }
  return res;
});

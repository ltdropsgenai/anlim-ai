// studio-storage: hands the video worker one-time links for the private "studio" bucket, so the
// service_role key never leaves Supabase. Auth: header x-worker-token, checked against its SHA-256 below
// (rotate = new token in worker\.env + redeploy with the new hash). @anlim
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const TOKEN_SHA256 = "0b79efae32809a607d361d737503d76793581226a1dd6c0ba98b9b5fddd4d25e";
const BUCKET = "studio";
const PATH_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._\-\/]{1,200}$/;

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

// Storage clean-up (2026-11-23, migration studio_retention): the worker starts it once a day. It never sends file
// names: studio.retention_due chooses what to remove (failed or rejected clips, discarded frames, cuts beyond a scene's
// 3 newest, all older than `days`, never a file a kept row points to), and only files in that owner's own folder or
// their clean copies are removed. At least 7 days, whatever the caller asks, so a bad request cannot sweep fresh work.
async function retention(days: number, dry: boolean) {
  const d = Math.max(7, Math.min(365, Math.round(Number(days) || 30)));
  const rows = await sql`select kind, ref_id, owner, paths, bytes from studio.retention_due(${d}, 200)`;
  let done = 0, files = 0, bytes = 0, skipped = 0;
  for (const r of rows) {
    const owner = String(r.owner);
    const paths = (r.paths as string[]) || [];
    const mine = (p: string) => !p.includes("..") &&
      (p.startsWith(`${owner}/`) || p.startsWith(`00000000-0000-0000-0000-000000000000/clean/${owner}/`));
    if (!paths.length || !paths.every(mine)) { skipped++; continue; }
    if (dry) { done++; files += paths.length; bytes += Number(r.bytes) || 0; continue; }
    const { error } = await sb.storage.from(BUCKET).remove([...paths, ...paths.map(thumbPath).filter((t): t is string => !!t)]);
    if (error) { console.error(`retention ${r.kind} ${r.ref_id}: ${error.message}`); skipped++; continue; }
    await sql`select studio.retention_done(${r.kind}, ${r.ref_id}, ${owner}::uuid, ${paths}::text[], ${Number(r.bytes) || 0}::bigint)`;
    done++; files += paths.length; bytes += Number(r.bytes) || 0;
  }
  return { days: d, dry, candidates: rows.length, done, files, bytes, skipped };
}

// Previews (2026-11-25): the worker writes a small JPEG beside each picture (worker/src/thumbs.js) at thumbPath(), inside
// the owner's folder; studio-api hands it out instead of a Storage transform. "thumbs_due" names pictures that have none
// yet, newest first; only pictures over 150 kB (smaller ones are sent as they are).
const VAULT = "00000000-0000-0000-0000-000000000000/clean/";
function thumbPath(p: string) {
  const m = p.startsWith(VAULT) ? p.match(/^(00000000-0000-0000-0000-000000000000\/clean\/[^/]+\/)(.+)$/) : p.match(/^([^/]+\/)(.+)$/);
  return m ? `${m[1]}thumbs/${m[2]}.jpg` : null;
}
async function thumbsDue(limit: number) {
  const n = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
  // no backslashes in here: a tagged template turns "\1" into undefined (2026-11-25, first deploy failed on it)
  const rows = await sql`
    with pics as (
      select o.name, o.created_at,
             coalesce(substring(o.name from '^00000000-0000-0000-0000-000000000000/clean/[^/]+/'), split_part(o.name, '/', 1) || '/') as pre
        from storage.objects o
       where o.bucket_id = ${BUCKET} and o.name ~* '[.](png|jpe?g|webp)$' and o.name !~ '(^|/)thumbs/'
         and coalesce((o.metadata->>'size')::bigint, 0) > 150000)
    select p.name from pics p
     where not exists (select 1 from storage.objects t where t.bucket_id = ${BUCKET}
                         and t.name = p.pre || 'thumbs/' || substr(p.name, length(p.pre) + 1) || '.jpg')
     order by p.created_at desc limit ${n}`;
  return rows.map((r) => ({ path: String(r.name), thumb: thumbPath(String(r.name)) })).filter((r) => r.thumb);
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const tok = req.headers.get("x-worker-token") || "";
  if (!tok || (await sha256(tok)) !== TOKEN_SHA256) return json({ error: "unauthorized" }, 401);
  let body: { op?: string; path?: string; expires?: number; days?: number; dry?: boolean; limit?: number };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (body.op === "retention") {
    try { return json(await retention(Number(body.days) || 30, body.dry === true)); }
    catch (e) { console.error("retention:", (e as Error).message); return json({ error: "retention failed" }, 500); }
  }
  if (body.op === "thumbs_due") {
    try { return json({ due: await thumbsDue(Number(body.limit) || 20) }); }
    catch (e) { console.error("thumbs_due:", (e as Error).message); return json({ error: "thumbs_due failed" }, 500); }
  }
  const path = body.path || "";
  if (!PATH_OK.test(path) || path.includes("..")) return json({ error: "bad path" }, 400);
  if (body.op === "sign_download") {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, Math.min(body.expires || 3600, 86400));
    return error ? json({ error: error.message }, 400) : json({ url: data.signedUrl });
  }
  if (body.op === "sign_upload") {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
    return error ? json({ error: error.message }, 400) : json({ url: data.signedUrl, token: data.token });
  }
  return json({ error: "op must be sign_download, sign_upload, retention or thumbs_due" }, 400);
});

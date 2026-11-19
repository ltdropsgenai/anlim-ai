// studio-storage: hands the video worker one-time links for the private "studio" bucket, so the
// service_role key never leaves Supabase. Auth: header x-worker-token, checked against its SHA-256 below
// (rotate = new token in worker\.env + redeploy with the new hash). @anlim
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN_SHA256 = "0b79efae32809a607d361d737503d76793581226a1dd6c0ba98b9b5fddd4d25e";
const BUCKET = "studio";
const PATH_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._\-\/]{1,200}$/;

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });

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
  let body: { op?: string; path?: string; expires?: number };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
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
  return json({ error: "op must be sign_download or sign_upload" }, 400);
});

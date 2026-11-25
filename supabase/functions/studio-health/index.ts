// studio-health: emails Londi when anlim stops working (2026-11-25 launch audit: nothing watched the worker). @anlim
// Called every 15 minutes by pg_cron + pg_net (migration studio_health_cron), so it runs even when the Fly worker is
// down. It reads the job tables only and answers {ok:true} whatever it finds; calls without the schedule's key are refused; each alert goes out at most once per 6 hours per kind (Resend Idempotency-Key), so it cannot be used to spam.
// Checks:
//   stalled  - work queued for more than 10 minutes (the worker picks jobs up within seconds): the worker is down
//   stuck    - clips rendering or being checked with no progress for more than 75 minutes (motion timeout is 60)
//   provider - a provider refused for money or quota (fal, Higgsfield, OpenAI, ElevenLabs) in the last 2 hours
//   failures - 3 or more clips or images failed in the last hour (creator rejections and refusals not counted)
import postgres from "npm:postgres@3.4.5";

const TO = "sysadmin@codeascent.online";
const FROM = "anlim.ai alerts <alerts@mail.anlim.ai>";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function findings() {
  const [r] = await sql`
    select
      (select count(*) from studio.generations where status = 'queued' and created_at < now() - interval '10 minutes')
    + (select count(*) from studio.frame_jobs  where status = 'queued' and created_at < now() - interval '10 minutes')
    + (select count(*) from studio.assemblies  where status = 'queued' and created_at < now() - interval '10 minutes')
    + (select count(*) from studio.audio_jobs  where status = 'queued' and created_at < now() - interval '10 minutes')
    + (select count(*) from studio.exports     where status = 'queued' and created_at < now() - interval '10 minutes') as stalled,
      (select count(*) from studio.generations where status in ('running', 'checking') and updated_at < now() - interval '75 minutes')
    + (select count(*) from studio.frame_jobs  where status in ('running', 'composing') and updated_at < now() - interval '75 minutes')
    + (select count(*) from studio.assemblies  where status = 'running' and updated_at < now() - interval '75 minutes') as stuck,
      (select count(*) from (
         select error from studio.generations where updated_at > now() - interval '2 hours' and status = 'failed'
         union all select error from studio.frame_jobs where updated_at > now() - interval '2 hours' and status = 'failed'
         union all select error from studio.audio_jobs where updated_at > now() - interval '2 hours' and status = 'failed') e
        where e.error ~* '(fal|higgsfield|openai|elevenlabs|provider)'
          and e.error ~* '(insufficient|balance|exhaust|quota|402|billing|payment required|out of credit|top up)') as provider,
      (select count(*) from studio.generations where status = 'failed' and updated_at > now() - interval '1 hour'
          and coalesce(error, '') !~* '(rejected by creator|refused|not allowed|moderation)')
    + (select count(*) from studio.frame_jobs  where status = 'failed' and updated_at > now() - interval '1 hour'
          and coalesce(error, '') !~* '(refused|not allowed|moderation)') as failures,
      (select left(string_agg(distinct left(coalesce(error, '?'), 140), E'\n'), 1500) from (
         select error from studio.generations where status = 'failed' and updated_at > now() - interval '2 hours'
         union all select error from studio.frame_jobs where status = 'failed' and updated_at > now() - interval '2 hours'
         union all select error from studio.assemblies where status = 'failed' and updated_at > now() - interval '2 hours'
         union all select error from studio.audio_jobs where status = 'failed' and updated_at > now() - interval '2 hours') x) as recent_errors`;
  const issues: Array<{ kind: string; line: string }> = [];
  if (Number(r.stalled) > 0) issues.push({ kind: "stalled", line: `${r.stalled} job(s) have waited more than 10 minutes to start. The worker (Fly app anlim-worker) is probably down or stuck.` });
  if (Number(r.stuck) > 0) issues.push({ kind: "stuck", line: `${r.stuck} job(s) have made no progress for more than 75 minutes.` });
  if (Number(r.provider) > 0) issues.push({ kind: "provider", line: `${r.provider} render(s) failed because a provider refused for money or quota. Check the fal, Higgsfield, OpenAI and ElevenLabs balances.` });
  if (Number(r.failures) >= 3) issues.push({ kind: "failures", line: `${r.failures} clips or images failed in the last hour.` });
  return { issues, recent: String(r.recent_errors || "") };
}

async function send(kinds: string[], text: string, test: boolean) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.error("studio-health: RESEND_API_KEY is not set"); return false; }
  const bucket = Math.floor(Date.now() / (test ? 3600_000 : 6 * 3600_000));   // one email per kind per 6 h (test: per hour)
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `health-${kinds.sort().join("-")}-${bucket}` },
    body: JSON.stringify({ from: FROM, to: [TO], subject: test ? "anlim.ai alerts: test" : `anlim.ai needs attention: ${kinds.join(", ")}`, text }),
  });
  if (!r.ok) console.error(`studio-health resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.ok;
}

// Only the schedule may run the checks (2026-11-25 review): it sends the key kept in Vault (migration
// studio_admin_hardening), which this function reads from the database; the key never appears in code or settings.
async function keyOk(given: string) {
  if (!given) return false;
  const [r] = await sql`select decrypted_secret as k from vault.decrypted_secrets where name = 'studio_health_key'`;
  const k = String(r?.k || "");
  if (!k || k.length !== given.length) return false;
  let d = 0;
  for (let i = 0; i < k.length; i++) d |= k.charCodeAt(i) ^ given.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await keyOk(req.headers.get("x-health-key") || ""))) return json({ error: "unauthorized" }, 401);
  let body: { test?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  try {
    const { issues, recent } = await findings();
    if (body.test === true) {
      await send(["test"], `This is a test of the anlim.ai health alerts. Current findings: ${issues.length ? issues.map((i) => i.line).join(" ") : "none"}.`, true);
    } else if (issues.length) {
      const text = issues.map((i) => `- ${i.line}`).join("\n") +
        (recent ? `\n\nRecent errors (last 2 hours):\n${recent}` : "") +
        "\n\nWorker: https://fly.io/apps/anlim-worker/monitoring\nThis check runs every 15 minutes; the same alert repeats at most every 6 hours.";
      await send(issues.map((i) => i.kind), text, false);
      console.log(`studio-health: ${issues.map((i) => i.kind).join(",")}`);
    }
  } catch (e) {
    console.error("studio-health:", (e as Error).message);
  }
  return json({ ok: true });
});

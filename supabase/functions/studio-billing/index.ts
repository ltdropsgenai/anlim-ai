// studio-billing: credit packs and plans through Stripe Checkout, the Stripe billing portal, and Stripe's webhook. @anlim
//   Creator ops (signed in): POST {op: "plans"} | {op: "checkout", plan_id, return_url} | {op: "portal", return_url}
//                            | {op: "account_delete", confirm: "<the account's email>"} (2026-11-19)
//   Stripe webhook: POST with a Stripe-Signature header -> signature checked -> studio.apply_stripe_event(event).
// Deployed with verify_jwt off (Stripe sends no Supabase JWT); creator ops check the sign-in themselves.
// Secrets: STRIPE_SECRET_KEY (sk_test_… while testing), STRIPE_WEBHOOK_SECRET (whsec_…), APP_URLS (allowed return
// origins, comma separated; default http://localhost:8081).
// Stripe prices are made on first use from studio.price_plans (lookup_key = plan id, one product per tier/pack).
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";
import { verifyStripeSignature } from "./stripe_sig.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const APP_URLS = (Deno.env.get("APP_URLS") || "http://localhost:8081").split(",").map((s) => s.trim()).filter(Boolean);

const cors = {
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---- Stripe REST (form-encoded) ----
function form(o: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === "object" ? form(x as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x)));
    else if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idem?: string) {
  if (!STRIPE_KEY) throw new Error("billing is not set up yet (no Stripe key)");
  const url = `https://api.stripe.com/v1/${path}` + (method === "GET" && body ? `?${form(body)}` : "");
  const r = await fetch(url, {
    method, headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded",
                       ...(idem ? { "Idempotency-Key": idem } : {}) },
    body: method === "POST" && body ? form(body) : undefined,
  });
  const res = await r.json();
  if (!r.ok) throw Object.assign(new Error(`Stripe: ${res?.error?.message || r.status}`), { status: r.status, code: res?.error?.code });
  return res;
}

type Plan = { id: string; kind: "pack" | "plan"; tier: string | null; billing_interval: "month" | "year" | null; name: string;
              price_cents: number; credits: number; stripe_price_id: string | null };

// one Stripe product per tier ("studio_pro") or pack ("studio_pack_pack_1000_v1"); custom ids make this idempotent
async function productFor(p: Plan) {
  const id = p.kind === "plan" ? `studio_${p.tier}` : `studio_pack_${p.id}`;
  try { await stripe("GET", `products/${id}`); }
  catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
    await stripe("POST", "products", { id, name: p.kind === "plan" ? `${p.name} plan` : p.name,
      metadata: { app: "studio" } }, `product-${id}`);
  }
  return id;
}
async function priceFor(p: Plan) {
  if (p.stripe_price_id) return p.stripe_price_id;
  const found = await stripe("GET", "prices", { lookup_keys: [p.id], active: true, limit: 1 });
  let price = found.data?.[0]?.id as string | undefined;
  if (!price) {
    const created = await stripe("POST", "prices", {
      product: await productFor(p), currency: "usd", unit_amount: p.price_cents, lookup_key: p.id,
      recurring: p.billing_interval ? { interval: p.billing_interval } : undefined,
      metadata: { plan_id: p.id, credits: p.credits },
    }, `price-${p.id}`);
    price = created.id as string;
  }
  await sql`select studio.set_stripe_price(${p.id}, ${price})`;
  return price;
}
async function customerFor(uid: string, email: string | undefined) {
  const [a] = await sql`select stripe_customer_id from studio.accounts where owner = ${uid}`;
  if (a?.stripe_customer_id) return a.stripe_customer_id as string;
  const c = await stripe("POST", "customers", { email, metadata: { owner: uid } }, `customer-${uid}`);
  await sql`select studio.set_stripe_customer(${uid}, ${c.id})`;
  const [b] = await sql`select stripe_customer_id from studio.accounts where owner = ${uid}`;   // a parallel call may have won
  return b.stripe_customer_id as string;
}
function returnUrl(u: unknown) {
  const s = String(u || "");
  try { const url = new URL(s); if (APP_URLS.includes(url.origin)) return url.origin + url.pathname; } catch { /* fall through */ }
  return APP_URLS[0] + "/billing";
}

// The billing portal configuration: ours (metadata app=studio) if it exists, else made once: cancel at period end,
// switch between the plan prices (proration invoiced now), update card, invoices.
async function portalConfig() {
  const list = await stripe("GET", "billing_portal/configurations", { active: true, limit: 100 });
  const ours = (list.data || []).find((c: { metadata?: Record<string, string> }) => c.metadata?.app === "studio");
  if (ours) return ours.id as string;
  const plans = await sql<Plan[]>`select * from studio.price_plans where active and kind = 'plan' order by sort`;
  const byProduct = new Map<string, string[]>();
  for (const p of plans) {
    const prod = await productFor(p), price = await priceFor(p);
    byProduct.set(prod, [...(byProduct.get(prod) || []), price]);
  }
  const cfg = await stripe("POST", "billing_portal/configurations", {
    business_profile: { headline: "Manage your plan" }, metadata: { app: "studio" },
    features: {
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: { enabled: true, default_allowed_updates: ["price"], proration_behavior: "always_invoice",
        products: [...byProduct].map(([product, prices]) => ({ product, prices })) },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
    },
  }, "portal-config-v1");
  return cfg.id as string;
}

async function handleWebhook(req: Request) {
  const raw = await req.text();
  if (!await verifyStripeSignature(raw, req.headers.get("Stripe-Signature"), WEBHOOK_SECRET)) return json({ error: "bad signature" }, 400);
  const event = JSON.parse(raw);
  if (event.livemode && STRIPE_KEY.startsWith("sk_test_")) return json({ received: true, result: "live event ignored by a test key" });
  try {
    const [r] = await sql`select studio.apply_stripe_event(${event}::jsonb) as result`;
    console.log(`stripe ${event.type} ${event.id}: ${r.result}`);
    return json({ received: true, result: r.result });
  } catch (e) {
    console.error(`stripe ${event.type} ${event.id} failed: ${(e as Error).message}`);
    return json({ error: "could not apply" }, 500);                        // Stripe retries
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (req.headers.get("Stripe-Signature")) return handleWebhook(req);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !who?.user) return json({ error: "sign in first" }, 401);
  const uid = who.user.id;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  try {
    switch (body.op) {
      case "plans": {
        const plans = await sql`select id, kind, tier, billing_interval, name, price_cents, credits from studio.price_plans
                                 where active order by sort`;
        await sql`select studio.refresh_plan(${uid})`;
        const [a] = await sql`select balance, reserved, plan_credits, plan_id, plan_status, plan_period_end, plan_next_refresh,
                                     plan_cancel_at_period_end, plan_cancel_at, stripe_customer_id is not null as has_customer
                                from studio.accounts where owner = ${uid}`;
        return json({ plans, account: a ?? null, ready: !!STRIPE_KEY });
      }
      case "checkout": {
        const [p] = await sql<Plan[]>`select * from studio.price_plans where id = ${String(body.plan_id || "")} and active`;
        if (!p) return json({ error: "unknown plan" }, 400);
        const [a] = await sql`select plan_status from studio.accounts where owner = ${uid}`;
        if (p.kind === "plan" && ["active", "trialing", "past_due"].includes(a?.plan_status))
          return json({ error: "you already have a plan: use Manage plan to change it" }, 400);
        const back = returnUrl(body.return_url), meta = { owner: uid, plan_id: p.id };
        const session = await stripe("POST", "checkout/sessions", {
          mode: p.kind === "pack" ? "payment" : "subscription",
          customer: await customerFor(uid, who.user.email),
          line_items: [{ price: await priceFor(p), quantity: 1 }],
          success_url: `${back}?paid=${p.id}`, cancel_url: `${back}?cancelled=1`,
          metadata: meta, client_reference_id: uid,
          ...(p.kind === "pack" ? { payment_intent_data: { metadata: meta } } : { subscription_data: { metadata: meta } }),
        });
        return json({ url: session.url });
      }
      case "portal": {
        const [a] = await sql`select stripe_customer_id from studio.accounts where owner = ${uid}`;
        if (!a?.stripe_customer_id) return json({ error: "nothing to manage yet: buy a plan or a pack first" }, 400);
        const configuration = await portalConfig();
        const s = await stripe("POST", "billing_portal/sessions", { customer: a.stripe_customer_id, return_url: returnUrl(body.return_url), configuration });
        return json({ url: s.url });
      }
      case "account_delete": {
        // Deletes the account for good (2026-11-19 review; App Store guideline 5.1.1(v), privacy laws). In order:
        // Stripe customer (Stripe also cancels its subscriptions at once), the ElevenLabs key in Vault, every stored file
        // (the creator's folder and their clean copies in the vault folder), then the auth user, which cascades to all
        // studio rows (series > scenes > shots > clips, credits, payments, jobs). Kept: studio.welcome_claims holds only a
        // hash of the email, so a deleted account cannot claim the free credits again (said in the privacy policy).
        // Every step can run again, so a second try after a failure finishes the job.
        const email = String(who.user.email || "").toLowerCase();
        if (!email || String(body.confirm || "").trim().toLowerCase() !== email)
          return json({ error: "Type your email address exactly to confirm." }, 400);
        const [a] = await sql`select stripe_customer_id from studio.accounts where owner = ${uid}`;
        if (a?.stripe_customer_id && STRIPE_KEY) {
          const r = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(a.stripe_customer_id)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
          if (!r.ok && r.status !== 404) return json({ error: "Your plan could not be cancelled with Stripe, so nothing was deleted. Try again or contact support." }, 502);
        }
        const conns = await sql`delete from studio.connections where owner = ${uid} returning secret_id`;
        for (const c of conns) await sql`delete from vault.secrets where id = ${c.secret_id}`;
        await sql`delete from studio.connection_attempts where owner = ${uid}`;
        const files = await sql`select name from storage.objects where bucket_id = 'studio'
                                  and (name like ${uid + "/%"} or name like ${"00000000-0000-0000-0000-000000000000/clean/" + uid + "/%"})`;
        const names = files.map((f) => f.name as string);
        for (let i = 0; i < names.length; i += 100) {
          const { error } = await admin.storage.from("studio").remove(names.slice(i, i + 100));
          if (error) return json({ error: "Deleting stopped partway (some files). Try again to finish; it carries on where it stopped." }, 502);
        }
        const { error: delErr } = await admin.auth.admin.deleteUser(uid);
        if (delErr) return json({ error: "Your files are deleted but the account itself could not be yet. Try again to finish, or contact support." }, 502);
        console.log(`account deleted: ${uid} (${names.length} files)`);
        return json({ ok: true, files: names.length });
      }
      default:
        return json({ error: "unknown op" }, 400);
    }
  } catch (e) {
    console.error("billing:", (e as Error).message);
    return json({ error: (e as Error).message.slice(0, 300) }, 400);
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

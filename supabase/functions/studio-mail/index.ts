// studio-mail: "your clip is ready" emails (2026-11-23, Londi: emails from anlim.ai). @anlim
// The worker calls {op: "flush"} once a minute with its token (header x-worker-token, same token as studio-storage).
// studio.mail_due picks what may go out (one email per account, at most one every 10 minutes, not while the creator is
// in the app, not when they turned the emails off); each email goes through Resend (POST https://api.resend.com/emails,
// resend.com/docs/api-reference/emails/send-email) from mail.anlim.ai. Without the RESEND_API_KEY secret nothing is
// sent and nothing is marked, so the emails start once Londi sets the key.
import postgres from "npm:postgres@3.4.5";

const TOKEN_SHA256 = "0b79efae32809a607d361d737503d76793581226a1dd6c0ba98b9b5fddd4d25e";   // as studio-storage
const FROM = "anlim.ai <studio@mail.anlim.ai>";
const APP = "https://anlim.ai";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

type Item = { id: number; kind: "clip" | "clip_failed" | "cut" | "cut_failed"; title: string; link: string; detail: string | null };
const LINE: Record<Item["kind"], string> = {
  clip: "Your clip is ready to review",
  clip_failed: "A clip could not be made (nothing was charged)",
  cut: "Your cut is ready",
  cut_failed: "A cut could not be made",
};

function compose(items: Item[]) {
  const ok = items.filter((i) => i.kind === "clip" || i.kind === "cut").length, bad = items.length - ok;
  const subject = items.length === 1 ? `${LINE[items[0].kind].replace(/ \(.*\)$/, "")}: ${items[0].title.slice(0, 60)}`
    : `${ok ? `${ok} ready` : ""}${ok && bad ? ", " : ""}${bad ? `${bad} could not be made` : ""} on anlim.ai`;
  const text = items.map((i) => `${LINE[i.kind]}: ${i.title}${i.detail ? `\n  ${i.detail}` : ""}\n  ${APP}${i.link}`).join("\n\n") +
    `\n\nYou get this email when something you started on anlim.ai finishes while you are away. Turn these emails off in Account: ${APP}/account`;
  const rows = items.map((i) => `<tr><td style="padding:12px 0;border-bottom:1px solid #2a2a30">
      <div style="color:${i.kind.endsWith("failed") ? "#ff8a8a" : "#9be29b"};font-size:13px">${esc(LINE[i.kind])}</div>
      <div style="color:#f4f1ea;font-size:15px;margin:4px 0">${esc(i.title)}</div>
      ${i.detail ? `<div style="color:#a5a3ab;font-size:13px">${esc(i.detail)}</div>` : ""}
      <a href="${APP}${esc(i.link)}" style="color:#ffb98a;font-size:14px">Open in anlim</a></td></tr>`).join("");
  const html = `<div style="background:#0a0a0b;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto">
      <div style="color:#ff7a1a;font-size:13px;letter-spacing:1px">ANLIM.AI</div>
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      <p style="color:#77757d;font-size:12px;margin-top:18px">You get this email when something you started on anlim.ai finishes while you are away.
        <a href="${APP}/account" style="color:#77757d">Turn these emails off</a>.</p>
    </div></div>`;
  return { subject, text, html };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const tok = req.headers.get("x-worker-token") || "";
  if (!tok || (await sha256(tok)) !== TOKEN_SHA256) return json({ error: "unauthorized" }, 401);
  let body: { op?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (body.op !== "flush") return json({ error: "op must be flush" }, 400);
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ skipped: "RESEND_API_KEY is not set" });
  let sent = 0, failed = 0;
  try {
    const due = await sql`select owner, email, items from studio.mail_due(50)`;
    for (const d of due) {
      const items = d.items as Item[], ids = items.map((i) => i.id);
      const { subject, text, html } = compose(items);
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `ready-${ids.join("-")}`.slice(0, 256) },
        body: JSON.stringify({ from: FROM, to: [String(d.email)], subject, text, html }),
      });
      if (r.ok) { sent++; await sql`select studio.mail_done(${ids}::bigint[], 'sent')`; }
      else {
        failed++;
        const msg = (await r.text()).slice(0, 200);
        console.error(`resend ${r.status}: ${msg}`);
        // a refused address will not start working: close those rows; a server error is tried again next minute
        if (r.status >= 400 && r.status < 500 && r.status !== 429) await sql`select studio.mail_done(${ids}::bigint[], ${`failed: ${r.status} ${msg}`})`;
      }
    }
    return json({ accounts: due.length, sent, failed });
  } catch (e) {
    console.error("flush:", (e as Error).message);
    return json({ error: "flush failed" }, 500);
  }
});

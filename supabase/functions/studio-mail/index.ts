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
type Lang = "en" | "es" | "fr";
// 2026-11-24 (languages): each email in the creator's language (studio.accounts.language)
const WORDS: Record<Lang, { line: Record<Item["kind"], string>; ready: (n: number) => string; bad: (n: number) => string; on: string;
  open: string; why: string; off: string; offText: string }> = {
  en: { line: { clip: "Your clip is ready to review", clip_failed: "A clip could not be made (nothing was charged)",
                cut: "Your cut is ready", cut_failed: "A cut could not be made" },
        ready: (n) => `${n} ready`, bad: (n) => `${n} could not be made`, on: "on anlim.ai", open: "Open in anlim",
        why: "You get this email when something you started on anlim.ai finishes while you are away.",
        off: "Turn these emails off", offText: "Turn these emails off in Account:" },
  es: { line: { clip: "Tu clip está listo para revisar", clip_failed: "No se pudo crear un clip (no se cobró nada)",
                cut: "Tu montaje está listo", cut_failed: "No se pudo crear un montaje" },
        ready: (n) => `${n} ${n === 1 ? "listo" : "listos"}`, bad: (n) => `${n} no se ${n === 1 ? "pudo" : "pudieron"} crear`, on: "en anlim.ai",
        open: "Abrir en anlim", why: "Recibes este correo cuando algo que empezaste en anlim.ai termina mientras no estás.",
        off: "Desactivar estos correos", offText: "Desactiva estos correos en Cuenta:" },
  fr: { line: { clip: "Votre clip est prêt à être vérifié", clip_failed: "Un clip n'a pas pu être créé (rien n'a été facturé)",
                cut: "Votre montage est prêt", cut_failed: "Un montage n'a pas pu être créé" },
        ready: (n) => `${n} ${n < 2 ? "prêt" : "prêts"}`, bad: (n) => `${n} n'${n < 2 ? "a" : "ont"} pas pu être ${n < 2 ? "créé" : "créés"}`,
        on: "sur anlim.ai", open: "Ouvrir dans anlim",
        why: "Vous recevez cet e-mail quand quelque chose que vous avez lancé sur anlim.ai se termine pendant votre absence.",
        off: "Désactiver ces e-mails", offText: "Désactivez ces e-mails dans Compte :" },
};

function compose(items: Item[], lang: Lang) {
  const W = WORDS[lang] || WORDS.en, LINE = W.line;
  const ok = items.filter((i) => i.kind === "clip" || i.kind === "cut").length, bad = items.length - ok;
  const subject = items.length === 1 ? `${LINE[items[0].kind].replace(/ \(.*\)$/, "")}: ${items[0].title.slice(0, 60)}`
    : `${ok ? W.ready(ok) : ""}${ok && bad ? ", " : ""}${bad ? W.bad(bad) : ""} ${W.on}`;
  const text = items.map((i) => `${LINE[i.kind]}: ${i.title}${i.detail ? `\n  ${i.detail}` : ""}\n  ${APP}${i.link}`).join("\n\n") +
    `\n\n${W.why} ${W.offText} ${APP}/account`;
  const rows = items.map((i) => `<tr><td style="padding:12px 0;border-bottom:1px solid #2a2a30">
      <div style="color:${i.kind.endsWith("failed") ? "#ff8a8a" : "#9be29b"};font-size:13px">${esc(LINE[i.kind])}</div>
      <div style="color:#f4f1ea;font-size:15px;margin:4px 0">${esc(i.title)}</div>
      ${i.detail ? `<div style="color:#a5a3ab;font-size:13px">${esc(i.detail)}</div>` : ""}
      <a href="${APP}${esc(i.link)}" style="color:#ffb98a;font-size:14px">${W.open}</a></td></tr>`).join("");
  const html = `<div lang="${lang}" style="background:#0a0a0b;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto">
      <div style="color:#ff7a1a;font-size:13px;letter-spacing:1px">ANLIM.AI</div>
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      <p style="color:#77757d;font-size:12px;margin-top:18px">${esc(W.why)}
        <a href="${APP}/account" style="color:#77757d">${esc(W.off)}</a>.</p>
    </div></div>`;
  return { subject, text, html };
}

// An item's detail (why a clip failed...) is the worker's English; the translation table has it when the app was shown it
const NUM = /(?<![\w.⟨{])\d+(?:\.\d+)?(?![\w⟩}])/g;
async function localDetails(items: Item[], lang: Lang) {
  if (lang === "en") return items;
  return await Promise.all(items.map(async (i) => {
    if (!i.detail) return i;
    const nums: string[] = [];
    const src = i.detail.replace(NUM, (m) => `⟨${nums.push(m) - 1}⟩`);
    const [r] = await sql`select out from studio.translations where lang = ${lang} and src = ${src} and out is not null`;
    if (!r) { await sql`insert into studio.translations(src, lang) values (${src}, ${lang}) on conflict do nothing`; return i; }
    return { ...i, detail: String(r.out).replace(/⟨(\d+)⟩/g, (m: string, k: string) => nums[Number(k)] ?? m) };
  }));
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
    const due = await sql`select m.owner, m.email, m.items, a.language from studio.mail_due(50) m left join studio.accounts a on a.owner = m.owner`;
    for (const d of due) {
      const lang = (["es", "fr"].includes(d.language) ? d.language : "en") as Lang;
      const items = await localDetails(d.items as Item[], lang), ids = items.map((i) => i.id);
      const { subject, text, html } = compose(items, lang);
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

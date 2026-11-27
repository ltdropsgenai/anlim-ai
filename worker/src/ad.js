// Ad scripts (2026-11-27, Londi: "build #1 first" of the UGC ad feature). The creator's product description is checked
// first (moderate.guard, Job: ad: no fake reviews, no real person's endorsement, no banned products), then the checker's
// /ad_script (frame_check/ad_script.py, Claude) writes three scripts as shots; the product page, if given, is fetched
// there with private and internal addresses refused. Free to the creator; studio.request_ad_script allows 30 a day.
// The creator picks one in the app or the connector and studio.apply_ad_draft makes it a project. @anlim
import { config } from "./config.js";
import * as db from "./db.js";
import * as moderate from "./moderate.js";

async function write(d) {
  try {
    await moderate.guard({ kind: "ad", ref: d.id, owner: d.owner, look: d.look,
      text: [`Product to advertise: ${d.product}`, `Description: ${d.brief}`, d.offer && `Offer: ${d.offer}`, d.cta && `Call to action: ${d.cta}`,
             d.presenter && `Presenter: ${d.presenter}`, d.tone && `Tone: ${d.tone}`, d.url && `Product page: ${d.url}`].filter(Boolean).join("\n") });
    const r = await fetch(`${config.checkerUrl}/ad_script`, {
      method: "POST", headers: { Authorization: `Bearer ${config.checkerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ product: d.product, brief: d.brief, url: d.url, offer: d.offer, cta: d.cta, presenter: d.presenter,
                             tone: d.tone, language: d.language, length_s: d.length_s, look: d.look }),
      signal: AbortSignal.timeout(180_000),
    });
    const res = await r.json().catch(() => ({ verdict: "ERROR", error: `checker HTTP ${r.status}` }));
    if (!r.ok || res.verdict === "ERROR" || !Array.isArray(res.variants) || !res.variants.length) throw new Error(`ad script: ${res.error || r.status}`);
    await db.q(`update studio.ad_drafts set status = 'done', variants = $2, page_title = $3, error = $4, locked_until = null, updated_at = now()
                 where id = $1`, [d.id, JSON.stringify(res.variants), res.page_title ? String(res.page_title).slice(0, 200) : null,
                                  res.page_note ? `The product page was not used: ${String(res.page_note).slice(0, 200)}.` : null]);
  } catch (e) {
    const tries = (d.tries || 0) + 1, give = e.blocked || tries >= 3;
    await db.q(`update studio.ad_drafts set tries = $2, status = $3, error = $4, locked_until = case when $3 = 'queued' then now() + interval '20 seconds' end,
                       updated_at = now() where id = $1`,
               [d.id, tries, give ? "failed" : "queued",
                (e.blocked ? e.message.replace(" Nothing was charged.", "") : give ? "The ad scripts could not be written; try again." : e.message).slice(0, 500)]);
    console.error(`ad ${String(d.id).slice(0, 8)}: ${e.message}`);
  }
}

export async function tick() {
  const drafts = await db.q("select * from studio.claim_ad_drafts(2, 240)").catch((e) => {
    if (!/does not exist/.test(e.message)) console.error("ad claim:", e.message);   // before the migration: none, quietly
    return [];
  });
  await Promise.all(drafts.map(write));
  return drafts.length;
}

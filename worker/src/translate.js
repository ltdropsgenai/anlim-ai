// Languages (2026-11-24, Londi: English, Spanish and French, "everything, UI and what anlim makes"). @anlim
//
// Two directions, both kept in studio.translations so each text is translated once (checker /translate, Claude):
//  - tick(): messages anlim writes in English while it runs (errors, check findings, cut notes, notices). studio-api adds
//    the ones a Spanish or French creator is shown, without a translation; this fills them in batches.
//  - toEnglish(): a Spanish or French creator's shot text, cast descriptions and style, put into English before the
//    prompt compiler and the image and video models get them. The compiler's own rules (walking, extras, camera words)
//    read English, and the models follow English best. A failed translation leaves the creator's words as they are.
import { config } from "./config.js";
import * as db from "./db.js";

const MAX = 2000;                         // longer texts are left as they are (the table's key)
const langs = new Map();                  // owner -> { lang, at }

async function checker(texts, lang) {
  const r = await fetch(`${config.checkerUrl}/translate`, {
    method: "POST", headers: { Authorization: `Bearer ${config.checkerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ texts, lang }),
  });
  const res = await r.json().catch(() => ({ verdict: "ERROR", error: `checker HTTP ${r.status}` }));
  if (!r.ok || res.verdict === "ERROR" || !Array.isArray(res.out) || res.out.length !== texts.length)
    throw new Error(`translate: ${res.error || r.status}`);
  return res.out;
}

export async function ownerLang(owner) {
  const hit = langs.get(owner);
  if (hit && Date.now() - hit.at < 60_000) return hit.lang;
  const [row] = await db.q("select language from studio.accounts where owner = $1", [owner]).catch(() => []);
  const lang = row?.language || "en";
  langs.set(owner, { lang, at: Date.now() });
  return lang;
}

// texts: strings or null; returns the same array with the creator's words in English (or as they were).
export async function toEnglish(owner, texts) {
  if (!owner || (await ownerLang(owner)) === "en") return texts;
  const todo = [...new Set(texts.filter((t) => typeof t === "string" && t.trim() && t.length <= MAX))];
  if (!todo.length) return texts;
  try {
    const have = new Map((await db.q("select src, out from studio.translations where lang = 'en' and src = any($1) and out is not null",
      [todo])).map((r) => [r.src, r.out]));
    const miss = todo.filter((t) => !have.has(t));
    if (miss.length) {
      const out = await checker(miss, "en");
      for (const [i, src] of miss.entries()) {
        have.set(src, out[i]);
        await db.q(`insert into studio.translations(src, lang, out, done_at) values ($1, 'en', $2, now())
                    on conflict (lang, src) do update set out = excluded.out, done_at = now()`, [src, out[i]]);
      }
    }
    return texts.map((t) => (typeof t === "string" && have.has(t) ? have.get(t) : t));
  } catch (e) {
    console.error("translate to English:", e.message);
    return texts;
  }
}

// The text fields of a shot, its cast and its project that reach a prompt, in English (shotContext, frameContext).
const SHOT_FIELDS = ["action", "camera", "end_instruction", "blocking", "location_description", "style_prompt"];
const CHAR_FIELDS = ["what", "wardrobe", "build", "palette"];
export async function englishContext(owner, shot, chars, extra = {}) {
  const slots = [];
  const put = (obj, k) => { if (obj && typeof obj[k] === "string" && obj[k].trim()) slots.push([obj, k]); };
  if (shot) SHOT_FIELDS.forEach((k) => put(shot, k));
  for (const c of chars || []) CHAR_FIELDS.forEach((k) => put(c, k));
  Object.keys(extra).forEach((k) => put(extra, k));
  if (!slots.length) return;
  const out = await toEnglish(owner, slots.map(([o, k]) => o[k]));
  slots.forEach(([o, k], i) => { o[k] = out[i]; });
}

// Fill the Spanish and French rows studio-api added. At most one batch every few seconds.
let last = 0;
export async function tick() {
  if (Date.now() - last < 4000) return 0;
  last = Date.now();
  const rows = await db.q(
    `select lang, src from studio.translations where out is null and lang in ('es', 'fr') and tries < 3
      order by created_at limit 40`);
  let n = 0;
  for (const lang of ["es", "fr"]) {
    const batch = rows.filter((r) => r.lang === lang).map((r) => r.src);
    if (!batch.length) continue;
    try {
      const out = await checker(batch, lang);
      for (const [i, src] of batch.entries())
        await db.q("update studio.translations set out = $3, done_at = now() where lang = $1 and src = $2", [lang, src, out[i]]);
      n += batch.length;
    } catch (e) {
      console.error(`translate ${lang}:`, e.message);
      await db.q("update studio.translations set tries = tries + 1 where lang = $1 and src = any($2)", [lang, batch]);
    }
  }
  return n;
}

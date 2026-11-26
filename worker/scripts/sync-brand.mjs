// Copies the app's brand colours into the worker (2026-11-25, Londi: the end card in "the app's brand colors ... take
// the colors from the app's existing theme"). The worker's image is built from worker/ alone, so it cannot import
// app/src/lib/theme.ts; this reads the theme's tokens and writes worker/assets/brand.json. Run it after changing the
// theme:  node worker/scripts/sync-brand.mjs   (it fails if a token is missing). @anlim
import fs from "node:fs";
import path from "node:path";
const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const theme = fs.readFileSync(path.join(root, "app", "src", "lib", "theme.ts"), "utf8");
const block = theme.match(/export const c = \{([\s\S]*?)\};/)?.[1];
if (!block) throw new Error("theme.ts: no `export const c = { ... }`");
const tok = (k) => {
  const m = block.match(new RegExp(`\\b${k}:\\s*"(#[0-9A-Fa-f]{6})"`));
  if (!m) throw new Error(`theme.ts: no colour ${k}`);
  return m[1].toUpperCase();
};
// the theme's tokens are refreshed; the end card's own colours (card_*, as Londi gave them in his 2026-11-25 mockup) are kept
const file = path.join(root, "worker", "assets", "brand.json");
const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const brand = { ...old,
  _source: "app/src/lib/theme.ts (export const c), written by worker/scripts/sync-brand.mjs",
  ink: tok("ink"),          // the app's text colour
  accent: tok("accent"),    // the app's accent
};
fs.writeFileSync(file, JSON.stringify(brand, null, 2) + "\n");
console.log(brand);

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
const brand = {
  _source: "app/src/lib/theme.ts (export const c), written by worker/scripts/sync-brand.mjs",
  ink: tok("ink"),          // text
  accent: tok("accent"),    // the dot in anlim.ai
  // the end card's pill: Londi gave #16161A at about 80% (2026-11-25); it is not a theme token (between card #111114
  // and card2 #18181C), so it is kept here as given
  pill: "#16161A", pill_alpha: 0.8,
};
fs.writeFileSync(path.join(root, "worker", "assets", "brand.json"), JSON.stringify(brand, null, 2) + "\n");
console.log(brand);

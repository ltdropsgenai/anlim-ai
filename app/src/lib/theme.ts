import { tr } from "./i18n";
import { Platform } from "react-native";
// anlim.ai Pro studio theme (2026-11-19, Londi: direction D's look with B's plain wording). @anlim
// Near-black studio surfaces, one tungsten-orange accent (no competitor uses it: Higgsfield is lime, OpenArt magenta),
// status colours tuned for a dark background. Text contrast: ink 18:1, sub 8:1, muted 5.6:1 on the card colour.
export const c = {
  bg: "#08080A", rail: "#0E0E11", card: "#111114", card2: "#18181C", field: "#141418", line: "#26262C",
  ink: "#F4F4F5", sub: "#A1A1AA", muted: "#8E8E96",
  accent: "#FF7A1A", onAccent: "#0A0A0B", link: "#FFB98A",
  pass: "#5EE6A8", passBg: "#0F2A1E", passLine: "#1F5C42",
  flag: "#FDE68A", flagBg: "#2E2608", flagLine: "#6B5512",
  fail: "#FCA5A5", failBg: "#2A1214", failLine: "#6B2A2E",
};
// Page backgrounds (2026-11-20): transparent on the web so the sun light (components/SunLight) shows through; native
// pages keep the solid background.
export const pageBg = Platform.OS === "web" ? "transparent" : c.bg;
// Fonts: Space Grotesk for display, Inter for text, JetBrains Mono for slates, timecodes and credits. Loaded on the
// web from Google Fonts (_layout); native falls back to the system font. Plain objects (not StyleSheet) on purpose:
// on the web they become inline styles, which win over the base text font rule.
export const font = {
  display: { fontFamily: "'Space Grotesk', Inter, system-ui, sans-serif", fontWeight: "700" as const, letterSpacing: -0.3 },
  mono: { fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
};
export const verdictColor = (v: string | null) =>
  v === "PASS" ? c.pass : v === "FAIL" ? c.fail : v === "FLAG" || v === "NOT_REVIEWED" ? c.flag : c.muted;
// plain words (direction B): what the check means for the creator, not the checker's term
export const verdictLabel = (v: string | null) =>
  tr(v === "NOT_REVIEWED" ? "Take a look" : v === "FLAG" ? "Your call" : v === "PASS" ? "Checked ✓" : v === "FAIL" ? "Problem found" : "Not checked");

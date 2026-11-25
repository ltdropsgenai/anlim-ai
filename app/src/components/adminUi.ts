// Shared bits of the admin console's pages (2026-11-25). @anlim
import { StyleSheet } from "react-native";
import { c } from "../lib/theme";

export const when = (t: string | null | undefined) => (t ? new Date(t).toLocaleString() : "—");
export const ago = (t: string | null | undefined) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export function detailText(d: Record<string, unknown>) {
  const parts: string[] = [];
  if (d.credits != null) parts.push(`${d.credits} credits`);
  if (d.hours != null) parts.push(`for ${d.hours} h`); else if ("hours" in d) parts.push("until lifted");
  if (d.reason) parts.push(`reason: ${d.reason}`);
  if (d.note) parts.push(`note: ${d.note}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export const s = StyleSheet.create({
  page: { padding: 16, maxWidth: 1100, width: "100%", alignSelf: "center", gap: 14 },
  h1: { color: c.ink, fontSize: 28 },
  h2: { color: c.ink, fontSize: 17, fontWeight: "700", marginBottom: 2 },
  sub: { color: c.sub, fontSize: 14, lineHeight: 20 },
  small: { color: c.muted, fontSize: 12 },
  cell: { color: c.ink, fontSize: 14, lineHeight: 21 },
  email: { color: c.ink, fontSize: 15, fontWeight: "600" },
  link: { color: c.link, fontSize: 14, textDecorationLine: "underline" },
  ok: { color: c.pass, fontSize: 14 },
  err: { color: c.fail, fontSize: 14 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  chip: { backgroundColor: c.card2, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  chipOn: { backgroundColor: c.accent },
  card: { backgroundColor: c.card, borderRadius: 14, padding: 16, gap: 8 },
  userRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 14 },
  input: { color: c.ink, backgroundColor: c.field, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: { backgroundColor: c.card, borderRadius: 12, padding: 14, minWidth: 160, flexGrow: 1, gap: 4 },
  tileN: { color: c.ink, fontSize: 24, fontWeight: "700" },
  badge: { color: c.sub, backgroundColor: c.card2, fontSize: 10, letterSpacing: 0.8, fontWeight: "700", paddingHorizontal: 7, paddingVertical: 3, borderRadius: 4, overflow: "hidden" },
  badgeOn: { color: c.onAccent, backgroundColor: c.accent },
  badgeBad: { color: c.fail, backgroundColor: c.failBg },
  line: { borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8, marginTop: 2, gap: 3 },
});

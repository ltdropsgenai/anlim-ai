// Insights (admins only, 2026-11-23, Londi chose monitoring "Built into Supabase"): how far new accounts get (sign-up,
// first picture, first clip, kept clip, cut, paid), how often each kind of job fails, what the content check blocked,
// the most common errors (app, api, connector, worker) and the most opened pages. studio.admin_insights. @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, Insights } from "../lib/api";
import { c, font, pageBg } from "../lib/theme";
import { tr, locale, trp, tMsg } from "../lib/i18n";

const RANGES = [7, 30, 90];

export default function InsightsPage() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { setD(null); setError(null); api.adminInsights(days).then(setD).catch((e) => setError((e as Error).message)); }, [days]);
  useEffect(load, [load]);
  const top = d?.funnel[0]?.n || 0;

  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={{ padding: 16, maxWidth: 1100, width: "100%", alignSelf: "center", gap: 14 }}>
      <Text style={[s.h1, font.display]}>{tr("Insights")}</Text>
      <View style={s.row}>
        {RANGES.map((n) => (
          <Pressable key={n} onPress={() => setDays(n)} style={[s.chip, days === n && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: days === n }}>
            <Text style={{ color: days === n ? c.onAccent : c.ink, fontWeight: "600" }}>{tr("Last {n} days", { n })}</Text>
          </Pressable>
        ))}
        <Pressable onPress={load} accessibilityRole="button"><Text style={s.link}>{tr("Refresh")}</Text></Pressable>
      </View>
      {error && <Text style={{ color: c.fail }}>{tMsg(error)}</Text>}
      {!d && !error && <ActivityIndicator style={{ marginTop: 30 }} />}
      {d && (<>
        <View style={s.card}>
          <Text style={s.h2}>{tr("New accounts: how far they got")}</Text>
          <Text style={s.sub}>{tr("Accounts made in the window. Each step counts accounts that ever did it; a clip made from words alone needs no picture, so \"First clip\" can be higher than \"First picture\".")}</Text>
          {d.funnel.map((f) => (
            <View key={f.step} style={s.bar}>
              <Text style={[s.cell, { width: 130 }]}>{f.step}</Text>
              <View style={s.track}><View style={[s.fill, { width: `${top ? Math.round((f.n / top) * 100) : 0}%` }]} /></View>
              <Text style={[s.cell, font.mono, { width: 150, textAlign: "right" }]}>
                {f.n}{top ? ` · ${Math.round((f.n / top) * 100)}%` : ""}{f.median_h != null ? ` · ${f.median_h} h` : ""}
              </Text>
            </View>
          ))}
          <Text style={s.small}>{tr("h = median hours from sign-up to the step.")}</Text>
        </View>
        <View style={s.card}>
          <Text style={s.h2}>{tr("Jobs")}</Text>
          {d.jobs.map((j) => (
            <Text key={j.kind} style={s.cell}>{tr("{kind}: {total} made, {failed} failed{v3}", { kind: j.kind, total: j.total, failed: j.failed, v3: j.total ? ` (${Math.round((j.failed / j.total) * 100)}%)` : "" })}</Text>
          ))}
          <Text style={s.cell}>{tr("Blocked by the content check: {blocked}", { blocked: d.blocked })}</Text>
        </View>
        <View style={s.card}>
          <Text style={s.h2}>{tr("Most common errors")}</Text>
          {d.errors.length === 0 && <Text style={s.sub}>{tr("None.")}</Text>}
          {d.errors.map((e, i) => (
            <View key={i} style={s.err}>
              <Text style={[s.small, font.mono]}>{trp(e.accounts, "{source} · {place} · {times}× · {n} account · last {last}", "{source} · {place} · {times}× · {n} accounts · last {last}", { source: e.source, place: e.place || "?", times: e.n, last: new Date(e.last).toLocaleString(locale()) })}</Text>
              <Text style={s.cell} selectable>{e.message}</Text>
            </View>
          ))}
        </View>
        <View style={s.card}>
          <Text style={s.h2}>{tr("Pages opened")}</Text>
          {d.views.length === 0 && <Text style={s.sub}>{tr("None yet.")}</Text>}
          {d.views.map((v) => <Text key={v.route} style={[s.cell, font.mono]}>{trp(v.accounts, "{route} {times}× · {n} account", "{route} {times}× · {n} accounts", { route: v.route, times: v.n })}</Text>)}
        </View>
      </>)}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  h1: { color: c.ink, fontSize: 28 },
  h2: { color: c.ink, fontSize: 17, fontWeight: "700", marginBottom: 4 },
  sub: { color: c.sub, fontSize: 14, lineHeight: 20 },
  small: { color: c.muted, fontSize: 12 },
  cell: { color: c.ink, fontSize: 14, lineHeight: 21 },
  link: { color: c.link, fontSize: 14, textDecorationLine: "underline" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 16, gap: 6 },
  bar: { flexDirection: "row", alignItems: "center", gap: 10 },
  track: { flex: 1, height: 10, borderRadius: 5, backgroundColor: c.card2, overflow: "hidden" },
  fill: { height: 10, backgroundColor: c.accent },
  err: { borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8, marginTop: 4 },
});

// Refund requests to review (admins only, 2026-11-20, Londi: "we collect these for review. The refund is permanent if
// we can validate their verdict on the asset, if we can't the refund is reversed with a notification to the user").
// Each request: the clip (jump to the moment the creator named), their reason, what the anlim check found, and the
// account's history. Confirm keeps the refund; Reverse takes the credits back and tells the creator the note. @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AdminRefund, api, MODEL_NAMES } from "../lib/api";
import { c, font, pageBg } from "../lib/theme";
import { MediaView } from "../components/MediaView";
import { tr, locale, trp, tMsg } from "../lib/i18n";
import { usePageTitle } from "../lib/pageTitle";

type Tab = "pending" | "upheld" | "reversed";

export default function Refunds() {
  usePageTitle(tr("Refunds"));
  const [tab, setTab] = useState<Tab>("pending");
  const [items, setItems] = useState<AdminRefund[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setItems(null); setError(null);
    api.adminRefunds(tab).then(setItems).catch((e) => setError((e as Error).message));
  }, [tab]);
  useEffect(load, [load]);

  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={{ padding: 16, maxWidth: 1100, width: "100%", alignSelf: "center" }}>
      <Text style={[s.h1, font.display]}>{tr("Refund requests")}</Text>
      <Text style={s.sub}>{tr("Nothing has been refunded yet. Approve if you can see the problem (the credits go back to the creator); otherwise decline and say why (the creator reads your note).")}</Text>
      <View style={s.tabs}>
        {(["pending", "upheld", "reversed"] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
            <Text style={{ color: tab === t ? c.onAccent : c.ink, fontWeight: "600" }}>{t === "pending" ? tr("Waiting") : t === "upheld" ? tr("Approved") : tr("Declined")}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={{ color: c.fail }}>{tMsg(error)}</Text>}
      {!items && !error && <ActivityIndicator style={{ marginTop: 30 }} />}
      {items && items.length === 0 && <Text style={s.sub}>{tr("Nothing here.")}</Text>}
      {items?.map((r) => <Request key={r.id} r={r} onDone={load} />)}
    </ScrollView>
  );
}

function Request({ r, onDone }: { r: AdminRefund; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function decide(d: "uphold" | "reverse") {
    setBusy(true); setErr(null);
    try { await api.decideRefund(r.id, d, note); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <View style={s.card}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        <View style={{ flexGrow: 1, flexBasis: 420 }}>
          {r.clip_url ? <MediaView kind="clip" url={r.clip_url} poster={r.start_url} /> : <Text style={s.sub}>{tr("Clip file missing.")}</Text>}
        </View>
        <View style={{ flexGrow: 1, flexBasis: 300, gap: 6 }}>
          <Text style={[s.small, font.mono]}>{tr("{v0} · {credits} CR · {v2}", { v0: new Date(r.created_at).toLocaleString(locale()), credits: r.credits, v2: MODEL_NAMES[r.model_id] ?? r.model_id })}</Text>
          <Text style={s.label}>{tr("Prompt")}</Text><Text style={s.text}>{r.action}</Text>
          <Text style={s.label}>{tr("Creator says")}</Text>
          <Text style={s.text}>{r.reasons.join(", ")}{r.at_s != null ? tr(" · at {v0} s", { v0: Number(r.at_s).toFixed(1) }) : ""}</Text>
          <Text style={[s.text, { fontStyle: "italic" }]}>"{r.note}"</Text>
          <Text style={s.label}>{tr("anlim check")}</Text>
          <Text style={[s.text, { color: r.checker_verdict === "FAIL" ? c.fail : r.checker_verdict === "PASS" ? c.pass : c.flag }]}>
            {r.checker_verdict === "FAIL" ? tr("Found a problem") : r.checker_verdict === "PASS" ? tr("Passed") : r.checker_verdict ?? tr("Not checked")}</Text>
          {(r.qc_reasons ?? []).slice(0, 4).map((q, i) => <Text key={i} style={s.small}>• {String(q).slice(0, 220)}</Text>)}
          <Text style={s.label}>{tr("Account")}</Text>
          <Text style={s.text}>{trp(r.owner_requests, "{who} · {n} request, {declined} declined", "{who} · {n} requests, {declined} declined", { who: r.email ?? r.owner, declined: r.owner_reversed })}</Text>
          {r.status === "pending" ? (
            <>
              <TextInput style={s.input} value={note} onChangeText={setNote} multiline placeholder={tr("Note to the creator (required to decline)")} placeholderTextColor={c.muted} />
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <Pressable style={[s.btn, { backgroundColor: c.accent, borderColor: c.accent }]} disabled={busy} onPress={() => decide("uphold")} accessibilityRole="button">
                  <Text style={{ color: c.onAccent, fontWeight: "700" }}>{tr("Approve refund")}</Text></Pressable>
                <Pressable style={[s.btn, note.trim().length < 5 && { opacity: 0.45 }]} disabled={busy || note.trim().length < 5} onPress={() => decide("reverse")} accessibilityRole="button">
                  <Text style={{ color: c.ink, fontWeight: "600" }}>{tr("Decline refund")}</Text></Pressable>
              </View>
              {err && <Text style={{ color: c.fail }}>{tMsg(err)}</Text>}
            </>
          ) : <Text style={s.text}>{r.status === "upheld" ? tr("Approved") : tr("Declined")}{r.decision_note ? `: ${r.decision_note}` : ""}</Text>}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  h1: { color: c.ink, fontSize: 28, marginTop: 8 },
  sub: { color: c.sub, fontSize: 14, marginTop: 6, maxWidth: 760 },
  tabs: { flexDirection: "row", gap: 8, marginVertical: 16 },
  tab: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  tabOn: { backgroundColor: c.accent, borderColor: c.accent },
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 16, padding: 16, marginBottom: 14 },
  label: { color: c.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginTop: 6 },
  text: { color: c.ink, fontSize: 14 },
  small: { color: c.sub, fontSize: 12 },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 10, color: c.ink, padding: 10, minHeight: 60, marginTop: 8, backgroundColor: c.field },
  btn: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, marginTop: 8 },
});

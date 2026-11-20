// Review: clips waiting for the creator's call first, then everything else, newest first (direction D look,
// direction B plain wording, 2026-11-19). @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Link, useFocusEffect } from "expo-router";
import { api, MODEL_NAMES, QueueItem, WelcomeStatus } from "../lib/api";
import { c, font } from "../lib/theme";
import { Grid } from "../components/Grid";

// shown only when a new account got no welcome credits, so the creator knows why
const WELCOME_NOTE: Record<string, string> = {
  repeat: "Free starter credits are one per person, and this email already received them. You can buy credits under Credits & plan.",
  disposable: "Free starter credits aren't given to temporary email addresses. Sign up with your regular email, or buy credits under Credits & plan.",
  held: "Your free starter credits are on their way. We're handing them out in batches today; they'll appear here soon.",
  needs_phone: "Verify your phone number in Account to get your free starter credits.",
};

type Tone = "ok" | "call" | "busy" | "bad" | "idle";
// what the creator needs to know about a clip, in plain words
function status(i: QueueItem): { text: string; tone: Tone; line: string } {
  if (i.decision === "approve") return { text: "✓ Kept", tone: "ok", line: "You kept this clip." };
  if (i.decision === "reject") return { text: "Rejected", tone: "idle", line: "You rejected it. To get credits back, request a refund on the clip page." };
  if (["queued", "running"].includes(i.status)) return { text: "Rendering", tone: "busy", line: "The video model is making it." };
  if (i.status === "checking") return { text: "Checking", tone: "busy", line: "anlim check is going through every frame." };
  if (i.status === "failed")
    return i.error === "refund requested" ? { text: "Refund requested", tone: "idle", line: "Credits back; we're looking at it." }
      : { text: "Didn't finish", tone: "bad", line: "The render didn't finish. Nothing was charged." };
  if (i.verdict === "FAIL") return { text: "! Problem found", tone: "bad", line: "The check found a problem. Look before you use it; request a refund if it's unusable." };
  if (i.verdict === "PASS") return { text: "✓ Checked", tone: "call", line: "Passed every check. Keep it?" };
  if (i.verdict === "NOT_REVIEWED") return { text: "! Take a look", tone: "call", line: "The check couldn't finish; watch it yourself." };
  return { text: "! Your call", tone: "call", line: i.flag_count ? `${i.flag_count} moment${i.flag_count === 1 ? "" : "s"} to look at.` : "Something to look at." };
}
const TONE: Record<Tone, { bg: string; fg: string; line: string }> = {
  ok: { bg: c.passBg, fg: c.pass, line: c.passLine }, call: { bg: c.flagBg, fg: c.flag, line: c.flagLine },
  bad: { bg: c.failBg, fg: c.fail, line: c.failLine }, busy: { bg: "rgba(8,8,10,0.8)", fg: c.ink, line: c.line },
  idle: { bg: "rgba(8,8,10,0.8)", fg: c.sub, line: c.line },
};

export default function Review() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [welcome, setWelcome] = useState<WelcomeStatus>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [q, m] = await Promise.all([api.queue(), api.me()]);
      setItems(q); setWelcome(m.welcome_status); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => {                                   // keep in-flight jobs moving on screen
    const busy = items?.some((i) => ["queued", "running", "checking"].includes(i.status));
    if (!busy) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [items, load]);

  const waiting = items?.filter((i) => !i.decision && (i.status === "review" || i.status === "succeeded")) ?? [];
  const working = items?.filter((i) => ["queued", "running", "checking"].includes(i.status)) ?? [];
  const rest = items?.filter((i) => !waiting.includes(i) && !working.includes(i)) ?? [];

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={s.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      {welcome && WELCOME_NOTE[welcome] && <Text style={s.note}>{WELCOME_NOTE[welcome]}</Text>}
      {error && <Text style={s.error}>{error}</Text>}
      {!items && !error && <ActivityIndicator style={{ marginTop: 40 }} color={c.accent} />}
      {items && (
        <>
          <Text style={[s.kicker, font.mono]}>NEEDS YOUR CALL · {waiting.length}</Text>
          <Text style={s.lead}>Every clip is checked by anlim. A clip that fails the check costs nothing; the others are charged when the check finishes.</Text>
          {waiting.length === 0 ? <Text style={s.empty}>Nothing waiting for you right now.</Text> : <Grid>{waiting.map((i) => <Card key={i.id} item={i} />)}</Grid>}
          {working.length > 0 && <>
            <Text style={[s.kicker, font.mono, { marginTop: 18 }]}>IN PROGRESS · {working.length}</Text>
            <Grid>{working.map((i) => <Card key={i.id} item={i} />)}</Grid>
          </>}
          <Text style={[s.kicker, font.mono, { marginTop: 18 }]}>ALL CLIPS · {rest.length}</Text>
          <Grid>{rest.map((i) => <Card key={i.id} item={i} />)}</Grid>
        </>
      )}
    </ScrollView>
  );
}

function Card({ item }: { item: QueueItem }) {
  const st = status(item), t = TONE[st.tone];
  const body = (
    <View style={s.card}>
      <View style={{ position: "relative", backgroundColor: c.card2 }}>
        {item.thumb_url ? <Image source={{ uri: item.thumb_url }} style={s.thumb} resizeMode="cover" />
          : <View style={s.thumb} />}
        <Text style={[s.slate, font.mono]}>SH {String(item.shot_ord).padStart(2, "0")}</Text>
        <Text style={[s.status, { backgroundColor: t.bg, color: t.fg, borderColor: t.line }]}>{st.text}</Text>
      </View>
      <View style={{ padding: 12 }}>
        <Text style={s.where} numberOfLines={1}>{item.series_name} · {item.scene_title}</Text>
        <Text style={s.action} numberOfLines={2}>{item.action}</Text>
        <Text style={s.line}>{st.line}</Text>
        <Text style={[s.meta, font.mono]}>{(MODEL_NAMES[item.model_id] ?? item.model_id ?? "").toUpperCase()} · {new Date(item.created_at).toLocaleDateString()}</Text>
      </View>
    </View>
  );
  const openable = ["review", "succeeded", "failed"].includes(item.status) && item.verdict;
  return openable
    ? <Link href={{ pathname: "/clip/[id]", params: { id: item.id } }} asChild><Pressable accessibilityRole="link" accessibilityLabel={`${item.action}. ${st.text}`}>{body}</Pressable></Link>
    : body;
}

const s = StyleSheet.create({
  page: { padding: 24, maxWidth: 1240, width: "100%", alignSelf: "center" },
  kicker: { color: c.sub, fontSize: 12, letterSpacing: 0.8, marginBottom: 6 },
  lead: { color: c.sub, fontSize: 14, marginBottom: 14 },
  empty: { color: c.sub, marginBottom: 8 },
  card: { backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: c.line, overflow: "hidden" },
  thumb: { width: "100%", aspectRatio: 16 / 9 },
  slate: { position: "absolute", top: 10, left: 10, color: c.ink, backgroundColor: "rgba(8,8,10,0.78)", fontSize: 11, fontWeight: "600", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4, overflow: "hidden" },
  status: { position: "absolute", top: 10, right: 10, fontSize: 11, fontWeight: "700", borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, overflow: "hidden" },
  where: { color: c.sub, fontSize: 12 },
  action: { color: "#E4E4E7", fontSize: 14, lineHeight: 20, marginTop: 4, minHeight: 40 },
  line: { color: c.ink, fontSize: 13, marginTop: 8 },
  meta: { color: c.muted, fontSize: 11, marginTop: 8 },
  note: { color: c.ink, backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 16 },
  error: { color: c.fail, marginBottom: 12 },
});

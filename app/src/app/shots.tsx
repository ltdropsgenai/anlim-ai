// Shots: series > scenes > shots. Create scenes and shots here; open a shot to add its start frame, end frame, render.
// @anlim
import { useCallback, useState } from "react";
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Link, router, useFocusEffect } from "expo-router";
import { api, MODEL_NAMES, Series, ShotRow } from "../lib/api";
import { c, font, pageBg } from "../lib/theme";
import { Grid } from "../components/Grid";
import { AddShot } from "../components/AddShot";
import { chip, pad2, TONE } from "../lib/shotStatus";

function ShotCard({ r }: { r: ShotRow }) {
  const st = chip(r), t = TONE[st.tone];
  return (
    <Link href={{ pathname: "/shot/[id]", params: { id: r.id } }} asChild>
      <Pressable style={s.card} accessibilityRole="link" accessibilityLabel={`Shot ${r.ord}: ${r.action}. ${st.text}`}>
        <View style={s.thumbBox}>
          {r.thumb_url
            ? <Image source={{ uri: r.thumb_url }} style={[s.thumb, !r.start_frame_approved && { opacity: 0.55 }]} resizeMode="cover" />
            : <View style={[s.thumb, { alignItems: "center", justifyContent: "center" }]}><Text style={{ color: c.muted, fontSize: 12 }}>No start frame yet</Text></View>}
          <Text style={[s.slate, font.mono]}>SH {pad2(r.ord)}</Text>
          <Text style={[s.status, { backgroundColor: t.bg, color: t.fg, borderColor: t.line }]}>{st.text}</Text>
        </View>
        <View style={{ padding: 12 }}>
          <Text style={s.action} numberOfLines={2}>{r.action}</Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 10 }}>
            <Text style={[s.meta, font.mono]}>{r.duration_s} S{r.gen_model ? ` · ${(MODEL_NAMES[r.gen_model] ?? r.gen_model).toUpperCase()}` : ""}</Text>
            {r.has_end_frame && <Text style={[s.meta, font.mono]}>END FRAME</Text>}
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

function AddScene({ seriesId, onDone }: { seriesId: string; onDone: (err?: string) => void }) {
  const [title, setTitle] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) return <Pressable onPress={() => setOpen(true)} accessibilityRole="button"><Text style={s.link}>+ New scene</Text></Pressable>;
  return (
    <View style={[s.row, { marginBottom: 12 }]}>
      <TextInput style={[s.input, { flex: 1, minHeight: 0 }]} value={title} onChangeText={setTitle} placeholderTextColor={c.muted} placeholder="Scene title, e.g. Kitchen breakfast" />
      <Pressable style={[s.btn, !title.trim() && { opacity: 0.5 }]} disabled={!title.trim()} accessibilityRole="button"
        onPress={async () => {
          try { await api.createScene(seriesId, title); setTitle(""); setOpen(false); onDone(); } catch (e) { onDone((e as Error).message); }
        }}>
        <Text style={s.btnText}>Create</Text>
      </Pressable>
      <Pressable onPress={() => setOpen(false)} accessibilityRole="button"><Text style={s.link}>Cancel</Text></Pressable>
    </View>
  );
}

export default function Shots() {
  const [series, setSeries] = useState<Series[] | null>(null);
  const [rows, setRows] = useState<ShotRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    try { const [se, sh] = await Promise.all([api.series(), api.shots()]); setSeries(se); setRows(sh); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const done = (err?: string) => { if (err) setError(err); load(); };

  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={s.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      {error && <Text style={s.error}>{error}</Text>}
      {!series && !error && <ActivityIndicator style={{ marginTop: 40 }} />}
      {series && series.length === 0 && (
        <Link href="/library" asChild><Pressable accessibilityRole="link"><Text style={s.link}>No series yet: create one</Text></Pressable></Link>
      )}
      {series?.map((se) => (
        <View key={se.id} style={{ marginBottom: 40 }}>
          <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-end", marginBottom: 14 }]}>
            <View style={{ flexShrink: 1 }}>
              <Text style={[s.kicker, font.mono]}>SERIES · {se.scenes.length} SCENE{se.scenes.length === 1 ? "" : "S"}</Text>
              <Text style={[s.series, font.display]}>{se.name}</Text>
            </View>
            <View style={s.row}>
              <Text style={[s.lookTag, font.mono]}>{se.look === "photoreal" ? "PHOTOREAL" : "CARTOON"}</Text>
              <Link href={{ pathname: "/library", params: { series: se.id } }} asChild>
                <Pressable accessibilityRole="link" style={s.ghostBtn}><Text style={{ color: c.ink, fontWeight: "600", fontSize: 13 }}>Cast & places</Text></Pressable>
              </Link>
            </View>
          </View>
          {se.scenes.map((sc) => {
            const shots = rows.filter((r) => r.scene_id === sc.id);
            return (
              <View key={sc.id} style={s.scene}>
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={[s.kicker, font.mono]}>
                      SCENE {pad2(sc.ord)} · {shots.length} SHOT{shots.length === 1 ? "" : "S"} · {shots.reduce((t, r) => t + r.duration_s, 0)} S
                    </Text>
                    <Text style={[s.h, font.display]}>{sc.title}</Text>
                  </View>
                  <Link href={{ pathname: "/cut/[scene]", params: { scene: sc.id } }} asChild>
                    <Pressable accessibilityRole="link" style={s.ghostBtn}><Text style={{ color: c.ink, fontWeight: "600", fontSize: 13 }}>Make the scene cut</Text></Pressable>
                  </Link>
                </View>
                <View style={[s.row, { marginBottom: 8 }]}>
                  <Text style={s.label}>Location:</Text>
                  {se.locations.length === 0 && (
                    <Link href={{ pathname: "/library", params: { series: se.id } }} asChild>
                      <Pressable accessibilityRole="link"><Text style={s.link}>add a location first</Text></Pressable>
                    </Link>
                  )}
                  {se.locations.map((l) => {
                    const on = sc.location_id === l.id;
                    return (
                      <Pressable key={l.id} style={[s.chip, on && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}
                        onPress={async () => { try { await api.setSceneLocation(sc.id, on ? null : l.id); load(); } catch (e) { setError((e as Error).message); } }}>
                        <Text style={on ? { color: c.onAccent } : { color: c.ink }}>{l.name}{l.has_plate ? "" : " (no plate yet)"}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {shots.length === 0 && <Text style={s.sub}>No shots yet.</Text>}
                <Grid>{shots.map((r) => <ShotCard key={r.id} r={r} />)}</Grid>
                <AddShot sceneId={sc.id} onDone={done} />
              </View>
            );
          })}
          <AddScene seriesId={se.id} onDone={done} />
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 24, maxWidth: 1240, width: "100%", alignSelf: "center" },
  kicker: { color: c.sub, fontSize: 12, letterSpacing: 0.8 },
  series: { fontSize: 32, color: c.ink, textTransform: "uppercase", marginTop: 2 },
  h: { fontSize: 22, color: c.ink, textTransform: "uppercase", marginTop: 2, marginBottom: 10 },
  scene: { marginBottom: 28, paddingTop: 18, borderTopWidth: 1, borderTopColor: c.line },
  lookTag: { color: c.onAccent, backgroundColor: c.ink, fontSize: 11, fontWeight: "600", letterSpacing: 0.8, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  ghostBtn: { borderWidth: 1, borderColor: c.line, backgroundColor: c.field, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginBottom: 14 },
  card: { backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: c.line, overflow: "hidden" },
  thumbBox: { position: "relative", backgroundColor: c.card2 },
  thumb: { width: "100%", aspectRatio: 16 / 9 },
  slate: { position: "absolute", top: 10, left: 10, color: c.ink, backgroundColor: "rgba(8,8,10,0.78)", fontSize: 11, fontWeight: "600", letterSpacing: 0.6, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4, overflow: "hidden" },
  status: { position: "absolute", top: 10, right: 10, fontSize: 11, fontWeight: "700", borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, overflow: "hidden" },
  action: { color: "#E4E4E7", fontSize: 14, lineHeight: 20, minHeight: 40 },
  title: { color: c.ink, fontWeight: "600" }, meta: { color: c.sub, fontSize: 11 },
  sub: { color: c.sub, marginBottom: 6 }, error: { color: c.fail, marginBottom: 12 },
  link: { color: c.link, fontSize: 14, marginVertical: 6 },
  newShot: { borderWidth: 1, borderStyle: "dashed", borderColor: "#34343C", backgroundColor: c.field, borderRadius: 18, padding: 18 },
  form: { backgroundColor: c.field, borderRadius: 18, borderWidth: 1, borderColor: "#2A2A31", padding: 18, gap: 10 },
  label: { color: c.sub, fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: c.field },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 12, minHeight: 60, color: c.ink, backgroundColor: c.bg, fontSize: 15 },
  btn: { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 18 }, btnText: { color: c.onAccent, fontWeight: "700" },
});

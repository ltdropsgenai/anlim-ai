// Scene cut: the scene's approved clips joined in shot order into one finished video, with music (the creator's track or a
// generated score), voiceover and sound effects (worker assemble.js, 2026-11-19). @anlim
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Link, useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, Cut, CutFormat } from "../../lib/api";
import { c, font, pageBg } from "../../lib/theme";
import { Music, SoundPanel } from "../../components/SoundPanel";
import { downloadFile } from "../../lib/download";
import { ClipPlayer } from "../../components/ClipPlayer";

const FORMATS: { id: CutFormat; title: string; sub: string }[] = [
  { id: "16x9", title: "Landscape 16:9", sub: "1920 × 1080 · YouTube, websites" },
  { id: "9x16", title: "Vertical 9:16", sub: "1080 × 1920 · Shorts, Reels, TikTok. Wide shots sit in the middle over a blurred fill." },
  { id: "4x5", title: "Feed 4:5", sub: "1080 × 1350 · Instagram and Facebook feed" },
];
const STATUS: Record<string, string> = { queued: "Waiting to start", running: "Cutting…", done: "Ready", failed: "Failed" };

export default function SceneCut() {
  const { scene } = useLocalSearchParams<{ scene: string }>();
  const [title, setTitle] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [cuts, setCuts] = useState<Cut[] | null>(null);
  const [format, setFormat] = useState<CutFormat>("16x9");
  const [fade, setFade] = useState(true);
  const [card, setCard] = useState(false);
  const [music, setMusic] = useState<Music>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [sfxOn, setSfxOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, me, series] = await Promise.all([api.cuts(scene), api.me(), api.series()]);
      setCuts(list); setOwner(me.user_id);
      for (const se of series) { const sc = se.scenes.find((x) => x.id === scene); if (sc) setTitle(`${se.name} · ${sc.title}`); }
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [scene]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const working = !!cuts?.some((x) => x.status === "queued" || x.status === "running");
  useEffect(() => {
    if (!working) return;
    timer.current = setInterval(load, 4000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [working, load]);

  async function make() {
    setBusy(true); setError(null);
    try { await api.makeCut(scene, format, { fade, end_card: card, music_path: music?.path ?? null, voice: voiceOn, sfx: sfxOn }); await load(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  if (!cuts) return error ? <Text style={[s.err, { padding: 16 }]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 40 }} />;
  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={s.page}>
      <Text style={s.title}>{title ?? "Scene"}: the cut</Text>
      <Text style={s.sub}>Joins every approved clip in this scene, in shot order, frame-exact. Shots without an approved clip are left out and listed. Making a cut is free.</Text>

      <View style={s.panel}>
        <Text style={[s.h, font.display]}>Format</Text>
        <View style={s.row}>
          {FORMATS.map((f) => (
            <Pressable key={f.id} onPress={() => setFormat(f.id)} style={[s.chip, format === f.id && s.chipOn]} accessibilityRole="radio"
              accessibilityState={{ checked: format === f.id }}>
              <Text style={format === f.id ? { color: c.onAccent } : { color: c.ink }}>{f.title}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={s.sub}>{FORMATS.find((f) => f.id === format)?.sub}</Text>

        <Text style={[s.h, font.display]}>Finish</Text>
        <View style={s.row}>
          <Pressable onPress={() => setFade(!fade)} style={[s.chip, fade && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: fade }}>
            <Text style={fade ? { color: c.onAccent } : { color: c.ink }}>Fade in and out</Text>
          </Pressable>
          <Pressable onPress={() => setCard(!card)} style={[s.chip, card && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: card }}>
            <Text style={card ? { color: c.onAccent } : { color: c.ink }}>anlim.ai end card (2.5 s)</Text>
          </Pressable>
        </View>

        {owner && <SoundPanel sceneId={scene} owner={owner} endCard={card} music={music} setMusic={setMusic}
          voiceOn={voiceOn} setVoiceOn={setVoiceOn} sfxOn={sfxOn} setSfxOn={setSfxOn} />}
        <Text style={s.sub}>
          The sound is set to −14 LUFS, the loudness YouTube, Instagram and TikTok play at, at one steady level (no pumping).
          Without music, voiceover or effects the cut is silent.
        </Text>

        <Pressable style={[s.btn, (busy || working) && { opacity: 0.5 }]} disabled={busy || working} onPress={make} accessibilityRole="button">
          <Text style={s.btnText}>{working ? "A cut is being made…" : "Make the cut"}</Text>
        </Pressable>
      </View>
      {error && <Text style={s.err}>{error}</Text>}

      <Text style={[s.h, font.display]}>Cuts</Text>
      {cuts.length === 0 && <Text style={s.sub}>No cuts yet.</Text>}
      {cuts.map((x) => (
        <View key={x.id} style={s.panel}>
          <Text style={{ color: c.ink, fontWeight: "600" }}>
            {FORMATS.find((f) => f.id === x.format)?.title} · {x.shots} shot{x.shots === 1 ? "" : "s"}
            {x.duration_s ? ` · ${Number(x.duration_s).toFixed(1)} s` : ""} · {STATUS[x.status] ?? x.status}
          </Text>
          <Text style={s.sub}>{new Date(x.created_at).toLocaleString()}{[x.options.music_path ? (x.options.music_path.includes("/audio/music/") ? "generated score" : "your track") : null,
            x.report?.voiceovers ? `${x.report.voiceovers} voiceover${x.report.voiceovers > 1 ? "s" : ""}` : null,
            x.report?.effects ? `${x.report.effects} sound effect${x.report.effects > 1 ? "s" : ""}` : null].filter(Boolean).map((t) => ` · ${t}`).join("") || " · silent"}</Text>
          {(x.status === "queued" || x.status === "running") && <ActivityIndicator style={{ alignSelf: "flex-start", marginVertical: 6 }} />}
          {x.status === "failed" && <Text style={s.err}>{x.error}</Text>}
          {x.url && <View style={{ maxWidth: x.format === "16x9" ? 900 : 380, marginVertical: 8 }}>
            <ClipPlayer src={x.url} duration={Number(x.duration_s) || 0} markers={[]} />
          </View>}
          {x.watermarked && (
            <Link href="/billing" asChild><Pressable accessibilityRole="link">
              <Text style={s.link}>Free cuts carry an anlim.ai watermark. Buy credits or a plan and every cut plays without it.</Text>
            </Pressable></Link>
          )}
          {x.url && (
            <Pressable onPress={() => downloadFile(x.url!, `${(title ?? "scene").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-")}-${x.format}${x.watermarked ? "-preview" : ""}.mp4`)
                .catch((e) => setError((e as Error).message))} accessibilityRole="button">
              <Text style={s.link}>Download the MP4</Text>
            </Pressable>
          )}
          {x.report && (
            <View style={{ marginTop: 8 }}>
              {x.report.checks.map((k) => (
                <Text key={k.name} style={[s.sub, { color: k.ok ? c.pass : c.fail }]}>{k.ok ? "✓" : "!"} {k.name}: {k.detail}</Text>
              ))}
              {x.report.notes.map((n) => <Text key={n} style={s.sub}>{n}</Text>)}
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, maxWidth: 1000, width: "100%", alignSelf: "center" },
  title: { fontSize: 20, fontWeight: "700", color: c.ink, marginTop: 6, marginBottom: 4 },
  h: { fontSize: 15, fontWeight: "700", color: c.ink, marginTop: 14, marginBottom: 6 },
  sub: { color: c.sub, fontSize: 13, marginBottom: 6 },
  link: { color: c.accent, fontSize: 14, marginVertical: 6 },
  panel: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 16, marginTop: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 6 },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.field },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  btn: { backgroundColor: c.accent, borderRadius: 8, padding: 13, alignItems: "center", marginTop: 12 },
  btnText: { color: c.onAccent, fontWeight: "600" },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, alignItems: "center", alignSelf: "flex-start" },
  err: { color: c.fail, marginTop: 8 },
});

// Motion transfer (2026-11-20, Londi: "ship both and explain their various uses ... not everyone will use the motion
// transfer in the same manner"). The creator uploads a clip and 1 to 8 reference images; Genjutsu (or Genjutsu Light)
// keeps the clip's motion, camera and cuts and recasts it with their characters, place and style. Paid accounts only;
// billed per second of the source, rounded up, as Higgsfield bills us (studio.motion_create). The result card is the
// Home prompt's (CreationCard, which polls "creation"). Layout from the canvas "anlim Motion transfer screen". @anlim
import { useEffect, useMemo, useState } from "react";
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { api, MotionModel, uploadMotionFile } from "../lib/api";
import { c, font } from "../lib/theme";
import { MOTION_NOTES, MOTION_USES, motionFamily } from "../lib/modelNotes";
import { StillPicker } from "../components/StillPicker";
import { MediaView } from "../components/MediaView";
import { CreationCard } from "../components/CreationCard";

const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
type Picked = { file: File; url: string };

// The clip's length, read by the browser before anything is uploaded (the server bills from it, rounded up).
function videoSeconds(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    if (Platform.OS !== "web" || typeof document === "undefined") return reject(new Error("web only"));
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve(v.duration);
    v.onerror = () => reject(new Error("This video could not be read. Try an MP4 file."));
    v.src = url;
  });
}

export default function Motion() {
  const { width } = useWindowDimensions();
  const narrow = width < 900;
  const [models, setModels] = useState<MotionModel[]>([]);
  const [paid, setPaid] = useState<boolean | null>(null);
  const [me, setMe] = useState<{ user_id: string; balance: number; reserved: number } | null>(null);
  const [src, setSrc] = useState<Picked | null>(null);
  const [secs, setSecs] = useState<number | null>(null);
  const [refs, setRefs] = useState<Picked[]>([]);
  const [who, setWho] = useState("");
  const [family, setFamily] = useState("genjutsu");
  const [res, setRes] = useState("720p");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);   // shot id of the clip being made

  useEffect(() => {
    api.motionModels().then((r) => { setModels(r.models); setPaid(r.paid); }).catch((e) => setErr((e as Error).message));
    api.me().then(setMe).catch(() => {});
  }, []);

  const families = useMemo(() => [...new Set(models.map((m) => motionFamily(m.id)))], [models]);
  const model = models.find((m) => motionFamily(m.id) === family && m.resolution === res)
    ?? models.find((m) => motionFamily(m.id) === family) ?? null;
  const resolutions = models.filter((m) => motionFamily(m.id) === family).map((m) => m.resolution);
  const used = secs == null || !model ? null : Math.min(secs, model.max_duration_s);
  const billed = used == null ? null : Math.ceil(used - 1e-6);
  const cost = billed != null && model ? billed * model.credits_per_second : null;
  const avail = me ? me.balance - me.reserved : null;
  const why = !paid ? "Motion transfer comes with a paid account."
    : !src || secs == null ? "Add your source clip."
    : secs < 4 ? "The source clip must be at least 4 seconds long."
    : refs.length === 0 ? "Add at least one reference image."
    : !agreed ? "Confirm you may use this footage."
    : cost != null && avail != null && cost > avail ? `This needs ${cost.toLocaleString()} credits; you have ${avail.toLocaleString()}.`
    : null;

  async function pickSource(f: File) {
    setErr(null);
    const url = URL.createObjectURL(f);
    try { const d = await videoSeconds(url); setSrc({ file: f, url }); setSecs(d); }
    catch (e) { setErr((e as Error).message); }
  }

  async function go() {
    if (why || !src || !model || !me || secs == null) return;
    setErr(null);
    try {
      setBusy("Uploading your clip…");
      const sourcePath = await uploadMotionFile(me.user_id, "source", src.file, src.file.type);
      setBusy("Uploading your images…");
      const refPaths: string[] = [];
      for (const r of refs) refPaths.push(await uploadMotionFile(me.user_id, "ref", r.file, r.file.type));
      setBusy("Starting…");
      const r = await api.motionCreate(sourcePath, refPaths, who.trim(), Math.round(secs * 1000) / 1000, model.id, null);
      setMade(r.shot_id);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  function reset() { setMade(null); setSrc(null); setSecs(null); setRefs([]); setWho(""); setAgreed(false); }

  if (Platform.OS !== "web") return (
    <View style={[s.page, { padding: 24 }]}>
      <Text style={[s.kicker, font.mono]}>MOTION TRANSFER</Text>
      <Text style={[s.h1, font.display, { fontSize: 28 }]}>Recast a clip as your own cartoon</Text>
      <Text style={s.lead}>Motion transfer works in the web app for now: open anlim.ai on a computer.</Text>
    </View>
  );

  const note = model ? MOTION_NOTES[motionFamily(model.id)] : null;

  return (
    <ScrollView style={s.page} contentContainerStyle={{ padding: narrow ? 18 : 40, paddingBottom: 80 }}>
      <View style={{ maxWidth: 1120, width: "100%", alignSelf: "center", gap: 26 }}>
        <View style={{ gap: 8 }}>
          <Text style={[s.kicker, font.mono]}>MOTION TRANSFER</Text>
          <Text style={[s.h1, font.display, narrow && { fontSize: 30 }]}>Recast a clip as your own cartoon</Text>
          <Text style={s.lead}>The motion, camera moves and cuts stay exactly as shot. The cast, the place and the style come from your images.</Text>
        </View>

        <View style={[s.uses, narrow && { flexDirection: "column" }]}>
          {MOTION_USES.map((u) => (
            <View key={u.title} style={s.use}>
              <Text style={s.useTitle}>{u.title}</Text>
              <Text style={s.useText}>{u.text}</Text>
            </View>
          ))}
        </View>

        {made ? <CreationCard shotId={made} output="video" onAgain={reset} /> : (
          <View style={[s.cols, narrow && { flexDirection: "column" }]}>
            <View style={{ flex: 2, minWidth: 0, gap: 18 }}>
              <View style={s.card}>
                <View style={s.cardHead}>
                  <Text style={s.h2}><Text style={[s.num, font.mono]}>01  </Text>Source clip</Text>
                  {src ? <StillPicker label="Replace" types={VIDEO_TYPES} maxMb={250} typeError="Use an MP4, MOV or WebM video."
                    onPick={pickSource} onError={setErr} textStyle={s.link} /> : null}
                </View>
                {src ? (
                  <View style={{ gap: 10 }}>
                    <MediaView kind="clip" url={src.url} />
                    <Text style={[s.meta, font.mono]}>
                      {src.file.name.slice(0, 40)} · {secs?.toFixed(1)} s{model && secs != null && secs > model.max_duration_s ? ` · ${model.label} uses the first ${model.max_duration_s} s` : ""}
                    </Text>
                  </View>
                ) : (
                  <StillPicker label="Choose a video (MP4, MOV or WebM, 4 to 30 seconds)" types={VIDEO_TYPES} maxMb={250}
                    typeError="Use an MP4, MOV or WebM video." onPick={pickSource} onError={setErr} style={s.drop} textStyle={s.dropText} />
                )}
                <Text style={s.hint}>Your own footage, or footage you have the right to use. Its sound is kept.</Text>
              </View>

              <View style={s.card}>
                <Text style={s.h2}><Text style={[s.num, font.mono]}>02  </Text>Cast and place</Text>
                <View style={s.thumbs}>
                  {refs.map((r, i) => (
                    <View key={r.url} style={s.thumbBox}>
                      <Image source={{ uri: r.url }} style={s.thumb} accessibilityLabel={`Reference image ${i + 1}`} />
                      <Pressable onPress={() => setRefs(refs.filter((x) => x !== r))} accessibilityRole="button"
                        accessibilityLabel={`Remove reference image ${i + 1}`} style={s.remove}><Text style={{ color: c.ink, fontSize: 13 }}>✕</Text></Pressable>
                    </View>
                  ))}
                  {refs.length < 8 && (
                    <StillPicker label={refs.length ? "+ Add image" : "+ Add a character or setting image"} types={IMAGE_TYPES} maxMb={15}
                      onPick={(f) => { setErr(null); setRefs([...refs, { file: f, url: URL.createObjectURL(f) }]); }} onError={setErr}
                      style={s.addTile} textStyle={s.addText} />
                  )}
                </View>
                <Text style={s.hint}>Up to 8 images. One image can hold the whole cast and the setting. Give each person in the clip someone to become, with a similar build, so the motion maps cleanly.</Text>
              </View>

              <View style={s.card}>
                <Text style={s.h2}><Text style={[s.num, font.mono]}>03  </Text>Who is who <Text style={s.optional}>(optional)</Text></Text>
                <TextInput value={who} onChangeText={setWho} multiline maxLength={2000} style={s.input} placeholderTextColor={c.muted}
                  accessibilityLabel="Who is who"
                  placeholder="Describe each person by what they wear, so nobody swaps halfway through. E.g. the dancer in front is always the fox in the red hoodie." />
              </View>

              <View style={s.card}>
                <Text style={s.h2}><Text style={[s.num, font.mono]}>04  </Text>Model</Text>
                <View style={[s.models, narrow && { flexDirection: "column" }]}>
                  {families.map((f) => {
                    const on = f === family, first = models.find((m) => motionFamily(m.id) === f)!;
                    const n = MOTION_NOTES[f];
                    const rates = models.filter((m) => motionFamily(m.id) === f).map((m) => `${m.credits_per_second} cr/s ${m.resolution}`).join(" · ");
                    return (
                      <Pressable key={f} onPress={() => { setFamily(f); if (!models.some((m) => motionFamily(m.id) === f && m.resolution === res)) setRes(first.resolution); }}
                        accessibilityRole="radio" accessibilityState={{ checked: on }} style={[s.model, on && s.modelOn]}>
                        <Text style={[s.modelName, on && { color: c.ink }]}>{first.label ?? f}</Text>
                        <Text style={[s.meta, font.mono]}>{rates} · up to {first.max_duration_s} s</Text>
                        {n ? <Text style={s.modelText}>{n.best}{n.watch ? <Text style={{ color: c.muted }}> {n.watch}</Text> : null}</Text> : null}
                      </Pressable>
                    );
                  })}
                </View>
                {resolutions.length > 1 && (
                  <View style={s.segRow}>
                    <Text style={s.hint}>Quality</Text>
                    <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel="Quality">
                      {resolutions.map((r) => (
                        <Pressable key={r} onPress={() => setRes(r)} accessibilityRole="radio" accessibilityState={{ checked: r === res }}
                          style={[s.segBtn, r === res && s.segOn]}>
                          <Text style={{ color: r === res ? c.ink : c.sub, fontSize: 13, fontWeight: r === res ? "600" : "500" }}>{r}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            </View>

            <View style={[s.card, s.summary, { flex: 1, minWidth: narrow ? 0 : 320 }]}>
              <Text style={[s.kicker, font.mono, { color: c.muted }]}>SUMMARY</Text>
              <Row k="Model" v={model ? `${model.label} · ${model.resolution}` : "…"} />
              <Row k="Length billed" v={billed != null ? `${billed} s` : "—"} />
              <Row k="Rate" v={model ? `${model.credits_per_second} cr/s` : "—"} />
              <Row k="Takes about" v={family === "genjutsu-light" ? "10 to 15 min" : "8 to 12 min"} />
              <View style={s.costRow}>
                <Text style={{ color: c.sub, fontSize: 14 }}>Cost</Text>
                <Text style={[s.cost, font.display]}>{cost != null ? cost.toLocaleString() : "—"}<Text style={s.costUnit}>  credits</Text></Text>
              </View>
              {avail != null && <Text style={[s.meta, font.mono]}>You have {avail.toLocaleString()} credits</Text>}
              <Pressable onPress={() => setAgreed(!agreed)} accessibilityRole="checkbox" accessibilityState={{ checked: agreed }} style={s.agree}>
                <View style={[s.box, agreed && s.boxOn]}>{agreed ? <Text style={{ color: c.onAccent, fontSize: 12, fontWeight: "800" }}>✓</Text> : null}</View>
                <Text style={{ color: c.sub, fontSize: 13, lineHeight: 19, flex: 1 }}>I made this footage or have the right to use it.</Text>
              </Pressable>
              <Pressable onPress={go} disabled={!!why || !!busy} accessibilityRole="button"
                style={[s.cta, (why || busy) ? s.ctaOff : null]}>
                <Text style={[{ color: why || busy ? c.muted : c.onAccent, fontSize: 15, fontWeight: "700" }, font.display]}>
                  {busy ?? (cost != null ? `Recast clip · ${cost.toLocaleString()} credits` : "Recast clip")}
                </Text>
              </Pressable>
              {why && !busy ? <Text style={s.hint}>{why}{paid === false ? " " : ""}{paid === false
                ? <Text style={s.link} onPress={() => router.navigate("/billing")}>See plans and credits</Text> : null}</Text> : null}
              {err ? <Text style={{ color: c.fail, fontSize: 13 }}>{err}</Text> : null}
              <Text style={s.small}>Charged per second of your clip, rounded up, when the clip is made. A clip with a problem can be refunded from its page.</Text>
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
      <Text style={{ color: c.sub, fontSize: 14 }}>{k}</Text>
      <Text style={[{ color: c.ink, fontSize: 14 }, font.mono]}>{v}</Text>
    </View>
  );
}

const shadow = { shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 20, shadowOffset: { width: 0, height: 12 } };
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  kicker: { color: c.accent, fontSize: 12, letterSpacing: 1.6 },
  h1: { color: c.ink, fontSize: 38, lineHeight: 42 },
  lead: { color: c.sub, fontSize: 15, lineHeight: 22, maxWidth: 640 },
  uses: { flexDirection: "row", gap: 12 },
  use: { flex: 1, backgroundColor: c.rail, borderRadius: 12, padding: 14, gap: 4 },
  useTitle: { color: c.ink, fontSize: 14, fontWeight: "600" },
  useText: { color: c.sub, fontSize: 13, lineHeight: 19 },
  cols: { flexDirection: "row", gap: 22, alignItems: "flex-start" },
  card: { backgroundColor: c.card, borderRadius: 14, padding: 22, gap: 14, ...shadow },
  summary: { gap: 14, shadowRadius: 40, shadowOpacity: 0.6 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  h2: { color: c.ink, fontSize: 19, fontWeight: "600", fontFamily: "'Space Grotesk', Inter, sans-serif" },
  num: { color: c.accent, fontSize: 12 },
  optional: { color: c.muted, fontSize: 13, fontWeight: "400" },
  link: { color: c.link, fontSize: 13 },
  meta: { color: c.muted, fontSize: 11.5 },
  hint: { color: c.muted, fontSize: 13, lineHeight: 19 },
  small: { color: c.muted, fontSize: 12, lineHeight: 17 },
  drop: { minHeight: 150, borderRadius: 12, backgroundColor: c.field, alignItems: "center", justifyContent: "center", padding: 18,
          shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  dropText: { color: c.sub, fontSize: 14, textAlign: "center" },
  thumbs: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  thumbBox: { width: 160, aspectRatio: 16 / 9, borderRadius: 10, overflow: "hidden", backgroundColor: c.field },
  thumb: { width: "100%", height: "100%" },
  remove: { position: "absolute", top: 6, right: 6, width: 28, height: 28, borderRadius: 8, backgroundColor: "rgba(8,8,10,0.75)",
            alignItems: "center", justifyContent: "center" },
  addTile: { width: 160, aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: c.card2, alignItems: "center", justifyContent: "center", padding: 10 },
  addText: { color: c.sub, fontSize: 12.5, textAlign: "center" },
  input: { minHeight: 96, borderRadius: 10, backgroundColor: c.field, color: c.ink, padding: 14, fontSize: 14, lineHeight: 21, textAlignVertical: "top" },
  models: { flexDirection: "row", gap: 12 },
  model: { flex: 1, borderRadius: 12, backgroundColor: c.field, padding: 14, gap: 6 },
  modelOn: { backgroundColor: "#1A1410", shadowColor: c.accent, shadowOpacity: 0.25, shadowRadius: 18, shadowOffset: { width: 0, height: 0 } },
  modelName: { color: c.sub, fontSize: 16, fontWeight: "700", fontFamily: "'Space Grotesk', Inter, sans-serif" },
  modelText: { color: c.sub, fontSize: 13, lineHeight: 19 },
  segRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  seg: { flexDirection: "row", gap: 4, backgroundColor: c.rail, padding: 4, borderRadius: 10 },
  segBtn: { paddingHorizontal: 18, minHeight: 40, justifyContent: "center", borderRadius: 7 },
  segOn: { backgroundColor: c.line, shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  costRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", paddingTop: 12 },
  cost: { color: c.ink, fontSize: 30 },
  costUnit: { color: c.sub, fontSize: 14, fontWeight: "500" },
  agree: { flexDirection: "row", gap: 12, alignItems: "flex-start", minHeight: 44 },
  box: { width: 20, height: 20, borderRadius: 5, backgroundColor: c.card2, alignItems: "center", justifyContent: "center", marginTop: 1 },
  boxOn: { backgroundColor: c.accent },
  cta: { minHeight: 52, borderRadius: 10, backgroundColor: c.accent, alignItems: "center", justifyContent: "center", paddingHorizontal: 16,
         shadowColor: c.accent, shadowOpacity: 0.35, shadowRadius: 22, shadowOffset: { width: 0, height: 8 } },
  ctaOff: { backgroundColor: c.card2, shadowOpacity: 0 },
});

// Replace a person (2026-11-27, Londi: "Bundle both models. Make sure that it is done safely"). One person in the
// creator's clip becomes the person in their photo; the place, the other people, the camera, the cuts and the sound stay
// as filmed (studio.replace_create). Two separate confirmations: the likeness of the person put in, and the creator's
// right to use the footage plus the promise not to pass the result off as real (the statement comes from the server,
// studio.replace_statement, so the words shown are the words recorded). Every result carries an "AI-edited" label. @anlim
import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { api, ReplaceModel, uploadMotionFile } from "../lib/api";
import { c, font } from "../lib/theme";
import { StillPicker } from "./StillPicker";
import { MediaView } from "./MediaView";
import { CreationCard } from "./CreationCard";
import { tr, locale, tMsg } from "../lib/i18n";

const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
type Picked = { file: File; url: string };

function videoSeconds(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve(v.duration);
    v.onerror = () => reject(new Error(tr("This video could not be read. Try an MP4 file.")));
    v.src = url;
  });
}

export function ReplaceForm({ narrow }: { narrow: boolean }) {
  const [models, setModels] = useState<ReplaceModel[]>([]);
  const [statement, setStatement] = useState("");
  const [paid, setPaid] = useState<boolean | null>(null);
  const [me, setMe] = useState<{ user_id: string; balance: number; reserved: number } | null>(null);
  const [src, setSrc] = useState<Picked | null>(null);
  const [secs, setSecs] = useState<number | null>(null);
  const [photo, setPhoto] = useState<Picked | null>(null);
  const [who, setWho] = useState("");
  const [modelId, setModelId] = useState<string | null>(null);
  const [likeness, setLikeness] = useState(false);
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  useEffect(() => {
    api.replaceModels().then((r) => { setModels(r.models); setPaid(r.paid); setStatement(r.statement); setModelId(r.models[0]?.id ?? null); })
      .catch((e) => setErr((e as Error).message));
    api.me().then(setMe).catch(() => {});
  }, []);

  const model = models.find((m) => m.id === modelId) ?? null;
  const billed = secs == null || !model ? null : Math.ceil(Math.min(secs, model.max_duration_s) - 1e-6);
  const cost = billed != null && model ? billed * model.credits_per_second : null;
  const avail = me ? me.balance - me.reserved : null;
  const why = !paid ? tr("Replacing a person comes with a paid account.")
    : !models.length ? tr("Replacing a person is not open yet.")
    : !src || secs == null ? tr("Add your clip.")
    : model && secs < model.min_duration_s ? tr("The clip must be at least {v0} seconds long.", { v0: model.min_duration_s })
    : model && secs > model.max_duration_s + 0.5 ? tr("{label} takes clips up to {v0} seconds. Trim it first.", { label: model.label ?? "", v0: model.max_duration_s })
    : !photo ? tr("Add the photo of the person who goes in.")
    : model?.needs_who && who.trim().length < 3 ? tr("Say who in the clip is replaced.")
    : !likeness ? tr("Confirm the person in the photo.")
    : !rights ? tr("Confirm you may use this clip.")
    : cost != null && avail != null && cost > avail ? tr("This needs {v0} credits; you have {v1}.", { v0: cost.toLocaleString(locale()), v1: avail.toLocaleString(locale()) })
    : null;

  async function pickSource(f: File) {
    setErr(null);
    const url = URL.createObjectURL(f);
    try { const d = await videoSeconds(url); setSrc({ file: f, url }); setSecs(d); }
    catch (e) { setErr((e as Error).message); }
  }

  async function go() {
    if (why || !src || !photo || !model || !me || secs == null) return;
    setErr(null);
    try {
      setBusy(tr("Uploading your clip…"));
      const sourcePath = await uploadMotionFile(me.user_id, "source", src.file, src.file.type);
      setBusy(tr("Uploading your photo…"));
      const refPath = await uploadMotionFile(me.user_id, "ref", photo.file, photo.file.type);
      setBusy(tr("Starting…"));
      const r = await api.replaceCreate(sourcePath, refPath, who.trim(), Math.round(secs * 1000) / 1000, model.id, likeness, rights);
      setMade(r.shot_id);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  function reset() { setMade(null); setSrc(null); setSecs(null); setPhoto(null); setWho(""); setLikeness(false); setRights(false); }

  if (made) return <CreationCard shotId={made} output="video" onAgain={reset} />;

  return (
    <View style={[s.cols, narrow && { flexDirection: "column" }]}>
      <View style={{ flex: 2, minWidth: 0, gap: 18 }}>
        <View style={s.card}>
          <View style={s.cardHead}>
            <Text style={s.h2}><Text style={[s.num, font.mono]}>01  </Text>{tr("Your clip")}</Text>
            {src ? <StillPicker label={tr("Replace")} types={VIDEO_TYPES} maxMb={250} typeError="Use an MP4, MOV or WebM video."
              onPick={pickSource} onError={setErr} textStyle={s.link} /> : null}
          </View>
          {src ? (
            <View style={{ gap: 10 }}>
              <MediaView kind="clip" url={src.url} />
              <Text style={[s.meta, font.mono]}>{src.file.name.slice(0, 40)} · {secs?.toFixed(1)} s</Text>
            </View>
          ) : (
            <StillPicker label={tr("Choose a video (MP4, MOV or WebM, 5 to 30 seconds)")} types={VIDEO_TYPES} maxMb={250}
              typeError="Use an MP4, MOV or WebM video." onPick={pickSource} onError={setErr} style={s.drop} textStyle={s.dropText} />
          )}
          <Text style={s.hint}>{tr("A sports moment, a dance, a scene from your own footage. Everything stays as filmed except the one person you replace, and the sound is kept. News, political, crime or disaster footage is refused.")}</Text>
        </View>

        <View style={s.card}>
          <Text style={s.h2}><Text style={[s.num, font.mono]}>02  </Text>{tr("Who goes in")}</Text>
          <View style={{ flexDirection: "row", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            {photo ? (
              <View style={s.thumbBox}>
                <Image source={{ uri: photo.url }} style={s.thumb} accessibilityLabel={tr("Photo of the person who goes in")} />
                <Pressable onPress={() => setPhoto(null)} accessibilityRole="button" accessibilityLabel={tr("Remove the photo")} style={s.remove}>
                  <Text style={{ color: c.ink, fontSize: 13 }}>✕</Text>
                </Pressable>
              </View>
            ) : (
              <StillPicker label={tr("+ Add a clear photo of the face")} types={IMAGE_TYPES} maxMb={15}
                onPick={(f) => { setErr(null); setPhoto({ file: f, url: URL.createObjectURL(f) }); }} onError={setErr}
                style={s.addTile} textStyle={s.addText} />
            )}
            <Text style={[s.hint, { flex: 1, minWidth: 200 }]}>{tr("Usually you. A front-facing photo with good light. A similar build to the person you replace keeps the motion clean.")}</Text>
          </View>
          <Check on={likeness} set={setLikeness}
            text={tr("Any real person in this photo is me, or has agreed that I may use their likeness here.")} />
        </View>

        <View style={s.card}>
          <Text style={s.h2}><Text style={[s.num, font.mono]}>03  </Text>{tr("Who is replaced ")}
            {!model?.needs_who ? <Text style={s.optional}>{tr("(this model replaces the main person)")}</Text> : null}</Text>
          <TextInput value={who} onChangeText={setWho} maxLength={300} style={s.input} placeholderTextColor={c.muted}
            accessibilityLabel={tr("Who is replaced")} editable={!!model?.needs_who}
            placeholder={model?.needs_who ? tr("Describe them by what they wear and where they are. E.g. the player in the red number 10 shirt who takes the shot.")
              : tr("Wan Animate Replace replaces the clip's main person: use a clip with one clear subject.")} />
        </View>

        <View style={s.card}>
          <Text style={s.h2}><Text style={[s.num, font.mono]}>04  </Text>{tr("Model")}</Text>
          <View style={[s.models, narrow && { flexDirection: "column" }]}>
            {models.map((m) => {
              const on = m.id === modelId;
              return (
                <Pressable key={m.id} onPress={() => setModelId(m.id)} accessibilityRole="radio" accessibilityState={{ checked: on }} style={[s.model, on && s.modelOn]}>
                  <Text style={[s.modelName, on && { color: c.ink }]}>{m.label} · {m.resolution}</Text>
                  <Text style={[s.meta, font.mono]}>{tr("{v0} cr/s · {v1} to {v2} s", { v0: m.credits_per_second, v1: m.min_duration_s, v2: m.max_duration_s })}{m.active ? "" : tr(" · admins only (testing)")}</Text>
                  <Text style={s.modelText}>{m.needs_who ? tr("You say who is replaced; it follows them through every cut. Best for busy scenes with several people.")
                    : tr("Cheaper. Replaces the main person; best with one clear subject.")}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      <View style={[s.card, s.summary, { flex: 1, minWidth: narrow ? 0 : 320 }]}>
        <Text style={[s.kicker, font.mono, { color: c.muted }]}>{tr("SUMMARY")}</Text>
        <Row k={tr("Model")} v={model ? `${model.label} · ${model.resolution}` : "…"} />
        <Row k={tr("Length billed")} v={billed != null ? `${billed} s` : "—"} />
        <Row k={tr("Rate")} v={model ? `${model.credits_per_second} cr/s` : "—"} />
        <View style={s.costRow}>
          <Text style={{ color: c.sub, fontSize: 14 }}>{tr("Cost")}</Text>
          <Text style={[s.cost, font.display]}>{cost != null ? cost.toLocaleString(locale()) : "—"}<Text style={s.costUnit}>{tr(" credits")}</Text></Text>
        </View>
        {avail != null && <Text style={[s.meta, font.mono]}>{tr("You have {v0} credits", { v0: avail.toLocaleString(locale()) })}</Text>}
        <Check on={rights} set={setRights} text={statement || "…"} />
        <Pressable onPress={go} disabled={!!why || !!busy} accessibilityRole="button" style={[s.cta, (why || busy) ? s.ctaOff : null]}>
          <Text style={[{ color: why || busy ? c.muted : c.onAccent, fontSize: 15, fontWeight: "700" }, font.display]}>
            {busy ?? (cost != null ? tr("Replace the person · {v0} credits", { v0: cost.toLocaleString(locale()) }) : tr("Replace the person"))}
          </Text>
        </Pressable>
        {why && !busy ? <Text style={s.hint}>{why}{paid === false ? " " : ""}{paid === false
          ? <Text style={s.link} onPress={() => router.navigate("/billing")}>{tr("See plans and credits")}</Text> : null}</Text> : null}
        {err ? <Text style={{ color: c.fail, fontSize: 13 }}>{tMsg(err)}</Text> : null}
        <Text style={s.small}>{tr("The result shows an “AI-edited” label for its whole length. Charged per second of your clip, rounded up, when it is made.")}</Text>
        <Text style={s.small} onPress={() => router.navigate("/terms")}>{tr("Rules for edited footage are in the Terms.")}</Text>
      </View>
    </View>
  );
}

function Check({ on, set, text }: { on: boolean; set: (v: boolean) => void; text: string }) {
  return (
    <Pressable onPress={() => set(!on)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={s.agree}>
      <View style={[s.box, on && s.boxOn]}>{on ? <Text style={{ color: c.onAccent, fontSize: 12, fontWeight: "800" }}>✓</Text> : null}</View>
      <Text style={{ color: c.sub, fontSize: 13, lineHeight: 19, flex: 1 }}>{text}</Text>
    </Pressable>
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
  kicker: { color: c.accent, fontSize: 12, letterSpacing: 1.6 },
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
  drop: { minHeight: 150, borderRadius: 12, backgroundColor: c.field, alignItems: "center", justifyContent: "center", padding: 18 },
  dropText: { color: c.sub, fontSize: 14, textAlign: "center" },
  thumbBox: { width: 160, aspectRatio: 1, borderRadius: 10, overflow: "hidden", backgroundColor: c.field },
  thumb: { width: "100%", height: "100%" },
  remove: { position: "absolute", top: 6, right: 6, width: 28, height: 28, borderRadius: 8, backgroundColor: "rgba(8,8,10,0.75)",
            alignItems: "center", justifyContent: "center" },
  addTile: { width: 160, aspectRatio: 1, borderRadius: 10, backgroundColor: c.card2, alignItems: "center", justifyContent: "center", padding: 10 },
  addText: { color: c.sub, fontSize: 12.5, textAlign: "center" },
  input: { minHeight: 64, borderRadius: 10, backgroundColor: c.field, color: c.ink, padding: 14, fontSize: 14, lineHeight: 21, textAlignVertical: "top" },
  models: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  model: { flex: 1, minWidth: 220, borderRadius: 12, backgroundColor: c.field, padding: 14, gap: 6 },
  modelOn: { backgroundColor: "#1A1410", shadowColor: c.accent, shadowOpacity: 0.25, shadowRadius: 18, shadowOffset: { width: 0, height: 0 } },
  modelName: { color: c.sub, fontSize: 16, fontWeight: "700", fontFamily: "'Space Grotesk', Inter, sans-serif" },
  modelText: { color: c.sub, fontSize: 13, lineHeight: 19 },
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

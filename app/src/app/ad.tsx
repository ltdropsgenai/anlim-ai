// Ad maker (2026-11-27, Londi: "build #1 first" of the UGC ad feature). The creator describes a product (and may give
// its web page); three short scripts come back as shots (worker ad.js, checker ad_script.py); the chosen one becomes a
// project with its shots, spoken lines and on-screen words (studio.apply_ad_draft). Free. The scripts are written for a
// presenter or a demo, never as an invented customer's review, and claim only what the creator gave (FTC rule on fake
// reviews and testimonials, 16 CFR 465). @anlim
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { api, AdDraft, AdSpec } from "../lib/api";
import { c, font } from "../lib/theme";
import { tr, tMsg } from "../lib/i18n";

const SHAPES = ["9:16", "1:1", "16:9"] as const;

export default function AdMaker() {
  const { width } = useWindowDimensions();
  const narrow = width < 900;
  const [spec, setSpec] = useState<AdSpec>({ product: "", brief: "", url: "", offer: "", cta: "", presenter: "", tone: "", language: "", length_s: 15, look: "photoreal" });
  const [draft, setDraft] = useState<AdDraft | null>(null);
  const [pick, setPick] = useState(1);
  const [shape, setShape] = useState<(typeof SHAPES)[number]>("9:16");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const set = (p: Partial<AdSpec>) => setSpec((x) => ({ ...x, ...p }));

  const why = spec.product.trim().length < 2 ? tr("Name the product.")
    : spec.brief.trim().length < 10 ? tr("Say what it is and who it is for (at least 10 characters).")
    : spec.url && !/^https?:\/\/\S+$/i.test(spec.url.trim()) ? tr("The web page must start with http:// or https://.")
    : null;

  function poll(id: string) {
    api.adGet(id).then((d) => {
      setDraft(d);
      if (d.status === "queued" || d.status === "running") timer.current = setTimeout(() => poll(id), 2500);
      else setBusy(false);
    }).catch((e) => { setErr((e as Error).message); setBusy(false); });
  }
  async function write() {
    if (why) return;
    setErr(null); setBusy(true); setDraft(null); setPick(1);
    try {
      const clean = Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === "string" ? v.trim() || null : v])) as AdSpec;
      const r = await api.adCreate(clean);
      poll(r.id);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  async function useIt() {
    if (!draft) return;
    setErr(null); setBusy(true);
    try {
      const r = await api.adApply(draft.id, pick, shape);
      router.push({ pathname: "/workspace", params: { series: r.series_id, scene: r.scene_id } });
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  const field = (key: keyof AdSpec, label: string, placeholder: string, max: number, multiline = false) => (
    <View style={{ gap: 6, flex: 1, minWidth: 220 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={[s.input, multiline && { minHeight: 90, textAlignVertical: "top" }]} multiline={multiline} maxLength={max}
        value={String(spec[key] ?? "")} placeholder={placeholder} placeholderTextColor={c.muted} accessibilityLabel={label}
        onChangeText={(v) => set({ [key]: multiline ? v : v.replace(/[\r\n\t]/g, " ") } as Partial<AdSpec>)} />
    </View>
  );
  const chip = (on: boolean, label: string, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} style={[s.chip, on && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
      <Text style={{ color: on ? c.onAccent : c.ink }}>{label}</Text>
    </Pressable>
  );
  const working = draft && (draft.status === "queued" || draft.status === "running");

  return (
    <ScrollView style={s.page} contentContainerStyle={{ padding: narrow ? 18 : 40, paddingBottom: 80 }}>
      <View style={{ maxWidth: 1000, width: "100%", alignSelf: "center", gap: 22 }}>
        <View style={{ gap: 8 }}>
          <Text style={[s.kicker, font.mono]}>{tr("AD MAKER")}</Text>
          <Text style={[s.h1, font.display, narrow && { fontSize: 30 }]}>{tr("A short video ad for your product")}</Text>
          <Text style={s.lead}>{tr("Describe the product and get three scripts, each a hook, a demo and a call to action laid out as shots. Pick one and it becomes a project with its shots, lines and on-screen words. Free.")}</Text>
        </View>

        <View style={s.card}>
          <View style={s.row}>
            {field("product", tr("Product"), tr("e.g. GlowCup travel mug"), 80)}
            {field("url", tr("Product web page (optional)"), "https://", 500)}
          </View>
          {field("brief", tr("What it is, what it does, who it is for"), tr("Keeps coffee hot for 6 hours, fits car cup holders, for commuters…"), 1500, true)}
          <View style={s.row}>
            {field("offer", tr("A real offer (optional)"), tr("e.g. 20% off this week"), 200)}
            {field("cta", tr("Call to action (optional)"), tr("e.g. Link in bio"), 80)}
          </View>
          <View style={s.row}>
            {field("presenter", tr("Presenter (optional)"), tr("Your character's name, or leave empty"), 80)}
            {field("tone", tr("Tone (optional)"), tr("e.g. upbeat, calm, funny"), 80)}
            {field("language", tr("Language (optional)"), tr("e.g. Spanish"), 40)}
          </View>
          <Text style={s.label}>{tr("Length")}</Text>
          <View style={s.row}>{([10, 15, 30] as const).map((n) => chip(spec.length_s === n, tr("{v0} s", { v0: n }), () => set({ length_s: n })))}</View>
          <Text style={s.label}>{tr("Look")}</Text>
          <View style={s.row}>
            {chip(spec.look === "photoreal", tr("Photoreal"), () => set({ look: "photoreal" }))}
            {chip(spec.look === "cartoon", tr("Cartoon"), () => set({ look: "cartoon" }))}
          </View>
          <Text style={s.hint}>{tr("The scripts are spoken by a presenter showing the product (you, or someone who agreed), never as a made-up customer's review, and they only claim what you write here or what your product page says. Fake reviews and testimonials break the FTC's rules.")}</Text>
          {why && <Text style={s.hint}>{why}</Text>}
          <Pressable style={[s.btn, (busy || !!why) && { opacity: 0.5 }]} disabled={busy || !!why} onPress={write} accessibilityRole="button">
            <Text style={s.btnText}>{working ? tr("Writing the scripts…") : tr("Write three scripts")}</Text>
          </Pressable>
        </View>

        {working && <View style={[s.row, { alignItems: "center" }]}><ActivityIndicator /><Text style={s.sub}>{tr("Writing… this takes about half a minute.")}</Text></View>}
        {draft?.status === "failed" && <Text style={s.err}>{tMsg(draft.error || tr("The ad scripts could not be written; try again."))}</Text>}
        {draft?.status === "done" && draft.variants && <View style={{ gap: 14 }}>
          {draft.error && <Text style={s.hint}>{tMsg(draft.error)}</Text>}
          {draft.variants.map((v, k) => (
            <Pressable key={k} onPress={() => setPick(k + 1)} accessibilityRole="radio" accessibilityState={{ checked: pick === k + 1 }}
              style={[s.card, pick === k + 1 && { borderColor: c.accent, borderWidth: 2 }]}>
              <Text style={s.title}>{tr("Script {v0}: {v1}", { v0: k + 1, v1: v.angle })} · {tr("{v0} s", { v0: v.seconds })}</Text>
              {v.shots.map((sh, j) => (
                <View key={j} style={s.shot}>
                  <Text style={[s.num, font.mono]}>{String(j + 1).padStart(2, "0")} · {sh.seconds}s</Text>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: c.ink }}>{sh.picture}</Text>
                    {sh.line ? <Text style={s.line}>“{sh.line}”</Text> : null}
                    {sh.on_screen ? <Text style={s.screen}>{sh.on_screen.toUpperCase()}</Text> : null}
                  </View>
                </View>
              ))}
              {v.caption ? <Text style={s.hint}>{tr("Post caption")}: {v.caption}</Text> : null}
            </Pressable>
          ))}
          <View style={s.card}>
            <Text style={s.label}>{tr("Shape of the new project")}</Text>
            <View style={s.row}>{SHAPES.map((x) => chip(shape === x, x, () => setShape(x)))}</View>
            <Text style={s.hint}>{tr("Next, add the presenter as a character (with their consent) and the product, make the start images, animate the shots, voice each shot's line, and make the cut with bold captions.")}</Text>
            <Pressable style={[s.btn, busy && { opacity: 0.5 }]} disabled={busy} onPress={useIt} accessibilityRole="button">
              <Text style={s.btnText}>{tr("Make script {v0} a project", { v0: pick })}</Text>
            </Pressable>
          </View>
        </View>}
        {err && <Text style={s.err}>{tMsg(err)}</Text>}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  kicker: { color: c.accent, fontSize: 12, letterSpacing: 1.5 },
  h1: { color: c.ink, fontSize: 40 },
  lead: { color: c.sub, fontSize: 16, lineHeight: 24, maxWidth: 720 },
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 18, gap: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  label: { color: c.sub, fontSize: 13, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: c.ink, backgroundColor: c.field },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: c.field },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  hint: { color: c.muted, fontSize: 13, lineHeight: 19 },
  sub: { color: c.sub, fontSize: 14 },
  btn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 11, paddingHorizontal: 18, alignSelf: "flex-start" },
  btnText: { color: c.onAccent, fontWeight: "600" },
  err: { color: c.fail, fontSize: 14 },
  title: { color: c.ink, fontWeight: "700", fontSize: 16 },
  shot: { flexDirection: "row", gap: 12, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line },
  num: { color: c.sub, fontSize: 12, width: 70 },
  line: { color: c.sub, fontStyle: "italic" },
  screen: { color: c.accent, fontWeight: "800", fontSize: 12, letterSpacing: 1 },
});

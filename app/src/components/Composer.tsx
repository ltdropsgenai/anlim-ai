// Home composer (2026-11-19, Londi: "the homepage should be similar to what all other tools show... 'What are we
// working on today?' with a prompt window"). 2026-11-20: the prompt makes an image, or an image and a short clip
// (studio.quick_create), in a new "Untitled project" or the project the creator picks; the result shows here with
// download and "start a project from this" (CreationCard). Not every creator is working on a project. @anlim
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { FloatCard } from "./FloatCard";
import { router } from "expo-router";
import { api, Aspect, ASPECTS, Look, Output, PromptModel, Series } from "../lib/api";
import { autoNote, MODEL_NOTES } from "../lib/modelNotes";
import { CreationCard } from "./CreationCard";
import { c, font } from "../lib/theme";
import { clearDraft, peekDraft, saveDraft } from "../lib/draft";
import { tr, tMsg } from "../lib/i18n";

const IDEAS: Record<Look, string[]> = {
  cartoon: [
    "A small fox tiptoes across a snowy log, slips, and lands in a pile of snow",
    "Two kids build a sandcastle as the tide creeps closer",
    "A robot waters a single flower on a rooftop at sunset",
    "A cat knocks a mug off the kitchen counter, then looks at the camera",
  ],
  photoreal: [
    "A woman reads a letter by the window, smiles, then folds it away",
    "A barista slides a latte across the counter to a customer",
    "Two friends sit on a park bench talking; one laughs and leans back",
    "A man walks into a quiet living room and sets his keys on the table",
  ],
};
// with no look chosen yet, the ideas alternate between the two; picking one also picks its look
const MIXED = [0, 1].flatMap((i) => [{ t: IDEAS.cartoon[i], l: "cartoon" as Look }, { t: IDEAS.photoreal[i], l: "photoreal" as Look }]);
const LENGTHS = [5, 10];
const CLIP_CREDITS_PER_S = 40;   // Kling 4.0, Auto's pick (studio.models); the server checks the real price

export function Composer({ narrow, guest = false, afterBanner = false }: { narrow: boolean; guest?: boolean; afterBanner?: boolean }) {
  const [text, setText] = useState("");
  // 2026-11-23 (Londi): no default look; the creator picks Cartoon or Photoreal for every new project
  const [look, setLook] = useState<Look | null>(null);
  const [len, setLen] = useState(5);
  // 2026-11-21 (Londi): every creator picks the shape (was always 16:9); a picked project keeps its own
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [output, setOutput] = useState<Output>("video");
  const [made, setMade] = useState<{ shot: string; output: Output } | null>(null);
  const [series, setSeries] = useState<Series[]>([]);
  const [target, setTarget] = useState<string | null>(null);   // null = new project
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  // 2026-11-20 (Londi): paid accounts pick the video model; free accounts use Auto (the server enforces it too)
  const [models, setModels] = useState<PromptModel[]>([]);
  const [paid, setPaid] = useState(false);
  const [model, setModel] = useState<string | null>(null);   // null = Auto
  const input = useRef<{ focus: () => void } | null>(null);

  useEffect(() => { if (!guest) api.series().then(setSeries).catch(() => setSeries([])); }, [guest]);
  useEffect(() => { if (!guest) api.promptModels().then((r) => { setModels(r.models); setPaid(r.paid); }).catch(() => {}); }, [guest]);
  // a prompt typed before signing up: make it now, on the new account (once; the draft is cleared first)
  useEffect(() => {
    if (guest) return;
    const d = peekDraft();
    if (!d) return;
    clearDraft();
    setText(d.text); setLook(d.look); setLen(d.len); setOutput(d.output ?? "video"); setAspect(d.aspect ?? "16:9");
    make(d.text, d.look, d.len, d.output ?? "video", null, null, d.aspect ?? "16:9");
  }, [guest]);   // eslint-disable-line react-hooks/exhaustive-deps
  const picked = useMemo(() => series.find((x) => x.id === target) ?? null, [series, target]);
  // adding to an existing project uses that project's look; the toggle is for new projects
  const effLook: Look | null = picked ? picked.look : look;
  const effAspect: Aspect = picked ? picked.aspect ?? "16:9" : aspect;
  const ready = text.trim().length >= 8 && !busy && effLook !== null;
  // models that can make this video: the look and the length must fit
  const fits = useMemo(() => models.filter((m) => (!m.looks || !effLook || m.looks.includes(effLook)) && len >= m.min_duration_s && len <= m.max_duration_s),
    [models, effLook, len]);
  useEffect(() => { if (model && !fits.some((m) => m.id === model)) setModel(null); }, [fits, model]);
  const chosen = models.find((m) => m.id === model) ?? null;
  const perS = chosen?.credits_per_second ?? CLIP_CREDITS_PER_S;

  async function go() {
    if (!ready || !effLook) return;
    if (guest) {
      // visitors: keep the prompt, ask for an account; the shot is made as soon as they are signed in
      saveDraft({ text: text.trim(), look: effLook, len, output, aspect });
      router.navigate({ pathname: "/login", params: { mode: "signup" } });
      return;
    }
    await make(text.trim(), effLook, len, output, picked, output === "video" ? model : null, aspect);
  }

  async function make(action: string, lk: Look, ln: number, out: Output, p: Series | null, m: string | null = null, a: Aspect = "16:9") {
    setBusy(true); setError(null);
    try {
      const r = await api.quickCreate(action, lk, ln, out, p ? p.id : null, m, a);
      setMade({ shot: r.shot_id, output: out });
      if (!p) api.series().then(setSeries).catch(() => {});      // the new Untitled project shows in "Add to"
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[s.wrap, narrow && { paddingTop: 28 }, afterBanner && { paddingTop: narrow ? 6 : 0, marginTop: narrow ? -28 : -64 }]}>
      <Text style={[s.h1, font.display, narrow && { fontSize: 30, lineHeight: 34 }]}>{tr("What are we making today?")}</Text>
      <Text style={s.lead}>{tr("Describe a shot. anlim makes the image or the clip; download it, or keep building it as a project.")}</Text>

      <FloatCard float style={[s.box, focus && { borderColor: c.accent }]}>
        <TextInput
          ref={input as never}
          style={[s.input, Platform.OS === "web" && ({ outlineStyle: "none" } as object)]}
          value={text}
          onChangeText={(t) => { setText(t); if (error) setError(null); }}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          placeholder={(effLook ? tr(IDEAS[effLook][0]) : tr("Describe a shot")) + "…"}
          placeholderTextColor={c.muted}
          multiline
          maxLength={2000}
          accessibilityLabel={tr("Describe your shot")}
          onKeyPress={(e) => {
            const n = e.nativeEvent as unknown as { key: string; metaKey?: boolean; ctrlKey?: boolean };
            if (n.key === "Enter" && (n.metaKey || n.ctrlKey)) go();
          }}
        />
        <View style={s.bar}>
          <View style={[s.row, { flex: 1 }]}>
            <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel={tr("Make")}>
              {(["image", "video"] as Output[]).map((o) => (
                <Pressable key={o} onPress={() => setOutput(o)} style={[s.segItem, output === o && s.segOn]}
                  accessibilityRole="radio" accessibilityState={{ checked: output === o }}>
                  <Text style={{ color: output === o ? c.onAccent : c.ink, fontSize: 13, fontWeight: "600" }}>{o === "image" ? tr("Image") : tr("Video")}</Text>
                </Pressable>
              ))}
            </View>
            <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel={tr("Look")}>
              {(["cartoon", "photoreal"] as Look[]).map((l) => {
                const on = effLook === l, locked = !!picked;
                return (
                  <Pressable key={l} disabled={locked} onPress={() => setLook(l)} style={[s.segItem, on && s.segOn, locked && !on && { opacity: 0.4 }]}
                    accessibilityRole="radio" accessibilityState={{ checked: on, disabled: locked }}>
                    <Text style={{ color: on ? c.onAccent : c.ink, fontSize: 13, fontWeight: "600" }}>{l === "cartoon" ? tr("Cartoon") : tr("Photoreal")}</Text>
                  </Pressable>
                );
              })}
            </View>
            {output === "video" && <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel={tr("Clip length")}>
              {LENGTHS.map((n) => (
                <Pressable key={n} onPress={() => setLen(n)} style={[s.segItem, len === n && s.segOn]} accessibilityRole="radio" accessibilityState={{ checked: len === n }}>
                  <Text style={[{ color: len === n ? c.onAccent : c.ink, fontSize: 12 }, font.mono]}>{n} S</Text>
                </Pressable>
              ))}
            </View>}
          </View>
          <Pressable onPress={go} disabled={!ready} style={[s.send, !ready && { opacity: 0.35 }]} accessibilityRole="button"
            accessibilityLabel={guest ? tr("Create an account and make this {output}", { output }) : tr("Make this {output}", { output })}>
            <Text style={{ color: c.onAccent, fontSize: 20, fontWeight: "800", lineHeight: 22 }}>{busy ? "…" : "↑"}</Text>
          </Pressable>
        </View>
      </FloatCard>

      <View style={[s.row, { marginTop: 12, justifyContent: "center" }]} accessibilityRole="radiogroup" accessibilityLabel={tr("Shape")}>
        <Text style={[s.small, font.mono]}>{tr("SHAPE")}</Text>
        {ASPECTS.map((a) => {
          const on = effAspect === a.id, locked = !!picked;
          return (
            <Pressable key={a.id} disabled={locked} onPress={() => setAspect(a.id)} style={[s.chip, on && s.chipOn, locked && !on && { opacity: 0.4 }]}
              accessibilityRole="radio" accessibilityState={{ checked: on, disabled: locked }} accessibilityLabel={`${a.label}, ${a.hint}`}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Shape ratio={a.id} on={on} />
                <Text style={[{ color: on ? c.ink : c.sub, fontSize: 12 }, font.mono]}>{a.label}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      <Text style={[s.small, { textAlign: "center", marginTop: 4 }]}>
        {picked ? tr("{name} is {effAspect}; change it in the project's settings.", { name: picked.name, effAspect }) : ASPECTS.find((a) => a.id === effAspect)?.hint}
      </Text>

      {output === "video" && !guest && fits.length > 0 && (
        <View style={[s.row, { marginTop: 12, justifyContent: "center" }]} accessibilityRole="radiogroup" accessibilityLabel={tr("Video model")}>
          <Text style={[s.small, font.mono]}>{tr("MODEL")}</Text>
          {[{ id: null as string | null, label: tr("Auto"), credits_per_second: CLIP_CREDITS_PER_S }, ...fits].map((m) => {
            const on = model === m.id, locked = m.id !== null && !paid;
            return (
              <Pressable key={m.id ?? "auto"} disabled={locked} onPress={() => setModel(m.id)} style={[s.chip, on && s.chipOn, locked && { opacity: 0.4 }]}
                accessibilityRole="radio" accessibilityState={{ checked: on, disabled: locked }}>
                <Text style={{ color: on ? c.ink : c.sub, fontSize: 12 }} numberOfLines={1}>
                  {m.id === null ? tr("Auto") : tr("{v0} · {v1} cr", { v0: m.label ?? m.id, v1: m.credits_per_second * len })}
                </Text>
              </Pressable>
            );
          })}
          {!paid && <Text style={s.small}>{tr("Picking a model comes with a paid account.")}</Text>}
        </View>
      )}
      {/* 2026-11-20 (Londi): say what the chosen model is good at, from our own tests */}
      {output === "video" && !guest && fits.length > 0 && (() => {
        const n = model ? MODEL_NOTES[model] : autoNote(tr("Kling 4.0"));
        if (!n) return null;
        return (
          <View style={{ marginTop: 8, alignSelf: "center", maxWidth: 560, paddingHorizontal: 8 }}>
            <Text style={{ color: c.sub, fontSize: 13, lineHeight: 19, textAlign: "center" }}>
              {n.best}{n.watch ? <Text style={{ color: c.muted }}> {n.watch}</Text> : null}
            </Text>
          </View>
        );
      })()}

      {series.length > 0 && (
        <View style={[s.row, { marginTop: 12, justifyContent: "center" }]}>
          <Text style={[s.small, font.mono]}>{tr("ADD TO")}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ flexGrow: 0, maxWidth: "100%" }}>
            {[{ id: null as string | null, name: tr("New project") }, ...series.map((x) => ({ id: x.id as string | null, name: x.name }))].map((o) => (
              <Pressable key={o.id ?? "new"} onPress={() => setTarget(o.id)} style={[s.chip, target === o.id && s.chipOn]}
                accessibilityRole="radio" accessibilityState={{ checked: target === o.id }}>
                <Text style={{ color: target === o.id ? c.ink : c.sub, fontSize: 12 }} numberOfLines={1}>{o.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {!effLook && text.trim().length >= 8 && <Text style={{ color: c.link, marginTop: 12, textAlign: "center" }}>{tr("Choose Cartoon or Photoreal for the new project.")}</Text>}
      {busy && <Text style={{ color: c.link, marginTop: 12, textAlign: "center" }}>{tr("Starting…")}</Text>}
      {error && <Text style={{ color: c.fail, marginTop: 12, textAlign: "center" }}>{tMsg(error)}</Text>}

      {made && <CreationCard key={made.shot} shotId={made.shot} output={made.output} onAgain={() => { setMade(null); setText(""); input.current?.focus(); }} />}

      {!made && <View style={[s.row, { marginTop: 18, justifyContent: "center" }]}>
        {(effLook ? IDEAS[effLook].map((t) => ({ t, l: effLook })) : MIXED).slice(narrow ? 2 : 0).map(({ t: ideaEn, l }) => { const idea = tr(ideaEn); return (
          <Pressable key={idea} style={s.idea} onPress={() => { setText(idea); if (!effLook) setLook(l); input.current?.focus(); }} accessibilityRole="button"
            accessibilityLabel={tr("Use idea: {idea}", { idea })}>
            <Text style={{ color: c.sub, fontSize: 13 }} numberOfLines={1}>{idea}</Text>
          </Pressable>
        ); })}
      </View>}
      <Text style={[s.small, { textAlign: "center", marginTop: 14 }]}>
        {output === "image" ? tr("An image uses 20 credits.") : picked && picked.has_cast ? tr("A {len} s video uses about {v1} credits: 20 for a start image of your cast, the rest for the clip. If a clip is unusable, request a refund and tell us why.", { len, v1: 20 + perS * len })
          : tr("A {len} s video uses about {v1} credits, made straight from your words. If a clip is unusable, request a refund and tell us why.", { len, v1: perS * len })}
        {guest ? tr(" Press the arrow and create a free account to see it; new accounts get free starter credits.") : picked ? tr(" It is added to {name}.", { name: picked.name }) : tr(" It is saved in a new Untitled project in your Workspace.")}
      </Text>
    </View>
  );
}

// a small outline of the shape, so 9:16 and 16:9 read at a glance
function Shape({ ratio, on }: { ratio: Aspect; on: boolean }) {
  const [w, h] = ratio.split(":").map(Number);
  const k = 14 / Math.max(w, h);
  return <View style={{ width: Math.round(w * k), height: Math.round(h * k), borderWidth: 1.5, borderRadius: 2, borderColor: on ? c.accent : c.muted }} />;
}

const s = StyleSheet.create({
  wrap: { width: "100%", maxWidth: 860, alignSelf: "center", paddingTop: 56, paddingBottom: 8 },
  h1: { color: c.ink, fontSize: 46, lineHeight: 50, textAlign: "center" },
  lead: { color: c.sub, fontSize: 16, lineHeight: 24, textAlign: "center", marginTop: 12, marginBottom: 26, maxWidth: 620, alignSelf: "center" },
  box: { borderWidth: 1, borderColor: "transparent", borderRadius: 24, padding: 18 },   // the surface is FloatCard's
  input: { color: c.ink, fontSize: 17, lineHeight: 25, minHeight: 96, maxHeight: 260, textAlignVertical: "top", padding: 4 },
  bar: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  seg: { flexDirection: "row", backgroundColor: c.field, borderWidth: 1, borderColor: c.line, borderRadius: 999, padding: 3 },
  segItem: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  segOn: { backgroundColor: c.accent },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.accent, alignItems: "center", justifyContent: "center" },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 220 },
  chipOn: { borderColor: c.accent, backgroundColor: "#2A1608" },
  idea: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "100%" },
  small: { color: c.muted, fontSize: 12 },
});

// Home composer (2026-11-19, Londi: "the homepage should be similar to what all other tools show... 'What are we
// working on today?' with a prompt window"). 2026-11-20: the prompt makes an image, or an image and a short clip
// (studio.quick_create), in a new "Untitled project" or the project the creator picks; the result shows here with
// download and "start a project from this" (CreationCard). Not every creator is working on a project. @anlim
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { FloatCard } from "./FloatCard";
import { router } from "expo-router";
import { api, Look, Output, PromptModel, Series } from "../lib/api";
import { autoNote, MODEL_NOTES } from "../lib/modelNotes";
import { CreationCard } from "./CreationCard";
import { c, font } from "../lib/theme";
import { clearDraft, peekDraft, saveDraft } from "../lib/draft";

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
const LENGTHS = [5, 10];
const CLIP_CREDITS_PER_S = 40;   // Kling 4.0, Auto's pick (studio.models); the server checks the real price

export function Composer({ narrow, guest = false, afterBanner = false }: { narrow: boolean; guest?: boolean; afterBanner?: boolean }) {
  const [text, setText] = useState("");
  const [look, setLook] = useState<Look>("cartoon");
  const [len, setLen] = useState(5);
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
    setText(d.text); setLook(d.look); setLen(d.len); setOutput(d.output ?? "video");
    make(d.text, d.look, d.len, d.output ?? "video", null);
  }, [guest]);   // eslint-disable-line react-hooks/exhaustive-deps
  const picked = useMemo(() => series.find((x) => x.id === target) ?? null, [series, target]);
  // adding to an existing project uses that project's look; the toggle is for new projects
  const effLook: Look = picked ? picked.look : look;
  const ready = text.trim().length >= 8 && !busy;
  // models that can make this video: the look and the length must fit
  const fits = useMemo(() => models.filter((m) => (!m.looks || m.looks.includes(effLook)) && len >= m.min_duration_s && len <= m.max_duration_s),
    [models, effLook, len]);
  useEffect(() => { if (model && !fits.some((m) => m.id === model)) setModel(null); }, [fits, model]);
  const chosen = models.find((m) => m.id === model) ?? null;
  const perS = chosen?.credits_per_second ?? CLIP_CREDITS_PER_S;

  async function go() {
    if (!ready) return;
    if (guest) {
      // visitors: keep the prompt, ask for an account; the shot is made as soon as they are signed in
      saveDraft({ text: text.trim(), look, len, output });
      router.navigate({ pathname: "/login", params: { mode: "signup" } });
      return;
    }
    await make(text.trim(), look, len, output, picked, output === "video" ? model : null);
  }

  async function make(action: string, lk: Look, ln: number, out: Output, p: Series | null, m: string | null = null) {
    setBusy(true); setError(null);
    try {
      const r = await api.quickCreate(action, lk, ln, out, p ? p.id : null, m);
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
      <Text style={[s.h1, font.display, narrow && { fontSize: 30, lineHeight: 34 }]}>What are we making today?</Text>
      <Text style={s.lead}>Describe a shot. anlim makes the image or the clip; download it, or keep building it as a project.</Text>

      <FloatCard float style={[s.box, focus && { borderColor: c.accent }]}>
        <TextInput
          ref={input as never}
          style={[s.input, Platform.OS === "web" && ({ outlineStyle: "none" } as object)]}
          value={text}
          onChangeText={(t) => { setText(t); if (error) setError(null); }}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          placeholder={IDEAS[effLook][0] + "…"}
          placeholderTextColor={c.muted}
          multiline
          maxLength={2000}
          accessibilityLabel="Describe your shot"
          onKeyPress={(e) => {
            const n = e.nativeEvent as unknown as { key: string; metaKey?: boolean; ctrlKey?: boolean };
            if (n.key === "Enter" && (n.metaKey || n.ctrlKey)) go();
          }}
        />
        <View style={s.bar}>
          <View style={[s.row, { flex: 1 }]}>
            <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel="Make">
              {(["image", "video"] as Output[]).map((o) => (
                <Pressable key={o} onPress={() => setOutput(o)} style={[s.segItem, output === o && s.segOn]}
                  accessibilityRole="radio" accessibilityState={{ checked: output === o }}>
                  <Text style={{ color: output === o ? c.onAccent : c.ink, fontSize: 13, fontWeight: "600" }}>{o === "image" ? "Image" : "Video"}</Text>
                </Pressable>
              ))}
            </View>
            <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel="Look">
              {(["cartoon", "photoreal"] as Look[]).map((l) => {
                const on = effLook === l, locked = !!picked;
                return (
                  <Pressable key={l} disabled={locked} onPress={() => setLook(l)} style={[s.segItem, on && s.segOn, locked && !on && { opacity: 0.4 }]}
                    accessibilityRole="radio" accessibilityState={{ checked: on, disabled: locked }}>
                    <Text style={{ color: on ? c.onAccent : c.ink, fontSize: 13, fontWeight: "600" }}>{l === "cartoon" ? "Cartoon" : "Photoreal"}</Text>
                  </Pressable>
                );
              })}
            </View>
            {output === "video" && <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel="Clip length">
              {LENGTHS.map((n) => (
                <Pressable key={n} onPress={() => setLen(n)} style={[s.segItem, len === n && s.segOn]} accessibilityRole="radio" accessibilityState={{ checked: len === n }}>
                  <Text style={[{ color: len === n ? c.onAccent : c.ink, fontSize: 12 }, font.mono]}>{n} S</Text>
                </Pressable>
              ))}
            </View>}
          </View>
          <Pressable onPress={go} disabled={!ready} style={[s.send, !ready && { opacity: 0.35 }]} accessibilityRole="button"
            accessibilityLabel={guest ? `Create an account and make this ${output}` : `Make this ${output}`}>
            <Text style={{ color: c.onAccent, fontSize: 20, fontWeight: "800", lineHeight: 22 }}>{busy ? "…" : "↑"}</Text>
          </Pressable>
        </View>
      </FloatCard>

      {output === "video" && !guest && fits.length > 0 && (
        <View style={[s.row, { marginTop: 12, justifyContent: "center" }]} accessibilityRole="radiogroup" accessibilityLabel="Video model">
          <Text style={[s.small, font.mono]}>MODEL</Text>
          {[{ id: null as string | null, label: "Auto", credits_per_second: CLIP_CREDITS_PER_S }, ...fits].map((m) => {
            const on = model === m.id, locked = m.id !== null && !paid;
            return (
              <Pressable key={m.id ?? "auto"} disabled={locked} onPress={() => setModel(m.id)} style={[s.chip, on && s.chipOn, locked && { opacity: 0.4 }]}
                accessibilityRole="radio" accessibilityState={{ checked: on, disabled: locked }}>
                <Text style={{ color: on ? c.ink : c.sub, fontSize: 12 }} numberOfLines={1}>
                  {m.id === null ? "Auto" : `${m.label ?? m.id} · ${m.credits_per_second * len} cr`}
                </Text>
              </Pressable>
            );
          })}
          {!paid && <Text style={s.small}>Picking a model comes with a paid account.</Text>}
        </View>
      )}
      {/* 2026-11-20 (Londi): say what the chosen model is good at, from our own tests */}
      {output === "video" && !guest && fits.length > 0 && (() => {
        const n = model ? MODEL_NOTES[model] : autoNote("Kling 4.0");
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
          <Text style={[s.small, font.mono]}>ADD TO</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ flexGrow: 0, maxWidth: "100%" }}>
            {[{ id: null as string | null, name: "New project" }, ...series.map((x) => ({ id: x.id as string | null, name: x.name }))].map((o) => (
              <Pressable key={o.id ?? "new"} onPress={() => setTarget(o.id)} style={[s.chip, target === o.id && s.chipOn]}
                accessibilityRole="radio" accessibilityState={{ checked: target === o.id }}>
                <Text style={{ color: target === o.id ? c.ink : c.sub, fontSize: 12 }} numberOfLines={1}>{o.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {busy && <Text style={{ color: c.link, marginTop: 12, textAlign: "center" }}>Starting…</Text>}
      {error && <Text style={{ color: c.fail, marginTop: 12, textAlign: "center" }}>{error}</Text>}

      {made && <CreationCard key={made.shot} shotId={made.shot} output={made.output} onAgain={() => { setMade(null); setText(""); input.current?.focus(); }} />}

      {!made && <View style={[s.row, { marginTop: 18, justifyContent: "center" }]}>
        {IDEAS[effLook].slice(narrow ? 2 : 0).map((idea) => (
          <Pressable key={idea} style={s.idea} onPress={() => { setText(idea); input.current?.focus(); }} accessibilityRole="button"
            accessibilityLabel={`Use idea: ${idea}`}>
            <Text style={{ color: c.sub, fontSize: 13 }} numberOfLines={1}>{idea}</Text>
          </Pressable>
        ))}
      </View>}
      <Text style={[s.small, { textAlign: "center", marginTop: 14 }]}>
        {output === "image" ? "An image uses 20 credits." : picked && picked.has_cast ? `A ${len} s video uses about ${20 + perS * len} credits: 20 for a start image of your cast, the rest for the clip. If a clip is unusable, request a refund and tell us why.`
          : `A ${len} s video uses about ${perS * len} credits, made straight from your words. If a clip is unusable, request a refund and tell us why.`}
        {guest ? " Press the arrow and create a free account to see it; new accounts get free starter credits." : picked ? ` It is added to ${picked.name}.` : " It is saved in a new Untitled project in your Workspace."}
      </Text>
    </View>
  );
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

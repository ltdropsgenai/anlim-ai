// Home composer (2026-11-19, Londi: "the homepage should be similar to what all other tools show... 'What are we
// working on today?' with a prompt window"). The prompt becomes a real shot: in a new project (series + "Scene 1")
// or added to the latest scene of a project the creator picks; its start frame is drawn from the prompt right away
// (start-frame mode "prompt", 20 credits) and the Workspace opens on it. @anlim
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { api, Look, Series } from "../lib/api";
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

// "A small fox tiptoes across..." -> "A small fox tiptoes across a snowy" (series names stay short)
function nameFrom(prompt: string) {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  const n = words.length > 48 ? words.slice(0, 48).trim() : words;
  return n ? n[0].toUpperCase() + n.slice(1) : "Untitled project";
}

export function Composer({ narrow, guest = false }: { narrow: boolean; guest?: boolean }) {
  const [text, setText] = useState("");
  const [look, setLook] = useState<Look>("cartoon");
  const [len, setLen] = useState(5);
  const [series, setSeries] = useState<Series[]>([]);
  const [target, setTarget] = useState<string | null>(null);   // null = new project
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const input = useRef<{ focus: () => void } | null>(null);

  useEffect(() => { if (!guest) api.series().then(setSeries).catch(() => setSeries([])); }, [guest]);
  // a prompt typed before signing up: make it now, on the new account (once; the draft is cleared first)
  useEffect(() => {
    if (guest) return;
    const d = peekDraft();
    if (!d) return;
    clearDraft();
    setText(d.text); setLook(d.look); setLen(d.len);
    make(d.text, d.look, d.len, null);
  }, [guest]);   // eslint-disable-line react-hooks/exhaustive-deps
  const picked = useMemo(() => series.find((x) => x.id === target) ?? null, [series, target]);
  // adding to an existing project uses that project's look; the toggle is for new projects
  const effLook: Look = picked ? picked.look : look;
  const ready = text.trim().length >= 8 && !busy;

  async function go() {
    if (!ready) return;
    if (guest) {
      // visitors: keep the prompt, ask for an account; the shot is made as soon as they are signed in
      saveDraft({ text: text.trim(), look, len });
      router.navigate({ pathname: "/login", params: { mode: "signup" } });
      return;
    }
    await make(text.trim(), look, len, picked);
  }

  async function make(action: string, lk: Look, ln: number, p: Series | null) {
    setBusy(true); setError(null);
    try {
      let seriesId: string, sceneId: string;
      if (p) {
        seriesId = p.id;
        const last = [...p.scenes].sort((a, b) => b.ord - a.ord)[0];
        sceneId = last ? last.id : (await api.createScene(seriesId, "Scene 1")).id;
      } else {
        seriesId = (await api.createSeries(nameFrom(action), lk)).id;
        sceneId = (await api.createScene(seriesId, "Scene 1")).id;
      }
      const shot = await api.createShot(sceneId, action, ln);
      // draw the first frame right away (20 credits); if that is refused (e.g. not enough credits) the shot still
      // opens and the Workspace offers the same option
      try { await api.requestStartFrame(shot.id, "prompt"); } catch { /* shown in the Workspace */ }
      router.navigate({ pathname: "/workspace", params: { series: seriesId, scene: sceneId, shot: shot.id } });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <View style={[s.wrap, narrow && { paddingTop: 28 }]}>
      <Text style={[s.h1, font.display, narrow && { fontSize: 30, lineHeight: 34 }]}>What are we making today?</Text>
      <Text style={s.lead}>Describe a shot. anlim draws its first frame and opens it in your Workspace, ready to animate.</Text>

      <View style={[s.box, focus && { borderColor: c.accent }]}>
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
            <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel="Shot length">
              {LENGTHS.map((n) => (
                <Pressable key={n} onPress={() => setLen(n)} style={[s.segItem, len === n && s.segOn]} accessibilityRole="radio" accessibilityState={{ checked: len === n }}>
                  <Text style={[{ color: len === n ? c.onAccent : c.ink, fontSize: 12 }, font.mono]}>{n} S</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Pressable onPress={go} disabled={!ready} style={[s.send, !ready && { opacity: 0.35 }]} accessibilityRole="button"
            accessibilityLabel={guest ? "Create an account and make this shot" : "Create this shot"}>
            <Text style={{ color: c.onAccent, fontSize: 20, fontWeight: "800", lineHeight: 22 }}>{busy ? "…" : "↑"}</Text>
          </Pressable>
        </View>
      </View>

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

      {busy && <Text style={{ color: c.link, marginTop: 12, textAlign: "center" }}>Setting up your shot and starting its first frame…</Text>}
      {error && <Text style={{ color: c.fail, marginTop: 12, textAlign: "center" }}>{error}</Text>}

      <View style={[s.row, { marginTop: 18, justifyContent: "center" }]}>
        {IDEAS[effLook].slice(narrow ? 2 : 0).map((idea) => (
          <Pressable key={idea} style={s.idea} onPress={() => { setText(idea); input.current?.focus(); }} accessibilityRole="button"
            accessibilityLabel={`Use idea: ${idea}`}>
            <Text style={{ color: c.sub, fontSize: 13 }} numberOfLines={1}>{idea}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[s.small, { textAlign: "center", marginTop: 14 }]}>
        {guest ? "Press the arrow and create a free account to see your first frame. New accounts get free starter credits; the first frame uses 20."
          : "The first frame uses 20 credits. Rendering the clip is a separate step, priced before you start."}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: "100%", maxWidth: 860, alignSelf: "center", paddingTop: 56, paddingBottom: 8 },
  h1: { color: c.ink, fontSize: 46, lineHeight: 50, textAlign: "center" },
  lead: { color: c.sub, fontSize: 16, lineHeight: 24, textAlign: "center", marginTop: 12, marginBottom: 26, maxWidth: 620, alignSelf: "center" },
  box: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 24, padding: 18 },
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

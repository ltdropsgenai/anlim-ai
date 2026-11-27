// A kept shot's effects in the scene cut (2026-11-27, Londi: "I want to build the same effects and more cinematic
// production effects into anlim.ai", then "Let's start with Tier1 and 2"). The worker makes them (worker/src/fx.js):
// plain ffmpeg and a person cut-out found on the CPU, free like every cut. Saved with studio.set_shot_fx. @anlim
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { api, ShotFx, ShotRow } from "../lib/api";
import { c } from "../lib/theme";
import { tr } from "../lib/i18n";

const LOOKS: [ShotFx["look"] | null, string][] = [[null, "None"], ["moody", "Moody"], ["bw", "Black and white"], ["warm", "Warm"], ["cool", "Cool"],
  ["teal_orange", "Teal and orange"], ["vivid", "Vivid"]];
const COLORS = ["yellow", "white", "red", "green", "blue"] as const;
const SWATCH: Record<string, string> = { yellow: "#FFD600", white: "#FFFFFF", red: "#EB2626", green: "#3CDC5A", blue: "#3CA0FF" };
const STICKERS: [NonNullable<ShotFx["stickers"]>[number]["kind"], string][] = [["pow", "POW!"], ["boom", "BOOM!"], ["wow", "WOW!"], ["zap", "ZAP!"],
  ["arrow", "Arrow"], ["circle", "Circle"], ["star", "Star"]];
// nine places in the picture for a sticker
const SPOTS: [number, number][] = [[0.2, 0.2], [0.5, 0.2], [0.8, 0.2], [0.2, 0.5], [0.5, 0.5], [0.8, 0.5], [0.2, 0.8], [0.5, 0.8], [0.8, 0.8]];
type Mode = "none" | "phone" | "pip" | "split" | "compare";

const num = (v: string, d: number) => { const n = Number(v); return v.trim() !== "" && Number.isFinite(n) ? n : d; };

export function ShotEffects({ row, others, onSaved }: { row: ShotRow; others: ShotRow[]; onSaved: () => void }) {
  const [fx, setFx] = useState<ShotFx>(() => row.fx ?? {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const saved = JSON.stringify(row.fx ?? {});
  useEffect(() => { setFx(row.fx ?? {}); }, [row.id, saved]);   // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(fx) !== saved;
  const set = (p: Partial<ShotFx>) => setFx((x) => {
    const o: ShotFx = { ...x, ...p };
    (Object.keys(o) as (keyof ShotFx)[]).forEach((k) => { if (o[k] === undefined || o[k] === null) delete o[k]; });
    return o;
  });
  const mode: Mode = fx.frame ? "phone" : fx.layout?.kind ?? "none";
  function setMode(m: Mode) {
    if (m === "none") set({ frame: undefined, layout: undefined });
    else if (m === "phone") set({ layout: undefined, frame: fx.frame ?? { kind: "phone", bg: "blur", views: null, pop_out: false } });
    else set({ frame: undefined, layout: { kind: m, with_shot: fx.layout?.with_shot ?? others[0]?.id ?? "", labels: fx.layout?.labels ?? [] } });
  }

  const problems: string[] = [];
  if (fx.title && !fx.title.text.trim()) problems.push(tr("The title needs its words."));
  if (fx.behind && !fx.behind.text.trim()) problems.push(tr("The words behind the person need their text."));
  if (fx.layout && !fx.layout.with_shot) problems.push(tr("Pick the other shot for the layout."));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api.shotCutEdit(row.id, { fx });
      setMsg({ ok: true, text: tr("Saved. The next cut uses it.") }); onSaved();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  }

  const chip = (on: boolean, label: string, onPress: () => void, key?: string) => (
    <Pressable key={key ?? label} onPress={onPress} style={[s.chip, on && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
      <Text style={{ color: on ? c.onAccent : c.ink, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  const toggle = (on: boolean, label: string, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} style={[s.chip, on && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <Text style={{ color: on ? c.onAccent : c.ink, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  const colors = (cur: string, pick: (v: typeof COLORS[number]) => void) => COLORS.map((k) => (
    <Pressable key={k} onPress={() => pick(k)} accessibilityRole="radio" accessibilityState={{ checked: cur === k }} accessibilityLabel={tr(k)}
      style={[s.swatch, { backgroundColor: SWATCH[k] }, cur === k && { borderColor: c.accent, borderWidth: 3 }]} />
  ));

  return (
    <View style={s.box}>
      <Text style={s.h}>{tr("Effects")}</Text>

      <Text style={s.label}>{tr("Look")}</Text>
      <View style={s.row}>{LOOKS.map(([v, l]) => chip((fx.look ?? null) === v, tr(l), () => set({ look: v ?? undefined }), l))}</View>

      <Text style={s.label}>{tr("Title (big words that pop in)")}</Text>
      <View style={s.row}>
        <TextInput style={[s.text, { flex: 1 }]} value={fx.title?.text ?? ""} maxLength={40} placeholder={tr("HYPER SPEED EFFECT")} placeholderTextColor={c.muted}
          onChangeText={(v) => set({ title: v ? { ...(fx.title ?? { at_s: 0, dur_s: 2.2, color: "yellow", y: 0.35 }), text: v.replace(/[\r\n\t]/g, " ") } : undefined })} />
        {fx.title && <>
          <Text style={s.sub}>{tr("at")}</Text>
          <TextInput style={s.num} defaultValue={String(fx.title.at_s ?? 0)} keyboardType="decimal-pad"
            onChangeText={(v) => set({ title: { ...fx.title!, at_s: num(v, 0) } })} />
          <Text style={s.sub}>{tr("s, for")}</Text>
          <TextInput style={s.num} defaultValue={String(fx.title.dur_s ?? 2.2)} keyboardType="decimal-pad"
            onChangeText={(v) => set({ title: { ...fx.title!, dur_s: num(v, 2.2) } })} />
          <Text style={s.sub}>s</Text>
          {colors(fx.title.color ?? "yellow", (k) => set({ title: { ...fx.title!, color: k } }))}
        </>}
      </View>

      <Text style={s.label}>{tr("Stickers ({v0}/6)", { v0: fx.stickers?.length ?? 0 })}</Text>
      {(fx.stickers ?? []).map((st, i) => (
        <View key={i} style={s.item}>
          <Text style={{ color: c.ink, fontWeight: "700" }}>{STICKERS.find((x) => x[0] === st.kind)?.[1]}</Text>
          <Text style={s.sub}>{tr("at")}</Text>
          <TextInput style={s.num} defaultValue={String(st.at_s ?? 0)} keyboardType="decimal-pad"
            onChangeText={(v) => set({ stickers: fx.stickers!.map((o, k) => k === i ? { ...o, at_s: num(v, 0) } : o) })} />
          <Text style={s.sub}>s</Text>
          <View style={s.spots}>
            {SPOTS.map(([x, y], k) => (
              <Pressable key={k} onPress={() => set({ stickers: fx.stickers!.map((o, q) => q === i ? { ...o, x, y } : o) })}
                accessibilityRole="radio" accessibilityState={{ checked: st.x === x && st.y === y }} accessibilityLabel={tr("Place {v0}", { v0: k + 1 })}
                style={[s.spot, st.x === x && st.y === y && { backgroundColor: c.accent }]} />
            ))}
          </View>
          <Pressable onPress={() => set({ stickers: fx.stickers!.filter((_, k) => k !== i).length ? fx.stickers!.filter((_, k) => k !== i) : undefined })} accessibilityRole="button">
            <Text style={s.link}>{tr("Remove")}</Text>
          </Pressable>
        </View>
      ))}
      {(fx.stickers?.length ?? 0) < 6 && <View style={s.row}>
        {STICKERS.map(([k, l]) => (
          <Pressable key={k} style={s.ghost} accessibilityRole="button"
            onPress={() => set({ stickers: [...(fx.stickers ?? []), { kind: k, at_s: 0, dur_s: 1.5, x: 0.8, y: 0.2, size: 1 }] })}>
            <Text style={{ color: c.ink, fontSize: 13 }}>+ {k === "arrow" || k === "circle" || k === "star" ? tr(l) : l}</Text>
          </Pressable>
        ))}
      </View>}

      <Text style={s.label}>{tr("Frame")}</Text>
      <View style={s.row}>
        {chip(mode === "none", tr("Full picture"), () => setMode("none"))}
        {chip(mode === "phone", tr("On a phone"), () => setMode("phone"))}
        {others.length > 0 && <>
          {chip(mode === "pip", tr("Another shot in a box"), () => setMode("pip"))}
          {chip(mode === "split", tr("Split with another shot"), () => setMode("split"))}
          {chip(mode === "compare", tr("Compare with labels"), () => setMode("compare"))}
        </>}
      </View>
      {fx.frame && <View style={s.row}>
        <Text style={s.sub}>{tr("Views")}</Text>
        <TextInput style={s.num} value={fx.frame.views ?? ""} maxLength={10} placeholder="754K" placeholderTextColor={c.muted}
          onChangeText={(v) => set({ frame: { ...fx.frame!, views: v.replace(/[\r\n\t]/g, "") || null } })} />
        {(["blur", "dark", "grid"] as const).map((b) => chip((fx.frame!.bg ?? "blur") === b, tr({ blur: "Blurred behind", dark: "Dark", grid: "Grid" }[b]),
          () => set({ frame: { ...fx.frame!, bg: b } }), b))}
        {toggle(!!fx.frame.pop_out, tr("Steps out of the phone"), () => set({ frame: { ...fx.frame!, pop_out: !fx.frame!.pop_out } }))}
      </View>}
      {fx.layout && <View style={s.row}>
        <Text style={s.sub}>{tr("With shot")}</Text>
        {others.map((o) => chip(fx.layout!.with_shot === o.id, String(o.ord).padStart(2, "0"), () => set({ layout: { ...fx.layout!, with_shot: o.id } }), o.id))}
        {fx.layout.kind === "compare" && [0, 1].map((k) => (
          <TextInput key={k} style={s.text} maxLength={24} value={fx.layout!.labels?.[k] ?? ""} placeholderTextColor={c.muted}
            placeholder={k === 0 ? tr("Label on this shot") : tr("Label on the other")}
            onChangeText={(v) => { const l = [...(fx.layout!.labels ?? ["", ""])]; l[k] = v.replace(/[\r\n\t]/g, " "); set({ layout: { ...fx.layout!, labels: l } }); }} />
        ))}
      </View>}
      {others.length > 0 && <View style={s.row}>
        {toggle(!!fx.inset_only, tr("Only inside another shot's frame"), () => set({ inset_only: fx.inset_only ? undefined : true }))}
      </View>}

      <Text style={s.label}>{tr("Cut-out effects")}</Text>
      <Text style={s.hint}>{tr("The person is found in every frame and cut out. Best with a still camera and one person; the cut takes a little longer.")}</Text>
      <View style={s.row}>
        <TextInput style={[s.text, { flex: 1 }]} value={fx.behind?.text ?? ""} maxLength={20} placeholder={tr("Big words behind the person")} placeholderTextColor={c.muted}
          onChangeText={(v) => set({ behind: v ? { ...(fx.behind ?? { color: "white", y: 0.3 }), text: v.replace(/[\r\n\t]/g, " ") } : undefined })} />
        {fx.behind && colors(fx.behind.color ?? "white", (k) => set({ behind: { ...fx.behind!, color: k } }))}
      </View>
      <View style={s.row}>
        {toggle(!!fx.ghost, tr("Ghost"), () => set({ ghost: fx.ghost ? undefined : { copies: 2, delay_s: 0.5, opacity: 0.45 } }))}
        {toggle(!!fx.trails, tr("Speed trails"), () => set({ trails: fx.trails ? undefined : { copies: 5, gap: 2 } }))}
        {toggle(!!fx.clone, tr("Clone"), () => set({ clone: fx.clone ? undefined : { x: 0.3, delay_s: 0.4, mirror: true } }))}
        {fx.clone && <>
          {chip((fx.clone.x ?? 0.3) < 0, tr("to the left"), () => set({ clone: { ...fx.clone!, x: -Math.abs(fx.clone!.x ?? 0.3) } }), "cl")}
          {chip((fx.clone.x ?? 0.3) >= 0, tr("to the right"), () => set({ clone: { ...fx.clone!, x: Math.abs(fx.clone!.x ?? 0.3) } }), "cr")}
          {toggle(!!fx.clone.mirror, tr("Mirrored"), () => set({ clone: { ...fx.clone!, mirror: !fx.clone!.mirror } }))}
        </>}
      </View>

      {problems.map((p) => <Text key={p} style={s.err}>{p}</Text>)}
      <View style={s.row}>
        <Pressable style={[s.btn, (!dirty || busy || problems.length > 0) && { opacity: 0.5 }]} disabled={!dirty || busy || problems.length > 0}
          onPress={save} accessibilityRole="button">
          <Text style={s.btnText}>{busy ? tr("Saving…") : tr("Save the effects")}</Text>
        </Pressable>
        {dirty && !busy && <Pressable onPress={() => { setFx(row.fx ?? {}); setMsg(null); }} accessibilityRole="button"><Text style={s.link}>{tr("Undo changes")}</Text></Pressable>}
      </View>
      {msg && <Text style={msg.ok ? s.ok : s.err}>{msg.text}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  box: { borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10, gap: 6 },
  h: { color: c.ink, fontWeight: "700", fontSize: 14 },
  label: { color: c.sub, fontSize: 13, fontWeight: "600", marginTop: 6 },
  sub: { color: c.sub, fontSize: 13 },
  hint: { color: c.muted, fontSize: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  item: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 8 },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6, backgroundColor: c.field },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  swatch: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: c.line },
  spots: { width: 42, height: 42, flexDirection: "row", flexWrap: "wrap", gap: 2 },
  spot: { width: 12, height: 12, borderRadius: 2, borderWidth: 1, borderColor: c.line, backgroundColor: c.bg },
  num: { width: 60, borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, color: c.ink, backgroundColor: c.bg },
  text: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, color: c.ink, backgroundColor: c.bg, minWidth: 120 },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  btn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14 },
  btnText: { color: c.onAccent, fontWeight: "600" },
  link: { color: c.link, fontSize: 13 },
  err: { color: c.fail, fontSize: 13 },
  ok: { color: c.pass, fontSize: 13 },
});

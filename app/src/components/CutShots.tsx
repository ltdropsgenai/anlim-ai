// How each kept shot plays in the scene cut: speed, trims and words drawn over it (2026-11-23, Londi: the backlog's "app
// screen for placing words"; until now only the connector could set these). One card per kept shot. Words: type them,
// tap the picture to place the one that is selected, set when it appears. The worker draws them (assemble.js
// wordFilters: Montserrat Bold, falls and fades), so this preview shows the size and place, not the motion. @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { api, cutSeconds, ShotRow, ShotWord } from "../lib/api";
import { c } from "../lib/theme";
import { tr, tMsg } from "../lib/i18n";

const SPEEDS = [0.5, 0.75, 1, 1.5, 2];
const MAX_WORDS = 12;
// times are kept as the typed text (a number per keystroke turned "1." into 1, so 1.5 could not be typed; 2026-11-23 test)
// size: percent of the usual size, as typed (2026-11-25, Londi: emojis "at any size"); 100 = the usual 6% of the width
type DraftWord = Omit<ShotWord, "at_s" | "dur_s" | "size"> & { at: string; dur: string; size: string };
const SIZES = [[50, "S"], [100, "M"], [160, "L"], [250, "XL"], [400, "XXL"]] as const;
type Draft = { speed: number; trimStart: string; trimEnd: string; words: DraftWord[] };
const draftOf = (r: ShotRow): Draft => ({
  speed: Number(r.speed) || 1,
  trimStart: String(Number(r.trim_start_s) || 0), trimEnd: String(Number(r.trim_end_s) || 0),
  words: (r.words ?? []).map(({ at_s, dur_s, size, ...w }) => ({ ...w, at: String(at_s), dur: String(dur_s), size: String(Math.round((Number(size) || 1) * 100)) })),
});
const num = (v: string) => (v.trim() === "" ? 0 : Number(v));

export function CutShots({ sceneId, aspect, onChanged }: { sceneId: string; aspect: string; onChanged: () => void }) {
  const [shots, setShots] = useState<ShotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setShots((await api.shots()).filter((x) => x.scene_id === sceneId && x.has_approved_clip)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [sceneId]);
  useEffect(() => { load(); }, [load]);

  if (!shots) return error ? <Text style={s.err}>{tMsg(error)}</Text> : <ActivityIndicator style={{ alignSelf: "flex-start", marginVertical: 8 }} />;
  if (shots.length === 0) return <Text style={s.sub}>{tr("Keep a clip on a shot first; kept shots show up here.")}</Text>;
  const [aw, ah] = (aspect || "16:9").split(":").map(Number);
  return (
    <View style={{ gap: 12 }}>
      {shots.map((r) => <ShotCard key={r.id} row={r} ratio={aw / ah} onSaved={() => { load(); onChanged(); }} />)}
    </View>
  );
}

function ShotCard({ row, ratio, onSaved }: { row: ShotRow; ratio: number; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(row));
  const [sel, setSel] = useState<number | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Reset the draft only when this shot's saved values change (its own save), not whenever the list reloads: saving one
  // card reloads every row, and resetting on the new row object wiped unsaved edits on the other cards (review 2026-11-23).
  const saved = JSON.stringify(draftOf(row));
  useEffect(() => { setD(draftOf(row)); }, [row.id, saved]);   // eslint-disable-line react-hooks/exhaustive-deps

  const clipLen = Number(row.clip_s) || Number(row.duration_s) || 0;
  const previewRow = { ...row, speed: d.speed, trim_start_s: num(d.trimStart) || 0, trim_end_s: num(d.trimEnd) || 0 };
  const len = cutSeconds(previewRow);
  const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(row));
  const setWord = (i: number, w: Partial<DraftWord>) => setD((x) => ({ ...x, words: x.words.map((o, k) => (k === i ? { ...o, ...w } : o)) }));

  // the same checks the database makes (studio.set_shot_trim / set_shot_words), shown before saving
  const problems: string[] = [];
  const ts = num(d.trimStart), te = num(d.trimEnd);
  if (!isFinite(ts) || !isFinite(te) || ts < 0 || te < 0) problems.push(tr("Trims are seconds to cut off, 0 or more."));
  else if (ts + te > Math.max(clipLen - 1, 0)) problems.push(tr("The trims leave less than 1 second of this {v0} s clip.", { v0: clipLen.toFixed(1) }));
  d.words.forEach((w, i) => {
    const t = w.text.trim();
    if (!t || t.length > 40) problems.push(`Word ${i + 1}: 1 to 40 characters.`);
    const at = num(w.at), dur = num(w.dur);
    if (!(at >= 0) || at >= len) problems.push(tr("Word {v0}: it must appear between 0 and {v1} s (the shot's length in the cut).", { v0: i + 1, v1: len.toFixed(1) }));
    if (!(dur >= 1 && dur <= 6)) problems.push(`Word ${i + 1}: it stays 1 to 6 seconds.`);
    const sz = num(w.size);
    if (!(sz >= 25 && sz <= 800)) problems.push(tr("Word {v0}: its size is 25 to 800%.", { v0: i + 1 }));
  });

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api.shotCutEdit(row.id, { speed: d.speed, trim_start_s: ts, trim_end_s: te,
        words: d.words.map(({ at, dur, size, ...w }) => ({ ...w, text: w.text.trim(), at_s: num(at), dur_s: num(dur), size: Math.round(num(size)) / 100 })) });
      setMsg({ ok: true, text: tr("Saved. The next cut uses it.") }); onSaved();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  }
  function place(x: number, y: number) {
    if (sel === null || !box.w || !box.h || !isFinite(x) || !isFinite(y)) return;
    setWord(sel, { x: Math.min(1, Math.max(0, x / box.w)), y: Math.min(1, Math.max(0, y / box.h)) });
  }

  const W = ratio >= 1 ? 280 : 170;
  return (
    <View style={s.card}>
      <Text style={s.title}>{tr("Shot {v0} · {v1} s in the cut", { v0: String(row.ord).padStart(2, "0"), v1: len.toFixed(1) })}</Text>
      <View style={s.cols}>
        {/* the picture: tap to place the selected word; words show at their size and place */}
        <View style={{ width: W }}>
          {/* on the web the press event has no locationX (it was undefined, so the word stayed put and its place became NaN;
              2026-11-23 test): there offsetX/Y of the picture box are used */}
          <Pressable onPress={(e) => { const n = e.nativeEvent as unknown as { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number };
              place(n.locationX ?? n.offsetX ?? NaN, n.locationY ?? n.offsetY ?? NaN); }} disabled={sel === null}
            accessibilityRole="button" accessibilityLabel={sel === null ? tr("Shot picture") : tr("Place word {v0} here", { v0: sel + 1 })}
            onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
            style={[s.pic, { aspectRatio: ratio }, sel !== null && { borderColor: c.accent }]}>
            {row.thumb_url ? <Image source={{ uri: row.thumb_url }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
            {d.words.map((w, i) => {
              const size = Math.min(0.06 * box.w * Math.min(8, Math.max(0.25, num(w.size) / 100 || 1)), (0.9 * box.w) / Math.max(1, w.text.length * 0.66));
              return (
                // centred on (x, y) like the worker's drawtext (x - tw/2, y - th/2)
                <View key={i} pointerEvents="none" style={[s.marker, { width: box.w, left: w.x * box.w - box.w / 2, top: w.y * box.h - size * 0.6 }]}>
                  <Text numberOfLines={1} style={[s.wordText, { fontSize: Math.max(6, size) }, w.style === "fire" && s.fireText, sel === i && { color: c.accent }]}>
                    {w.text || "…"}
                  </Text>
                </View>
              );
            })}
          </Pressable>
          <Text style={s.hint}>{sel === null ? tr("Select a word below, then tap the picture to place it.") : tr("Tap the picture to place word {v0}.", { v0: sel + 1 })}</Text>
        </View>

        <View style={{ flex: 1, minWidth: 260, gap: 8 }}>
          <Text style={s.label}>{tr("Speed")}</Text>
          <View style={s.row}>
            {SPEEDS.map((v) => (
              <Pressable key={v} onPress={() => setD((x) => ({ ...x, speed: v }))} style={[s.chip, d.speed === v && s.chipOn]}
                accessibilityRole="radio" accessibilityState={{ checked: d.speed === v }}>
                <Text style={{ color: d.speed === v ? c.onAccent : c.ink }}>{v === 1 ? tr("Normal") : `${v}×`}</Text>
              </Pressable>
            ))}
          </View>
          {d.speed < 1 && <Text style={s.hint}>{tr("Slowed shots are rebuilt frame by frame, so the cut takes a few minutes longer.")}</Text>}

          <Text style={s.label}>{tr("Trim (seconds cut off; the clip is {v0} s)", { v0: clipLen.toFixed(1) })}</Text>
          <View style={s.row}>
            <Text style={s.sub}>{tr("From the start")}</Text>
            <TextInput style={s.num} value={d.trimStart} onChangeText={(v) => setD((x) => ({ ...x, trimStart: v }))} keyboardType="decimal-pad" />
            <Text style={s.sub}>{tr("From the end")}</Text>
            <TextInput style={s.num} value={d.trimEnd} onChangeText={(v) => setD((x) => ({ ...x, trimEnd: v }))} keyboardType="decimal-pad" />
          </View>

          <Text style={s.label}>{tr("Words over the shot ({length}/{MAX_WORDS})", { length: d.words.length, MAX_WORDS })}</Text>
          {d.words.map((w, i) => (
            <Pressable key={i} onPress={() => setSel(i)} style={[s.wordRow, sel === i && { borderColor: c.accent }]}
              accessibilityRole="button" accessibilityState={{ selected: sel === i }}>
              <TextInput style={[s.text, { flex: 1 }]} value={w.text} maxLength={40} placeholder={tr("WORD")}
                placeholderTextColor={c.muted} onFocus={() => setSel(i)}
                onChangeText={(v) => setWord(i, { text: v.replace(/[\r\n\t]/g, " ") })} />
              <Text style={s.sub}>{tr("at")}</Text>
              <TextInput style={s.num} value={w.at} keyboardType="decimal-pad" onFocus={() => setSel(i)}
                onChangeText={(v) => setWord(i, { at: v })} />
              <Text style={s.sub}>{tr("s, for")}</Text>
              <TextInput style={s.num} value={w.dur} keyboardType="decimal-pad" onFocus={() => setSel(i)}
                onChangeText={(v) => setWord(i, { dur: v })} />
              <Text style={s.sub}>s</Text>
              <View style={[s.row, { width: "100%", gap: 6 }]}>
                <Text style={s.sub}>{tr("size")}</Text>
                {SIZES.map(([v, label]) => (
                  <Pressable key={v} onPress={() => { setSel(i); setWord(i, { size: String(v) }); }} style={[s.chip, s.chipSm, num(w.size) === v && s.chipOn]}
                    accessibilityRole="radio" accessibilityState={{ checked: num(w.size) === v }} accessibilityLabel={`${label} ${v}%`}>
                    <Text style={{ color: num(w.size) === v ? c.onAccent : c.ink, fontSize: 12 }}>{label}</Text>
                  </Pressable>
                ))}
                {/* 2026-11-25 (Londi: "a fire text style"): plain or fire, per word */}
                <Pressable onPress={() => { setSel(i); setWord(i, { style: w.style === "fire" ? "plain" : "fire" }); }}
                  style={[s.chip, s.chipSm, w.style === "fire" && s.chipFire]} accessibilityRole="switch" accessibilityState={{ checked: w.style === "fire" }}>
                  <Text style={{ color: w.style === "fire" ? "#2A0A00" : c.ink, fontSize: 12, fontWeight: "700" }}>{tr("🔥 Fire")}</Text>
                </Pressable>
                <TextInput style={s.num} value={w.size} keyboardType="number-pad" onFocus={() => setSel(i)} accessibilityLabel={tr("Size in percent")}
                  onChangeText={(v) => setWord(i, { size: v.replace(/[^\d]/g, "").slice(0, 3) })} />
                <Text style={s.sub}>%</Text>
              </View>
              <Pressable onPress={() => { setD((x) => ({ ...x, words: x.words.filter((_, k) => k !== i) })); setSel(null); }}
                accessibilityRole="button" accessibilityLabel={tr("Remove word {v0}", { v0: i + 1 })}>
                <Text style={s.remove}>{tr("Remove")}</Text>
              </Pressable>
            </Pressable>
          ))}
          {d.words.length < MAX_WORDS && (
            <Pressable style={s.ghost} accessibilityRole="button" onPress={() => {
              const at = d.words.length ? Math.min(len - 0.5, (num(d.words[d.words.length - 1].at) || 0) + 1) : 0;
              setD((x) => ({ ...x, words: [...x.words, { text: "", at: String(Math.max(0, Number(at.toFixed(2)))), x: 0.5, y: 0.4, dur: "2.6", size: "100" }] }));
              setSel(d.words.length);
            }}>
              <Text style={{ color: c.ink }}>{tr("Add a word")}</Text>
            </Pressable>
          )}
          <Text style={s.hint}>{tr("A word appears at its time in the shot as it plays in the cut (after trims and speed), then falls and fades.")}{" "}
            {tr("Emojis work too, at any size (a word or a line too wide for the picture is drawn smaller to fit).")}</Text>

          {problems.map((p) => <Text key={p} style={s.err}>{p}</Text>)}
          <View style={s.row}>
            <Pressable style={[s.btn, (!dirty || busy || problems.length > 0) && { opacity: 0.5 }]} disabled={!dirty || busy || problems.length > 0}
              onPress={save} accessibilityRole="button">
              <Text style={s.btnText}>{busy ? tr("Saving…") : tr("Save this shot")}</Text>
            </Pressable>
            {dirty && !busy && <Pressable onPress={() => { setD(draftOf(row)); setSel(null); setMsg(null); }} accessibilityRole="button">
              <Text style={s.remove}>{tr("Undo changes")}</Text>
            </Pressable>}
          </View>
          {msg && <Text style={msg.ok ? s.ok : s.err}>{msg.text}</Text>}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: c.card2, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12, gap: 8 },
  title: { color: c.ink, fontWeight: "700", fontSize: 14 },
  cols: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  pic: { width: "100%", backgroundColor: c.bg, borderRadius: 8, overflow: "hidden", borderWidth: 2, borderColor: c.line },
  marker: { position: "absolute", alignItems: "center" },
  wordText: { color: "#FFF1D6", fontWeight: "800", textShadowColor: "rgba(0,0,0,0.8)", textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } },
  label: { color: c.sub, fontSize: 13, fontWeight: "600", marginTop: 4 },
  sub: { color: c.sub, fontSize: 13 },
  hint: { color: c.muted, fontSize: 12, marginTop: 4 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: c.field },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  chipSm: { paddingHorizontal: 9, paddingVertical: 4 },
  chipFire: { backgroundColor: "#FF8A1E", borderColor: "#FF8A1E" },
  fireText: { color: "#FFB23A", textShadowColor: "rgba(255,90,0,0.95)", textShadowRadius: 8, textShadowOffset: { width: 0, height: 0 } },
  num: { width: 60, borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, color: c.ink, backgroundColor: c.bg },
  text: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, color: c.ink, backgroundColor: c.bg, minWidth: 100 },
  wordRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center", borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 8 },
  remove: { color: c.link, fontSize: 13 },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, alignSelf: "flex-start" },
  btn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 },
  btnText: { color: c.onAccent, fontWeight: "600" },
  err: { color: c.fail, fontSize: 13 },
  ok: { color: c.pass, fontSize: 13 },
});

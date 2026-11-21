// Review one clip: play it, see the anlim check in plain words, jump to the moments to look at, keep or reject.
// 2026-11-19: direction D look, direction B wording. @anlim
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { api, Clip, Flag, KIND_NAMES, MODEL_NAMES } from "../../lib/api";
import { c, font, pageBg } from "../../lib/theme";
import { ClipPlayer, PlayerHandle } from "../../components/ClipPlayer";

const REASONS = ["Character looks wrong", "Extra or broken limbs", "Room or props changed", "Wrong action", "Motion looks bad", "Other"];

// The checker's rule names, in the words a creator would use (direction B).
const PLAIN: Record<string, string> = {
  "SET LAYOUT": "The room or furniture changed", "ANATOMY": "Hands or bodies look wrong", "CAMERA": "The camera moved",
  "SCREEN SIDE": "Characters swapped sides", "NATURAL POSES": "A pose looks unnatural", "BODY CONTACT": "Bodies pass into each other",
  "PROPS": "A prop looks wrong", "PROPS MOVED": "A prop moved on its own", "RELATIVE HEIGHT": "Someone's size changed",
  "HEIGHTS": "Someone's size changed", "MOUTHS": "A mouth moves oddly", "MOTION": "The movement looks wrong",
  "MOTION (VIDEO)": "The movement looks wrong", "NO MATERIALISING": "Something appeared or vanished", "WARDROBE": "Clothes changed",
  "IMAGE QUALITY": "Blurry or smeared", "IDENTITY": "A face changed", "FACE": "A face changed", "HEAD COUNT": "Wrong number of characters",
  "EVERY CREATURE": "A character went missing", "FEET THROUGH FURNITURE": "Feet go through furniture",
  "FOOT ON FURNITURE": "A foot lands on furniture", "FIXED DETAILS": "A fixed detail changed",
  "HELD OBJECTS FACE THE HOLDER": "A held object faces the wrong way", "REFLECTIONS AND SHADOWS": "A reflection or shadow is wrong",
  "EDITORIAL": "Something looks off",
};
// The checker's reasons, rule by rule (2026-11-19): "RULE: N frame(s) f12, f16" = it stood on those frames;
// "RULE: f20 REJECTED: ..." = a second look cleared that rule on that frame.
function parseReasons(reasons: string[] | null) {
  const standing: { rule: string; frames: string[] }[] = [];
  let cleared = 0;
  for (const line of reasons || []) {
    const m = line.match(/^([A-Z][A-Z ()]+?): (\d+) frame\(s\) (.*)$/);
    if (m) { standing.push({ rule: m[1], frames: m[3].match(/\bf\d+\b/g) ?? [] }); continue; }
    cleared += (line.match(/\bf\d+ REJECTED\b/g) ?? []).length;
  }
  return { standing, cleared };
}
const ruleWords = (r: string) => PLAIN[r] ?? r.charAt(0) + r.slice(1).toLowerCase();
const plain = (f: Flag) => (f.rules.length ? f.rules.map(ruleWords) : [f.verdict]).join(" · ");

export default function Review() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [clip, setClip] = useState<Clip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // refund request (2026-11-20): credits back at once; anlim reviews every request and may reverse it with a reason
  const [refundAt, setRefundAt] = useState("");
  const [refunded, setRefunded] = useState(false);
  const player = useRef<PlayerHandle>(null);

  useEffect(() => { api.clip(id).then(setClip).catch((e) => setError(e.message)); }, [id]);

  const why = useMemo(() => parseReasons(clip?.reasons ?? null), [clip]);
  // each frame's rules that still stand after the second look; frames with none are left out
  const standing = useMemo(() => (clip?.flags ?? []).filter((f) => f.t_s != null).map((f) => ({
    ...f, rules: why.standing.filter((g) => g.frames.includes(f.frame)).map((g) => g.rule),
  })).filter((f) => f.rules.length > 0), [clip, why]);
  const timeOf = useMemo(() => Object.fromEntries((clip?.flags ?? []).map((f) => [f.frame, f.t_s])), [clip]);

  // 2026-11-21 (Londi): Keep or Reject only. Reject opens a short form (what's wrong, when); sending it rejects the clip and
  // asks for a refund, which anlim reviews: the credits come back only if the problem is there to see.
  const [rejecting, setRejecting] = useState(false);
  async function decide(decision: "approve" | "reject") {
    setBusy(true); setError(null);
    try {
      const at = refundAt.trim() ? Number(refundAt.replace(",", ".").replace(/[^0-9.]/g, "")) : null;
      await api.decide(id, decision, picked, note, decision === "reject" && at != null && isFinite(at) ? at : null);
      setDone(decision); if (decision === "reject") setRefunded(true);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  if (error && !clip) return <Text style={[s.err, { padding: 16 }]}>{error}</Text>;
  if (!clip) return <ActivityIndicator style={{ marginTop: 40 }} />;

  const decidable = !done && !clip.decision && (clip.status === "review" || clip.status === "succeeded");
  const cost = clip.credits_reserved;
  const checkUsd = [clip.review_usd, clip.verify_usd, clip.action_usd, clip.passthrough_usd].reduce((a, b) => a + Number(b || 0), 0);

  const act = clip.action_check?.verdict;
  const actOk = act === "PASS" || act === "OK";
  const actBad = act === "FAIL" || act === "WRONG";
  const pt = clip.passthrough?.verdict;
  const ptBad = pt === "THROUGH" || pt === "CONTACT";
  // what the moments are about, grouped, so the report reads as a short list rather than frame codes
  const groups = why.standing.map((g) => [ruleWords(g.rule), g.frames.map((fr) => timeOf[fr]).filter((t): t is number => t != null)] as [string, number[]])
    .sort((x, y) => y[1].length - x[1].length);
  const verdict = clip.verdict === "PASS" ? { text: "✓ Passed every check", tone: "ok" as const }
    : clip.verdict === "FAIL" ? { text: "Didn't pass", tone: "bad" as const }
    : clip.verdict === "NOT_REVIEWED" ? { text: "! Check couldn't finish", tone: "call" as const }
    : { text: "! Your call", tone: "call" as const };
  const T = { ok: [c.passBg, c.pass, c.passLine], bad: [c.failBg, c.fail, c.failLine], call: [c.flagBg, c.flag, c.flagLine] }[verdict.tone];

  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={s.page}>
      <View style={s.grid}>
        <View style={s.main}>
          <Text style={[s.kicker, font.mono]}>
            {clip.series_name.toUpperCase()} · {clip.scene_title.toUpperCase()} · {(MODEL_NAMES[clip.model_id] ?? clip.model_id).toUpperCase()} · {clip.duration_s} S
          </Text>
          <Text style={[s.title, font.display]}>{clip.action}</Text>
          {clip.clip_url ? (
            <ClipPlayer ref={player} src={clip.clip_url} duration={clip.duration_s}
              markers={standing.map((f) => ({ t: f.t_s!, color: c.flag, label: plain(f) }))} />
          ) : <Text style={s.sub}>No clip file.</Text>}
          {clip.watermarked && (
            <Pressable onPress={() => router.push("/billing")} accessibilityRole="link">
              <Text style={s.wm}>Free clips carry an anlim.ai watermark. Buy credits or a plan and this clip, and every earlier one, plays without it.</Text>
            </Pressable>
          )}
          {standing.length > 0 && <Text style={s.legend}>Yellow marks are moments to look at. Click one to jump there.</Text>}

          <Text style={[s.h, font.display]}>Moments to look at</Text>
          {standing.length === 0 && <Text style={s.sub}>Nothing to look at{why.cleared ? ": everything flagged was cleared on a second look" : ""}.</Text>}
          {standing.map((f, i) => (
            <Pressable key={i} onPress={() => player.current?.seek(f.t_s!)} style={s.flag} accessibilityRole="button"
              accessibilityLabel={`Jump to ${f.t_s!.toFixed(1)} seconds: ${plain(f)}`}>
              <Text style={[s.time, font.mono]}>{f.t_s!.toFixed(2)} s</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.rules}>{plain(f)}</Text>
                {f.note ? <Text style={s.note}>{f.note}</Text> : null}
              </View>
              <Text style={s.jump}>Jump</Text>
            </Pressable>
          ))}
          {why.cleared > 0 && (
            <Text style={s.small}>{why.cleared} other possible problem{why.cleared === 1 ? " was" : "s were"} looked at a second time and cleared.</Text>
          )}
        </View>

        <View style={s.side}>
          <View style={s.panel}>
            <View style={[s.rowBetween, { marginBottom: 6 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View style={s.seal}><Text style={[{ color: c.accent, fontSize: 13 }, font.display]}>a.</Text></View>
                <View>
                  <Text style={[{ color: c.ink, fontSize: 15, textTransform: "uppercase", letterSpacing: 0.4 }, font.display]}>anlim check</Text>
                  <Text style={{ color: c.sub, fontSize: 12 }}>Every clip, before you pay</Text>
                </View>
              </View>
              <Text style={[s.chip, { backgroundColor: T[0], color: T[1], borderColor: T[2] }]}>{verdict.text}</Text>
            </View>
            {act && (
              <View style={s.item}>
                <Text style={[s.mark, { color: actOk ? c.pass : actBad ? c.fail : c.flag }]}>{actOk ? "✓" : "!"}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.itemTitle}>{actOk ? "Does what the shot says" : actBad ? "Doesn't do what the shot says" : "May not do exactly what the shot says"}</Text>
                  <Text style={s.itemText}>
                    {clip.action_check?.differs || clip.action_check?.why || ""}
                    {clip.action_check?.confidence ? `${clip.action_check?.differs || clip.action_check?.why ? " " : ""}${clip.action_check.confidence[0].toUpperCase()}${clip.action_check.confidence.slice(1)} confidence.` : ""}
                  </Text>
                </View>
              </View>
            )}
            {groups.map(([k, ts]) => (
              <View key={k} style={s.item}>
                <Text style={[s.mark, { color: c.flag }]}>!</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.itemTitle}>{k}</Text>
                  <Text style={s.itemText}>{ts.length} moment{ts.length === 1 ? "" : "s"}{ts.length ? `: ${ts.slice(0, 4).map((t) => `${t.toFixed(1)} s`).join(", ")}${ts.length > 4 ? "…" : ""}` : ""}</Text>
                </View>
                {ts.length > 0 && <Pressable onPress={() => player.current?.seek(ts[0])} style={s.smallBtn} accessibilityRole="button"><Text style={{ color: c.ink, fontSize: 12 }}>Jump</Text></Pressable>}
              </View>
            ))}
            {pt && pt !== "NOT CHECKED" && (
              <View style={s.item}>
                <Text style={[s.mark, { color: ptBad ? c.fail : c.pass }]}>{ptBad ? "!" : "✓"}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.itemTitle}>{ptBad ? (pt === "THROUGH" ? "Feet go through furniture" : "A foot lands on furniture") : "Nobody walks through furniture"}</Text>
                </View>
              </View>
            )}
            {!act && groups.length === 0 && (
              <View style={s.item}><Text style={[s.mark, { color: c.pass }]}>✓</Text>
                <Text style={[s.itemTitle, { flex: 1 }]}>Nothing to look at</Text></View>
            )}

            {done ? (
              <>
                <Text style={[s.decided, font.display]}>{done === "approve" ? "Kept" : "Rejected"}</Text>
                <Pressable style={s.ghost} onPress={() => router.navigate("/review")} accessibilityRole="link"><Text style={{ color: c.ink }}>Back to Review</Text></Pressable>
              </>
            ) : decidable ? (
              <>
                <Pressable style={[s.btn, { backgroundColor: c.accent }]} onPress={() => decide("approve")} disabled={busy} accessibilityRole="button">
                  <Text style={s.btnText}>Keep it</Text>
                </Pressable>
                {!rejecting ? (
                <Pressable style={s.ghost} onPress={() => setRejecting(true)} disabled={busy} accessibilityRole="button">
                  <Text style={{ color: c.ink, fontWeight: "600", fontSize: 15 }}>Reject</Text>
                </Pressable>
                ) : (<>
                <Text style={[s.kicker, font.mono, { marginTop: 14 }]}>WHAT'S WRONG WITH IT?</Text>
                <Text style={s.sub}>Pick what's wrong and say in a sentence what you see (and when, if you can). We look at every rejected
                  clip: if we can see the problem, the{clip.credits_reserved ? ` ${clip.credits_reserved}` : ""} credits come back to you and we tell you.</Text>
                <View style={s.chips}>
                  {REASONS.map((r) => (
                    <Pressable key={r} onPress={() => setPicked((p) => p.includes(r) ? p.filter((x) => x !== r) : [...p, r])}
                      style={[s.reason, picked.includes(r) && { backgroundColor: c.accent, borderColor: c.accent }]} accessibilityRole="checkbox"
                      accessibilityState={{ checked: picked.includes(r) }}>
                      <Text style={{ color: picked.includes(r) ? c.onAccent : c.ink, fontSize: 13 }}>{r}</Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput style={[s.input, { marginTop: 8 }]} placeholder="What's wrong, e.g. the fox's tail comes off its body" placeholderTextColor={c.muted}
                  value={note} onChangeText={setNote} multiline />
                <TextInput style={[s.input, { marginTop: 8, minHeight: 0 }]} placeholder="When (seconds, optional), e.g. 2.1" placeholderTextColor={c.muted}
                  value={refundAt} onChangeText={setRefundAt} keyboardType="decimal-pad" />
                <Pressable style={[s.ghost, (picked.length === 0 || note.trim().length < 15) && { opacity: 0.45 }]} onPress={() => decide("reject")}
                  disabled={busy || picked.length === 0 || note.trim().length < 15} accessibilityRole="button">
                  <Text style={{ color: c.ink, fontWeight: "600", fontSize: 15 }}>Reject and ask for a refund</Text>
                </Pressable>
                <Pressable onPress={() => setRejecting(false)} disabled={busy} accessibilityRole="button"><Text style={[s.small, { textDecorationLine: "underline" }]}>Cancel</Text></Pressable>
                </>)}
                {error && <Text style={s.err}>{error}</Text>}
                <Text style={s.small}>Every clip is charged when it is made, because the video model is paid for every render.</Text>
              </>
            ) : null}
            {refunded ? (
              <Text style={[s.sub, { marginTop: 14 }]}>Rejected. We'll look at the clip and let you know; if we can see the problem, the credits come back to you.</Text>
            ) : clip.refund ? (
              <Text style={[s.sub, { marginTop: 14 }]}>{clip.refund.status === "pending" ? "Refund requested: we're looking at it."
                : clip.refund.status === "upheld" ? "Refund approved: the credits are back in your account." : `Refund declined${clip.refund.decision_note ? `: ${clip.refund.decision_note}` : "."}`}</Text>
            ) : null}
            {!decidable && !done && clip.decision ? (
              <Text style={[s.decided, font.display]}>You {clip.decision === "approve" ? "kept" : "rejected"} this clip</Text>
            ) : !decidable && !done && !clip.refund && !refunded ? <Text style={s.sub}>This clip {clip.status === "failed" ? "didn't work" : `is ${clip.status}`}{clip.error ? `: ${clip.error}` : ""}.</Text> : null}
          </View>

          <View style={[s.panel, { marginTop: 14 }]}>
            <Text style={[s.kicker, font.mono]}>HOW IT WAS MADE</Text>
            <Text style={{ color: c.ink, fontSize: 14 }}>
              {MODEL_NAMES[clip.model_id] ?? clip.model_id}{clip.route_kind ? `, Auto's pick for ${KIND_NAMES[clip.route_kind] ?? clip.route_kind}` : ", chosen by you"}
            </Text>
            {clip.route_reason ? <Text style={[s.sub, { marginTop: 4 }]}>{clip.route_reason}</Text> : null}
            {clip.start_url && <Image source={{ uri: clip.start_url }} style={s.still} resizeMode="contain" accessibilityLabel="Approved start frame" />}
            <Pressable onPress={() => router.push({ pathname: "/shot/[id]", params: { id: clip.shot_id } })} accessibilityRole="link">
              <Text style={s.link}>Open the shot (end frame, render again)</Text>
            </Pressable>
            <Text style={s.small}>Check cost ${checkUsd.toFixed(3)}</Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 24, maxWidth: 1320, width: "100%", alignSelf: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 24 },
  main: { flexGrow: 3, flexShrink: 1, flexBasis: 600, minWidth: 0 }, side: { flexGrow: 1, flexShrink: 1, flexBasis: 320, minWidth: 0 },
  kicker: { color: c.sub, fontSize: 12, letterSpacing: 0.8, marginBottom: 6 },
  title: { fontSize: 24, lineHeight: 30, color: c.ink, marginBottom: 16 },
  legend: { color: c.sub, fontSize: 12, marginTop: 6 },
  wm: { color: c.link, fontSize: 13, marginTop: 8 },
  h: { fontSize: 18, color: c.ink, textTransform: "uppercase", marginTop: 24, marginBottom: 10 },
  sub: { color: c.sub, marginBottom: 8, fontSize: 13 }, small: { color: c.muted, fontSize: 12, marginTop: 10 },
  flag: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12, marginBottom: 8 },
  time: { color: c.flag, fontSize: 13, width: 60 },
  rules: { fontWeight: "600", color: c.ink, fontSize: 14 }, note: { color: c.sub, fontSize: 13, marginTop: 2 },
  jump: { color: c.sub, fontSize: 12 },
  panel: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 18, padding: 18 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" },
  seal: { width: 34, height: 34, borderRadius: 999, borderWidth: 2, borderStyle: "dashed", borderColor: c.accent, alignItems: "center", justifyContent: "center" },
  chip: { fontSize: 11, fontWeight: "700", borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, overflow: "hidden" },
  item: { flexDirection: "row", gap: 12, paddingVertical: 11, borderTopWidth: 1, borderTopColor: c.line, alignItems: "flex-start" },
  mark: { fontWeight: "700", width: 16, fontSize: 15 },
  itemTitle: { color: c.ink, fontSize: 14, fontWeight: "600" }, itemText: { color: c.sub, fontSize: 13, marginTop: 2 },
  smallBtn: { backgroundColor: "#1C1C21", borderWidth: 1, borderColor: "#2A2A31", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, alignSelf: "center" },
  label: { color: c.sub, fontSize: 13, marginBottom: 6 },
  still: { width: "100%", aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: "#000", marginTop: 12 },
  btn: { borderRadius: 14, minHeight: 50, alignItems: "center", justifyContent: "center", marginTop: 16 }, btnText: { color: c.onAccent, fontWeight: "700", fontSize: 15 },
  ghost: { borderWidth: 1, borderColor: "#2A2A31", borderRadius: 14, minHeight: 50, alignItems: "center", justifyContent: "center", marginTop: 8 },
  decided: { color: c.ink, fontSize: 18, textTransform: "uppercase", marginTop: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  reason: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: c.field },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 10, minHeight: 60, marginBottom: 6, color: c.ink, backgroundColor: c.field },
  link: { color: c.link, fontSize: 13, marginTop: 10 },
  err: { color: c.fail, marginTop: 8 },
});

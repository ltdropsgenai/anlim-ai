// Result of a Home prompt (2026-11-20, Londi: "the initial prompt [makes] both a still image and/or a short video clip
// ... Then, they have the option to start a project from their generated asset or just download it. Either way, a
// default workspace is created along with an untitled project."). Polls studio-api "creation" for the shot until the
// image (and the clip, when one was asked for) is done. Downloading a clip marks it kept (creation_keep); it was charged
// when the check passed or flagged it (charging policy v2). @anlim
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { api, Creation, Output } from "../lib/api";
import { c, font } from "../lib/theme";
import { downloadFile } from "../lib/download";
import { MediaView } from "./MediaView";

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "anlim";

function stage(x: Creation | null, output: Output) {
  if (!x) return { done: false, label: "Starting…" };
  if (x.frame_status === "failed") return { done: true, label: "The image could not be made." };
  if (!x.image_url && !x.from_text) return { done: false, label: "Drawing the image… (usually under a minute)" };
  if (output === "image" && !x.gen_id) return { done: true, label: "Your image is ready." };
  if (x.render_error && !x.gen_id) return { done: true, label: "The image is ready; the clip did not start." };
  if (!x.gen_id || x.gen_status === "queued") return { done: false, label: "Starting the clip…" };
  if (x.gen_status === "running") return { done: false, label: `Animating with ${x.model_label ?? "the video model"}… (usually 3 to 5 minutes)` };
  if (x.gen_status === "checking") return { done: false, label: "Checking the clip… you can watch it below." };
  if (x.gen_status === "failed") return { done: true, label: x.gen_error === "refund requested" ? "Refund requested for this clip." : "The clip didn't finish. Nothing was charged for it." };
  return { done: true, label: x.gen_status === "succeeded" ? "Your clip is ready (checked ✓)." : "Your clip is ready. Our check flagged something: have a look." };
}

export function CreationCard({ shotId, output, onAgain }: { shotId: string; output: Output; onAgain: () => void }) {
  const [x, setX] = useState<Creation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [work, setWork] = useState<string | null>(null);     // a button in progress
  const [tick, setTick] = useState(0);
  const started = useRef(Date.now());
  const st = stage(x, x?.gen_id ? "video" : output);

  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try { const r = await api.creation(shotId); if (live) { setX(r); setErr(null); } if (live && !stage(r, r.gen_id ? "video" : output).done) timer = setTimeout(poll, 4000); }
      catch (e) { if (live) { setErr((e as Error).message); timer = setTimeout(poll, 8000); } }
    };
    poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [shotId, output, tick]);

  const secs = Math.round((Date.now() - started.current) / 1000);
  const name = slug(x?.action ?? "anlim");

  async function run(label: string, fn: () => Promise<unknown>) {
    setWork(label); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setWork(null); }
  }
  const animate = () => run("animate", async () => {
    if (x?.job_id && x.frame_status === "ready") await api.decideFrame(x.job_id, "approve");
    await api.render(shotId);
    setTick((t) => t + 1);
  });
  const openWorkspace = () => x && router.navigate({ pathname: "/workspace", params: { series: x.series_id, scene: x.scene_id, shot: shotId } });
  const checking = x?.gen_status === "checking";
  const clipDone = x?.gen_status === "review" || x?.gen_status === "succeeded";

  return (
    <View style={s.card}>
      <View style={s.head}>
        <Text style={[s.small, font.mono]}>{(x?.series_name ?? "Untitled project").toUpperCase()} · SAVED IN YOUR WORKSPACE</Text>
        {!st.done && <ActivityIndicator size="small" color={c.accent} />}
      </View>
      <Text style={{ color: st.done && (x?.gen_status === "failed" || x?.frame_status === "failed") ? c.fail : c.ink, fontSize: 15, marginBottom: 10 }}>
        {st.label}{!st.done ? `  ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : ""}
      </Text>

      {x?.video_url ? <MediaView kind="clip" url={x.video_url} poster={x.image_url ?? x.poster_url ?? null} />
        : x?.image_url ? <MediaView kind="still" url={x.image_url} /> : <View style={s.placeholder} />}

      {x?.gen_status === "review" && x.gen_error?.startsWith("checker found: ") ? (
        <Text style={[s.note, { color: c.flag }]}>Our check found: {x.gen_error.slice(15, 300)}</Text>) : null}
      {x?.gen_status === "failed" && x.gen_error && x.gen_error !== "refund requested" ? (
        <Text style={[s.note, { color: c.fail }]}>{x.gen_error.slice(0, 300)}</Text>) : null}
      {x?.render_error && !x.gen_id ? <Text style={[s.note, { color: c.fail }]}>{x.render_error}</Text> : null}
      {x?.frame_error ? <Text style={[s.note, { color: c.fail }]}>{x.frame_error}</Text> : null}
      {x?.watermarked ? <Text style={s.note}>Free accounts see and download clips with a watermark. It goes away once you buy credits or a plan.</Text> : null}
      {err ? <Text style={[s.note, { color: c.fail }]}>{err}</Text> : null}

      <View style={s.row}>
        {x?.image_url ? <Btn label="Download image" busy={work === "img"} onPress={() => run("img", () => downloadFile(x.image_url!, `${name}.png`))} /> : null}
        {x?.video_url ? <Btn label={checking ? "Download clip (after the check)" : "Download clip"} primary disabled={!clipDone} busy={work === "vid"}
          onPress={() => run("vid", async () => { if (x.gen_id) await api.keepCreation(x.gen_id); await downloadFile(x.video_url!, `${name}.mp4`); })} /> : null}
        {st.done && (x?.image_url || x?.from_text) && (!x.gen_id || x.gen_status === "failed") ?
          <Btn label={x.gen_id ? "Try the clip again" : "Animate this image"} primary={!x.gen_id} busy={work === "animate"} onPress={animate} /> : null}
        {clipDone && x?.gen_id ? <Btn label="Something wrong? Request a refund" onPress={() => router.navigate({ pathname: "/clip/[id]", params: { id: x.gen_id! } })} /> : null}
        {x ? <Btn label="Start a project from this" onPress={openWorkspace} /> : null}
        {st.done ? <Btn label="Make another" onPress={onAgain} /> : null}
      </View>
      <Text style={s.small}>
        {x?.from_text ? "The clip is charged when it is made. If it is unusable, request a refund and tell us why."
          : x?.gen_id ? "The image used 20 credits; the clip is charged when it is made. If it is unusable, request a refund and tell us why."
          : "The image used 20 credits. Animating it costs credits per second, charged when the clip is made."}
      </Text>
    </View>
  );
}

function Btn({ label, onPress, primary, disabled, busy }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean; busy?: boolean }) {
  const off = disabled || busy;
  return (
    <Pressable onPress={onPress} disabled={off} accessibilityRole="button" accessibilityState={{ disabled: !!off }}
      style={[s.btn, primary && s.btnPrimary, off && { opacity: 0.45 }]}>
      <Text style={{ color: primary ? c.onAccent : c.ink, fontSize: 14, fontWeight: "600" }}>{busy ? "…" : label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: { marginTop: 18, backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 20, padding: 18, gap: 4 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  placeholder: { width: "100%", aspectRatio: 16 / 9, borderRadius: 12, backgroundColor: c.field },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12, marginBottom: 8 },
  btn: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: c.card2 },
  btnPrimary: { backgroundColor: c.accent, borderColor: c.accent },
  note: { color: c.sub, fontSize: 13, marginTop: 8 },
  small: { color: c.muted, fontSize: 12 },
});

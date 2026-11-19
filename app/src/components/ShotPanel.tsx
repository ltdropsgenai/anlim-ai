// One shot (components/ShotPanel, 2026-11-19 moved out of app/shot/[id]): who is in it, its start frame (uploaded, or made: continue from the previous clip, same room with new
// positions, or a new setup from the location's empty room + character references), an end frame made from a
// sentence (edited with Nano Banana 2, rebuilt so only the characters change, checked), then render. @anlim
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Link, router, useFocusEffect } from "expo-router";
import { api, CutoutJob, END_FRAME_CREDITS, FRAME_CREDITS, EndCheck, HeightCheck, KIND_NAMES, StagingCheck, MODEL_NAMES, QUALITY_NAMES, Shot, StartMode, StartSource, startFrameCredits, uploadStill } from "../lib/api";
import { c, font } from "../lib/theme";
import { StillPicker } from "./StillPicker";

const MAKING = ["queued", "running", "composing"];
const MODE_TEXT: Record<StartMode, string> = {
  continue: "Continue from the previous clip", reposition: "Same room, new positions", new_setup: "New setup from the location",
};
const SOURCE_TEXT: Record<StartSource, string> = {
  prev_last: "previous clip's last frame", this_start: "this shot's start frame", prev_start: "previous shot's start frame",
};

// 2026-11-16: areas a character left that the image model had to draw (no fitting empty-room plate): shown dashed.
// A FLAG with red boxes is a drift; one without (2026-11-16: a character not found, or most of the room redrawn by the
// image model) says why in words.
const flagText = (ch: EndCheck | null | undefined, boxes: string) =>
  `Check: ${!ch?.why || ch.why.startsWith("things outside the characters changed") ? boxes
    : ch.why.charAt(0).toUpperCase() + ch.why.slice(1) + ((ch.drift?.length ?? 0) > 0 ? " (red boxes)." : ".")}`;
const drawnAreas = (ch?: EndCheck | null) => (ch?.revealed ?? []).filter((r) => r.source === "edit").map((r) => r.box);
function RevealedNote({ ch }: { ch?: EndCheck | null }) {
  const n = drawnAreas(ch).length;
  if (!n) return ch?.plate_used ? <Text style={s.sub}>Where a character moved away, the room comes from the location's empty-room picture.</Text> : null;
  return <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>
    Look inside the dashed box{n > 1 ? "es" : ""}: a character stood there before, so the image model drew that part of the room. Check nothing was added or changed.</Text>;
}

// 2026-11-16: height check on a new start still: are the characters drawn at the heights on their cards?
function HeightBadge({ h, mode }: { h?: HeightCheck; mode: StartMode }) {
  if (!h) return null;
  if (h.verdict === "OK") return <Text style={[s.badge, { color: c.pass, borderColor: c.pass }]}>Heights: match the character cards</Text>;
  if (h.verdict === "WRONG") return (<>
    <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>{mode === "continue"
      ? "Heights: wrong, already in the previous clip's last frame. Making it again gives the same frame: use \"Same room, new positions\" and ask for the right sizes."
      : "Heights: wrong. The video would keep these sizes; discard and make it again."}</Text>
    {h.problems.map((p, i) => <Text key={i} style={s.sub}>{p}</Text>)}
  </>);
  if (h.verdict === "UNSURE") return <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>Heights: the check could not tell. Compare the characters' sizes yourself.</Text>;
  return <Text style={s.sub}>Heights were not checked{h.notes[0] ? ` (${h.notes[0]})` : ""}. Compare the characters' sizes yourself.</Text>;
}

function StagingBadge({ st }: { st?: StagingCheck }) {
  if (!st) return null;
  if (st.verdict === "OK") return <Text style={[s.badge, { color: c.pass, borderColor: c.pass }]}>Poses: everyone is placed as the text says (seated people on the seat, feet on the floor)</Text>;
  if (st.verdict === "WRONG") return (<>
    <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>Poses: wrong. The video would start from this; discard and make it again.</Text>
    {st.problems.map((p, i) => <Text key={i} style={s.sub}>{p}</Text>)}
  </>);
  if (st.verdict === "UNSURE") return <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>Poses: the check could not tell. Look at how everyone sits or stands.</Text>;
  return <Text style={s.sub}>Poses were not checked{st.notes?.[0] ? ` (${st.notes[0]})` : ""}. Look at how everyone sits or stands.</Text>;
}

// Start frame maker: three ways, each says why it is unavailable instead of hiding.
// 2026-11-18: three test shots got the action typed as the starting pose (the frame then showed the END of the shot,
// a cat already asleep on the sofa), or the starting pose typed as the action. Share of the pose's words that are also
// in the action: 0.8+ = almost the same text.
function sameText(a: string, b: string) {
  const w = (x: string) => x.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((t) => t.length > 2);
  const pa = w(a), pb = new Set(w(b));
  return pa.length >= 3 ? pa.filter((t) => pb.has(t)).length / pa.length : 0;
}

function StartMaker({ shot, busy, run }: { shot: Shot; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const ctx = shot.context;
  const [mode, setMode] = useState<StartMode | null>(null);
  const [text, setText] = useState("");
  const [source, setSource] = useState<StartSource | null>(null);
  const [sameOk, setSameOk] = useState(false);       // the creator saw the "this is the action" warning and goes ahead
  if (!ctx) return null;
  const cast = ctx.characters.filter((x) => x.in_shot);
  const noRef = cast.filter((x) => !x.has_ref).map((x) => x.name);
  const why: Record<StartMode, string | null> = {
    continue: !ctx.prev_id ? "This is the first shot of the scene." : !ctx.prev_clip_approved ? "Approve a clip of the previous shot first." : null,
    reposition: !shot.start_url && !ctx.prev_clip_approved && !ctx.prev_start_approved ? "Needs a still to start from: upload one, or approve the previous shot's start frame or clip." : null,
    new_setup: !ctx.location_id ? "Give the scene a location (Characters & locations)." : !ctx.has_plate ? `Make or upload the empty-room plate for ${ctx.location_name}.`
      : !cast.length ? "Nobody is in this shot." : noRef.length ? `Add a reference image for ${noRef.join(", ")}.` : null,
  };
  const sources: StartSource[] = [
    ...(ctx.prev_clip_approved ? ["prev_last" as const] : []), ...(shot.start_url ? ["this_start" as const] : []),
    ...(ctx.prev_start_approved ? ["prev_start" as const] : [])];
  const src = source && sources.includes(source) ? source : sources[0];
  return (
    <View style={s.panel}>
      <Text style={s.label}>Make a start frame</Text>
      {(Object.keys(MODE_TEXT) as StartMode[]).map((m) => (
        <Pressable key={m} disabled={!!why[m] || busy} onPress={() => setMode(m)} accessibilityRole="radio" accessibilityState={{ checked: mode === m, disabled: !!why[m] }}
          style={[s.choice, mode === m && s.choiceOn, !!why[m] && { opacity: 0.55 }]}>
          <Text style={s.choiceTitle}>{MODE_TEXT[m]} · {m === "continue" ? "free" : `${startFrameCredits(m, shot.look, cast.length)} credits`}</Text>
          <Text style={s.sub}>{why[m] ?? (m === "continue" ? "Starts exactly where the approved clip ended."
            : m === "reposition" ? "Moves the characters; the room stays pixel-for-pixel." : `Places ${cast.map((x) => x.name).join(" and ")} in the empty ${ctx.location_name}.`)}</Text>
        </Pressable>
      ))}
      {mode === "reposition" && sources.length > 1 && (
        <View style={s.row}>
          <Text style={s.label}>Start from</Text>
          {sources.map((x) => (
            <Pressable key={x} onPress={() => setSource(x)} style={[s.chip, src === x && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: src === x }}>
              <Text style={src === x ? { color: c.onAccent } : { color: c.ink }}>{SOURCE_TEXT[x]}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Link href={{ pathname: "/library", params: { series: ctx.series_id } }} style={s.link}>Characters & locations</Link>
      {(mode === "reposition" || mode === "new_setup") && (<>
        <Text style={s.sub}>What happens in the clip (the shot's action): <Text style={{ fontStyle: "italic" }}>{shot.action}</Text></Text>
        <Text style={s.label}>Starting pose: where everyone is at the first moment, before anything happens</Text>
        <TextInput style={s.input} multiline value={text} onChangeText={(v) => { setText(v); setSameOk(false); }} placeholderTextColor={c.muted}
          placeholder="e.g. Layana stands by the window, looking at King; King sits on the sofa. Describe the start, not what happens next." />
        {sameText(text, shot.action) >= 0.8 && (
          <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>
            This is almost the same as the shot's action. The start frame should show the first moment, before the action happens;
            if it shows the action done, the video has nothing left to do.{sameOk ? " Press the button once more to make it anyway." : " To make it anyway, press the button twice."}
          </Text>
        )}
      </>)}
      {mode && (
        <Pressable style={[s.btn, { backgroundColor: c.accent }, (busy || (mode !== "continue" && !text.trim())) && { opacity: 0.5 }]}
          disabled={busy || (mode !== "continue" && !text.trim())} accessibilityRole="button"
          onPress={() => {
            if (mode !== "continue" && sameText(text, shot.action) >= 0.8 && !sameOk) { setSameOk(true); return; }   // first press: warn
            run(() => api.requestStartFrame(shot.id, mode, mode === "continue" ? undefined : text, mode === "reposition" ? src : undefined));
          }}>
          <Text style={s.btnText}>{mode === "continue" ? "Use the last frame" : `Make start frame (${startFrameCredits(mode, shot.look, cast.length)} credits)`}</Text>
        </Pressable>
      )}
    </View>
  );
}

// Reference images cut out of this shot's start frame (free; frame_check cutout.py on the PC). The creator says which
// cut-out is which character; it then becomes that character's reference image for new setups.
function Cutouts({ shot }: { shot: Shot }) {
  const [job, setJob] = useState<CutoutJob | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setJob(await api.cutouts(shot.id)); } catch (e) { setErr((e as Error).message); }
  }, [shot.id]);
  useEffect(() => { if (open) load(); }, [open, load]);
  const working = !!job && MAKING.includes(job.status);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [working, load]);
  const chars = shot.context?.characters ?? [];
  if (!shot.start_url || !chars.length) return null;
  if (!open) return (
    <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
      <Text style={s.link}>Character references from this start frame</Text>
    </Pressable>
  );
  const ready = job && job.status === "ready" ? job : null;
  return (
    <View style={s.panel}>
      <Text style={s.label}>Character references from this start frame · free</Text>
      <Text style={s.sub}>Each character is cut out onto white. Pick who each one is to make it their reference image for new setups.
        With the location's empty-room plate the room is cut away cleanly; without one, some background can come along.</Text>
      {working && <View style={s.row}><ActivityIndicator /><Text style={s.sub}>Cutting out the characters… a few seconds.</Text></View>}
      {job?.status === "failed" && <Text style={s.err}>Could not cut them out: {job.error ?? "unknown error"}</Text>}
      {ready && ready.cutouts.length === 0 && <Text style={s.sub}>No character was found in this start frame.</Text>}
      {ready && ready.cutouts.length > 0 && (
        <View style={s.frames}>
          {ready.cutouts.map((cu) => (
            <View key={cu.index} style={s.cutCol}>
              <View style={s.cut}>{cu.url && <Image source={{ uri: cu.url }} style={StyleSheet.absoluteFill} resizeMode="contain"
                accessibilityLabel={`Cut-out ${cu.index}`} />}</View>
              {cu.warnings.map((w, i) => <Text key={i} style={[s.sub, { color: c.flag }]}>{w}</Text>)}
              <View style={s.row}>
                {chars.map((ch) => (
                  <Pressable key={ch.id} style={s.chip} accessibilityRole="button"
                    onPress={async () => {
                      setErr(null); setMsg(null);
                      try { await api.useCutout(ready.id, cu.index, ch.id); setMsg(`Cut-out ${cu.index} is now ${ch.name}'s reference image.`); }
                      catch (e) { setErr((e as Error).message); }
                    }}>
                    <Text style={{ color: c.ink }}>This is {ch.name}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </View>
      )}
      {msg && <Text style={[s.sub, { color: c.pass }]}>{msg}</Text>}
      {err && <Text style={s.err}>{err}</Text>}
      {!working && (
        <Pressable style={[s.btn, { backgroundColor: c.accent, alignSelf: "flex-start" }]} accessibilityRole="button"
          onPress={async () => { setErr(null); setMsg(null); try { await api.requestCutouts(shot.id); await load(); } catch (e) { setErr((e as Error).message); } }}>
          <Text style={s.btnText}>{ready ? "Cut them out again" : "Cut out the characters"}</Text>
        </Pressable>
      )}
    </View>
  );
}

function Frame({ label, uri, boxes, look }: { label: string; uri: string | null; boxes?: number[][]; look?: number[][] }) {
  return (
    <View style={s.frameCol}>
      <Text style={s.label}>{label}</Text>
      <View style={s.frame}>
        {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel={label} />
          : <Text style={[s.sub, { padding: 12 }]}>None yet</Text>}
        {(boxes ?? []).map((b, i) => (   // drift boxes: fractions x0,y0,x1,y1 of the frame
          <View key={i} style={[s.box, { left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${(b[2] - b[0]) * 100}%`, height: `${(b[3] - b[1]) * 100}%` }]} />
        ))}
        {(look ?? []).map((b, i) => (   // areas the image model drew (behind where a character stood): dashed amber
          <View key={`l${i}`} style={[s.box, s.look, { left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${(b[2] - b[0]) * 100}%`, height: `${(b[3] - b[1]) * 100}%` }]} />
        ))}
      </View>
    </View>
  );
}

// The whole shot workflow (start frame, end frame, model, render). Used by the shot page and by the Workspace's centre
// pane (2026-11-19). onRendered / onDeleted let the host decide where to go next.
export function ShotPanel({ id, onRendered, onDeleted }: { id: string; onRendered?: () => void; onDeleted?: () => void }) {
  const [shot, setShot] = useState<Shot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string | null>(null);   // null = the app picks (route); else the creator's override
  const [showWhy, setShowWhy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ action: "", camera: "", dur: "5" });
  const [showMaker, setShowMaker] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.shot(id); setShot(s); setError(null);
      setText((t) => t || s.end_instruction || "");
    } catch (e) { setError((e as Error).message); }
  }, [id]);
  // load on mount and when the shot changes; reload when the screen comes back into focus (useFocusEffect alone does not
  // fire for a panel mounted inside an already-focused screen, e.g. the Workspace's centre pane)
  const first = useRef(true);
  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { if (first.current) { first.current = false; return; } load(); }, [load]));
  const making = !!shot?.job && MAKING.includes(shot.job.status);
  const startMaking = !!shot?.start_job && MAKING.includes(shot.start_job.status);
  const heightChecking = !!shot?.height_job && MAKING.includes(shot.height_job.status);
  const anyMaking = making || startMaking || heightChecking;
  useEffect(() => {                         // a made frame takes about a minute (first live end frame: 68 s): keep the screen current
    if (!anyMaking) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [anyMaking, load]);

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setError(null);
    // the panel reloads itself first, then the host follows up (2026-11-19: in the Workspace it kept showing "Render"
    // after a render had been queued, because the host's reload replaced the panel's own)
    try { await fn(); setShowMaker(false); await load(); after?.(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  if (error && !shot) return <Text style={[s.err, { padding: 16 }]}>{error}</Text>;
  if (!shot) return <ActivityIndicator style={{ marginTop: 40 }} />;
  const modelLabel = (id: string) => shot.models?.find((x) => x.id === id)?.label ?? MODEL_NAMES[id] ?? id;
  const picked = model ? shot.models?.find((x) => x.id === model) : null;

  const job = shot.job;
  const candidate = job?.status === "ready" ? job : null;
  const check = candidate?.check_result;
  const inFlight = shot.latest && ["queued", "running", "checking"].includes(shot.latest.status);
  const startCandidate = shot.start_job?.status === "ready" ? shot.start_job : null;

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={s.page}>
      <Text style={s.crumb}>{shot.series_name} · {shot.scene_title} · shot {shot.ord} · {shot.duration_s} s · camera {shot.camera ?? "locked"}</Text>
      {!editing ? (
        <>
          <Text style={s.title}>{shot.action}</Text>
          <View style={s.row}>
            <Pressable disabled={busy || !!inFlight || anyMaking} accessibilityRole="button"
              onPress={() => { setDraft({ action: shot.action, camera: shot.camera ?? "locked", dur: String(shot.duration_s) }); setEditing(true); }}>
              <Text style={s.link}>Edit shot</Text>
            </Pressable>
            {!shot.latest && (
              <Pressable disabled={busy} accessibilityRole="button"
                onPress={() => run(() => api.deleteShot(shot.id), onDeleted ?? (() => router.replace("/workspace")))}>
                <Text style={[s.link, { color: c.fail }]}>Delete shot</Text>
              </Pressable>
            )}
          </View>
        </>
      ) : (
        <View style={s.panel}>
          <Text style={s.label}>What happens in the shot</Text>
          <TextInput style={s.input} multiline value={draft.action} onChangeText={(v) => setDraft({ ...draft, action: v })} />
          <View style={s.row}>
            <Text style={s.label}>Camera</Text>
            <TextInput style={[s.input, { minHeight: 0, flex: 1 }]} value={draft.camera} onChangeText={(v) => setDraft({ ...draft, camera: v })}
              placeholderTextColor={c.muted} placeholder="locked, or e.g. slow pan right following Layana" />
            <Text style={s.label}>Seconds</Text>
            <TextInput style={[s.input, { minHeight: 0, width: 70 }]} value={draft.dur} onChangeText={(v) => setDraft({ ...draft, dur: v })} keyboardType="number-pad" />
          </View>
          <View style={s.row}>
            <Pressable style={[s.btn, { backgroundColor: c.accent }]} disabled={busy} accessibilityRole="button"
              onPress={() => run(() => api.updateShot(shot.id, draft.action, draft.camera || null, Number(draft.dur)), async () => { setEditing(false); await load(); })}>
              <Text style={s.btnText}>Save</Text>
            </Pressable>
            <Pressable style={s.ghost} onPress={() => setEditing(false)} accessibilityRole="button"><Text style={{ color: c.ink }}>Cancel</Text></Pressable>
          </View>
        </View>
      )}

      {shot.context && shot.context.characters.length > 0 && (
        <View style={s.row}>
          <Text style={[s.label, { marginTop: 8 }]}>In this shot:</Text>
          {shot.context.characters.map((ch) => {
            const on = ch.in_shot, ids = shot.context!.characters.filter((x) => x.in_shot).map((x) => x.id);
            return (
              <Pressable key={ch.id} disabled={busy || !!inFlight || anyMaking || (on && ids.length === 1)} style={[s.chip, on && s.chipOn]}
                accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                onPress={() => run(() => api.setShotCast(shot.id, on ? ids.filter((x) => x !== ch.id) : [...ids, ch.id]))}>
                <Text style={on ? { color: c.onAccent } : { color: c.ink }}>{ch.name}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <Text style={[s.h, font.display]}>Start frame</Text>
      <Text style={s.sub}>The first frame of the shot: your characters in the room, posed as the shot begins. The video starts exactly on it.</Text>
      <View style={s.frames}>
        <Frame label={!shot.start_url ? "Start frame" : shot.start_frame_approved ? "Start frame (approved)" : "Start frame (not approved yet)"} uri={shot.start_url} />
        {(startCandidate || startMaking) && (
          <Frame label={startMaking ? "New start frame (being made)" : "New start frame (not approved yet)"} uri={startCandidate?.composed_url ?? null}
            boxes={startCandidate?.check_result?.verdict === "FLAG" ? startCandidate.check_result.drift.map((d) => d.box) : undefined}
            look={drawnAreas(startCandidate?.check_result)} />
        )}
      </View>
      {!startCandidate && !startMaking && shot.height_job && (
        <View style={s.panel}>
          {heightChecking ? <Text style={s.sub}>Checking the characters' heights in your uploaded start frame…</Text>
            : shot.height_job.status === "failed" ? <Text style={s.sub}>The height check could not run: {shot.height_job.error ?? "unknown error"}. Compare the characters' sizes yourself.</Text>
            : <HeightBadge h={shot.height_job.check_result?.height} mode="reposition" />}
        </View>
      )}
      {startMaking && (
        <View style={s.panel}><ActivityIndicator /><Text style={s.sub}>
          {shot.start_job!.mode === "continue" ? "Taking the last frame of the previous clip…" : "Making the start frame… about a minute."}</Text></View>
      )}
      {startCandidate && (
        <View style={s.panel}>
          <Text style={s.sub}>{MODE_TEXT[startCandidate.mode]}{startCandidate.mode !== "continue" ? `: ${startCandidate.instruction}` : "."}</Text>
          {startCandidate.mode !== "continue" && (startCandidate.check_result?.verdict === "PASS"
            ? <Text style={[s.badge, { color: c.pass, borderColor: c.pass }]}>{startCandidate.check_result?.why?.startsWith("the room's layout")
                ? "Check: the room's layout matches the location (lighting may differ slightly)" : "Check: the room is unchanged"}</Text>
            : <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>{flagText(startCandidate.check_result, "something in the room changed (red boxes). Look closely.")}</Text>)}
          {startCandidate.mode !== "continue" && <RevealedNote ch={startCandidate.check_result} />}
          <HeightBadge h={startCandidate.check_result?.height} mode={startCandidate.mode} />
          <StagingBadge st={startCandidate.check_result?.staging} />
          {startCandidate.mode !== "continue" && <Text style={s.sub}>Look at each character's face and clothes: the checks cannot judge those.</Text>}
          {shot.end_url && <Text style={s.sub}>Using it removes the current end frame (it was drawn from the old start frame).</Text>}
          <View style={s.row}>
            <Pressable style={[s.btn, { backgroundColor: c.pass }]} disabled={busy} accessibilityRole="button"
              onPress={() => run(() => api.decideFrame(startCandidate.id, "approve"))}>
              <Text style={s.btnText}>Use this start frame</Text>
            </Pressable>
            <Pressable style={s.ghost} disabled={busy} accessibilityRole="button" onPress={() => run(() => api.decideFrame(startCandidate.id, "discard"))}>
              <Text style={{ color: c.ink }}>Discard</Text>
            </Pressable>
          </View>
        </View>
      )}
      {shot.start_job?.status === "failed" && <Text style={s.err}>The last start frame could not be made: {shot.start_job.error ?? "unknown error"}. No credits were charged.</Text>}
      {!startMaking && !startCandidate && (<>
        {(!shot.start_frame_approved || showMaker) ? (<>
          <StartMaker shot={shot} busy={busy || !!inFlight || making} run={run} />
          <View style={s.row}>
            <StillPicker label={shot.start_url ? "Or upload a different image" : "Or upload your own image"} disabled={busy || !!inFlight || making}
              style={{}} textStyle={s.link} onError={setError}
              onPick={(f) => run(async () => {
                await api.setStartFrame(shot.id, await uploadStill(shot.owner, shot.id, f, f.type));
                await api.requestHeightCheck(shot.id).catch(() => null);   // 2026-11-16: uploaded stills get the height check too
              })} />
            {shot.start_url && !shot.start_frame_approved && (
              <Pressable style={[s.btn, { backgroundColor: c.pass }]} disabled={busy} accessibilityRole="button"
                onPress={() => run(() => api.approveStartFrame(shot.id))}>
                <Text style={s.btnText}>Approve start frame</Text>
              </Pressable>
            )}
          </View>
        </>) : (
          <Pressable disabled={busy || !!inFlight || making} onPress={() => setShowMaker(true)} accessibilityRole="button">
            <Text style={s.link}>Change the start frame (removes the end frame)</Text>
          </Pressable>
        )}
      </>)}
      {busy && <ActivityIndicator style={{ marginTop: 8 }} />}
      {error && !shot.start_frame_approved && <Text style={s.err}>{error}</Text>}
      <Cutouts shot={shot} />

      {shot.start_frame_approved && !startCandidate && (<>
      <Text style={[s.h, font.display]}>How the shot ends</Text>
      <Text style={s.sub}>
        An end frame shows the video model exactly where everyone finishes. It is drawn from your start frame: only the
        characters move, the room stays pixel-for-pixel the same.
      </Text>

      <View style={s.frames}>
        <Frame label="Start frame" uri={shot.start_url} />
        <Frame label={candidate ? "New end frame (not approved yet)" : shot.end_url ? "End frame (approved)" : "End frame"}
          uri={candidate?.composed_url ?? shot.end_url} boxes={check?.verdict === "FLAG" ? check.drift.map((d) => d.box) : undefined}
          look={candidate ? drawnAreas(check) : undefined} />
      </View>

      {making && (
        <View style={s.panel}><ActivityIndicator /><Text style={s.sub}>Making the end frame… about a minute.</Text></View>
      )}

      {candidate && (
        <View style={s.panel}>
          {check?.verdict === "PASS"
            ? <Text style={[s.badge, { color: c.pass, borderColor: c.pass }]}>Check: only the characters changed</Text>
            : <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>{flagText(check, "something else changed (red boxes). Look closely.")}</Text>}
          <RevealedNote ch={check} />
          <HeightBadge h={check?.height} mode="reposition" />
          <StagingBadge st={check?.staging} />
          <Text style={s.sub}>Look at each character's face and clothes: the checks cannot judge those.</Text>
          <View style={s.row}>
            <Pressable style={[s.btn, { backgroundColor: c.pass }]} disabled={busy} accessibilityRole="button"
              onPress={() => run(() => api.decideEndFrame(candidate.id, "approve"))}>
              <Text style={s.btnText}>Use this end frame</Text>
            </Pressable>
            <Pressable style={s.ghost} disabled={busy} accessibilityRole="button"
              onPress={() => run(() => api.decideEndFrame(candidate.id, "discard"))}>
              <Text style={{ color: c.ink }}>Discard</Text>
            </Pressable>
          </View>
        </View>
      )}

      {job?.status === "failed" && <Text style={s.err}>The last end frame could not be made: {job.error ?? "unknown error"}. No credits were charged.</Text>}

      {!making && !candidate && (
        <View style={s.panel}>
          <Text style={s.label}>Describe the last moment of the shot</Text>
          <TextInput style={s.input} multiline value={text} onChangeText={setText}
            placeholderTextColor={c.muted} placeholder="e.g. Layana has stopped in front of the toy shelf, turned toward King, smiling at the camera. King watches her from the sofa." />
          <View style={s.row}>
            <Pressable style={[s.btn, { backgroundColor: c.accent }, (!text.trim() || busy) && { opacity: 0.5 }]}
              disabled={!text.trim() || busy} accessibilityRole="button"
              onPress={() => run(() => api.requestEndFrame(shot.id, text))}>
              <Text style={s.btnText}>{shot.end_url ? "Make a new end frame" : "Make end frame"} ({END_FRAME_CREDITS} credits)</Text>
            </Pressable>
            {shot.end_url && (
              <Pressable style={s.ghost} disabled={busy} accessibilityRole="button" onPress={() => run(() => api.clearEndFrame(shot.id))}>
                <Text style={{ color: c.ink }}>Remove end frame</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      <Text style={[s.h, font.display]}>Render</Text>
      <View style={s.panel}>
        {/* 2026-11-19: Auto picks per shot from tested routes and says why; the series' quality setting picks the table */}
        {shot.route ? (
          <View style={{ marginBottom: 8 }}>
            <Text style={{ color: c.ink, fontWeight: "600" }}>
              Auto picks {shot.route.label ?? MODEL_NAMES[shot.route.model_id] ?? shot.route.model_id} for {KIND_NAMES[shot.route.kind] ?? shot.route.kind}
              <Text style={{ color: c.sub, fontWeight: "400" }}> · series set to {QUALITY_NAMES[shot.quality] ?? "Balanced"}</Text>
            </Text>
            <Text style={s.sub}>{shot.route.reason}</Text>
            <Pressable onPress={() => setShowWhy(!showWhy)} accessibilityRole="button" accessibilityState={{ expanded: showWhy }}>
              <Text style={{ color: c.accent, fontSize: 13 }}>{showWhy ? "Hide the test results" : "Why? See the test results"}</Text>
            </Pressable>
            {showWhy && <Text style={[s.sub, { marginTop: 4 }]}>What the tests showed: {shot.route.evidence}</Text>}
          </View>
        ) : <Text style={s.err}>{shot.route_error ?? "No model can make this shot."}</Text>}
        {candidate && <Text style={s.sub}>Decide on the new end frame first, or it will not be used.</Text>}
        {!shot.end_url && <Text style={s.sub}>No end frame: the model decides how the shot ends.</Text>}
        {/* 2026-11-17: the creator can override the route (studio-api "render" already took a model id) */}
        <View style={s.row}>
          <Text style={s.label}>Model</Text>
          {[null, ...(shot.models ?? []).map((x) => x.id)].map((m) => (
            <Pressable key={m ?? "auto"} onPress={() => setModel(m)} style={[s.chip, model === m && s.chipOn]} accessibilityRole="radio"
              accessibilityState={{ checked: model === m }}>
              <Text style={model === m ? { color: c.onAccent } : { color: c.ink }}>
                {m === null ? `Auto${shot.route ? ` (${shot.route.label ?? MODEL_NAMES[shot.route.model_id] ?? shot.route.model_id})` : ""}` : modelLabel(m)}
              </Text>
            </Pressable>
          ))}
        </View>
        {model && shot.route && model !== shot.route.model_id && (
          <Text style={s.warnBox}>
            {modelLabel(model)} is not Auto's pick for {KIND_NAMES[shot.route.kind] ?? shot.route.kind}. What the tests showed: {shot.route.evidence}
          </Text>
        )}
        <Pressable style={[s.btn, { backgroundColor: c.accent }, (busy || (!shot.route && !model) || inFlight || making) && { opacity: 0.5 }]}
          disabled={busy || (!shot.route && !model) || !!inFlight || making} accessibilityRole="button"
          onPress={() => run(() => api.render(shot.id, model ?? undefined), onRendered)}>
          <Text style={s.btnText}>{inFlight ? "Rendering…" : model ? `Render with ${modelLabel(model)} (${picked?.credits ?? "?"} credits)` : `Render (${shot.route?.credits ?? "?"} credits)`}</Text>
        </Pressable>
      </View>
      {error && <Text style={s.err}>{error}</Text>}
      </>)}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, maxWidth: 1100, width: "100%", alignSelf: "center" },
  crumb: { color: c.sub, fontSize: 13 }, title: { fontSize: 17, fontWeight: "600", color: c.ink, marginTop: 4 },
  h: { fontSize: 16, fontWeight: "700", color: c.ink, marginTop: 22, marginBottom: 6 },
  sub: { color: c.sub, fontSize: 13, marginBottom: 6 }, label: { color: c.sub, fontSize: 13, marginBottom: 6 },
  frames: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 8 },
  frameCol: { flexGrow: 1, flexBasis: 320, minWidth: 0 },
  frame: { width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000", borderRadius: 8, overflow: "hidden", justifyContent: "center" },
  box: { position: "absolute", borderWidth: 2, borderColor: c.fail },
  look: { borderColor: c.flag, borderStyle: "dashed" },
  panel: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 14, marginTop: 12, gap: 6 },
  badge: { alignSelf: "flex-start", borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, fontSize: 12, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 6 },
  btn: { borderRadius: 8, paddingVertical: 11, paddingHorizontal: 16, alignItems: "center" }, btnText: { color: c.onAccent, fontWeight: "600" },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingVertical: 11, paddingHorizontal: 16, alignItems: "center", backgroundColor: c.field },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, minHeight: 70, color: c.ink, backgroundColor: c.field },
  warnBox: { color: c.flag, backgroundColor: c.flagBg, borderWidth: 1, borderColor: c.flagLine, borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 8 },
  err: { color: c.fail, marginTop: 8 }, link: { color: c.accent, fontSize: 14, marginVertical: 6 },
  choice: { borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 10, backgroundColor: c.field },
  choiceOn: { borderColor: c.accent, borderWidth: 2 }, choiceTitle: { color: c.ink, fontWeight: "600", marginBottom: 2 },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.field },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  cutCol: { flexGrow: 0, flexBasis: 220, minWidth: 0 },
  cut: { width: "100%", aspectRatio: 3 / 4, backgroundColor: c.field, borderWidth: 1, borderColor: c.line, borderRadius: 8, overflow: "hidden" },
});

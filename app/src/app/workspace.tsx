// Workspace (2026-11-19, Londi: "a dedicated workspace where assets are going to be generated"). Three panes on a
// wide screen: the project (series > scene > shots, plus the "next shot" director bar), the selected shot's whole
// workflow (components/ShotPanel: frames, model, render), and what this scene has made so far. On a phone it is the
// project pane; a shot opens on its own page. @anlim
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, Aspect, ASPECTS, Genre, GENRE_NAMES, Look, MODEL_NAMES, QueueItem, Series, ShotRow } from "../lib/api";
import { c, font, verdictColor, verdictLabel, pageBg } from "../lib/theme";
import { chip, GEN, pad2, TONE } from "../lib/shotStatus";
import { AddShot } from "../components/AddShot";
import { ShotPanel } from "../components/ShotPanel";
import { Icon } from "../components/Icon";

const BUSY_GEN = ["queued", "running", "checking"], BUSY_FRAME = ["queued", "running", "composing"];
const isBusy = (r: ShotRow) => (!!r.gen_status && BUSY_GEN.includes(r.gen_status)) || (!!r.frame_status && BUSY_FRAME.includes(r.frame_status));

function NewSeries({ onDone }: { onDone: (id?: string, err?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [look, setLook] = useState<Look | null>(null);   // 2026-11-23 (Londi): no default look
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [genre, setGenre] = useState<Genre | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <Pressable onPress={() => setOpen(true)} accessibilityRole="button"><Text style={s.link}>+ New series</Text></Pressable>;
  return (
    <View style={s.form}>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Series name" placeholderTextColor={c.muted} />
      <Text style={s.label}>Look</Text>
      <View style={s.row}>
        {(["cartoon", "photoreal"] as Look[]).map((l) => (
          <Pressable key={l} onPress={() => setLook(l)} style={[s.chip, look === l && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: look === l }}>
            <Text style={{ color: look === l ? c.onAccent : c.ink, fontSize: 13 }}>{l === "cartoon" ? "Cartoon" : "Photoreal"}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.label}>Shape</Text>
      <View style={s.row}>
        {ASPECTS.map((a) => (
          <Pressable key={a.id} onPress={() => setAspect(a.id)} style={[s.chip, aspect === a.id && s.chipOn]} accessibilityRole="radio"
            accessibilityState={{ checked: aspect === a.id }} accessibilityLabel={`${a.label}, ${a.hint}`}>
            <Text style={{ color: aspect === a.id ? c.onAccent : c.ink, fontSize: 13 }}>{a.label}</Text>
          </Pressable>
        ))}
        <Text style={{ color: c.muted, fontSize: 12 }}>{ASPECTS.find((a) => a.id === aspect)?.hint}</Text>
      </View>
      <Text style={s.label}>Genre (optional, for filing in Assets)</Text>
      <View style={s.row}>
        {(Object.keys(GENRE_NAMES) as Genre[]).map((g) => (
          <Pressable key={g} onPress={() => setGenre(genre === g ? null : g)} style={[s.chip, genre === g && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: genre === g }}>
            <Text style={{ color: genre === g ? c.onAccent : c.ink, fontSize: 12 }}>{GENRE_NAMES[g]}</Text>
          </Pressable>
        ))}
      </View>
      <View style={s.row}>
        <Pressable style={[s.btn, (!name.trim() || !look || busy) && { opacity: 0.5 }]} disabled={!name.trim() || !look || busy} accessibilityRole="button"
          onPress={async () => {
            if (!look) return;
            setBusy(true);
            try { const r = await api.createSeries(name, look, undefined, genre, aspect); setOpen(false); setName(""); onDone(r.id); }
            catch (e) { onDone(undefined, (e as Error).message); }
            setBusy(false);
          }}>
          <Text style={s.btnText}>Create series</Text>
        </Pressable>
        <Pressable onPress={() => setOpen(false)} accessibilityRole="button"><Text style={s.link}>Cancel</Text></Pressable>
        {!look && name.trim() ? <Text style={{ color: c.muted, fontSize: 12 }}>Choose Cartoon or Photoreal first.</Text> : null}
      </View>
    </View>
  );
}

function NewScene({ seriesId, onDone }: { seriesId: string; onDone: (err?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  if (!open) return <Pressable onPress={() => setOpen(true)} accessibilityRole="button" style={s.sceneChip}><Text style={{ color: c.link, fontSize: 13 }}>+ Scene</Text></Pressable>;
  return (
    <View style={[s.row, { width: "100%" }]}>
      <TextInput style={[s.input, { flex: 1 }]} value={title} onChangeText={setTitle} placeholder="Scene title" placeholderTextColor={c.muted} autoFocus />
      <Pressable style={[s.btn, !title.trim() && { opacity: 0.5 }]} disabled={!title.trim()} accessibilityRole="button"
        onPress={async () => { try { await api.createScene(seriesId, title); setTitle(""); setOpen(false); onDone(); } catch (e) { onDone((e as Error).message); } }}>
        <Text style={s.btnText}>Add</Text>
      </Pressable>
    </View>
  );
}

// Rename and delete for a series or a scene (2026-11-19). Deleting asks a second time and says what goes with it.
function Manage({ label, name, what, onRename, onDelete }: { label: string; name: string; what: string;
  onRename: (v: string) => Promise<unknown>; onDelete: () => Promise<unknown> }) {
  const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
  const [v, setV] = useState(name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setMode("idle"); } catch (e) { setErr((e as Error).message); } setBusy(false); };
  if (mode === "idle") return (
    <View style={[s.row, { gap: 14 }]}>
      <Pressable onPress={() => { setV(name); setMode("rename"); }} accessibilityRole="button"><Text style={s.small}>Rename {label}</Text></Pressable>
      <Pressable onPress={() => setMode("delete")} accessibilityRole="button"><Text style={[s.small, { color: c.fail }]}>Delete {label}</Text></Pressable>
    </View>
  );
  if (mode === "rename") return (
    <View style={[s.row, { width: "100%" }]}>
      <TextInput value={v} onChangeText={setV} style={[s.input, { flex: 1 }]} autoFocus accessibilityLabel={`New ${label} name`} />
      <Pressable style={[s.btn, (!v.trim() || busy) && { opacity: 0.5 }]} disabled={!v.trim() || busy} onPress={() => run(() => onRename(v))} accessibilityRole="button">
        <Text style={s.btnText}>Save</Text>
      </Pressable>
      <Pressable onPress={() => setMode("idle")} accessibilityRole="button"><Text style={s.small}>Cancel</Text></Pressable>
      {err && <Text style={{ color: c.fail, fontSize: 12 }}>{err}</Text>}
    </View>
  );
  return (
    <View style={s.danger}>
      <Text style={{ color: c.ink, fontSize: 13 }}>Delete “{name}” and {what}? Its files are removed too. This cannot be undone.</Text>
      <View style={s.row}>
        <Pressable style={[s.btn, { backgroundColor: c.fail }, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => run(onDelete)} accessibilityRole="button">
          <Text style={s.btnText}>{busy ? "Deleting…" : `Delete ${label}`}</Text>
        </Pressable>
        <Pressable onPress={() => setMode("idle")} accessibilityRole="button"><Text style={s.small}>Keep it</Text></Pressable>
      </View>
      {err && <Text style={{ color: c.fail, fontSize: 12 }}>{err}</Text>}
    </View>
  );
}

function ShotRowItem({ r, on, onPress, onMove, first, last }: { r: ShotRow; on: boolean; onPress: () => void;
  onMove: (dir: -1 | 1) => void; first: boolean; last: boolean }) {
  const st = chip(r), t = TONE[st.tone];
  return (
    // the row and its move buttons are siblings: a button inside a button is invalid HTML on the web (2026-11-19)
    <View style={[s.shot, on && s.shotOn]}>
    <Pressable onPress={onPress} style={{ flex: 1, minWidth: 0, flexDirection: "row", gap: 10 }} accessibilityRole="button"
      accessibilityState={{ selected: on }} accessibilityLabel={`Shot ${r.ord}: ${r.action}. ${st.text}`}>
      <View style={s.shotThumb}>
        {r.thumb_url ? <Image source={{ uri: r.thumb_url }} style={{ width: "100%", height: "100%" }} resizeMode="cover" /> : null}
        <Text style={[s.slate, font.mono]}>SH {pad2(r.ord)}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: c.ink, fontSize: 13, lineHeight: 18 }} numberOfLines={2}>{r.action}</Text>
        <View style={[s.row, { marginTop: 6, gap: 6 }]}>
          <Text style={[s.status, { backgroundColor: t.bg, color: t.fg, borderColor: t.line }]}>{st.text}</Text>
          <Text style={[s.meta, font.mono]}>{r.duration_s} S</Text>
        </View>
      </View>
    </Pressable>
      <View style={{ justifyContent: "center", gap: 2 }}>
        <Pressable onPress={() => onMove(-1)} disabled={first} accessibilityRole="button" accessibilityLabel={`Move shot ${r.ord} earlier`}
          style={[s.move, first && { opacity: 0.25 }]}><Text style={{ color: c.sub, fontSize: 12 }}>▲</Text></Pressable>
        <Pressable onPress={() => onMove(1)} disabled={last} accessibilityRole="button" accessibilityLabel={`Move shot ${r.ord} later`}
          style={[s.move, last && { opacity: 0.25 }]}><Text style={{ color: c.sub, fontSize: 12 }}>▼</Text></Pressable>
      </View>
    </View>
  );
}

function Outputs({ items, title }: { items: QueueItem[]; title: string }) {
  return (
    <View>
      <Text style={[s.kicker, font.mono]}>{title}</Text>
      {items.length === 0 && <Text style={[s.sub, { marginTop: 8 }]}>Nothing rendered here yet. Renders appear here as they run.</Text>}
      {items.map((q) => {
        const busy = BUSY_GEN.includes(q.status);
        const word = q.decision === "approve" ? "Approved" : q.decision === "reject" ? "Rejected" : busy ? GEN[q.status] : q.verdict ? verdictLabel(q.verdict) : GEN[q.status] ?? q.status;
        const col = q.decision === "approve" ? c.pass : q.decision === "reject" ? c.muted : busy ? c.ink : verdictColor(q.verdict);
        return (
          <Pressable key={q.id} style={s.out} accessibilityRole="link" disabled={busy}
            onPress={() => router.navigate({ pathname: "/clip/[id]", params: { id: q.id } })}>
            <View style={s.outThumb}>
              {q.thumb_url ? <Image source={{ uri: q.thumb_url }} style={{ width: "100%", height: "100%", opacity: busy ? 0.5 : 1 }} resizeMode="cover" /> : null}
              {busy ? <ActivityIndicator style={StyleSheet.absoluteFill} color={c.ink} /> : <View style={s.play}><Icon name="play" size={14} color={c.ink} /></View>}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[s.meta, font.mono]}>SH {pad2(q.shot_ord)} · {(MODEL_NAMES[q.model_id] ?? q.model_id).toUpperCase()}</Text>
              <Text style={{ color: col, fontSize: 13, fontWeight: "600", marginTop: 3 }}>{word}</Text>
              <Text style={[s.meta, { marginTop: 2 }]}>{new Date(q.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function Workspace() {
  const { width } = useWindowDimensions();
  const narrow = width < 760, wide = width >= 1360;
  const p = useLocalSearchParams<{ series?: string; scene?: string; shot?: string }>();
  const [series, setSeries] = useState<Series[] | null>(null);
  const [rows, setRows] = useState<ShotRow[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [se, sh, q] = await Promise.all([api.series(), api.shots(), api.queue()]);
      setSeries(se); setRows(sh); setQueue(q); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const cur = series?.find((x) => x.id === p.series) ?? series?.[0] ?? null;
  const scene = cur?.scenes.find((x) => x.id === p.scene) ?? cur?.scenes[0] ?? null;
  const shots = useMemo(() => rows.filter((r) => r.scene_id === scene?.id), [rows, scene?.id]);
  const shotId = p.shot && shots.some((r) => r.id === p.shot) ? p.shot : !narrow ? (shots.find((r) => !r.has_approved_clip) ?? shots[0])?.id : undefined;
  const sceneOutputs = useMemo(() => { const ids = new Set(shots.map((r) => r.id)); return queue.filter((q) => ids.has(q.shot_id)).slice(0, 20); }, [queue, shots]);

  // keep the board and the outputs current while anything in this scene is being made
  const anyBusy = shots.some(isBusy) || sceneOutputs.some((q) => BUSY_GEN.includes(q.status));
  useEffect(() => { if (!anyBusy) return; const t = setInterval(load, 5000); return () => clearInterval(t); }, [anyBusy, load]);

  const pick = (o: { series?: string; scene?: string; shot?: string }) => router.setParams({
    series: o.series ?? cur?.id ?? "", scene: o.scene ?? (o.series ? "" : scene?.id ?? ""), shot: o.shot ?? "",
  });
  const openShot = (id: string) => narrow ? router.push({ pathname: "/shot/[id]", params: { id } }) : pick({ shot: id });
  const done = (err?: string) => { if (err) setError(err); load(); };

  if (!series && !error) return <ActivityIndicator style={{ marginTop: 40 }} />;

  const project = (
    <ScrollView style={[s.pane, !narrow && { width: wide ? 360 : 330, flexGrow: 0, borderRightWidth: 1, borderRightColor: c.line }]}
      contentContainerStyle={{ padding: narrow ? 14 : 16, gap: 12, paddingBottom: 40 }}>
      {error && <Text style={{ color: c.fail }}>{error}</Text>}
      <Text style={[s.kicker, font.mono]}>SERIES</Text>
      <View style={s.row}>
        {series?.map((se) => (
          <Pressable key={se.id} onPress={() => pick({ series: se.id })} style={[s.chip, se.id === cur?.id && s.chipOn]}
            accessibilityRole="radio" accessibilityState={{ checked: se.id === cur?.id }}>
            <Text style={{ color: se.id === cur?.id ? c.onAccent : c.ink, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>{se.name}</Text>
          </Pressable>
        ))}
      </View>
      <NewSeries onDone={(id, err) => { if (err) setError(err); load().then(() => id && pick({ series: id })); }} />
      {cur && (<>
        <View style={[s.row, { marginTop: 4 }]}>
          <Text style={[s.tag, font.mono]}>{cur.look === "photoreal" ? "PHOTOREAL" : "CARTOON"}</Text>
          {cur.genre && <Text style={[s.tagGhost, font.mono]}>{GENRE_NAMES[cur.genre].toUpperCase()}</Text>}
          <Pressable onPress={() => router.navigate({ pathname: "/library", params: { series: cur.id } })} accessibilityRole="link">
            <Text style={[s.link, { marginVertical: 0, fontSize: 13 }]}>Cast & places</Text>
          </Pressable>
        </View>
        <Manage key={`se-${cur.id}`} label="series" name={cur.name}
          what={`its ${cur.scenes.length} scene${cur.scenes.length === 1 ? "" : "s"}, every shot, clip, cut, character and place in it`}
          onRename={async (v) => { await api.renameSeries(cur.id, v); await load(); }}
          onDelete={async () => { await api.deleteSeries(cur.id); router.setParams({ series: "", scene: "", shot: "" }); await load(); }} />
        <Text style={[s.kicker, font.mono, { marginTop: 8 }]}>SCENE</Text>
        <View style={s.row}>
          {cur.scenes.map((sc) => (
            <Pressable key={sc.id} onPress={() => pick({ scene: sc.id })} style={[s.sceneChip, sc.id === scene?.id && s.sceneOn]}
              accessibilityRole="radio" accessibilityState={{ checked: sc.id === scene?.id }}>
              <Text style={[{ color: c.sub, fontSize: 10 }, font.mono]}>{pad2(sc.ord)}</Text>
              <Text style={{ color: c.ink, fontSize: 13 }} numberOfLines={1}>{sc.title}</Text>
            </Pressable>
          ))}
          <NewScene seriesId={cur.id} onDone={done} />
        </View>
        {scene && <Manage key={`sc-${scene.id}`} label="scene" name={scene.title}
          what={`its ${shots.length} shot${shots.length === 1 ? "" : "s"}, their clips, frames, cuts and sound`}
          onRename={async (v) => { await api.renameScene(scene.id, v); await load(); }}
          onDelete={async () => { await api.deleteScene(scene.id); router.setParams({ scene: "", shot: "" }); await load(); }} />}
      </>)}
      {scene && (<>
        <View style={[s.row, { justifyContent: "space-between", marginTop: 8 }]}>
          <Text style={[s.kicker, font.mono]}>SHOTS · {shots.length} · {shots.reduce((t, r) => t + r.duration_s, 0)} S</Text>
          <Pressable onPress={() => router.navigate({ pathname: "/cut/[scene]", params: { scene: scene.id } })} accessibilityRole="link">
            <Text style={[s.link, { marginVertical: 0, fontSize: 13 }]}>Make the scene cut</Text>
          </Pressable>
        </View>
        {shots.length === 0 && <Text style={s.sub}>No shots yet. Describe the first one below.</Text>}
        {shots.map((r, i) => <ShotRowItem key={r.id} r={r} on={r.id === shotId} onPress={() => openShot(r.id)} first={i === 0} last={i === shots.length - 1}
          onMove={async (dir) => { try { await api.moveShot(r.id, dir); await load(); } catch (e) { setError((e as Error).message); } }} />)}
        {shots.length > 1 && <Text style={s.small}>Moving a shot changes which shot "continue from the previous clip" uses.</Text>}
        <AddShot sceneId={scene.id} onDone={done} onCreated={(id) => { load(); openShot(id); }} />
        <Pressable onPress={() => router.navigate("/shots")} accessibilityRole="link"><Text style={[s.link, { fontSize: 13 }]}>See every scene on the scene board</Text></Pressable>
      </>)}
      {cur && cur.scenes.length === 0 && <Text style={s.sub}>Add a scene to start writing shots.</Text>}
      {narrow && scene && (
        <View style={{ marginTop: 16 }}><Outputs items={sceneOutputs.slice(0, 6)} title="MADE IN THIS SCENE" /></View>
      )}
    </ScrollView>
  );

  if (narrow) return <View style={{ flex: 1, backgroundColor: pageBg }}>{project}</View>;

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: pageBg }}>
      {project}
      <View style={{ flex: 1, minWidth: 0 }}>
        {shotId ? <ShotPanel key={shotId} id={shotId} onRendered={load} onDeleted={() => { pick({ shot: "" }); load(); }} />
          : (
            <View style={s.empty}>
              <Icon name="workspace" size={36} color={c.muted} />
              <Text style={[{ color: c.ink, fontSize: 22, marginTop: 14, textTransform: "uppercase" }, font.display]}>
                {!cur ? "Start a series" : !scene ? "Add a scene" : "Write the first shot"}</Text>
              <Text style={[s.sub, { textAlign: "center", maxWidth: 420, marginTop: 6 }]}>
                {!cur ? "A series holds your characters, places and look. Create one on the left."
                  : !scene ? "Scenes hold the shots that play in one place. Add one on the left."
                  : "Describe what happens in the shot on the left. It opens here to make its frames and render it."}</Text>
            </View>
          )}
      </View>
      {wide && (
        <ScrollView style={[s.pane, { width: 300, flexGrow: 0, borderLeftWidth: 1, borderLeftColor: c.line }]} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <Outputs items={sceneOutputs} title={`MADE IN ${(scene?.title ?? "THIS SCENE").toUpperCase()}`} />
          <Pressable onPress={() => router.navigate("/storage")} accessibilityRole="link" style={{ marginTop: 12 }}>
            <Text style={[s.link, { fontSize: 13 }]}>All your assets</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  pane: { backgroundColor: c.rail },
  kicker: { color: c.sub, fontSize: 11, letterSpacing: 0.9 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.field, maxWidth: 260 },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  sceneChip: { borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: c.field, flexDirection: "row", gap: 6, alignItems: "center", maxWidth: 300 },
  sceneOn: { borderColor: c.accent, backgroundColor: "#22140A" },
  tag: { color: c.onAccent, backgroundColor: c.ink, fontSize: 10, fontWeight: "600", letterSpacing: 0.8, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, overflow: "hidden" },
  tagGhost: { color: c.sub, borderWidth: 1, borderColor: c.line, fontSize: 10, letterSpacing: 0.8, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  shot: { flexDirection: "row", gap: 10, padding: 8, borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.card },
  shotOn: { borderColor: c.accent, backgroundColor: "#1A120B" },
  shotThumb: { width: 104, aspectRatio: 16 / 9, borderRadius: 8, overflow: "hidden", backgroundColor: c.card2 },
  slate: { position: "absolute", top: 4, left: 4, color: c.ink, backgroundColor: "rgba(8,8,10,0.8)", fontSize: 9, letterSpacing: 0.5, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 2, overflow: "hidden" },
  status: { fontSize: 10, fontWeight: "700", borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, overflow: "hidden" },
  meta: { color: c.sub, fontSize: 10, letterSpacing: 0.4 },
  sub: { color: c.sub, fontSize: 13 }, label: { color: c.sub, fontSize: 12 },
  link: { color: c.link, fontSize: 14, marginVertical: 4 },
  form: { backgroundColor: c.card, borderRadius: 14, borderWidth: 1, borderColor: c.line, padding: 12, gap: 8 },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 10, color: c.ink, backgroundColor: c.bg, fontSize: 14 },
  btn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 }, btnText: { color: c.onAccent, fontWeight: "700" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  out: { flexDirection: "row", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, alignItems: "center" },
  outThumb: { width: 92, aspectRatio: 16 / 9, borderRadius: 8, overflow: "hidden", backgroundColor: c.card2, justifyContent: "center", alignItems: "center" },
  small: { color: c.sub, fontSize: 12 },
  danger: { backgroundColor: c.failBg, borderColor: c.failLine, borderWidth: 1, borderRadius: 10, padding: 10, gap: 8 },
  move: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: c.field },
  play: { position: "absolute", width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(8,8,10,0.75)", alignItems: "center", justifyContent: "center" },
});

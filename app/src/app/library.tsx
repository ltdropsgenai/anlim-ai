// Characters & locations of a series: reference images, empty-room plates (uploaded, or made from a shot's start
// frame), which location each scene is in, new characters and locations. What "new setup" start frames are made from.
// @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, ASPECTS, FRAME_CREDITS, Genre, GENRE_NAMES, Kind, Library, Look, Series, ShotRow, uploadImage, Quality, QUALITY_NAMES, QUALITY_HELP } from "../lib/api";
import { c, font, pageBg } from "../lib/theme";
import { StillPicker } from "../components/StillPicker";

const MAKING = ["queued", "running", "composing"];
const LOOKS: { id: Look; title: string; sub: string }[] = [
  { id: "cartoon", title: "Cartoon", sub: "Drawn or animated characters" },
  { id: "photoreal", title: "Photoreal", sub: "Looks filmed with a camera" },
];
const QUALITIES: Quality[] = ["best", "balanced", "economy"];
// a cast member can be a person, an animal or an object, in either look (2026-11-16)
const KINDS: { id: Kind; title: string; what: string; looks: string }[] = [
  { id: "person", title: "Person", what: "Who, e.g. girl about 6, grey-haired grandfather", looks: "Usual clothes" },
  { id: "animal", title: "Animal", what: "What animal, e.g. golden retriever, tabby cat", looks: "Fur, markings, collar…" },
  { id: "object", title: "Object", what: "What it is, e.g. red toy dump truck, robot vacuum", looks: "Colours, materials, details" },
];

function Pic({ uri, label, ratio = 16 / 9 }: { uri: string | null; label: string; ratio?: number }) {
  return (
    <View style={[s.pic, { aspectRatio: ratio }]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel={label} />
        : <Text style={[s.sub, { padding: 10 }]}>No image yet</Text>}
    </View>
  );
}

export default function LibraryScreen() {
  const params = useLocalSearchParams<{ series?: string }>();
  const [series, setSeries] = useState<Series[] | null>(null);
  const [sid, setSid] = useState<string | null>(params.series ?? null);
  const [lib, setLib] = useState<Library | null>(null);
  const [shots, setShots] = useState<ShotRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ch, setCh] = useState<{ name: string; height: string; wardrobe: string; kind: Kind; what: string }>(
    { name: "", height: "", wardrobe: "", kind: "person", what: "" });
  // editing one character's card (2026-11-18): its id and the form values
  const [edId, setEdId] = useState<string | null>(null);
  const [ed, setEd] = useState<{ name: string; height: string; wardrobe: string; kind: Kind; what: string }>(
    { name: "", height: "", wardrobe: "", kind: "person", what: "" });
  const [loc, setLoc] = useState({ name: "", description: "" });
  const [newSeries, setNewSeries] = useState("");
  const [newLook, setNewLook] = useState<Look | null>(null);   // 2026-11-23 (Londi): no default look
  const [newQuality, setNewQuality] = useState<Quality>("balanced");   // 2026-11-19: asked when the series is made
  const [style, setStyle] = useState<string | null>(null);         // the current series' style text while it is edited
  const [platePick, setPlatePick] = useState<string | null>(null);   // location whose "make from a shot" list is open

  const load = useCallback(async () => {
    try {
      const [se, sh] = await Promise.all([api.series(), api.shots()]);
      setSeries(se); setShots(sh);
      const cur = sid ?? se[0]?.id ?? null; if (cur !== sid) setSid(cur);
      setLib(cur ? await api.library(cur) : null); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [sid]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const making = !!lib?.locations.some((l) => l.job_status && MAKING.includes(l.job_status));
  useEffect(() => { if (!making) return; const t = setInterval(load, 4000); return () => clearInterval(t); }, [making, load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  if (!series) return error ? <Text style={[s.err, { padding: 16 }]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 40 }} />;
  const cur = series.find((x) => x.id === sid);
  const withStill = shots.filter((r) => r.series_id === sid && r.has_start_frame);

  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={s.page}>
      <View style={s.row}>
        {series.map((x) => (
          <Pressable key={x.id} onPress={() => { setSid(x.id); setLib(null); setStyle(null); }} style={[s.chip, x.id === sid && s.chipOn]} accessibilityRole="tab"
            accessibilityState={{ selected: x.id === sid }}>
            <Text style={x.id === sid ? { color: c.onAccent } : { color: c.ink }}>{x.name}</Text>
          </Pressable>
        ))}
        <TextInput style={[s.input, { minWidth: 180 }]} value={newSeries} onChangeText={setNewSeries} placeholderTextColor={c.muted} placeholder="New series name" />
        {LOOKS.map((l) => (
          <Pressable key={l.id} onPress={() => setNewLook(l.id)} style={[s.chip, newLook === l.id && s.chipOn]} accessibilityRole="radio"
            accessibilityState={{ checked: newLook === l.id }}>
            <Text style={newLook === l.id ? { color: c.onAccent } : { color: c.ink }}>{l.title}</Text>
          </Pressable>
        ))}
        {QUALITIES.map((q) => (
          <Pressable key={q} onPress={() => setNewQuality(q)} style={[s.chip, newQuality === q && s.chipOn]} accessibilityRole="radio"
            accessibilityState={{ checked: newQuality === q }}>
            <Text style={newQuality === q ? { color: c.onAccent } : { color: c.ink }}>{QUALITY_NAMES[q]}</Text>
          </Pressable>
        ))}
        <Pressable style={[s.btn, (!newSeries.trim() || !newLook) && { opacity: 0.5 }]} disabled={!newSeries.trim() || !newLook || busy} accessibilityRole="button"
          accessibilityHint={newLook ? undefined : "Choose Cartoon or Photoreal first"}
          onPress={() => run(async () => {
            if (!newLook) return;
            const r = await api.createSeries(newSeries, newLook);
            if (newQuality !== "balanced") await api.setSeriesQuality(r.id, newQuality);
            setNewSeries(""); setSid(r.id);
          })}>
          <Text style={s.btnText}>Create series</Text>
        </Pressable>
      </View>
      {cur && (
        <View style={s.card}>
          <Text style={s.title}>Look</Text>
          <Text style={s.sub}>Sets how frames are made and how clips are checked. A change applies to frames and renders made after it.</Text>
          <View style={s.row}>
            {LOOKS.map((l) => (
              <Pressable key={l.id} disabled={busy || cur.look === l.id} onPress={() => run(() => api.updateSeries(cur.id, l.id))}
                style={[s.chip, cur.look === l.id && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: cur.look === l.id }}>
                <Text style={cur.look === l.id ? { color: c.onAccent } : { color: c.ink }}>{l.title}</Text>
              </Pressable>
            ))}
            <Text style={s.sub}>{LOOKS.find((l) => l.id === cur.look)?.sub}</Text>
          </View>
          <Text style={[s.title, { marginTop: 14 }]}>Shape</Text>
          <Text style={s.sub}>The frame shape of new images and clips. Clips already made keep theirs; a cut can still be exported in any shape.</Text>
          <View style={s.row}>
            {ASPECTS.map((a) => {
              const on = (cur.aspect ?? "16:9") === a.id;
              return (
                <Pressable key={a.id} disabled={busy || on} onPress={() => run(() => api.setSeriesAspect(cur.id, a.id))}
                  style={[s.chip, on && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={`${a.label}, ${a.hint}`}>
                  <Text style={on ? { color: c.onAccent } : { color: c.ink }}>{a.label}</Text>
                </Pressable>
              );
            })}
            <Text style={s.sub}>{ASPECTS.find((a) => a.id === (cur.aspect ?? "16:9"))?.hint}</Text>
          </View>
          <Text style={[s.title, { marginTop: 14 }]}>Genre</Text>
          <Text style={s.sub}>Optional. Files this series' work in Assets so you can filter by it; it does not change how anything is made.</Text>
          <View style={s.row}>
            {(Object.keys(GENRE_NAMES) as Genre[]).map((g) => (
              <Pressable key={g} disabled={busy} onPress={() => run(() => api.setSeriesGenre(cur.id, cur.genre === g ? null : g))}
                style={[s.chip, cur.genre === g && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: cur.genre === g }}>
                <Text style={cur.genre === g ? { color: c.onAccent } : { color: c.ink }}>{GENRE_NAMES[g]}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[s.title, { marginTop: 14 }]}>Model choice</Text>
          <Text style={s.sub}>Auto picks a video model for every shot from our tests. This sets what it favours. You can still pick a model on any shot.</Text>
          <View style={s.row}>
            {QUALITIES.map((q) => (
              <Pressable key={q} disabled={busy || cur.quality === q} onPress={() => run(() => api.setSeriesQuality(cur.id, q))}
                style={[s.chip, cur.quality === q && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: cur.quality === q }}>
                <Text style={cur.quality === q ? { color: c.onAccent } : { color: c.ink }}>{QUALITY_NAMES[q]}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.sub}>{QUALITY_HELP[cur.quality ?? "balanced"]}</Text>
          <TextInput style={s.input} multiline value={style ?? cur.style_prompt ?? ""} onChangeText={setStyle} placeholderTextColor={c.muted}
            placeholder={cur.look === "photoreal" ? "Style, e.g. natural daylight, 35 mm film look, shallow depth of field"
              : "Style, e.g. 2D children's cartoon, flat colours, clean outlines"} />
          {style !== null && style !== (cur.style_prompt ?? "") && (
            <Pressable style={s.btn} disabled={busy} accessibilityRole="button"
              onPress={() => run(async () => { await api.updateSeries(cur.id, undefined, style); setStyle(null); })}>
              <Text style={s.btnText}>Save style</Text>
            </Pressable>
          )}
        </View>
      )}
      {error && <Text style={s.err}>{error}</Text>}
      {busy && <ActivityIndicator style={{ marginTop: 8 }} />}
      {cur && !lib && <ActivityIndicator style={{ marginTop: 20 }} />}
      {cur && lib && (<>
        <Text style={[s.h, font.display]}>Characters</Text>
        <Text style={s.sub}>People, animals or objects. One reference image each: the whole of them, front on, as they usually look. New setups draw them from it.</Text>
        <View style={s.grid}>
          {lib.characters.map((x) => (
            <View key={x.id} style={[s.card, s.cell]}>
              <Text style={s.title}>{x.name}</Text>
              <Text style={s.sub}>{[KINDS.find((k) => k.id === x.kind)?.title, x.what, x.height_units ? `height ${Number(x.height_units)}` : null,
                x.wardrobe].filter(Boolean).join(" · ") || " "}</Text>
              <Pic uri={x.ref_url} label={`${x.name} reference`} ratio={3 / 4} />
              <StillPicker label={x.ref_url ? "Replace reference" : "Upload reference"} disabled={busy} style={{}} textStyle={s.link} onError={setError}
                onPick={(f) => run(async () => api.setCharacterRef(x.id, await uploadImage(lib.owner, "characters", x.id, f, f.type)))} />
              {edId !== x.id ? (
                <Pressable disabled={busy} accessibilityRole="button" onPress={() => { setEdId(x.id);
                  setEd({ name: x.name, height: x.height_units == null ? "" : String(Number(x.height_units)), wardrobe: x.wardrobe ?? "", kind: x.kind, what: x.what ?? "" }); }}>
                  <Text style={s.link}>Edit</Text>
                </Pressable>
              ) : (<>
                <View style={s.row}>
                  {KINDS.map((k) => (
                    <Pressable key={k.id} onPress={() => setEd({ ...ed, kind: k.id })} style={[s.chip, ed.kind === k.id && s.chipOn]} accessibilityRole="radio"
                      accessibilityState={{ checked: ed.kind === k.id }}>
                      <Text style={ed.kind === k.id ? { color: c.onAccent } : { color: c.ink }}>{k.title}</Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput style={s.input} value={ed.name} onChangeText={(v) => setEd({ ...ed, name: v })} placeholderTextColor={c.muted} placeholder="Name" />
                <TextInput style={s.input} value={ed.what} onChangeText={(v) => setEd({ ...ed, what: v })} placeholderTextColor={c.muted}
                  placeholder={KINDS.find((k) => k.id === ed.kind)!.what} />
                <TextInput style={s.input} value={ed.height} onChangeText={(v) => setEd({ ...ed, height: v })} keyboardType="decimal-pad"
                  placeholderTextColor={c.muted} placeholder="Height, relative (e.g. tallest 10, a shorter one 8)" />
                <TextInput style={s.input} value={ed.wardrobe} onChangeText={(v) => setEd({ ...ed, wardrobe: v })} placeholderTextColor={c.muted}
                  placeholder={KINDS.find((k) => k.id === ed.kind)!.looks} />
                <Text style={s.sub}>Changes apply to frames and renders made from now on; finished ones keep what they were made with.</Text>
                <View style={s.row}>
                  <Pressable style={[s.btn, !ed.name.trim() && { opacity: 0.5 }]} disabled={!ed.name.trim() || busy} accessibilityRole="button"
                    onPress={() => run(async () => { await api.updateCharacter(x.id, ed.name, ed.height, ed.wardrobe, ed.kind, ed.what); setEdId(null); })}>
                    <Text style={s.btnText}>Save</Text>
                  </Pressable>
                  <Pressable style={s.ghost} disabled={busy} accessibilityRole="button" onPress={() => setEdId(null)}><Text style={{ color: c.ink }}>Cancel</Text></Pressable>
                </View>
              </>)}
            </View>
          ))}
          <View style={[s.card, s.cell]}>
            <Text style={s.title}>New character</Text>
            <View style={s.row}>
              {KINDS.map((k) => (
                <Pressable key={k.id} onPress={() => setCh({ ...ch, kind: k.id })} style={[s.chip, ch.kind === k.id && s.chipOn]} accessibilityRole="radio"
                  accessibilityState={{ checked: ch.kind === k.id }}>
                  <Text style={ch.kind === k.id ? { color: c.onAccent } : { color: c.ink }}>{k.title}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput style={s.input} value={ch.name} onChangeText={(v) => setCh({ ...ch, name: v })} placeholderTextColor={c.muted} placeholder="Name" />
            <TextInput style={s.input} value={ch.what} onChangeText={(v) => setCh({ ...ch, what: v })} placeholderTextColor={c.muted}
              placeholder={KINDS.find((k) => k.id === ch.kind)!.what} />
            <TextInput style={s.input} value={ch.height} onChangeText={(v) => setCh({ ...ch, height: v })} keyboardType="decimal-pad"
              placeholderTextColor={c.muted} placeholder="Height, relative (e.g. tallest 10, a shorter one 8)" />
            <TextInput style={s.input} value={ch.wardrobe} onChangeText={(v) => setCh({ ...ch, wardrobe: v })} placeholderTextColor={c.muted} placeholder={KINDS.find((k) => k.id === ch.kind)!.looks} />
            <Pressable style={[s.btn, !ch.name.trim() && { opacity: 0.5 }]} disabled={!ch.name.trim() || busy} accessibilityRole="button"
              onPress={() => run(async () => { await api.createCharacter(cur.id, ch.name, ch.height, ch.wardrobe, ch.kind, ch.what);
                setCh({ name: "", height: "", wardrobe: "", kind: ch.kind, what: "" }); })}>
              <Text style={s.btnText}>Add character</Text>
            </Pressable>
          </View>
        </View>

        <Text style={[s.h, font.display]}>Locations</Text>
        <Text style={s.sub}>
          A plate is the location as an empty room, framed as the shots are. Upload one, or make it from a shot's start frame:
          every character is removed and the room is kept pixel-for-pixel ({FRAME_CREDITS} credits). Each camera framing
          (wide, close at the table…) needs its own plate: make one from a shot in that framing. Earlier plates are kept and
          used automatically for shots framed like them; the newest is used for New setup.
        </Text>
        {lib.locations.map((l) => {
          const jobMaking = !!l.job_status && MAKING.includes(l.job_status), ready = l.job_status === "ready";
          return (
            <View key={l.id} style={[s.card, { marginBottom: 12 }]}>
              <Text style={s.title}>{l.name}</Text>
              {l.description && <Text style={s.sub}>{l.description}</Text>}
              <View style={s.grid}>
                <View style={s.col}><Text style={s.label}>Plate{l.other_plates ? ` (newest; ${l.other_plates} other framing${l.other_plates > 1 ? "s" : ""} kept)` : ""}</Text>
                  <Pic uri={l.plate_url} label={`${l.name} plate`} /></View>
                {(ready || jobMaking) && (
                  <View style={s.col}><Text style={s.label}>{jobMaking ? "New plate (being made, about a minute)" : "New plate (not approved yet)"}</Text>
                    {jobMaking ? <View style={[s.pic, { aspectRatio: 16 / 9 }]}><ActivityIndicator /></View> : <Pic uri={l.job_url} label="new plate" />}</View>
                )}
              </View>
              {ready && (<>
                {l.job_check?.verdict === "PASS"
                  ? <Text style={[s.badge, { color: c.pass, borderColor: c.pass }]}>Check: the room is unchanged</Text>
                  : <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>Check: something in the room changed. Look closely.</Text>}
                <Text style={s.sub}>Look where the characters stood: nobody should be left, and no shadow or outline.</Text>
                <View style={s.row}>
                  <Pressable style={[s.btn, { backgroundColor: c.pass }]} disabled={busy} accessibilityRole="button" onPress={() => run(() => api.decideFrame(l.job_id!, "approve"))}>
                    <Text style={s.btnText}>Use this plate</Text>
                  </Pressable>
                  <Pressable style={s.ghost} disabled={busy} accessibilityRole="button" onPress={() => run(() => api.decideFrame(l.job_id!, "discard"))}><Text style={{ color: c.ink }}>Discard</Text></Pressable>
                </View>
              </>)}
              {l.job_status === "failed" && <Text style={s.err}>The last plate could not be made: {l.job_error ?? "unknown error"}. No credits were charged.</Text>}
              {!jobMaking && !ready && (
                <View style={s.row}>
                  <StillPicker label={l.plate_url ? "Upload a different plate" : "Upload plate"} disabled={busy} style={{}} textStyle={s.link} onError={setError}
                    onPick={(f) => run(async () => api.setLocationPlate(l.id, await uploadImage(lib.owner, "locations", l.id, f, f.type)))} />
                  <Pressable onPress={() => setPlatePick(platePick === l.id ? null : l.id)} accessibilityRole="button">
                    <Text style={s.link}>Make the plate from a shot</Text>
                  </Pressable>
                </View>
              )}
              {platePick === l.id && !jobMaking && !ready && (
                <View style={s.row}>
                  {withStill.length === 0 && <Text style={s.sub}>No shot in this series has a start frame yet.</Text>}
                  {withStill.map((r) => (
                    <Pressable key={r.id} style={s.chip} disabled={busy} accessibilityRole="button"
                      onPress={() => run(async () => { await api.requestPlate(l.id, r.id); setPlatePick(null); })}>
                      <Text style={{ color: c.ink }}>{r.scene_title} · shot {r.ord}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <View style={s.row}>
                <Text style={[s.label, { color: c.ink, fontWeight: "600" }]}>Scenes in this location (tap to add or remove):</Text>
                {cur.scenes.map((sc) => {
                  const on = l.scene_ids.includes(sc.id);
                  return (
                    <Pressable key={sc.id} style={[s.chip, on && s.chipOn]} disabled={busy} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                      onPress={() => run(() => api.setSceneLocation(sc.id, on ? null : l.id))}>
                      <Text style={on ? { color: c.onAccent } : { color: c.ink }}>{sc.title}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
        <View style={s.card}>
          <Text style={s.title}>New location</Text>
          <TextInput style={s.input} value={loc.name} onChangeText={(v) => setLoc({ ...loc, name: v })} placeholderTextColor={c.muted} placeholder="Name, e.g. Playroom" />
          <TextInput style={s.input} value={loc.description} onChangeText={(v) => setLoc({ ...loc, description: v })} placeholderTextColor={c.muted} placeholder="What is in it (optional)" />
          <Pressable style={[s.btn, !loc.name.trim() && { opacity: 0.5 }]} disabled={!loc.name.trim() || busy} accessibilityRole="button"
            onPress={() => run(async () => { await api.createLocation(cur.id, loc.name, loc.description); setLoc({ name: "", description: "" }); })}>
            <Text style={s.btnText}>Add location</Text>
          </Pressable>
        </View>
      </>)}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, maxWidth: 1100, width: "100%", alignSelf: "center" },
  h: { fontSize: 18, fontWeight: "700", color: c.ink, marginTop: 22, marginBottom: 6 },
  title: { color: c.ink, fontWeight: "700", marginBottom: 4 },
  sub: { color: c.sub, fontSize: 13, marginBottom: 6 }, label: { color: c.sub, fontSize: 13, marginBottom: 4 },
  err: { color: c.fail, marginTop: 8 }, link: { color: c.accent, fontSize: 14, marginVertical: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  // card: full-width blocks in the page column. cell: a card inside a wrapping row (flexBasis there is a width;
  // in the page column it became a fixed 220 px height and the location card's content spilled over the next card)
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12, gap: 6 },
  cell: { flexGrow: 1, flexBasis: 220, minWidth: 0 },
  col: { flexGrow: 1, flexBasis: 300, minWidth: 0 },
  pic: { width: "100%", backgroundColor: "#000", borderRadius: 8, overflow: "hidden", justifyContent: "center" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 6 },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.field },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, color: c.ink, backgroundColor: c.field },
  btn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: "center" }, btnText: { color: c.onAccent, fontWeight: "600" },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: "center", backgroundColor: c.field },
  badge: { alignSelf: "flex-start", borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, fontSize: 12, fontWeight: "600" },
});

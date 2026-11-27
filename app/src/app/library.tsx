// Characters & locations of a series: reference images, empty-room plates (uploaded, or made from a shot's start
// frame), which location each scene is in, new characters and locations. What "new setup" start frames are made from.
// @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, ASPECTS, FRAME_CREDITS, Genre, GENRE_NAMES, Kind, Library, Look, Series, ShotRow, uploadImage, Quality, QUALITY_NAMES, QUALITY_HELP } from "../lib/api";
import { c, font, pageBg } from "../lib/theme";
import { StillPicker } from "../components/StillPicker";
import { LikenessConsent } from "../components/LikenessConsent";
import { ProjectDownload } from "../components/ProjectDownload";

// Style presets for cartoon projects (2026-11-24). The words go to the image and video models as the project's style.
const STYLE_PRESETS = [
  { id: "3d", label: "3D animated",
    text: "3D animated feature-film look: stylised proportions, expressive faces, soft rendered skin and fabric, cinematic lighting; clearly animated, not a photograph" },
  { id: "2d", label: "2D cartoon", text: "2D cartoon: flat colours, clean outlines, simple shading" },
  { id: "anime", label: "Anime", text: "Anime style: crisp line art, cel shading, vivid colours, detailed backgrounds" },
];
import { tr, trDeep, trp, tMsg } from "../lib/i18n";

const MAKING = ["queued", "running", "composing"];
const LOOKS: { id: Look; title: string; sub: string }[] = trDeep([
  { id: "cartoon", title: "Cartoon", sub: "Drawn or animated characters" },
  { id: "photoreal", title: "Photoreal", sub: "Looks filmed with a camera" },
], ["title", "sub"]);
const QUALITIES: Quality[] = ["best", "balanced", "economy"];
// a cast member can be a person, an animal or an object, in either look (2026-11-16)
const KINDS: { id: Kind; title: string; what: string; looks: string }[] = trDeep([
  { id: "person", title: "Person", what: "Who, e.g. girl about 6, grey-haired grandfather", looks: "Usual clothes" },
  { id: "animal", title: "Animal", what: "What animal, e.g. golden retriever, tabby cat", looks: "Fur, markings, collar…" },
  { id: "object", title: "Object", what: "What it is, e.g. red toy dump truck, robot vacuum", looks: "Colours, materials, details" },
], ["title", "what", "looks"]);

function Pic({ uri, label, ratio = 16 / 9 }: { uri: string | null; label: string; ratio?: number }) {
  return (
    <View style={[s.pic, { aspectRatio: ratio }]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel={label} />
        : <Text style={[s.sub, { padding: 10 }]}>{tr("No image yet")}</Text>}
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
  const [consent, setConsent] = useState(false);   // likeness consent for people's reference photos (2026-11-24)
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

  if (!series) return error ? <Text style={[s.err, { padding: 16 }]}>{tMsg(error)}</Text> : <ActivityIndicator style={{ marginTop: 40 }} />;
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
        <TextInput style={[s.input, { minWidth: 180 }]} value={newSeries} onChangeText={setNewSeries} placeholderTextColor={c.muted} placeholder={tr("New series name")} />
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
          accessibilityHint={newLook ? undefined : tr("Choose Cartoon or Photoreal first")}
          onPress={() => run(async () => {
            if (!newLook) return;
            const r = await api.createSeries(newSeries, newLook);
            if (newQuality !== "balanced") await api.setSeriesQuality(r.id, newQuality);
            setNewSeries(""); setSid(r.id);
          })}>
          <Text style={s.btnText}>{tr("Create series")}</Text>
        </Pressable>
      </View>
      {cur && (
        <View style={s.card}>
          <Text style={s.title}>{tr("Look")}</Text>
          <Text style={s.sub}>{tr("Sets how frames are made and how clips are checked. A change applies to frames and renders made after it.")}</Text>
          <View style={s.row}>
            {LOOKS.map((l) => (
              <Pressable key={l.id} disabled={busy || cur.look === l.id} onPress={() => run(() => api.updateSeries(cur.id, l.id))}
                style={[s.chip, cur.look === l.id && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: cur.look === l.id }}>
                <Text style={cur.look === l.id ? { color: c.onAccent } : { color: c.ink }}>{l.title}</Text>
              </Pressable>
            ))}
            <Text style={s.sub}>{LOOKS.find((l) => l.id === cur.look)?.sub}</Text>
          </View>
          <Text style={[s.title, { marginTop: 14 }]}>{tr("Shape")}</Text>
          <Text style={s.sub}>{tr("The frame shape of new images and clips. Clips already made keep theirs; a cut can still be exported in any shape.")}</Text>
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
          <Text style={[s.title, { marginTop: 14 }]}>{tr("Genre")}</Text>
          <Text style={s.sub}>{tr("Optional. Files this series' work in Assets so you can filter by it; it does not change how anything is made.")}</Text>
          <View style={s.row}>
            {(Object.keys(GENRE_NAMES) as Genre[]).map((g) => (
              <Pressable key={g} disabled={busy} onPress={() => run(() => api.setSeriesGenre(cur.id, cur.genre === g ? null : g))}
                style={[s.chip, cur.genre === g && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: cur.genre === g }}>
                <Text style={cur.genre === g ? { color: c.onAccent } : { color: c.ink }}>{GENRE_NAMES[g]}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[s.title, { marginTop: 14 }]}>{tr("Model choice")}</Text>
          <Text style={s.sub}>{tr("Auto picks a video model for every shot from our tests. This sets what it favours. You can still pick a model on any shot.")}</Text>
          <View style={s.row}>
            {QUALITIES.map((q) => (
              <Pressable key={q} disabled={busy || cur.quality === q} onPress={() => run(() => api.setSeriesQuality(cur.id, q))}
                style={[s.chip, cur.quality === q && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: cur.quality === q }}>
                <Text style={cur.quality === q ? { color: c.onAccent } : { color: c.ink }}>{QUALITY_NAMES[q]}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.sub}>{QUALITY_HELP[cur.quality ?? "balanced"]}</Text>
          {/* 2026-11-24 (Londi: recreate scenes "in cartoon 3D (realistic looking)"): style presets for cartoon projects. They
              fill the style text, which the creator can still edit; "3D animated" stays clearly animated (not photoreal). */}
          {cur.look !== "photoreal" && (
            <View style={s.row}>
              {STYLE_PRESETS.map((p) => (
                <Pressable key={p.id} disabled={busy} onPress={() => setStyle(p.text)} style={s.chip} accessibilityRole="button">
                  <Text style={{ color: c.ink }}>{tr(p.label)}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <TextInput style={s.input} multiline value={style ?? cur.style_prompt ?? ""} onChangeText={setStyle} placeholderTextColor={c.muted}
            placeholder={cur.look === "photoreal" ? tr("Style, e.g. natural daylight, 35 mm film look, shallow depth of field")
              : tr("Style, e.g. 2D children's cartoon, flat colours, clean outlines")} />
          {style !== null && style !== (cur.style_prompt ?? "") && (
            <Pressable style={s.btn} disabled={busy} accessibilityRole="button"
              onPress={() => run(async () => { await api.updateSeries(cur.id, undefined, style); setStyle(null); })}>
              <Text style={s.btnText}>{tr("Save style")}</Text>
            </Pressable>
          )}
          <ProjectDownload key={cur.id} seriesId={cur.id} />
        </View>
      )}
      {error && <Text style={s.err}>{tMsg(error)}</Text>}
      {busy && <ActivityIndicator style={{ marginTop: 8 }} />}
      {cur && !lib && <ActivityIndicator style={{ marginTop: 20 }} />}
      {cur && lib && (<>
        <Text style={[s.h, font.display]}>{tr("Characters")}</Text>
        <Text style={s.sub}>{tr("People, animals or objects. One reference image each: the whole of them, front on, as they usually look. New setups draw them from it.")}</Text>
        {lib.characters.some((x) => x.kind === "person") && <LikenessConsent on={consent} onChange={setConsent} disabled={busy} />}
        <View style={s.grid}>
          {lib.characters.map((x) => (
            <View key={x.id} style={[s.card, s.cell]}>
              <Text style={s.title}>{x.name}</Text>
              <Text style={s.sub}>{[KINDS.find((k) => k.id === x.kind)?.title, x.what, x.height_units ? `height ${Number(x.height_units)}` : null,
                x.wardrobe].filter(Boolean).join(" · ") || " "}</Text>
              <Pic uri={x.ref_url} label={tr("{name} reference", { name: x.name })} ratio={3 / 4} />
              <StillPicker label={x.ref_url ? tr("Replace reference") : tr("Upload reference")} disabled={busy || (x.kind === "person" && !consent)} style={{}}
                textStyle={s.link} onError={setError}
                onPick={(f) => run(async () => api.setCharacterRef(x.id, await uploadImage(lib.owner, "characters", x.id, f, f.type), x.kind === "person" && consent))} />
              {x.kind === "person" && !consent && <Text style={s.sub}>{tr("Tick the box above to upload a person's photo.")}</Text>}
              {edId !== x.id ? (
                <Pressable disabled={busy} accessibilityRole="button" onPress={() => { setEdId(x.id);
                  setEd({ name: x.name, height: x.height_units == null ? "" : String(Number(x.height_units)), wardrobe: x.wardrobe ?? "", kind: x.kind, what: x.what ?? "" }); }}>
                  <Text style={s.link}>{tr("Edit")}</Text>
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
                <TextInput style={s.input} value={ed.name} onChangeText={(v) => setEd({ ...ed, name: v })} placeholderTextColor={c.muted} placeholder={tr("Name")} />
                <TextInput style={s.input} value={ed.what} onChangeText={(v) => setEd({ ...ed, what: v })} placeholderTextColor={c.muted}
                  placeholder={KINDS.find((k) => k.id === ed.kind)!.what} />
                <TextInput style={s.input} value={ed.height} onChangeText={(v) => setEd({ ...ed, height: v })} keyboardType="decimal-pad"
                  placeholderTextColor={c.muted} placeholder={tr("Height, relative (e.g. tallest 10, a shorter one 8)")} />
                <TextInput style={s.input} value={ed.wardrobe} onChangeText={(v) => setEd({ ...ed, wardrobe: v })} placeholderTextColor={c.muted}
                  placeholder={KINDS.find((k) => k.id === ed.kind)!.looks} />
                <Text style={s.sub}>{tr("Changes apply to frames and renders made from now on; finished ones keep what they were made with.")}</Text>
                <View style={s.row}>
                  <Pressable style={[s.btn, !ed.name.trim() && { opacity: 0.5 }]} disabled={!ed.name.trim() || busy} accessibilityRole="button"
                    onPress={() => run(async () => { await api.updateCharacter(x.id, ed.name, ed.height, ed.wardrobe, ed.kind, ed.what); setEdId(null); })}>
                    <Text style={s.btnText}>{tr("Save")}</Text>
                  </Pressable>
                  <Pressable style={s.ghost} disabled={busy} accessibilityRole="button" onPress={() => setEdId(null)}><Text style={{ color: c.ink }}>{tr("Cancel")}</Text></Pressable>
                </View>
              </>)}
            </View>
          ))}
          <View style={[s.card, s.cell]}>
            <Text style={s.title}>{tr("New character")}</Text>
            <View style={s.row}>
              {KINDS.map((k) => (
                <Pressable key={k.id} onPress={() => setCh({ ...ch, kind: k.id })} style={[s.chip, ch.kind === k.id && s.chipOn]} accessibilityRole="radio"
                  accessibilityState={{ checked: ch.kind === k.id }}>
                  <Text style={ch.kind === k.id ? { color: c.onAccent } : { color: c.ink }}>{k.title}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput style={s.input} value={ch.name} onChangeText={(v) => setCh({ ...ch, name: v })} placeholderTextColor={c.muted} placeholder={tr("Name")} />
            <TextInput style={s.input} value={ch.what} onChangeText={(v) => setCh({ ...ch, what: v })} placeholderTextColor={c.muted}
              placeholder={KINDS.find((k) => k.id === ch.kind)!.what} />
            <TextInput style={s.input} value={ch.height} onChangeText={(v) => setCh({ ...ch, height: v })} keyboardType="decimal-pad"
              placeholderTextColor={c.muted} placeholder={tr("Height, relative (e.g. tallest 10, a shorter one 8)")} />
            <TextInput style={s.input} value={ch.wardrobe} onChangeText={(v) => setCh({ ...ch, wardrobe: v })} placeholderTextColor={c.muted} placeholder={KINDS.find((k) => k.id === ch.kind)!.looks} />
            <Pressable style={[s.btn, !ch.name.trim() && { opacity: 0.5 }]} disabled={!ch.name.trim() || busy} accessibilityRole="button"
              onPress={() => run(async () => { await api.createCharacter(cur.id, ch.name, ch.height, ch.wardrobe, ch.kind, ch.what);
                setCh({ name: "", height: "", wardrobe: "", kind: ch.kind, what: "" }); })}>
              <Text style={s.btnText}>{tr("Add character")}</Text>
            </Pressable>
          </View>
        </View>

        <Text style={[s.h, font.display]}>{tr("Locations")}</Text>
        <Text style={s.sub}>
          {tr("A plate is the location as an empty room, framed as the shots are. Upload one, or make it from a shot's start frame: every character is removed and the room is kept pixel-for-pixel ({FRAME_CREDITS} credits). Each camera framing (wide, close at the table…) needs its own plate: make one from a shot in that framing. Earlier plates are kept and used automatically for shots framed like them; the newest is used for New setup.", { FRAME_CREDITS })}</Text>
        {lib.locations.map((l) => {
          const jobMaking = !!l.job_status && MAKING.includes(l.job_status), ready = l.job_status === "ready";
          return (
            <View key={l.id} style={[s.card, { marginBottom: 12 }]}>
              <Text style={s.title}>{l.name}</Text>
              {l.description && <Text style={s.sub}>{l.description}</Text>}
              <View style={s.grid}>
                <View style={s.col}><Text style={s.label}>{l.other_plates ? trp(l.other_plates, "Plate (newest; {n} other framing kept)", "Plate (newest; {n} other framings kept)") : tr("Plate")}</Text>
                  <Pic uri={l.plate_url} label={tr("{name} plate", { name: l.name })} /></View>
                {(ready || jobMaking) && (
                  <View style={s.col}><Text style={s.label}>{jobMaking ? tr("New plate (being made, about a minute)") : tr("New plate (not approved yet)")}</Text>
                    {jobMaking ? <View style={[s.pic, { aspectRatio: 16 / 9 }]}><ActivityIndicator /></View> : <Pic uri={l.job_url} label={tr("new plate")} />}</View>
                )}
              </View>
              {ready && (<>
                {l.job_check?.verdict === "PASS"
                  ? <Text style={[s.badge, { color: c.pass, borderColor: c.pass }]}>{tr("Check: the room is unchanged")}</Text>
                  : <Text style={[s.badge, { color: c.flag, borderColor: c.flag }]}>{tr("Check: something in the room changed. Look closely.")}</Text>}
                <Text style={s.sub}>{tr("Look where the characters stood: nobody should be left, and no shadow or outline.")}</Text>
                <View style={s.row}>
                  <Pressable style={[s.btn, { backgroundColor: c.pass }]} disabled={busy} accessibilityRole="button" onPress={() => run(() => api.decideFrame(l.job_id!, "approve"))}>
                    <Text style={s.btnText}>{tr("Use this plate")}</Text>
                  </Pressable>
                  <Pressable style={s.ghost} disabled={busy} accessibilityRole="button" onPress={() => run(() => api.decideFrame(l.job_id!, "discard"))}><Text style={{ color: c.ink }}>{tr("Discard")}</Text></Pressable>
                </View>
              </>)}
              {l.job_status === "failed" && <Text style={s.err}>{tr("The last plate could not be made: {v0}. No credits were charged.", { v0: tMsg(l.job_error ?? "unknown error") })}</Text>}
              {!jobMaking && !ready && cur.look === "cartoon" && (
                // 2026-11-27 (KAMK test): a photo plate in a cartoon project gave photographic start images with no warning
                <Text style={s.sub}>{tr("Cartoon project: the plate is used exactly as uploaded. Upload a drawn background; a photo makes the start images look like photos. To turn a photo into a drawing, use “Recreate a picture in this project's look” on a shot with it, then “Make the plate from a shot”.")}</Text>
              )}
              {!jobMaking && !ready && (
                <View style={s.row}>
                  <StillPicker label={l.plate_url ? tr("Upload a different plate") : tr("Upload plate")} disabled={busy} style={{}} textStyle={s.link} onError={setError}
                    onPick={(f) => run(async () => api.setLocationPlate(l.id, await uploadImage(lib.owner, "locations", l.id, f, f.type)))} />
                  <Pressable onPress={() => setPlatePick(platePick === l.id ? null : l.id)} accessibilityRole="button">
                    <Text style={s.link}>{tr("Make the plate from a shot")}</Text>
                  </Pressable>
                </View>
              )}
              {platePick === l.id && !jobMaking && !ready && (
                <View style={s.row}>
                  {withStill.length === 0 && <Text style={s.sub}>{tr("No shot in this series has a start frame yet.")}</Text>}
                  {withStill.map((r) => (
                    <Pressable key={r.id} style={s.chip} disabled={busy} accessibilityRole="button"
                      onPress={() => run(async () => { await api.requestPlate(l.id, r.id); setPlatePick(null); })}>
                      <Text style={{ color: c.ink }}>{tr("{scene_title} · shot {ord}", { scene_title: r.scene_title, ord: r.ord })}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <View style={s.row}>
                <Text style={[s.label, { color: c.ink, fontWeight: "600" }]}>{tr("Scenes in this location (tap to add or remove):")}</Text>
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
          <Text style={s.title}>{tr("New location")}</Text>
          <TextInput style={s.input} value={loc.name} onChangeText={(v) => setLoc({ ...loc, name: v })} placeholderTextColor={c.muted} placeholder={tr("Name, e.g. Playroom")} />
          <TextInput style={s.input} value={loc.description} onChangeText={(v) => setLoc({ ...loc, description: v })} placeholderTextColor={c.muted} placeholder={tr("What is in it (optional)")} />
          <Pressable style={[s.btn, !loc.name.trim() && { opacity: 0.5 }]} disabled={!loc.name.trim() || busy} accessibilityRole="button"
            onPress={() => run(async () => { await api.createLocation(cur.id, loc.name, loc.description); setLoc({ name: "", description: "" }); })}>
            <Text style={s.btnText}>{tr("Add location")}</Text>
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

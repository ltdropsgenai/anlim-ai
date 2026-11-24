// Scene cut: the scene's approved clips joined in shot order into one finished video, with music (the creator's track or a
// generated score), voiceover and sound effects (worker assemble.js, 2026-11-19). 2026-11-23: an edit style (editstyle.js). @anlim
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Link, useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, Cut, CutFormat, EditTransition, uploadImage } from "../../lib/api";
import { StillPicker } from "../../components/StillPicker";
import { c, font, pageBg } from "../../lib/theme";
import { Music, SoundPanel } from "../../components/SoundPanel";
import { downloadFile } from "../../lib/download";
import { ClipPlayer } from "../../components/ClipPlayer";
import { CutShots } from "../../components/CutShots";
import { ThumbnailMaker } from "../../components/ThumbnailMaker";
import { tr, locale, trDeep, trMap, trp, tMsg } from "../../lib/i18n";

const FORMATS: { id: CutFormat; title: string; sub: string }[] = trDeep([
  { id: "16x9", title: "Landscape 16:9", sub: "1920 × 1080 · YouTube, websites" },
  { id: "9x16", title: "Vertical 9:16", sub: "1080 × 1920 · Shorts, Reels, TikTok" },
  { id: "1x1", title: "Square 1:1", sub: "1080 × 1080 · feeds" },
  { id: "4x5", title: "Feed 4:5", sub: "1080 × 1350 · Instagram and Facebook feed" },
  { id: "4x3", title: "Classic 4:3", sub: "1440 × 1080" },
  { id: "3x4", title: "Portrait 3:4", sub: "1440 tall × 1080" },
  { id: "21x9", title: "Cinema 21:9", sub: "2520 × 1080" },
], ["title", "sub"]);
// 2026-11-21: clips can be any project shape now. A clip in a different shape than the cut is shown whole, in the middle,
// over a blurred fill (never cropped). The cut starts on the project's own shape.
// 2026-11-23: the edit style's transitions, in the words the creator sees
const TRANSITIONS: { id: EditTransition; title: string; sub: string }[] = trDeep([
  { id: "mixed", title: "Mixed", sub: "A mix of the ones below, mostly flashes, whips and plain cuts" },
  { id: "flash", title: "Flash", sub: "The picture blurs into a bright haze and the next shot comes out of it" },
  { id: "whip", title: "Whip", sub: "A fast sideways smear from one shot into the next" },
  { id: "zoom", title: "Zoom", sub: "The picture rushes forward in a blur and the next shot settles out of it" },
  { id: "spin", title: "Spin", sub: "The picture turns and blurs into the next shot, which turns back into place" },
  { id: "glitch", title: "Glitch", sub: "Three frames of split colours and grain" },
  { id: "punch", title: "Punch-in", sub: "The next shot starts zoomed in and snaps back" },
  { id: "cut", title: "Plain cut", sub: "No transition; the grade, push-in and the rest still apply" },
], ["title", "sub"]);
const STATUS: Record<string, string> = trMap({ queued: "Waiting to start", running: "Cutting…", done: "Ready", failed: "Failed" });

export default function SceneCut() {
  const { scene } = useLocalSearchParams<{ scene: string }>();
  const [title, setTitle] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [cuts, setCuts] = useState<Cut[] | null>(null);
  const [format, setFormat] = useState<CutFormat>("16x9");
  const [fade, setFade] = useState(true);
  const [card, setCard] = useState(false);
  const [music, setMusic] = useState<Music>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [sfxOn, setSfxOn] = useState(true);
  const [captionsOn, setCaptionsOn] = useState(false);   // 2026-11-23: captions from the voiceovers and narration
  // 2026-11-23: the edit style (the look of the reference voiceover edit Londi sent)
  const [story, setStory] = useState(false);
  const [trans, setTrans] = useState<EditTransition>("mixed");
  const [rain, setRain] = useState(false);
  const [drops, setDrops] = useState(false);
  // 2026-11-24: "match this look": a picture whose colours every shot takes on (worker editstyle.js matchCurves)
  const [lookRef, setLookRef] = useState<{ path: string; name: string; url: string } | null>(null);
  const [hits, setHits] = useState(true);
  const [beats, setBeats] = useState(true);
  const [styleTitle, setStyleTitle] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aspect, setAspect] = useState("16:9");
  const [shotsVersion, setShotsVersion] = useState(0);   // bumps when a shot's speed, trims or words change
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const picked = useRef(false);    // the project's shape is the starting format, once; then the creator's choice stands

  const load = useCallback(async () => {
    try {
      const [list, me, series] = await Promise.all([api.cuts(scene), api.me(), api.series()]);
      setCuts(list); setOwner(me.user_id);
      for (const se of series) {
        const sc = se.scenes.find((x) => x.id === scene);
        if (sc) {
          setTitle(`${se.name} · ${sc.title}`); setAspect(se.aspect ?? "16:9");
          if (!picked.current) { picked.current = true; setFormat(((se.aspect ?? "16:9").replace(":", "x")) as CutFormat); }
        }
      }
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [scene]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const working = !!cuts?.some((x) => x.status === "queued" || x.status === "running");
  useEffect(() => {
    if (!working) return;
    timer.current = setInterval(load, 4000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [working, load]);

  async function make() {
    setBusy(true); setError(null);
    const style = story ? { preset: "story" as const, transitions: trans, grade: true, push: true, rain, drops, hits, beat_sync: beats,
                            title: styleTitle.trim() || null, handle: handle.trim() || null, look_ref: lookRef?.path ?? null } : null;
    try { await api.makeCut(scene, format, { fade, end_card: card, music_path: music?.path ?? null, voice: voiceOn, sfx: sfxOn, captions: captionsOn, style }); await load(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  if (!cuts) return error ? <Text style={[s.err, { padding: 16 }]}>{tMsg(error)}</Text> : <ActivityIndicator style={{ marginTop: 40 }} />;
  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={s.page}>
      <Text style={s.title}>{(title ? tr("{title}: the cut", { title }) : tr("Scene: the cut"))}</Text>
      <Text style={s.sub}>{tr("Joins every approved clip in this scene, in shot order, frame-exact. Shots without an approved clip are left out and listed. Making a cut is free.")}</Text>

      <View style={s.panel}>
        <Text style={[s.h, font.display]}>{tr("Format")}</Text>
        <View style={s.row}>
          {FORMATS.map((f) => (
            <Pressable key={f.id} onPress={() => setFormat(f.id)} style={[s.chip, format === f.id && s.chipOn]} accessibilityRole="radio"
              accessibilityState={{ checked: format === f.id }}>
              <Text style={format === f.id ? { color: c.onAccent } : { color: c.ink }}>{f.title}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={s.sub}>{FORMATS.find((f) => f.id === format)?.sub}</Text>

        <Text style={[s.h, font.display]}>{tr("Finish")}</Text>
        <View style={s.row}>
          <Pressable onPress={() => setFade(!fade)} style={[s.chip, fade && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: fade }}>
            <Text style={fade ? { color: c.onAccent } : { color: c.ink }}>{tr("Fade in and out")}</Text>
          </Pressable>
          <Pressable onPress={() => setCard(!card)} style={[s.chip, card && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: card }}>
            <Text style={card ? { color: c.onAccent } : { color: c.ink }}>{tr("\"Made with anlim.ai\" on the last shot")}</Text>
          </Pressable>
          <Pressable onPress={() => setCaptionsOn(!captionsOn)} style={[s.chip, captionsOn && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: captionsOn }}>
            <Text style={captionsOn ? { color: c.onAccent } : { color: c.ink }}>{tr("Captions")}</Text>
          </Pressable>
        </View>
        {captionsOn && <Text style={s.sub}>{tr("The words of the voiceovers and the narration appear at the bottom as they are spoken, and you also get a .srt file to upload to YouTube or TikTok. ElevenLabs times the words (once per take, on your ElevenLabs account).")}</Text>}

        <Text style={[s.h, font.display]}>{tr("Edit style")}</Text>
        <View style={s.row}>
          {[{ on: false, t: tr("Plain") }, { on: true, t: tr("Story edit") }].map((o) => (
            <Pressable key={o.t} onPress={() => setStory(o.on)} style={[s.chip, story === o.on && s.chipOn]} accessibilityRole="radio"
              accessibilityState={{ checked: story === o.on }}>
              <Text style={story === o.on ? { color: c.onAccent } : { color: c.ink }}>{o.t}</Text>
            </Pressable>
          ))}
        </View>
        {!story && <Text style={s.sub}>{tr("Your shots joined as they are.")}</Text>}
        {story && <>
          <Text style={s.sub}>{tr("A moody voiceover-edit look: a darker teal grade, a slow push-in on every shot, a transition at every change with a whoosh or hit under it, and with music the changes moved onto its beats. With captions on, they use a serif in small capitals, low in the frame. Free, like every cut; it takes a little longer to make.")}</Text>
          <View style={s.row}>
            {TRANSITIONS.map((x) => (
              <Pressable key={x.id} onPress={() => setTrans(x.id)} style={[s.chip, trans === x.id && s.chipOn]} accessibilityRole="radio"
                accessibilityState={{ checked: trans === x.id }}>
                <Text style={trans === x.id ? { color: c.onAccent } : { color: c.ink }}>{x.title}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.sub}>{TRANSITIONS.find((x) => x.id === trans)?.sub}</Text>
          <View style={s.row}>
            {[{ v: rain, set: setRain, t: tr("Rain") }, { v: drops, set: setDrops, t: tr("Drops on the lens") }, { v: hits, set: setHits, t: tr("Hits under the changes") }, { v: beats, set: setBeats, t: tr("Changes on the beat") }].map((o) => (
              <Pressable key={o.t} onPress={() => o.set(!o.v)} style={[s.chip, o.v && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: o.v }}>
                <Text style={o.v ? { color: c.onAccent } : { color: c.ink }}>{o.t}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.sub}>{tr("Hits need music, a voiceover or an effect in the cut. Changes on the beat need music: a shot may end up to a third of a second early, or a quarter of a second late with its last frame held.")}</Text>
          <Text style={{ color: c.ink, fontWeight: "700", marginTop: 10 }}>{tr("Match a look")}</Text>
          <Text style={s.sub}>{tr("Pick a picture whose colours you like (a frame of a video you admire, a photo): every shot takes on its tones and colours, in place of the teal grade.")}</Text>
          {lookRef ? (
            <View style={[s.row, { alignItems: "center" }]}>
              <Image source={{ uri: lookRef.url }} style={{ width: 64, height: 64, borderRadius: 8 }} accessibilityLabel={tr("Look picture")} />
              <Text style={{ color: c.ink, flexShrink: 1 }} numberOfLines={1}>{lookRef.name}</Text>
              <Pressable onPress={() => setLookRef(null)} accessibilityRole="button"><Text style={s.link}>{tr("Remove")}</Text></Pressable>
            </View>
          ) : owner ? (
            <StillPicker label={tr("Choose a picture (PNG, JPEG or WebP)")} style={s.ghost} textStyle={{ color: c.ink }} onError={setError}
              onPick={async (f) => {
                setError(null);
                try {
                  const path = await uploadImage(owner, "stills", "look", f, f.type);
                  setLookRef({ path, name: f.name, url: typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(f) : "" });
                } catch (e) { setError((e as Error).message); }
              }} />
          ) : null}
          <TextInput style={s.input} value={styleTitle} onChangeText={setStyleTitle} maxLength={60} placeholderTextColor={c.muted}
            placeholder={tr("Title over the first 3.5 s (optional)")} accessibilityLabel={tr("Title over the first seconds")} />
          <TextInput style={[s.input, { marginTop: 8 }]} value={handle} onChangeText={setHandle} maxLength={30} placeholderTextColor={c.muted}
            placeholder={tr("Your handle, small, above the middle (optional)")} accessibilityLabel={tr("Handle")} autoCapitalize="none" />
        </>}

        <Text style={[s.h, font.display]}>{tr("Shots in the cut")}</Text>
        <Text style={s.sub}>{tr("Speed, trims and words drawn over each kept shot. Save a shot, then make the cut.")}</Text>
        <CutShots sceneId={scene} aspect={aspect} onChanged={() => setShotsVersion((v) => v + 1)} />

        {owner && <SoundPanel refresh={shotsVersion} sceneId={scene} owner={owner} endCard={card} music={music} setMusic={setMusic}
          voiceOn={voiceOn} setVoiceOn={setVoiceOn} sfxOn={sfxOn} setSfxOn={setSfxOn} />}
        <Text style={s.sub}>
          {tr("The sound is set to −14 LUFS, a common target for YouTube, Instagram and TikTok, at one steady level (no pumping). Without music, voiceover or effects the cut is silent.")}
        </Text>

        <Pressable style={[s.btn, (busy || working) && { opacity: 0.5 }]} disabled={busy || working} onPress={make} accessibilityRole="button">
          <Text style={s.btnText}>{working ? tr("A cut is being made…") : tr("Make the cut")}</Text>
        </Pressable>
      </View>
      {error && <Text style={s.err}>{tMsg(error)}</Text>}

      <Text style={[s.h, font.display]}>{tr("Cuts")}</Text>
      {cuts.length === 0 && <Text style={s.sub}>{tr("No cuts yet.")}</Text>}
      {cuts.map((x) => (
        <View key={x.id} style={s.panel}>
          <Text style={{ color: c.ink, fontWeight: "600" }}>
            {[FORMATS.find((f) => f.id === x.format)?.title, trp(x.shots, "{n} shot", "{n} shots"), x.duration_s ? `${Number(x.duration_s).toFixed(1)} s` : null, STATUS[x.status] ?? x.status].filter(Boolean).join(" · ")}</Text>
          <Text style={s.sub}>{new Date(x.created_at).toLocaleString(locale())}{[x.options.music_path ? (x.options.music_path.includes("/audio/music/") ? tr("generated score") : tr("your track")) : null,
            x.report?.narration ? tr("narration") : null,   // 2026-11-23 (ep16): a cut with only the narration read "silent"
            x.report?.voiceovers ? trp(x.report.voiceovers, "{n} voiceover", "{n} voiceovers") : null,
            x.report?.effects ? trp(x.report.effects, "{n} sound effect", "{n} sound effects") : null,
            x.report?.captions ? tr("captions") : null,
            x.report?.style ? tr("story edit") : null].filter(Boolean).map((t) => ` · ${t}`).join("") || tr(" · silent")}</Text>
          {(x.status === "queued" || x.status === "running") && <ActivityIndicator style={{ alignSelf: "flex-start", marginVertical: 6 }} />}
          {x.status === "failed" && <Text style={s.err}>{tMsg(x.error)}</Text>}
          {x.url && <View style={{ maxWidth: ["16x9", "21x9", "4x3"].includes(x.format) ? 900 : x.format === "1x1" ? 520 : 380, marginVertical: 8 }}>
            <ClipPlayer src={x.url} duration={Number(x.duration_s) || 0} markers={[]} />
          </View>}
          {x.watermarked && (
            <Link href="/billing" asChild><Pressable accessibilityRole="link">
              <Text style={s.link}>{tr("Free cuts carry an anlim.ai watermark. Buy credits or a plan and every cut plays without it.")}</Text>
            </Pressable></Link>
          )}
          {x.url && (
            <Pressable onPress={() => downloadFile(x.url!, `${(title ?? "scene").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-")}-${x.format}${x.watermarked ? "-preview" : ""}.mp4`)
                .catch((e) => setError((e as Error).message))} accessibilityRole="button">
              <Text style={s.link}>{tr("Download the MP4")}</Text>
            </Pressable>
          )}
          {x.url && <ThumbnailMaker src={x.url} vertical={["9x16", "4x5", "3x4"].includes(x.format)}
            name={`${(title ?? "scene").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-")}-${x.format}`} />}
          {x.srt_url && (
            <Pressable onPress={() => downloadFile(x.srt_url!, `${(title ?? "scene").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-")}-${x.format}.srt`)
                .catch((e) => setError((e as Error).message))} accessibilityRole="button">
              <Text style={s.link}>{tr("Download the captions (.srt)")}</Text>
            </Pressable>
          )}
          {x.report && (
            <View style={{ marginTop: 8 }}>
              {x.report.checks.map((k) => (
                <Text key={k.name} style={[s.sub, { color: k.ok ? c.pass : c.fail }]}>{k.ok ? "✓" : "!"} {tMsg(k.name)}: {tMsg(k.detail)}</Text>
              ))}
              {x.report.notes.map((n) => <Text key={n} style={s.sub}>{tMsg(n)}</Text>)}
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, maxWidth: 1000, width: "100%", alignSelf: "center" },
  title: { fontSize: 20, fontWeight: "700", color: c.ink, marginTop: 6, marginBottom: 4 },
  h: { fontSize: 15, fontWeight: "700", color: c.ink, marginTop: 14, marginBottom: 6 },
  sub: { color: c.sub, fontSize: 13, marginBottom: 6 },
  link: { color: c.accent, fontSize: 14, marginVertical: 6 },
  panel: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 16, marginTop: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 6 },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.field },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  btn: { backgroundColor: c.accent, borderRadius: 8, padding: 13, alignItems: "center", marginTop: 12 },
  btnText: { color: c.onAccent, fontWeight: "600" },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, alignItems: "center", alignSelf: "flex-start" },
  err: { color: c.fail, marginTop: 8 },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, color: c.ink, backgroundColor: c.field },
});

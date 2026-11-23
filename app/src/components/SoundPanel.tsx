// Sound for a scene cut (2026-11-19): the music (none, the creator's own track, or a score generated with their
// ElevenLabs account) and, per shot, a voiceover line and a sound effect. Audio runs on the creator's ElevenLabs
// credits, not anlim's. The worker places each shot's chosen line and effect where the shot starts (assemble.js).
// 2026-11-22 the score composer (Londi: "kind of a mini Suno"): one style for the whole score, and by default one section
// per kept shot, each with its own mood and exactly as long as the shot is in the cut, so the music changes on the cut.
// Instrumental for now; ElevenLabs music_v2_5 composition plans (worker/src/audio.js). @anlim
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { api, AudioJob, AudioKind, Connection, cutSeconds as shotCutSeconds, scoreSections, ShotRow, uploadMusic, Voice } from "../lib/api";
import { c, font } from "../lib/theme";
import { pad2 } from "../lib/shotStatus";
import { StillPicker } from "./StillPicker";
import { AudioPlayer } from "./AudioPlayer";

const AUDIO = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4", "audio/x-m4a", "audio/aac"];
export type Music = { path: string; name: string; source: "upload" | "score" } | null;
const BUSY = ["queued", "running"];
// quick picks for the composer; tapping one adds it to the text (the creator can write anything)
const STYLES = ["cinematic film score", "warm strings", "soft piano", "ambient pads", "acoustic guitar", "epic orchestral", "lo-fi beats", "synthwave"];
const MOODS = ["somber", "tense", "reflective", "hopeful", "uplifting", "triumphant", "calm", "playful"];

function Chip({ on, text, onPress, disabled }: { on: boolean; text: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[s.chip, on && s.chipOn, disabled && { opacity: 0.5 }]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
      <Text style={{ color: on ? c.onAccent : c.ink, fontSize: 13 }}>{text}</Text>
    </Pressable>
  );
}

// The finished pieces of one kind for a shot (or the scene's scores): which is in the cut, the newest being made, errors.
function Takes({ jobs, shotS, onUse, label }: { jobs: AudioJob[]; shotS?: number; onUse: (j: AudioJob, on: boolean) => void; label: string }) {
  if (!jobs.length) return null;
  const making = jobs.find((j) => BUSY.includes(j.status));
  const used = jobs.find((j) => j.in_cut && j.status === "done");
  const lastFail = jobs[0]?.status === "failed" ? jobs[0] : null;
  const others = jobs.filter((j) => j.status === "done" && j !== used).slice(0, 3);
  return (
    <View style={{ gap: 6, marginTop: 6 }}>
      {making && <View style={s.row}><ActivityIndicator size="small" /><Text style={s.small}>Making the {label}… usually under a minute.</Text></View>}
      {lastFail && !making && <Text style={{ color: c.fail, fontSize: 13 }}>{lastFail.error ?? "It could not be made."}</Text>}
      {used && (
        <View style={s.take}>
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <Text style={[s.small, { color: c.pass }]}>✓ In the cut · {Number(used.duration_s).toFixed(1)} s</Text>
            <Pressable onPress={() => onUse(used, false)} accessibilityRole="button"><Text style={s.link}>Leave out</Text></Pressable>
          </View>
          {used.url && <AudioPlayer src={used.url} />}
          {shotS && Number(used.duration_s) > shotS + 0.1 && (
            <Text style={[s.small, { color: c.flag }]}>Longer than the shot ({shotS} s): it carries into the next shot.</Text>)}
        </View>
      )}
      {others.map((j) => (
        <View key={j.id} style={[s.row, { justifyContent: "space-between" }]}>
          <Text style={s.small} numberOfLines={1}>Earlier take · {Number(j.duration_s).toFixed(1)} s</Text>
          <View style={s.row}>
            {j.url && <AudioPlayer src={j.url} />}
            <Pressable onPress={() => onUse(j, true)} accessibilityRole="button"><Text style={s.link}>Use this</Text></Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

function ShotSound({ r, sceneId, voice, jobs, connected, onMade, onUse, setError }: {
  r: ShotRow; sceneId: string; voice: Voice | null; jobs: AudioJob[]; connected: boolean;
  onMade: () => void; onUse: (j: AudioJob, on: boolean) => void; setError: (e: string | null) => void }) {
  const vo = jobs.filter((j) => j.kind === "voiceover"), fx = jobs.filter((j) => j.kind === "sfx");
  const [line, setLine] = useState(vo[0]?.input.text ?? "");
  const [sound, setSound] = useState(fx[0]?.input.text ?? "");
  const [secs, setSecs] = useState(String(r.duration_s));
  const [busy, setBusy] = useState<AudioKind | null>(null);
  async function make(kind: AudioKind) {
    setBusy(kind); setError(null);
    try {
      if (kind === "voiceover") await api.makeAudio({ scene_id: sceneId, shot_id: r.id, kind, text: line, voice_id: voice!.id, voice_name: voice!.name });
      else await api.makeAudio({ scene_id: sceneId, shot_id: r.id, kind, text: sound, duration_s: Number(secs) || null });
      onMade();
    } catch (e) { setError((e as Error).message); }
    setBusy(null);
  }
  const voMaking = vo.some((j) => BUSY.includes(j.status)), fxMaking = fx.some((j) => BUSY.includes(j.status));
  return (
    <View style={s.shot}>
      <Text style={[s.small, font.mono, { color: c.sub }]}>SH {pad2(r.ord)} · {r.duration_s} S</Text>
      <Text style={{ color: c.ink, fontSize: 14, marginBottom: 6 }} numberOfLines={2}>{r.action}</Text>
      <Text style={s.label}>Voiceover</Text>
      <TextInput value={line} onChangeText={setLine} multiline editable={connected} placeholderTextColor={c.muted} style={s.input}
        placeholder="What is said over this shot. Tags like [whispers], [sighs] or [laughs] set the delivery." />
      <View style={s.row}>
        <Pressable style={[s.btnSm, (!connected || !voice || !line.trim() || !!busy || voMaking) && { opacity: 0.5 }]}
          disabled={!connected || !voice || !line.trim() || !!busy || voMaking} onPress={() => make("voiceover")} accessibilityRole="button">
          <Text style={s.btnText}>{busy === "voiceover" ? "Sending…" : vo.length ? "Make it again" : "Make the voiceover"}</Text>
        </Pressable>
        {connected && !voice && <Text style={s.small}>Pick a voice above first.</Text>}
        {voice && <Text style={s.small}>Voice: {voice.name}</Text>}
      </View>
      <Takes jobs={vo} shotS={r.duration_s} onUse={onUse} label="voiceover" />

      <Text style={[s.label, { marginTop: 12 }]}>Sound effect</Text>
      <View style={s.row}>
        <TextInput value={sound} onChangeText={setSound} editable={connected} placeholderTextColor={c.muted} style={[s.input, { flex: 1, minWidth: 200, minHeight: 0 }]}
          placeholder="e.g. rain on the window, a distant dog barking" />
        <TextInput value={secs} onChangeText={setSecs} editable={connected} keyboardType="decimal-pad" style={[s.input, { width: 64, minHeight: 0 }]}
          accessibilityLabel="Seconds" />
        <Text style={s.small}>s</Text>
        <Pressable style={[s.btnSm, (!connected || !sound.trim() || !!busy || fxMaking) && { opacity: 0.5 }]}
          disabled={!connected || !sound.trim() || !!busy || fxMaking} onPress={() => make("sfx")} accessibilityRole="button">
          <Text style={s.btnText}>{busy === "sfx" ? "Sending…" : fx.length ? "Make it again" : "Make the sound"}</Text>
        </Pressable>
      </View>
      <Takes jobs={fx} onUse={onUse} label="sound effect" />
    </View>
  );
}

export function SoundPanel({ sceneId, owner, endCard, music, setMusic, voiceOn, setVoiceOn, sfxOn, setSfxOn }: {
  sceneId: string; owner: string; endCard: boolean; music: Music; setMusic: (m: Music) => void;
  voiceOn: boolean; setVoiceOn: (v: boolean) => void; sfxOn: boolean; setSfxOn: (v: boolean) => void }) {
  const [conn, setConn] = useState<Connection | null | undefined>(undefined);
  const [jobs, setJobs] = useState<AudioJob[]>([]);
  const [shots, setShots] = useState<ShotRow[]>([]);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [vq, setVq] = useState("");
  const [mode, setMode] = useState<"none" | "upload" | "score">(music?.source === "score" ? "score" : music ? "upload" : "none");
  const [prompt, setPrompt] = useState("");
  const [instrumental, setInstrumental] = useState(true);
  const [follow, setFollow] = useState(true);                       // the score's sections follow the shots
  const [moods, setMoods] = useState<Record<string, string>>({});   // per shot id: that section's mood
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = conn?.status === "ok";

  const load = useCallback(async () => {
    try {
      const [cs, js, sh] = await Promise.all([api.connections(), api.audio(sceneId), api.shots()]);
      setConn(cs.find((x) => x.provider === "elevenlabs") ?? null); setJobs(js);
      setShots(sh.filter((x) => x.scene_id === sceneId && x.has_approved_clip));
    } catch (e) { setError((e as Error).message); }
  }, [sceneId]);
  useEffect(() => { load(); }, [load]);
  const working = jobs.some((j) => BUSY.includes(j.status));
  useEffect(() => { if (!working) return; const t = setInterval(load, 4000); return () => clearInterval(t); }, [working, load]);
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(() => api.voices(vq.trim() || undefined).then((v) => { setVoices(v); }).catch((e) => setError((e as Error).message)), vq ? 350 : 0);
    return () => clearTimeout(t);
  }, [connected, vq]);
  // remember the last voice used in this scene
  useEffect(() => {
    if (voice || !voices) return;
    const last = jobs.find((j) => j.kind === "voiceover")?.input.voice_id;
    const v = voices.find((x) => x.id === last);
    if (v) setVoice(v);
  }, [voices, jobs, voice]);

  // the score is made to the cut's length: the kept shots, one second spare (the clips can run a frame or two over
  // their shot length; the cut trims and fades the score). Since 2026-11-22 the "Made with anlim.ai" credit sits on the
  // last shot and adds no time.
  const cutSeconds = shots.reduce((t, r) => t + shotCutSeconds(r), 0) + (shots.length ? 1 : 0);
  // one section per kept shot, as long as the shot is in the cut (trims and speed included); the last one gets the
  // spare second; a section shorter than ElevenLabs' 3 s joins a neighbour (lib/api.ts scoreSections, same as the connector)
  const plan = useMemo(() => scoreSections(shots, (r) => moods[r.id] ?? ""), [shots, moods]);
  const sections = plan.sections;
  const scores = useMemo(() => jobs.filter((j) => j.kind === "music"), [jobs]);
  const scorePath = (j: AudioJob) => `${owner}/audio/music/${j.id}.mp3`;
  // the score in the cut follows the chosen one
  useEffect(() => {
    if (mode !== "score") return;
    const used = scores.find((j) => j.in_cut && j.status === "done");
    if (used && music?.path !== scorePath(used)) setMusic({ path: scorePath(used), name: `Score: ${used.input.text.slice(0, 40)}`, source: "score" });
    if (!used && music?.source === "score") setMusic(null);
  }, [mode, scores]);   // eslint-disable-line react-hooks/exhaustive-deps

  const use = async (j: AudioJob, on: boolean) => { try { await api.useAudio(j.id, on); await load(); } catch (e) { setError((e as Error).message); } };
  const anyVo = jobs.some((j) => j.kind === "voiceover" && j.in_cut && j.status === "done");
  const anyFx = jobs.some((j) => j.kind === "sfx" && j.in_cut && j.status === "done");

  return (
    <View>
      <Text style={[s.h, font.display]}>Music</Text>
      <View style={s.row}>
        <Chip on={mode === "none"} text="No music" onPress={() => { setMode("none"); setMusic(null); }} />
        <Chip on={mode === "upload"} text="Your track" onPress={() => { setMode("upload"); if (music?.source !== "upload") setMusic(null); }} />
        <Chip on={mode === "score"} text="Generate a score" onPress={() => setMode("score")} />
      </View>
      {mode === "upload" && (music?.source === "upload" ? (
        <View style={s.row}>
          <Text style={{ color: c.ink }}>{music.name}</Text>
          <Pressable onPress={() => setMusic(null)} accessibilityRole="button"><Text style={s.link}>Remove</Text></Pressable>
        </View>
      ) : (
        <StillPicker label="Add a music track (MP3, WAV or M4A, up to 30 MB)" disabled={busy} style={s.ghost} textStyle={{ color: c.ink }}
          types={AUDIO} maxMb={30} typeError="Use an MP3, WAV or M4A file." onError={setError}
          onPick={async (f) => {
            setBusy(true); setError(null);
            try { setMusic({ path: await uploadMusic(owner, f, f.name, f.type), name: f.name, source: "upload" }); } catch (e) { setError((e as Error).message); }
            setBusy(false);
          }} />
      ))}
      {mode === "upload" && <Text style={s.small}>Use a track you have the rights to.</Text>}
      {mode === "score" && (!connected ? <ConnectNote conn={conn} /> : (
        <View style={{ gap: 8 }}>
          <Text style={s.label}>The whole score: genre, instruments, tempo</Text>
          <TextInput value={prompt} onChangeText={setPrompt} multiline placeholderTextColor={c.muted} style={s.input}
            placeholder="e.g. cinematic film score, warm strings, soft piano, slow build, 70 bpm" />
          <View style={s.row}>
            {STYLES.map((t) => <Chip key={t} on={prompt.toLowerCase().includes(t.toLowerCase())} text={t}
              onPress={() => setPrompt((p) => p.toLowerCase().includes(t.toLowerCase()) ? p : (p.trim() ? `${p.trim().replace(/,$/, "")}, ${t}` : t))} />)}
          </View>
          <View style={s.row}>
            <Chip on={follow && shots.length > 0} disabled={!shots.length} text="Follow the shots" onPress={() => setFollow(true)} />
            <Chip on={!follow || !shots.length} text="One piece" onPress={() => setFollow(false)} />
            {follow && shots.length > 0
              ? <Text style={s.small}>Instrumental (no singing)</Text>
              : <Chip on={instrumental} text="Instrumental" onPress={() => setInstrumental((v) => !v)} />}
          </View>
          {follow && shots.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text style={s.sub}>Each shot gets its own section, exactly as long as the shot is in the cut, so the music changes where the picture does.</Text>
              {shots.map((r, i) => {
                const sec = plan.lens[i], joins = plan.joins[i];
                return (
                  <View key={r.id} style={s.shot}>
                    <Text style={[s.small, font.mono, { color: c.sub }]}>SH {pad2(r.ord)} · {sec.toFixed(1)} S{joins === "before" ? " · JOINS THE SECTION BEFORE" : joins === "after" ? " · JOINS THE NEXT SECTION" : ""}</Text>
                    <Text style={{ color: c.ink, fontSize: 13, marginBottom: 4 }} numberOfLines={1}>{r.action}</Text>
                    <TextInput value={moods[r.id] ?? ""} onChangeText={(t) => setMoods((m) => ({ ...m, [r.id]: t }))} placeholderTextColor={c.muted}
                      style={[s.input, { minHeight: 0 }]} placeholder="The mood here, e.g. somber, sparse, minor key" />
                    <View style={[s.row, { marginTop: 4 }]}>
                      {MOODS.map((t) => <Chip key={t} on={(moods[r.id] ?? "").toLowerCase().includes(t)} text={t}
                        onPress={() => setMoods((m) => { const cur = (m[r.id] ?? "").trim(); return cur.toLowerCase().includes(t) ? m : { ...m, [r.id]: cur ? `${cur.replace(/,$/, "")}, ${t}` : t }; })} />)}
                    </View>
                  </View>
                );
              })}
              <Text style={s.small}>Length: {plan.total} s in {sections.length} section{sections.length > 1 ? "s" : ""}. It fades out at the end of the cut.</Text>
            </View>
          ) : (
            <Text style={s.small}>Length: {Math.ceil(cutSeconds)} s, the length of the cut. It fades out at the end.</Text>
          )}
          <Pressable style={[s.btnSm, (!prompt.trim() || busy || scores.some((j) => BUSY.includes(j.status)) || cutSeconds < 3) && { opacity: 0.5 }]}
            disabled={!prompt.trim() || busy || scores.some((j) => BUSY.includes(j.status)) || cutSeconds < 3} accessibilityRole="button"
            onPress={async () => {
              setBusy(true); setError(null);
              try {
                if (follow && shots.length) await api.makeAudio({ scene_id: sceneId, kind: "music", text: prompt, styles: prompt, sections, instrumental: true });
                else await api.makeAudio({ scene_id: sceneId, kind: "music", text: prompt, length_s: Math.ceil(cutSeconds), instrumental });
                await load();
              }
              catch (e) { setError((e as Error).message); }
              setBusy(false);
            }}>
            <Text style={s.btnText}>{scores.length ? "Make another score" : "Make the score"}</Text>
          </Pressable>
          <Text style={s.small}>Made with ElevenLabs Music on your ElevenLabs credits. Check ElevenLabs' terms for where you may publish it.</Text>
          <Takes jobs={scores} onUse={use} label="score" />
        </View>
      ))}

      <Text style={[s.h, font.display]}>Voiceover and sound effects</Text>
      {!connected ? <ConnectNote conn={conn} /> : (<>
        <Text style={s.sub}>Each shot's line and effect start with the shot. Speech sits above the music at one steady level; the music does not dip.</Text>
        <Text style={s.label}>Voice</Text>
        <TextInput value={vq} onChangeText={setVq} placeholder="Search your ElevenLabs voices" placeholderTextColor={c.muted} style={[s.input, { minHeight: 0 }]} />
        {!voices && <ActivityIndicator style={{ alignSelf: "flex-start" }} />}
        <View style={[s.row, { marginTop: 6 }]}>
          {(voices ?? []).slice(0, 24).map((v) => (
            <Chip key={v.id} on={voice?.id === v.id} onPress={() => setVoice(v)}
              text={`${v.name}${[v.gender, v.accent].filter(Boolean).length ? ` · ${[v.gender, v.accent].filter(Boolean).join(", ")}` : ""}`} />
          ))}
          {voices && voices.length === 0 && <Text style={s.small}>No voices match.</Text>}
        </View>
        {voice?.preview_url && <View style={{ marginTop: 6 }}><Text style={s.small}>Preview of {voice.name}</Text><AudioPlayer src={voice.preview_url} /></View>}
        {shots.length === 0 && <Text style={s.sub}>Keep at least one clip in this scene first.</Text>}
        {shots.map((r) => (
          <ShotSound key={r.id} r={r} sceneId={sceneId} voice={voice} connected={connected} setError={setError}
            jobs={jobs.filter((j) => j.shot_id === r.id)} onMade={load} onUse={use} />
        ))}
        {(anyVo || anyFx) && (
          <View style={[s.row, { marginTop: 8 }]}>
            <Text style={s.label}>In this cut:</Text>
            <Chip on={voiceOn} disabled={!anyVo} text="Voiceover" onPress={() => setVoiceOn(!voiceOn)} />
            <Chip on={sfxOn} disabled={!anyFx} text="Sound effects" onPress={() => setSfxOn(!sfxOn)} />
          </View>
        )}
      </>)}
      {error && <Text style={{ color: c.fail, marginTop: 8 }}>{error}</Text>}
    </View>
  );
}

function ConnectNote({ conn }: { conn: Connection | null | undefined }) {
  if (conn === undefined) return <ActivityIndicator style={{ alignSelf: "flex-start" }} />;
  return (
    <View style={s.note}>
      <Text style={{ color: c.ink, fontSize: 14 }}>
        {conn?.status === "invalid" ? "ElevenLabs refused your key. Connect it again to make audio."
          : "Connect your ElevenLabs account to make voiceover, sound effects and a score here. It uses your ElevenLabs credits; anlim charges nothing."}</Text>
      <Pressable onPress={() => router.navigate("/account")} accessibilityRole="link"><Text style={s.link}>Connect in Account</Text></Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  h: { fontSize: 15, color: c.ink, marginTop: 14, marginBottom: 6 },
  sub: { color: c.sub, fontSize: 13, marginBottom: 6 }, small: { color: c.sub, fontSize: 12 },
  label: { color: c.sub, fontSize: 12, marginBottom: 4 },
  link: { color: c.link, fontSize: 13 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: c.field },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, minHeight: 60, color: c.ink, backgroundColor: c.field, fontSize: 14 },
  btnSm: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14, alignSelf: "flex-start" },
  btnText: { color: c.onAccent, fontWeight: "700" },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, alignItems: "center", alignSelf: "flex-start" },
  shot: { borderTopWidth: 1, borderTopColor: c.line, paddingTop: 12, marginTop: 12 },
  take: { backgroundColor: c.field, borderRadius: 8, borderWidth: 1, borderColor: c.line, padding: 8, gap: 4 },
  note: { backgroundColor: c.field, borderRadius: 10, borderWidth: 1, borderColor: c.line, padding: 12, gap: 6 },
});

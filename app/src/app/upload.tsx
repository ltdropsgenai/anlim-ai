// Upload for AI tools (2026-11-22, Londi: the connector must be "fully functional from chat"). A chat cannot hand files
// to anlim's MCP server, so the connector's get_upload_link sends the creator here. Each file goes straight to storage
// with the creator's own session, to <owner>/motion/up-<time>-<random>[_d<centiseconds>].<ext> (the folder the storage
// policy already allows for images and videos); a video's length is measured here and kept in the name. The AI then
// sees the files with list_uploads and uses their ids (characters, backgrounds, start images, motion transfer). @anlim
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../lib/api";
import { supabase } from "../lib/supabase";
import { c, font, pageBg } from "../lib/theme";
import { LikenessConsent } from "../components/LikenessConsent";
import { tr, trp, tMsg } from "../lib/i18n";
import { usePageTitle } from "../lib/pageTitle";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_IMAGE_MB = 15, MAX_VIDEO_MB = 250;
type Row = { name: string; id?: string; state: "uploading" | "done" | "failed"; note?: string; kind: "image" | "video"; seconds?: number };

// A video's length in seconds. WebM recordings (MediaRecorder) often report Infinity until the browser has read to the
// end; seeking far past the end makes it work the length out (review 2026-11-23). NaN if it still cannot be read.
function videoSeconds(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), v = document.createElement("video");
    let settled = false;
    const done = (x: number) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(x); };
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      if (isFinite(v.duration) && v.duration > 0) return done(v.duration);
      v.ondurationchange = () => { if (isFinite(v.duration) && v.duration > 0) done(v.duration); };
      v.currentTime = 1e7;
      setTimeout(() => done(NaN), 8000);
    };
    v.onerror = () => { if (settled) return; settled = true; URL.revokeObjectURL(url); reject(new Error(tr("This video could not be read. Try an MP4 file."))); };
    v.src = url;
  });
}
// five random base-36 characters (the upload id's second part must be 3 to 8 of them: studio-mcp UPLOAD_ID)
const randomPart = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => (b % 36).toString(36)).join("");

export default function Upload() {
  usePageTitle(tr("Upload files"));
  const [owner, setOwner] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [drag, setDrag] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  // likeness consent (2026-11-24): ticked, it is kept for each file uploaded while it is on; unticked, the AI tool must
  // ask the creator in the chat before a person's photo or video can be used
  const [consent, setConsent] = useState(false);
  useEffect(() => { api.me().then((m) => setOwner(m.user_id)).catch((e) => setSignInError((e as Error).message || tr("Could not sign you in."))); }, []);

  const set = (i: number, r: Partial<Row>) => setRows((xs) => xs.map((x, k) => (k === i ? { ...x, ...r } : x)));

  async function send(files: File[]) {
    if (!owner) return;
    const start = rows.length;
    setRows((xs) => [...xs, ...files.map((f) => ({ name: f.name, state: "uploading" as const, kind: f.type.startsWith("video/") ? "video" as const : "image" as const }))]);
    await Promise.all(files.map(async (f, k) => {
      const i = start + k, video = VIDEO_TYPES.includes(f.type);
      try {
        if (!video && !IMAGE_TYPES.includes(f.type)) throw new Error(tr("Use a PNG, JPEG or WebP image, or an MP4, MOV or WebM video."));
        if (f.size > (video ? MAX_VIDEO_MB : MAX_IMAGE_MB) * 1024 * 1024) throw new Error(`Over ${video ? MAX_VIDEO_MB : MAX_IMAGE_MB} MB.`);
        const secs = video ? await videoSeconds(f) : null;
        const id = `up-${Date.now().toString(36)}-${randomPart()}`;
        const ext = f.type === "image/jpeg" ? "jpg" : f.type === "image/webp" ? "webp" : f.type === "image/png" ? "png"
          : f.type === "video/quicktime" ? "mov" : f.type === "video/webm" ? "webm" : "mp4";
        if (video && !(secs && isFinite(secs))) throw new Error(tr("This video's length could not be read, so it cannot be used for motion transfer. Try an MP4 file."));
        const path = `${owner}/motion/${id}${secs && isFinite(secs) ? `_d${Math.round(secs * 100)}` : ""}.${ext}`;
        const { error } = await supabase.storage.from("studio").upload(path, f, { contentType: f.type, upsert: false });
        if (error) throw new Error(error.message);
        if (consent) await api.likenessConsent([path], "upload");
        set(i, { state: "done", id, seconds: secs ?? undefined });
      } catch (e) { set(i, { state: "failed", note: (e as Error).message }); }
    }));
  }

  async function copy(t: string) {
    try { await navigator.clipboard.writeText(t); setCopied(t); setTimeout(() => setCopied(null), 1500); } catch { /* shown on screen anyway */ }
  }
  const done = rows.filter((r) => r.state === "done");

  if (Platform.OS !== "web") return (
    <View style={[s.page, { backgroundColor: pageBg, padding: 24 }]}><Text style={s.lead}>{tr("Open anlim.ai/upload in a web browser.")}</Text></View>
  );
  return (
    <ScrollView style={[s.page, { backgroundColor: pageBg }]} contentContainerStyle={{ padding: 24, paddingBottom: 80 }}>
      <View style={{ maxWidth: 760, width: "100%", alignSelf: "center", gap: 16 }}>
        <Text style={[s.kicker, font.mono]}>{tr("UPLOAD FOR YOUR AI TOOL")}</Text>
        <Text style={[s.h1, font.display]}>{tr("Drop your photos and videos")}</Text>
        <Text style={s.lead}>{tr("For Claude, ChatGPT or any AI tool connected to anlim: upload here, then tell it you're done. It sees each file by its upload id and can use it for a character's reference photo, a background, a start image or a motion transfer video. Images: PNG, JPEG or WebP up to {MAX_IMAGE_MB} MB. Videos: MP4, MOV or WebM up to {MAX_VIDEO_MB} MB.", { MAX_IMAGE_MB, MAX_VIDEO_MB })}</Text>
        <LikenessConsent on={consent} onChange={setConsent} plural />
        {/* a plain drop zone: the browser's own file input, so it also works with a click */}
        <label onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); send(Array.from(e.dataTransfer.files)); }}
          style={{ display: "block", cursor: owner ? "pointer" : "default", borderRadius: 18, border: `2px dashed ${drag ? c.accent : c.line}`,
                   padding: 36, textAlign: "center", background: drag ? "rgba(255,138,61,0.06)" : c.card, color: c.sub, fontSize: 15 }}>
          <input type="file" multiple accept={[...IMAGE_TYPES, ...VIDEO_TYPES].join(",")} style={{ display: "none" }} disabled={!owner}
            onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) send(fs); }} />
          {owner ? tr("Drop files here, or click to choose") : signInError ? tr("Not signed in: {signInError} Sign in at anlim.ai, then open this page again.", { signInError }) : tr("Signing you in…")}
        </label>
        {rows.map((r, i) => (
          <View key={i} style={s.row}>
            <Text style={[s.name, { flex: 1 }]} numberOfLines={1}>{r.name}{r.seconds ? ` · ${r.seconds.toFixed(1)} s` : ""}</Text>
            {r.state === "uploading" ? <Text style={s.small}>{tr("Uploading…")}</Text>
              : r.state === "failed" ? <Text style={[s.small, { color: c.fail }]}>{tMsg(r.note)}</Text>
              : <Pressable onPress={() => copy(r.id!)} accessibilityRole="button" style={s.idChip}>
                  <Text style={[{ color: c.ink, fontSize: 13 }, font.mono]}>{copied === r.id ? tr("Copied") : r.id}</Text>
                </Pressable>}
          </View>
        ))}
        {done.length ? (
          <View style={s.tell}>
            <Text style={s.small}>{tr("Tell your AI tool:")}</Text>
            <Text style={[s.name, font.mono]} selectable>{trp(done.length, "I uploaded {n} file to anlim: {ids}", "I uploaded {n} files to anlim: {ids}", { ids: done.map((r) => r.id).join(", ") })}</Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1 },
  kicker: { color: c.accent, fontSize: 12, letterSpacing: 1.2 },
  h1: { color: c.ink, fontSize: 32, lineHeight: 38 },
  lead: { color: c.sub, fontSize: 15, lineHeight: 22 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 12 },
  name: { color: c.ink, fontSize: 14 },
  small: { color: c.muted, fontSize: 13 },
  idChip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.card2 },
  tell: { backgroundColor: c.card, borderWidth: 1, borderColor: c.accent, borderRadius: 14, padding: 14, gap: 6 },
});

// Download a whole project (2026-11-23): the worker packs its kept clips, latest cuts, frames, cast, places and audio into
// zip files (worker/src/export.js); this starts one and shows the links when it is ready. @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { api, ProjectExport } from "../lib/api";
import { c } from "../lib/theme";
import { downloadFile } from "../lib/download";

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

export function ProjectDownload({ seriesId }: { seriesId: string }) {
  const [x, setX] = useState<ProjectExport | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { api.exportLatest(seriesId).then(setX).catch((e) => setErr((e as Error).message)); }, [seriesId]);
  useEffect(load, [load]);
  const working = x?.status === "queued" || x?.status === "running";
  useEffect(() => { if (!working) return; const t = setInterval(load, 5000); return () => clearInterval(t); }, [working, load]);
  async function start() {
    setErr(null);
    try { await api.exportCreate(seriesId); load(); } catch (e) { setErr((e as Error).message); }
  }
  if (x === undefined) return null;
  return (
    <View style={{ gap: 6, marginTop: 10 }}>
      <Text style={{ color: c.sub, fontSize: 13 }}>Download the whole project: kept clips, the 3 newest cuts of each scene (and their captions), start and end
        frames, cast and place pictures, and the audio in the cuts, as zip files of up to 100 MB.</Text>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Pressable onPress={start} disabled={working} accessibilityRole="button"
          style={{ borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, opacity: working ? 0.5 : 1 }}>
          <Text style={{ color: c.ink }}>{working ? "Preparing the download…" : x?.status === "done" ? "Prepare it again" : "Prepare the download"}</Text>
        </Pressable>
        {working && <ActivityIndicator />}
      </View>
      {x?.status === "done" && x.parts.map((p) => (
        <Pressable key={p.name} onPress={() => p.url && downloadFile(p.url, p.name).catch((e) => setErr((e as Error).message))} accessibilityRole="button">
          <Text style={{ color: c.link, textDecorationLine: "underline" }}>{p.name} · {p.files} files · {mb(p.bytes)}</Text>
        </Pressable>
      ))}
      {x?.status === "done" && <Text style={{ color: c.muted, fontSize: 12 }}>Prepared {new Date(x.created_at).toLocaleString()}.{x.error ? ` ${x.error}.` : ""}</Text>}
      {x?.status === "failed" && <Text style={{ color: c.fail, fontSize: 13 }}>{x.error}</Text>}
      {err && <Text style={{ color: c.fail, fontSize: 13 }}>{err}</Text>}
    </View>
  );
}

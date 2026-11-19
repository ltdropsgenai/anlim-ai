// Web preview for an asset: video, image or audio (Assets, 2026-11-19). @anlim
import type { AssetKind } from "../lib/api";

export function MediaView({ kind, url, poster }: { kind: AssetKind; url: string; poster?: string | null }) {
  if (kind === "clip" || kind === "cut")
    return <video src={url} poster={poster ?? undefined} controls autoPlay playsInline
      style={{ width: "100%", maxHeight: "62vh", borderRadius: 12, background: "#000", display: "block" }} />;
  if (kind === "music" || kind === "voice" || kind === "sfx")
    return <audio src={url} controls autoPlay style={{ width: "100%", display: "block" }} />;
  return <img src={url} alt="" style={{ width: "100%", maxHeight: "62vh", objectFit: "contain", borderRadius: 12, background: "#000", display: "block" }} />;
}

// Thumbnail from a cut (2026-11-23, Londi: "all of the above"): pick a moment of the cut, add a title, download a JPEG
// for YouTube (1280x720) or a vertical cover (1080x1920). Drawn in the browser on a canvas: nothing is uploaded and
// nothing is charged. The picture fills the thumbnail (cropped to its shape); the title is fitted to the width in up to
// two lines, white with a black outline. @anlim
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { c } from "../lib/theme";
import { tr, tMsg } from "../lib/i18n";

const SIZES = { youtube: [1280, 720], cover: [1080, 1920] } as const;
type Size = keyof typeof SIZES;

function draw(cv: HTMLCanvasElement, v: HTMLVideoElement, title: string, place: "top" | "bottom") {
  const ctx = cv.getContext("2d")!;
  const W = cv.width, H = cv.height, vw = v.videoWidth, vh = v.videoHeight;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  if (vw && vh) {
    const k = Math.max(W / vw, H / vh), dw = vw * k, dh = vh * k;
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  const text = title.trim().toUpperCase();
  if (!text) return;
  // up to two lines: split at the word nearest the middle when one line would be too small
  const words = text.split(/\s+/);
  let lines = [text];
  let size = Math.min(W, H) * 0.17;
  const fit = (ls: string[]) => {
    let s = Math.min(W, H) * 0.17;
    ctx.font = `900 ${s}px "Montserrat", "Arial Black", Impact, sans-serif`;
    const widest = Math.max(...ls.map((l) => ctx.measureText(l).width));
    if (widest > W * 0.9) s *= (W * 0.9) / widest;
    return s;
  };
  size = fit(lines);
  if (size < Math.min(W, H) * 0.09 && words.length > 1) {
    let best = 1, bestDiff = Infinity;
    for (let i = 1; i < words.length; i++) {
      const d = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
      if (d < bestDiff) { best = i; bestDiff = d; }
    }
    lines = [words.slice(0, best).join(" "), words.slice(best).join(" ")];
    size = fit(lines);
  }
  ctx.font = `900 ${size}px "Montserrat", "Arial Black", Impact, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  const lh = size * 1.05, block = lh * lines.length;
  const y0 = place === "top" ? H * 0.08 + lh / 2 : H - H * 0.08 - block + lh / 2;
  lines.forEach((l, i) => {
    const y = y0 + i * lh;
    ctx.lineWidth = size * 0.16; ctx.strokeStyle = "rgba(0,0,0,0.92)"; ctx.strokeText(l, W / 2, y);
    ctx.fillStyle = "#ffffff"; ctx.fillText(l, W / 2, y);
  });
}

export function ThumbnailMaker({ src, name, vertical }: { src: string; name: string; vertical: boolean }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<Size>(vertical ? "cover" : "youtube");
  const [title, setTitle] = useState("");
  const [place, setPlace] = useState<"top" | "bottom">("bottom");
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const look = useRef({ title, place });   // what the seek handler draws (it is set up once per open)
  look.current = { title, place };

  useEffect(() => {
    if (!open) return;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous"; v.muted = true; v.preload = "auto"; v.playsInline = true; v.src = src;
    v.onloadedmetadata = () => { setDur(v.duration || 0); const mid = (v.duration || 0) * 0.4; v.currentTime = mid; setT(mid); };
    v.onseeked = () => { if (canvas.current) draw(canvas.current, v, look.current.title, look.current.place); };
    v.onerror = () => setErr(tr("The cut could not be loaded for a thumbnail."));
    video.current = v;
    return () => { v.src = ""; video.current = null; };
  }, [open, src]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const v = video.current; if (v && canvas.current && v.readyState >= 2) draw(canvas.current, v, title, place); }, [title, place, size]);
  useEffect(() => { const v = video.current; if (v && Math.abs(v.currentTime - t) > 0.01) v.currentTime = t; }, [t]);

  function download() {
    const cv = canvas.current;
    if (!cv) return;
    try {
      cv.toBlob((b) => {
        if (!b) return setErr(tr("The thumbnail could not be made."));
        const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${name}-thumbnail.jpg`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }, "image/jpeg", 0.92);
    } catch { setErr(tr("The browser blocked reading the video for a thumbnail. Download the cut and try again.")); }
  }

  if (!open) return (
    <Pressable onPress={() => setOpen(true)} accessibilityRole="button"><Text style={{ color: c.link, textDecorationLine: "underline" }}>{tr("Make a thumbnail")}</Text></Pressable>
  );
  const [W, H] = SIZES[size];
  const chip = (on: boolean) => ({ borderWidth: 1, borderColor: on ? c.accent : c.line, backgroundColor: on ? c.accent : "transparent",
                                   borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 });
  return (
    <View style={{ gap: 8, marginTop: 8, padding: 12, borderWidth: 1, borderColor: c.line, borderRadius: 12 }}>
      <Text style={{ color: c.ink, fontWeight: "600" }}>{tr("Thumbnail")}</Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {(Object.keys(SIZES) as Size[]).map((k) => (
          <Pressable key={k} onPress={() => setSize(k)} style={chip(size === k)} accessibilityRole="radio" accessibilityState={{ checked: size === k }}>
            <Text style={{ color: size === k ? c.onAccent : c.ink }}>{k === "youtube" ? tr("YouTube 1280×720") : tr("Vertical 1080×1920")}</Text>
          </Pressable>
        ))}
        {(["top", "bottom"] as const).map((p) => (
          <Pressable key={p} onPress={() => setPlace(p)} style={chip(place === p)} accessibilityRole="radio" accessibilityState={{ checked: place === p }}>
            <Text style={{ color: place === p ? c.onAccent : c.ink }}>{tr("Title {p}", { p })}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput value={title} onChangeText={setTitle} placeholder={tr("Title on the thumbnail (optional)")} placeholderTextColor={c.muted} maxLength={60}
        style={{ color: c.ink, borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, backgroundColor: c.field }} />
      <Text style={{ color: c.sub, fontSize: 13 }}>{tr("Moment: {v0} s of {v1} s", { v0: t.toFixed(1), v1: dur.toFixed(1) })}</Text>
      <input type="range" min={0} max={Math.max(0.1, dur - 0.05)} step={0.04} value={t} onChange={(e) => setT(Number(e.target.value))}
        aria-label={tr("Moment of the cut")} style={{ width: "100%", maxWidth: 560 }} />
      <canvas ref={canvas} width={W} height={H} style={{ width: size === "youtube" ? 480 : 220, maxWidth: "100%", borderRadius: 8, border: `1px solid ${c.line}` }} />
      <View style={{ flexDirection: "row", gap: 14 }}>
        <Pressable onPress={download} accessibilityRole="button"><Text style={{ color: c.link, textDecorationLine: "underline" }}>{tr("Download the JPEG")}</Text></Pressable>
        <Pressable onPress={() => setOpen(false)} accessibilityRole="button"><Text style={{ color: c.muted }}>{tr("Close")}</Text></Pressable>
      </View>
      {err && <Text style={{ color: c.fail, fontSize: 13 }}>{tMsg(err)}</Text>}
    </View>
  );
}

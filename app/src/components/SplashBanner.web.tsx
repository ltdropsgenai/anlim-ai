// Splash banner (2026-11-20, Londi: "a splash banner for anlim.ai home page and welcome page"; a reel of anlim clips,
// slow motion, stops on hover). One muted reel (public/banner/anlim-reel.mp4, 1600x440, about 24 s, 2.5 MB): seven
// clips made in anlim's held-out test of 2026-11-19 that Londi labelled PASS, slowed to 0.83x, cross-faded. It pauses
// while pointed at, and does not play at all when the visitor asks for reduced motion (the poster frame shows). The
// caption (top left: the page headline overlaps the bottom fade) names the model and look of the clip on screen. No outline: it fades into the page at its edges. @anlim
import { useEffect, useRef, useState } from "react";
import { c } from "../lib/theme";

// order and timing of the reel: each clip holds 4.08 s and cross-fades 0.8 s into the next (ffmpeg build, 2026-11-20)
const SEG = 3.28;
const CAPTIONS = [
  "Kling 4.0 · photoreal", "Seedance 2.0 · anime", "Kling 4.0 · claymation", "Seedance 2.0 · photoreal",
  "Kling 4.0 · photoreal", "Kling 4.0 · anime", "Kling 4.0 · photoreal",
];

export function SplashBanner({ height = 300 }: { height?: number }) {
  const v = useRef<HTMLVideoElement | null>(null);
  const [idx, setIdx] = useState(0);
  const [still, setStill] = useState(false);
  useEffect(() => {
    let reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* old browser */ }
    setStill(reduce);
    if (!reduce) v.current?.play().catch(() => setStill(true));   // autoplay refused: the poster stays
  }, []);
  return (
    <div style={{ position: "relative", width: "100%", height, borderRadius: 18, overflow: "hidden", background: "#0B0B0E",
                  boxShadow: "0 30px 80px rgba(0,0,0,0.55)" }}
      onMouseEnter={() => v.current?.pause()} onMouseLeave={() => { if (!still) v.current?.play().catch(() => {}); }}>
      <video ref={v} src="/banner/anlim-reel.mp4" poster="/banner/anlim-reel-poster.jpg" muted loop playsInline preload="auto"
        aria-label="Clips made with anlim" onTimeUpdate={(e) => setIdx(Math.min(CAPTIONS.length - 1, Math.floor(e.currentTarget.currentTime / SEG)))}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      {/* edges melt into the page: a vignette and a deeper fall-off at the bottom where the headline sits */}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none",
        background: `radial-gradient(120% 90% at 50% 40%, rgba(8,8,10,0) 55%, rgba(8,8,10,0.55) 100%),
                     linear-gradient(180deg, rgba(8,8,10,0) 55%, ${c.bg} 100%)` }} />
      <div style={{ position: "absolute", left: 18, top: 14, display: "flex", alignItems: "center", gap: 8, pointerEvents: "none" }}>
        <span style={{ width: 7, height: 7, borderRadius: 4, background: c.accent, boxShadow: "0 0 8px rgba(255,122,26,0.9)" }} />
        <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11, letterSpacing: 1.1, color: "#D4D4D8",
                       textTransform: "uppercase", textShadow: "0 1px 6px rgba(0,0,0,0.8)" }}>Made in anlim · {CAPTIONS[idx]}</span>
      </div>
    </div>
  );
}

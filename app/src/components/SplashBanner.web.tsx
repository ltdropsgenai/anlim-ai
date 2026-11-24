// Splash banner (2026-11-20, Londi: "a splash banner for anlim.ai home page and welcome page", made from his own
// @anlim music videos and his Name That Fight episodes; slow motion, stops on hover). One muted reel
// (public/banner/anlim-reel.mp4, 1600x440, about 40 s, 4.5 MB): twelve moments, seven from the final cuts of his music
// videos (cropped above the burned-in lyrics) interleaved with five Name That Fight fight clips, slowed to 0.83x and
// cross-faded. It pauses while pointed at, and does not play at all when the visitor asks for reduced motion (the
// poster frame shows). The caption (top left, clear of the headline) names the song or series on screen. No outline:
// the banner fades into the page at its edges. @anlim
import { useEffect, useRef, useState } from "react";
import { c } from "../lib/theme";
import { tr } from "../lib/i18n";

// order and timing of the reel: each clip holds 4.08 s and cross-fades 0.8 s into the next (ffmpeg build, 2026-11-20)
const SEG = 3.28;
const FIGHT = "Name That Fight";
const CAPTIONS = ["Ann Rebati", FIGHT, "Denye Chans", FIGHT, "Fanm Vanyan", FIGHT, "Kijan Pou M Fè", FIGHT, "Fanm Vanyan", FIGHT,
                  "Pa Tann Mwen Ale", "Denye Chans"];

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
        aria-label={tr("Moments from @anlim music videos and Name That Fight")} onTimeUpdate={(e) => setIdx(Math.min(CAPTIONS.length - 1, Math.floor(e.currentTarget.currentTime / SEG)))}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      {/* edges melt into the page: a vignette and a deeper fall-off at the bottom where the headline sits */}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none",
        background: `radial-gradient(120% 90% at 50% 40%, rgba(8,8,10,0) 55%, rgba(8,8,10,0.55) 100%),
                     linear-gradient(180deg, rgba(8,8,10,0) 55%, ${c.bg} 100%)` }} />
      <div style={{ position: "absolute", left: 18, top: 14, display: "flex", alignItems: "center", gap: 8, pointerEvents: "none" }}>
        <span style={{ width: 7, height: 7, borderRadius: 4, background: c.accent, boxShadow: "0 0 8px rgba(255,122,26,0.9)" }} />
        <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11, letterSpacing: 1.1, color: "#D4D4D8",
                       textTransform: "uppercase", textShadow: "0 1px 6px rgba(0,0,0,0.8)" }}>{tr("@anlim · {v0}", { v0: CAPTIONS[idx] })}</span>
      </div>
    </div>
  );
}

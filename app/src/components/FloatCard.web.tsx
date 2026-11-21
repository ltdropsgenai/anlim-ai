// Glass cards over ambient light (web, 2026-11-20, Londi picked direction B over the flat boxes). The look lives in the
// anlim-glass / anlim-ambient CSS that _layout.tsx injects (hover, reduced motion, no-backdrop-filter fallback). @anlim
import { ReactNode } from "react";
import { StyleProp, View, ViewStyle } from "react-native";
import { font } from "../lib/theme";

// `float` (2026-11-20, Londi: the prompt box should "appear 3D and ... floating on the background"): a deeper, two-part
// shadow, a brighter top edge and a slow drift that stops while the creator types (anlim-float CSS in _layout.tsx)
export function FloatCard({ children, style, compact = false, hover = false, float = false }:
  { children: ReactNode; style?: StyleProp<ViewStyle>; compact?: boolean; hover?: boolean; float?: boolean }) {
  return (
    <div className={`anlim-glass${compact ? " anlim-glass--compact" : ""}${hover ? " anlim-glass--hover" : ""}${float ? " anlim-float" : ""}`}>
      <View style={[{ flexGrow: 1 }, style]}>{children}</View>
    </div>
  );
}

// Soft tungsten light behind a grid of glass cards: what the glass shows through
export function Ambient({ children }: { children: ReactNode }) {
  return <div className="anlim-ambient">{children}</div>;
}

// A step's numbered tally light. With `rail` (wide screens) a thin line runs through every step: each card draws its
// own segment, reaching across the gap to the next card. Assumes the card's 24 px side padding.
export function StepMark({ n, rail = false, first = false, last = false, gap = 14 }:
  { n: number; rail?: boolean; first?: boolean; last?: boolean; gap?: number }) {
  const line = first ? "linear-gradient(90deg, rgba(255,122,26,0), rgba(255,122,26,0.55) 30%)"
    : last ? "linear-gradient(90deg, rgba(255,185,138,0.4), rgba(255,185,138,0) 85%)" : "rgba(255,150,80,0.45)";
  return (
    <div style={{ position: "relative", height: 20, display: "flex", alignItems: "center", gap: 12 }}>
      {rail && <div aria-hidden="true" style={{ position: "absolute", top: 10, height: 1, left: first ? 0 : -24, right: last ? 0 : -(24 + gap), background: line }} />}
      <span aria-hidden="true" style={{ position: "relative", width: 12, height: 12, borderRadius: "50%",
        background: "radial-gradient(circle at 35% 30%, #FFE2CC 0%, #FF9A4D 35%, #FF7A1A 60%, #9A3A06 100%)",
        boxShadow: "0 0 0 4px rgba(255,122,26,0.10), 0 0 18px rgba(255,122,26,0.55)" }} />
      <span style={{ position: "relative", fontFamily: font.mono.fontFamily, fontSize: 11, letterSpacing: 1, color: "#FFB98A",
        background: "rgba(16,14,14,0.92)", padding: "2px 6px", borderRadius: 4 }}>{String(n).padStart(2, "0")}</span>
    </div>
  );
}

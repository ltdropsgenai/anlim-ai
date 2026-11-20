// Soft light behind a nav glyph (web): tungsten for the current page, faint white on hover. A radial gradient, so it
// has no edge: depth from light, not from an outline (Londi's no-borders rule). @anlim
export function NavGlow({ tone, size = 44 }: { tone: "on" | "hover" | "off"; size?: number }) {
  const bg = tone === "on" ? "radial-gradient(closest-side, rgba(255,122,26,0.22), rgba(255,122,26,0))"
    : tone === "hover" ? "radial-gradient(closest-side, rgba(255,255,255,0.08), rgba(255,255,255,0))" : "none";
  return (
    <div aria-hidden="true" style={{ position: "absolute", left: "50%", top: "50%", width: size, height: size,
      marginLeft: -size / 2, marginTop: -size / 2, background: bg, pointerEvents: "none",
      opacity: tone === "off" ? 0 : 1, transition: "opacity 200ms ease" }} />
  );
}

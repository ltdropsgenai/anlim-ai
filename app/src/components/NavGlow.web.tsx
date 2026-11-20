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

// The current page's row in the sidebar: a tungsten wash that fades to nothing (no edge, no outline). `solid` is the
// project swatch: a warm gradient square.
export function Wash({ solid = false }: { solid?: boolean }) {
  return (
    <div aria-hidden="true" style={{ position: "absolute", inset: 0, borderRadius: solid ? 0 : 10, pointerEvents: "none",
      background: solid ? "linear-gradient(135deg, #FF7A1A, #B4440A)"
        : "linear-gradient(90deg, rgba(255,122,26,0.14), rgba(255,122,26,0) 85%)" }} />
  );
}

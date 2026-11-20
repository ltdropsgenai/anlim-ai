// Feature mark on the web (2026-11-20): a MARK glyph in brushed-metal strokes with one lit tungsten part, sitting in a
// soft pool of light instead of a square tile. Geometry in iconData.ts, shared with Mark.tsx. @anlim
import { useId } from "react";
import { MARK, Prim } from "./iconData";
import type { MarkName } from "./iconData";

const draw = (list: Prim[]) => list.map((x, i) =>
  x.t === "path" ? <path key={i} {...x.p} /> : x.t === "rect" ? <rect key={i} {...x.p} /> : <circle key={i} {...x.p} />);

export function Mark({ name, size = 64 }: { name: MarkName; size?: number }) {
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const g = MARK[name];
  return (
    <div aria-hidden="true" style={{ position: "relative", width: size, height: size, margin: "-6px 0 12px -6px" }}>
      <div style={{ position: "absolute", inset: -8, borderRadius: "50%", pointerEvents: "none",
        background: "radial-gradient(closest-side, rgba(255,122,26,0.22), rgba(255,122,26,0.06) 60%, rgba(255,122,26,0))" }} />
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" strokeLinecap="round" strokeLinejoin="round"
        style={{ position: "relative", display: "block" }}>
        <defs>
          <linearGradient id={id + "m"} x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stopColor="#FFFFFF" /><stop offset="1" stopColor="#9C9CA6" /></linearGradient>
          <linearGradient id={id + "a"} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FFC69C" /><stop offset="1" stopColor="#FF7A1A" /></linearGradient>
          <filter id={id + "f"} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.1" /></filter>
        </defs>
        {g.b.length > 0 && <g fill="#FFFFFF" fillOpacity={0.06} stroke="none">{draw(g.b)}</g>}
        <g stroke={`url(#${id}m)`} strokeWidth={1.35}>{draw(g.s)}</g>
        <g fill="#FF7A1A" stroke="#FF7A1A" opacity={0.55} filter={`url(#${id}f)`}>{draw(g.a)}</g>
        <g fill={`url(#${id}a)`} stroke={`url(#${id}a)`}>{draw(g.a)}</g>
      </svg>
    </div>
  );
}

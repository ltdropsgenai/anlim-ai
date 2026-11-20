// Icons for the app frame (web: inline SVG). The geometry lives in iconData.ts, shared with the native renderer. @anlim
import { ACCENT, LINE, NAV, Prim } from "./iconData";
import type { IconName } from "./iconData";
export type { IconName };

const draw = (list: Prim[]) => list.map((x, i) =>
  x.t === "path" ? <path key={i} {...x.p} /> : x.t === "rect" ? <rect key={i} {...x.p} /> : <circle key={i} {...x.p} />);

export function Icon({ name, size = 20, color = "currentColor", active = false, weight = 1.8 }:
  { name: IconName; size?: number; color?: string; active?: boolean; weight?: number }) {
  const n = NAV[name];
  if (n) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        style={{ display: "block", overflow: "visible" }}>
        {n.b.length > 0 && <g fill={color} fillOpacity={active ? 0.16 : 0.09} stroke="none">{draw(n.b)}</g>}
        <g stroke={color} strokeWidth={weight} style={{ transition: "stroke 160ms ease" }}>{draw(n.s)}</g>
        <g fill={active ? ACCENT : color} stroke={active ? ACCENT : color} opacity={active ? 1 : 0.75}
          style={{ transition: "fill 200ms ease, stroke 200ms ease", filter: active ? "drop-shadow(0 0 3px rgba(255,122,26,0.7))" : "none" }}>{draw(n.a)}</g>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={weight}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block" }}>{draw(LINE[name] ?? [])}</svg>
  );
}

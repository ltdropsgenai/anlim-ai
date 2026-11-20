// Icons on iOS / Android: the same geometry as the web (iconData.ts), drawn with react-native-svg (2026-11-20: the
// native build showed placeholder characters). No glow on native; the orange accent part carries the current page. @anlim
import Svg, { Circle, G, Path, Rect } from "react-native-svg";
import { ACCENT, LINE, NAV, Prim } from "./iconData";
import type { IconName } from "./iconData";
export type { IconName };

const draw = (list: Prim[]) => list.map((x, i) =>
  x.t === "path" ? <Path key={i} {...(x.p as object)} /> : x.t === "rect" ? <Rect key={i} {...(x.p as object)} /> : <Circle key={i} {...(x.p as object)} />);

export function Icon({ name, size = 20, color = "#F4F4F5", active = false, weight = 1.8 }:
  { name: IconName; size?: number; color?: string; active?: boolean; weight?: number }) {
  const n = NAV[name];
  if (n) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {n.b.length > 0 && <G fill={color} fillOpacity={active ? 0.16 : 0.09} stroke="none">{draw(n.b)}</G>}
        <G stroke={color} strokeWidth={weight}>{draw(n.s)}</G>
        <G fill={active ? ACCENT : color} stroke={active ? ACCENT : color} opacity={active ? 1 : 0.75}>{draw(n.a)}</G>
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round">
      {draw(LINE[name] ?? [])}
    </Svg>
  );
}

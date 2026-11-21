// Feature mark on iOS / Android (2026-11-20): the same MARK geometry as the web, flat colours, no light pool. @anlim
import { View } from "react-native";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";
import { ACCENT, MARK, Prim } from "./iconData";
import type { MarkName } from "./iconData";

const draw = (list: Prim[]) => list.map((x, i) =>
  x.t === "path" ? <Path key={i} {...(x.p as object)} /> : x.t === "rect" ? <Rect key={i} {...(x.p as object)} /> : <Circle key={i} {...(x.p as object)} />);

export function Mark({ name, size = 64 }: { name: MarkName; size?: number }) {
  const g = MARK[name];
  return (
    <View style={{ width: size, height: size, marginLeft: -6, marginTop: -6, marginBottom: 12 }}>
      <Svg width={size} height={size} viewBox="0 0 32 32" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {g.b.length > 0 && <G fill="#FFFFFF" fillOpacity={0.06} stroke="none">{draw(g.b)}</G>}
        <G stroke="#D4D4D8" strokeWidth={1.35}>{draw(g.s)}</G>
        <G fill={ACCENT} stroke={ACCENT}>{draw(g.a)}</G>
      </Svg>
    </View>
  );
}

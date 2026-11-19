// Equal-width columns that fit the space: every card the same width, the last row included. @anlim
import { ReactNode, useState } from "react";
import { View } from "react-native";

export function Grid({ children, min = 260, gap = 16 }: { children: ReactNode[]; min?: number; gap?: number }) {
  const [w, setW] = useState(0);
  const n = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = w ? (w - gap * (n - 1)) / n : 0;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap, marginBottom: 14 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 && children.map((ch, i) => <View key={i} style={{ width: cw }}>{ch}</View>)}
    </View>
  );
}

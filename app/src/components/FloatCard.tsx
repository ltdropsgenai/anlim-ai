// Cards on iOS / Android (2026-11-20): a solid raised surface with a faint top highlight stands in for the web glass
// (no backdrop blur on native, no gradient dependency). Same API as FloatCard.web.tsx. @anlim
import { ReactNode } from "react";
import { StyleProp, Text, View, ViewStyle } from "react-native";
import { c, font } from "../lib/theme";

export function FloatCard({ children, style, compact = false }:
  { children: ReactNode; style?: StyleProp<ViewStyle>; compact?: boolean; hover?: boolean }) {
  return (
    <View style={{ backgroundColor: "#141418", borderRadius: compact ? 14 : 20,
      shadowColor: "#000", shadowOpacity: 0.6, shadowRadius: compact ? 16 : 28, shadowOffset: { width: 0, height: compact ? 8 : 16 }, elevation: compact ? 4 : 8 }}>
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 18, right: 18, height: 1, backgroundColor: "rgba(255,255,255,0.08)" }} />
      <View style={style}>{children}</View>
    </View>
  );
}

// Native: no ambient light
export function Ambient({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function StepMark({ n }: { n: number; rail?: boolean; first?: boolean; last?: boolean; gap?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 20 }}>
      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.accent }} />
      <Text style={[{ color: c.link, fontSize: 11, letterSpacing: 1 }, font.mono]}>{String(n).padStart(2, "0")}</Text>
    </View>
  );
}

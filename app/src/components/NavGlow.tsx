import { View } from "react-native";
// Native: no glow (the tally light and the glyph's fill carry the current page). @anlim
export function NavGlow(_: { tone: "on" | "hover" | "off"; size?: number }) {
  return null;
}

// Native: a flat tint stands in for the web gradient.
export function Wash({ solid = false }: { solid?: boolean }) {
  return <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: solid ? 0 : 10,
    backgroundColor: solid ? "#E2630F" : "rgba(255,122,26,0.10)" }} />;
}

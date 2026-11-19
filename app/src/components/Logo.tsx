// anlim.ai mark, direction D "Tally dot" (native): drawn with views, no SVG library needed. @anlim
import { View } from "react-native";

export function Logo({ size = 40 }: { size?: number }) {
  const u = size / 100, sw = (size <= 36 ? 10 : 9) * u;
  return (
    <View style={{ width: size, height: size, borderRadius: 24 * u, backgroundColor: "#16161A" }} accessibilityLabel="anlim.ai">
      <View style={{ position: "absolute", left: (42 - 16 - sw / u / 2) * u, top: (56 - 16 - sw / u / 2) * u, width: (32 * u) + sw,
                     height: (32 * u) + sw, borderRadius: size, borderWidth: sw, borderColor: "#F4F4F5" }} />
      <View style={{ position: "absolute", left: 58 * u - sw / 2, top: 34 * u, width: sw, height: 38 * u, borderRadius: 3 * u, backgroundColor: "#F4F4F5" }} />
      <View style={{ position: "absolute", left: (76 - 7) * u, top: (68 - 7) * u, width: 14 * u, height: 14 * u, borderRadius: 7 * u, backgroundColor: "#FF7A1A" }} />
    </View>
  );
}

// Splash banner on iOS / Android: the reel's poster frame (the web plays the reel itself, SplashBanner.web.tsx). @anlim
import { Image, View } from "react-native";
import { c } from "../lib/theme";

export function SplashBanner({ height = 300 }: { height?: number }) {
  return (
    <View style={{ width: "100%", height, borderRadius: 18, overflow: "hidden", backgroundColor: "#0B0B0E" }}>
      <Image source={require("../../assets/banner/poster.jpg")} style={{ width: "100%", height: "100%" }} resizeMode="cover"
        accessibilityLabel="A clip made with anlim" />
      <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: height * 0.35, backgroundColor: c.bg, opacity: 0.55 }} />
    </View>
  );
}

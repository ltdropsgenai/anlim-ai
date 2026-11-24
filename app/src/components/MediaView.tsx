// Native preview for an asset: images inline; video and audio open in the system player. @anlim
import { Image, Linking, Pressable, Text } from "react-native";
import type { AssetKind } from "../lib/api";
import { c } from "../lib/theme";
import { tr } from "../lib/i18n";

export function MediaView({ kind, url, poster, ratio = 16 / 9 }: { kind: AssetKind; url: string; poster?: string | null; ratio?: number }) {
  if (kind === "clip" || kind === "cut" || kind === "music" || kind === "voice" || kind === "sfx")
    return (
      <Pressable onPress={() => Linking.openURL(url)} accessibilityRole="button" style={{ alignItems: "center", padding: 12 }}>
        {poster ? <Image source={{ uri: poster }} style={{ width: "100%", aspectRatio: ratio, borderRadius: 12 }} /> : null}
        <Text style={{ color: c.link, marginTop: 10 }}>{tr("Play")}</Text>
      </Pressable>
    );
  return <Image source={{ uri: url }} style={{ width: "100%", aspectRatio: ratio, borderRadius: 12 }} resizeMode="contain" />;
}

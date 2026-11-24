// Native: open the audio in the system player. @anlim
import { Linking, Pressable, Text } from "react-native";
import { c } from "../lib/theme";
import { tr } from "../lib/i18n";
export function AudioPlayer({ src }: { src: string }) {
  return <Pressable onPress={() => Linking.openURL(src)} accessibilityRole="button"><Text style={{ color: c.link }}>{tr("Play")}</Text></Pressable>;
}

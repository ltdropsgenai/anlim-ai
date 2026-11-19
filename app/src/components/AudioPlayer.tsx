// Native: open the audio in the system player. @anlim
import { Linking, Pressable, Text } from "react-native";
import { c } from "../lib/theme";
export function AudioPlayer({ src }: { src: string }) {
  return <Pressable onPress={() => Linking.openURL(src)} accessibilityRole="button"><Text style={{ color: c.link }}>Play</Text></Pressable>;
}

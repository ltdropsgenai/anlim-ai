// Native: video guides open in the browser for now (the Help page's player is web first). @anlim
import { Linking, Pressable, Text } from "react-native";
import { c } from "../lib/theme";
import type { Tutorial } from "../lib/tutorials";

export function TutorialVideo({ t }: { t: Tutorial }) {
  return (
    <Pressable onPress={() => Linking.openURL(`https://anlim.ai${t.file}`)} accessibilityRole="link">
      <Text style={{ color: c.accent, fontSize: 15 }}>Watch “{t.title}”</Text>
    </Pressable>
  );
}

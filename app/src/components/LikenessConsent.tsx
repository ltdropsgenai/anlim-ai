// Likeness consent (2026-11-24, migration studio_safety): before a photo or video of people is used (a character's
// reference, an uploaded start image, a motion transfer, an upload for an AI tool), the creator confirms that any real
// person in it is them or agreed. The server keeps the confirmation per file and refuses a person's photo without it. @anlim
import { Pressable, StyleSheet, Text, View } from "react-native";
import { c } from "../lib/theme";
import { tr } from "../lib/i18n";

// Same words as studio.likeness_statement() in the database.
export const LIKENESS_STATEMENT = "Any real person in this picture or video is me, or has agreed that I may use their likeness here.";

export function LikenessConsent({ on, onChange, disabled, plural }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; plural?: boolean }) {
  const words = plural ? tr("Any real person in these pictures or videos is me, or has agreed that I may use their likeness here.") : tr(LIKENESS_STATEMENT);
  return (
    <Pressable disabled={disabled} onPress={() => onChange(!on)} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={words} style={s.row}>
      <View style={[s.box, on && s.boxOn]}>{on && <Text style={s.tick}>✓</Text>}</View>
      <Text style={s.text}>{words} <Text style={s.small}>{tr("Making pictures of real people without their consent is not allowed (Terms).")}</Text></Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginVertical: 6, maxWidth: 640 },
  box: { width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: c.muted, alignItems: "center", justifyContent: "center", marginTop: 1 },
  boxOn: { backgroundColor: c.accent, borderColor: c.accent },
  tick: { color: c.onAccent, fontSize: 13, fontWeight: "700", lineHeight: 15 },
  text: { color: c.ink, flex: 1, fontSize: 14, lineHeight: 20 },
  small: { color: c.muted, fontSize: 13 },
});

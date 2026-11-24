// Language picker (2026-11-24): English, Español, Français. Signed in, the choice is saved to the account, so emails,
// end cards and anlim's replies follow it; signed out, it is kept on this device. @anlim
import { Pressable, Text, View } from "react-native";
import { c } from "../lib/theme";
import { LANGS, Lang, getLang, setLang, tr } from "../lib/i18n";
import { api } from "../lib/api";

export function LanguagePicker({ signedIn, compact }: { signedIn: boolean; compact?: boolean }) {
  const cur = getLang();
  const pick = (l: Lang) => {
    if (l === cur) return;
    if (signedIn) api.setLanguage(l).catch(() => null);
    setLang(l);   // remounts the app in the new language
  };
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={tr("Language")} style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
      {LANGS.map((l) => (
        <Pressable key={l.id} onPress={() => pick(l.id)} accessibilityRole="radio" accessibilityState={{ checked: l.id === cur }}
          style={{ borderWidth: 1, borderColor: l.id === cur ? c.accent : c.line, backgroundColor: l.id === cur ? c.accent : "transparent",
                   borderRadius: 999, paddingHorizontal: compact ? 10 : 14, paddingVertical: compact ? 4 : 8 }}>
          <Text style={{ color: l.id === cur ? c.onAccent : c.ink, fontSize: compact ? 12 : 14, fontWeight: "600" }}>{l.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

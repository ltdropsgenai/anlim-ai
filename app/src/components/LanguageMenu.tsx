// Language menu (2026-11-24, Londi: "I don't see any language selector"): the current language as a short code in the
// top bar of the studio and of the public pages; tapping it opens the three languages. Signed in, the choice is saved
// to the account (emails, end cards, notices follow it); signed out, on this device. @anlim
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { c, font } from "../lib/theme";
import { LANGS, Lang, getLang, setLang, tr } from "../lib/i18n";
import { api } from "../lib/api";

export function LanguageMenu({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const cur = getLang();
  const pick = (l: Lang) => {
    setOpen(false);
    if (l === cur) return;
    if (signedIn) api.setLanguage(l).catch(() => null);
    setLang(l);   // remounts the app in the new language
  };
  return (
    <View style={{ position: "relative", zIndex: 50 }}>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityLabel={tr("Language")}
        accessibilityState={{ expanded: open }}
        style={({ hovered }: { hovered?: boolean }) => ({ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8,
          paddingVertical: 6, borderRadius: 8, backgroundColor: open || hovered ? "#17171B" : "transparent" })}>
        <Text style={[{ color: c.sub, fontSize: 12, fontWeight: "600", letterSpacing: 0.8 }, font.mono]}>{cur.toUpperCase()}</Text>
        <Text style={{ color: c.muted, fontSize: 9 }}>▼</Text>
      </Pressable>
      {open && (
        <View accessibilityRole="menu" style={{ position: "absolute", top: 34, right: 0, minWidth: 140, backgroundColor: c.card,
          borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingVertical: 4, shadowColor: "#000", shadowOpacity: 0.5,
          shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>
          {LANGS.map((l) => (
            <Pressable key={l.id} onPress={() => pick(l.id)} accessibilityRole="menuitem" accessibilityState={{ selected: l.id === cur }}
              style={({ hovered }: { hovered?: boolean }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12,
                paddingVertical: 8, backgroundColor: hovered ? "#1C1C21" : "transparent" })}>
              <Text style={[{ color: l.id === cur ? c.accent : c.muted, fontSize: 11, width: 20 }, font.mono]}>{l.id.toUpperCase()}</Text>
              <Text style={{ color: l.id === cur ? c.ink : c.sub, fontSize: 14, fontWeight: l.id === cur ? "700" : "500" }}>{l.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

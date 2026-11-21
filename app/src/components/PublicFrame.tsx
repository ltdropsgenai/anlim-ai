// Frame for the pages anyone can open without signing in: landing, Terms, Privacy, Help (2026-11-19). @anlim
import { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { c, font } from "../lib/theme";
import { Logo } from "./Logo";
import { OPERATOR } from "../lib/legal";
import { SunStage } from "./SunLight";

// `sun` (2026-11-20): the page sits in front of the distant sun light (welcome page)
export function PublicFrame({ children, signedIn, sun }: { children: ReactNode; signedIn?: boolean; sun?: boolean }) {
  const { width } = useWindowDimensions();
  const narrow = width < 700;
  const page = (
    <ScrollView style={{ flex: 1, backgroundColor: sun ? "transparent" : c.bg }} contentContainerStyle={{ minHeight: "100%" }}>
      <View style={[s.bar, narrow && { paddingHorizontal: 16 }]}>
        <Pressable onPress={() => router.navigate("/welcome")} accessibilityRole="link" accessibilityLabel="anlim.ai" style={s.row}>
          <Logo size={32} />
          {!narrow && <Text style={[{ color: c.ink, fontSize: 20 }, font.display]}>anlim<Text style={{ color: c.accent }}>.</Text><Text style={{ color: c.sub }}>ai</Text></Text>}
        </Pressable>
        <View style={{ flex: 1 }} />
        {!narrow && <Pressable onPress={() => router.navigate({ pathname: "/welcome", params: { at: "pricing" } })} accessibilityRole="link"><Text style={s.nav}>Pricing</Text></Pressable>}
        {signedIn ? (
          <Pressable style={({ pressed }) => [s.cta, pressed && s.pressed]} onPress={() => router.navigate("/")} accessibilityRole="link"><Text style={s.ctaText}>Open the studio</Text></Pressable>
        ) : (<>
          <Pressable onPress={() => router.navigate("/login")} accessibilityRole="link"><Text style={s.nav}>Sign in</Text></Pressable>
          <Pressable style={({ pressed }) => [s.cta, pressed && s.pressed]} onPress={() => router.navigate("/start")} accessibilityRole="link">
            <Text style={s.ctaText}>Start free</Text>
          </Pressable>
        </>)}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
      <View style={s.foot}>
        <Text style={{ color: c.muted, fontSize: 12 }}>© 2026 {OPERATOR} · anlim.ai</Text>
        <View style={[s.row, { gap: 18 }]}>
          <Pressable onPress={() => router.navigate("/terms")} accessibilityRole="link"><Text style={s.footLink}>Terms</Text></Pressable>
          <Pressable onPress={() => router.navigate("/privacy")} accessibilityRole="link"><Text style={s.footLink}>Privacy</Text></Pressable>
          <Pressable onPress={() => router.navigate("/support")} accessibilityRole="link"><Text style={s.footLink}>Help & contact</Text></Pressable>
        </View>
      </View>
    </ScrollView>
  );
  return sun ? <SunStage>{page}</SunStage> : page;
}

// A readable column for long text (Terms, Privacy, Help).
export function Doc({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ padding: 24, maxWidth: 780, width: "100%", alignSelf: "center", gap: 10 }}>
      <Text style={[{ color: c.ink, fontSize: 34, marginBottom: 6 }, font.display]}>{title}</Text>
      {children}
    </View>
  );
}
export const H = ({ children }: { children: ReactNode }) => <Text style={[{ color: c.ink, fontSize: 19, marginTop: 18 }, font.display]}>{children}</Text>;
export const P = ({ children }: { children: ReactNode }) => <Text style={{ color: "#D4D4D8", fontSize: 15, lineHeight: 24 }}>{children}</Text>;
export const Li = ({ children }: { children: ReactNode }) => <Text style={{ color: "#D4D4D8", fontSize: 15, lineHeight: 24, paddingLeft: 14 }}>• {children}</Text>;

const s = StyleSheet.create({
  // 2026-11-20: no hairlines and no pill: the bar and the footer separate by space and value; the call to action is squared off
  bar: { flexDirection: "row", alignItems: "center", gap: 22, paddingHorizontal: 28, paddingVertical: 18 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  nav: { color: c.sub, fontSize: 14, fontWeight: "600" },
  cta: { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9,
         shadowColor: c.accent, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.92 },
  ctaText: { color: c.onAccent, fontWeight: "700", fontSize: 14 },
  foot: { backgroundColor: "#060608", padding: 24, paddingVertical: 28, flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 12, marginTop: 40 },
  footLink: { color: c.sub, fontSize: 13 },
});

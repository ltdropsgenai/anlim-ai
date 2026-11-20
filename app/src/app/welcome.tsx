// Public landing page (2026-11-19): what anlim does, the price list (live from studio.price_plans), and a way in.
// Anyone can open it; signed-out visitors land here instead of the sign-in form. @anlim
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { PricePlan, publicPlans } from "../lib/api";
import { supabase } from "../lib/supabase";
import { c, font } from "../lib/theme";
import { FEATURES } from "../lib/marketing";
import { Grid } from "../components/Grid";
import { Icon } from "../components/Icon";
import { PublicFrame } from "../components/PublicFrame";
import { SplashBanner } from "../components/SplashBanner";

const STEPS = [
  ["Set up your cast", "Add each character and place once, with a reference picture."],
  ["Write the shot", "Say what happens. anlim makes the start and end frames in your location."],
  ["Render and check", "Auto picks the video model; the anlim check looks at every frame."],
  ["Cut the scene", "Keep the takes you like and get one finished video, with sound."],
];
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

export default function Welcome() {
  const { width } = useWindowDimensions();
  const narrow = width < 760;
  const { at } = useLocalSearchParams<{ at?: string }>();
  const [plans, setPlans] = useState<PricePlan[] | null>(null);
  const [planError, setPlanError] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => { publicPlans().then(setPlans).catch(() => setPlanError(true)); supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session)); }, []);
  useEffect(() => {
    if (at === "pricing" && plans && typeof document !== "undefined") document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" });
  }, [at, plans]);
  const packs = (plans ?? []).filter((p) => p.kind === "pack");
  const monthly = (plans ?? []).filter((p) => p.kind === "plan" && p.billing_interval === "month");

  return (
    <PublicFrame signedIn={signedIn}>
      <View style={[s.page, narrow && { padding: 16 }]}>
        <SplashBanner height={narrow ? 180 : 340} />
        <View style={[s.hero, narrow && { paddingVertical: 32 }, { marginTop: narrow ? -40 : -96, paddingTop: 0 }]}>
          <Text style={[s.kicker, font.mono, { color: c.accent }]}>AI VIDEO STUDIO FOR CREATORS</Text>
          <Text style={[s.h1, font.display, narrow && { fontSize: 36, lineHeight: 40 }]}>Make AI video where your cast stays the same.</Text>
          <Text style={s.lead}>Cartoon or photoreal. Write each shot, and anlim makes the frames, picks the model, renders the clip and checks it before you keep it.</Text>
          <View style={[s.row, { marginTop: 24, justifyContent: "center" }]}>
            <Pressable style={({ pressed }) => [s.cta, pressed && s.pressed]} onPress={() => router.navigate(signedIn ? "/" : "/start")} accessibilityRole="link">
              <Text style={s.ctaText}>{signedIn ? "Open the studio" : "Start free"}</Text><Icon name="arrow" size={18} color={c.onAccent} />
            </Pressable>
            {!signedIn && <Pressable style={({ pressed }) => [s.ghost, pressed && s.pressed]} onPress={() => router.navigate("/login")} accessibilityRole="link">
              <Text style={{ color: c.ink, fontWeight: "600", fontSize: 16 }}>Sign in</Text><Icon name="arrow" size={16} color={c.sub} />
            </Pressable>}
          </View>
          <Text style={[s.small, { marginTop: 12, textAlign: "center" }]}>Free starter credits when you confirm your email. No card needed.</Text>
        </View>

        <Text style={[s.kicker, font.mono, s.center]}>HOW IT WORKS</Text>
        <Grid min={220} gap={14}>
          {STEPS.map(([t, b], i) => (
            <View key={t} style={[s.card, { padding: 20, minHeight: 150 }]}>
              <Text style={[{ color: c.accent, fontSize: 13 }, font.mono]}>0{i + 1}</Text>
              <Text style={[s.h3, font.display]}>{t}</Text>
              <Text style={s.body}>{b}</Text>
            </View>
          ))}
        </Grid>

        <Text style={[s.kicker, font.mono, s.center, { marginTop: 40 }]}>WHAT YOU GET</Text>
        <Grid min={300} gap={14}>
          {FEATURES.map((f) => (
            <View key={f.title} style={[s.card, { padding: 20, minHeight: 160 }]}>
              <View style={s.iconBox}><Icon name={f.icon} size={20} color={c.accent} /></View>
              <Text style={[s.h3, font.display]}>{f.title}</Text>
              <Text style={s.body}>{f.body}</Text>
            </View>
          ))}
        </Grid>

        <View nativeID="pricing">
          <Text style={[s.kicker, font.mono, s.center, { marginTop: 40 }]}>PRICING</Text>
          <Text style={[s.h2, font.display, s.center]}>Pay for what you make</Text>
          <Text style={[s.body, s.center, { maxWidth: 640, alignSelf: "center" }]}>
            Everything runs on credits. A clip costs credits per second of video; a made frame costs a few credits; scene cuts are free.
            If a clip is unusable, request a refund and tell us why; we look at every request.
          </Text>
          {!plans && !planError && <ActivityIndicator style={{ marginVertical: 24 }} />}
          {planError && <Text style={[s.body, s.center]}>The price list could not load. Sign in to see it under Credits & plan.</Text>}
          {monthly.length > 0 && (<>
            <Text style={[s.h3, font.display, { marginTop: 22 }]}>Monthly plans</Text>
            <Grid min={240} gap={14}>
              {monthly.map((p) => (
                <View key={p.id} style={[s.card, { padding: 20 }]}>
                  <Text style={[{ color: c.ink, fontSize: 18 }, font.display]}>{p.name}</Text>
                  <Text style={[{ color: c.ink, fontSize: 32, marginTop: 6 }, font.display]}>{money(p.price_cents)}<Text style={{ color: c.sub, fontSize: 14 }}> / month</Text></Text>
                  <Text style={[s.body, font.mono]}>{p.credits.toLocaleString()} CREDITS A MONTH</Text>
                </View>
              ))}
            </Grid>
          </>)}
          {packs.length > 0 && (<>
            <Text style={[s.h3, font.display, { marginTop: 22 }]}>Credit packs</Text>
            <Grid min={200} gap={14}>
              {packs.map((p) => (
                <View key={p.id} style={[s.card, { padding: 18 }]}>
                  <Text style={[{ color: c.ink, fontSize: 16 }, font.display]}>{p.name}</Text>
                  <Text style={[{ color: c.ink, fontSize: 26, marginTop: 4 }, font.display]}>{money(p.price_cents)}</Text>
                  <Text style={[s.body, font.mono]}>{p.credits.toLocaleString()} CREDITS · ONE TIME</Text>
                </View>
              ))}
            </Grid>
          </>)}
        </View>

        <View style={[s.card, { padding: 28, alignItems: "center", marginTop: 40, gap: 10 }]}>
          <Text style={[s.h2, font.display, s.center, { marginTop: 0 }]}>Your first scene is on us</Text>
          <Text style={[s.body, s.center]}>Confirm your email and your starter credits are waiting.</Text>
          <Pressable style={({ pressed }) => [s.cta, pressed && s.pressed]} onPress={() => router.navigate(signedIn ? "/" : "/start")} accessibilityRole="link">
            <Text style={s.ctaText}>{signedIn ? "Open the studio" : "Create your account"}</Text>
          </Pressable>
        </View>
      </View>
    </PublicFrame>
  );
}

const s = StyleSheet.create({
  page: { padding: 28, maxWidth: 1180, width: "100%", alignSelf: "center" },
  hero: { alignItems: "center", paddingVertical: 56, paddingHorizontal: 8 },
  kicker: { color: c.sub, fontSize: 12, letterSpacing: 1, marginBottom: 12 },
  center: { textAlign: "center" },
  h1: { color: c.ink, fontSize: 60, lineHeight: 64, textAlign: "center", maxWidth: 900 },
  h2: { color: c.ink, fontSize: 30, marginBottom: 10 },
  h3: { color: c.ink, fontSize: 18, marginTop: 10, marginBottom: 2 },
  lead: { color: c.sub, fontSize: 18, lineHeight: 28, textAlign: "center", maxWidth: 680, marginTop: 18 },
  body: { color: c.sub, fontSize: 14, lineHeight: 21, marginTop: 6 },
  small: { color: c.muted, fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  // 2026-11-20 (Londi's rules: no pills, no outlined boxes): the one filled control is squared off and lit; the
  // second action is type; cards are raised surfaces (value and shadow), not hairline boxes.
  cta: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.accent, borderRadius: 10, paddingHorizontal: 22, paddingVertical: 14,
         shadowColor: c.accent, shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 0 } },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.92 },
  ctaText: { color: c.onAccent, fontWeight: "700", fontSize: 16 },
  ghost: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 14 },
  card: { backgroundColor: "#0F0F13", borderRadius: 16,
          shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 28, shadowOffset: { width: 0, height: 14 } },
  iconBox: { width: 40, height: 40, borderRadius: 12, backgroundColor: "#2A1608", alignItems: "center", justifyContent: "center" },
});

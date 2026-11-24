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
import { Ambient, FloatCard, StepMark } from "../components/FloatCard";
import { Mark } from "../components/Mark";
import { PublicFrame } from "../components/PublicFrame";
import { SplashBanner } from "../components/SplashBanner";
import { tr, locale } from "../lib/i18n";

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
  // 2026-11-20: the step rail only reads when all four steps sit in one row (4 x 220 + 3 x 16 gap + 56 page padding)
  const oneRow = !narrow && width >= 984;
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
        <View style={[s.hero, narrow && { paddingVertical: 32 }, { marginTop: narrow ? -24 : -44, paddingTop: 0 }]}>
          <Text style={[s.kicker, font.mono, { color: c.accent }]}>{tr("AI VIDEO STUDIO FOR CREATORS")}</Text>
          <Text style={[s.h1, font.display, narrow && { fontSize: 36, lineHeight: 40 }]}>{tr("Make AI video where your cast stays the same.")}</Text>
          <Text style={s.lead}>{tr("Cartoon or photoreal. Write each shot, and anlim makes the frames, picks the model, renders the clip and checks it before you keep it.")}</Text>
          <View style={[s.row, { marginTop: 24, justifyContent: "center" }]}>
            <Pressable style={({ pressed }) => [s.cta, pressed && s.pressed]} onPress={() => router.navigate(signedIn ? "/" : "/start")} accessibilityRole="link">
              <Text style={s.ctaText}>{signedIn ? tr("Open the studio") : tr("Start free")}</Text><Icon name="arrow" size={18} color={c.onAccent} />
            </Pressable>
            {!signedIn && <Pressable style={({ pressed }) => [s.ghost, pressed && s.pressed]} onPress={() => router.navigate("/login")} accessibilityRole="link">
              <Text style={{ color: c.ink, fontWeight: "600", fontSize: 16 }}>{tr("Sign in")}</Text><Icon name="arrow" size={16} color={c.sub} />
            </Pressable>}
          </View>
          <Text style={[s.small, { marginTop: 12, textAlign: "center" }]}>{tr("Free starter credits when you confirm your email. No card needed.")}</Text>
        </View>

        {/* 2026-11-20 (Londi: no square boxes with logos): glass cards over a soft light; the steps share one lit rail on
            wide screens (a phone keeps just the numbered light), the features carry bespoke marks */}
        <Text style={[s.kicker, font.mono, s.center]}>{tr("HOW IT WORKS")}</Text>
        <Ambient>
          <Grid min={220} gap={16}>
            {STEPS.map(([t, b], i) => (
              <FloatCard key={t} style={{ padding: 24, paddingTop: 28, minHeight: narrow ? 0 : 170 }}>
                <StepMark n={i + 1} rail={oneRow} first={i === 0} last={i === STEPS.length - 1} gap={16} />
                <Text style={[s.h3, font.display, { marginTop: 26 }]}>{tr(t)}</Text>
                <Text style={s.body}>{tr(b)}</Text>
              </FloatCard>
            ))}
          </Grid>
        </Ambient>

        <Text style={[s.kicker, font.mono, s.center, { marginTop: 40 }]}>{tr("WHAT YOU GET")}</Text>
        <Ambient>
          <Grid min={300} gap={16}>
            {FEATURES.map((f) => (
              <FloatCard key={f.title} hover style={{ padding: 24, minHeight: 196 }}>
                <Mark name={f.mark} />
                <Text style={[s.h3, font.display, { marginTop: 0 }]}>{f.title}</Text>
                <Text style={s.body}>{f.body}</Text>
              </FloatCard>
            ))}
          </Grid>
        </Ambient>

        <View nativeID="pricing">
          <Text style={[s.kicker, font.mono, s.center, { marginTop: 40 }]}>{tr("PRICING")}</Text>
          <Text style={[s.h2, font.display, s.center]}>{tr("Pay for what you make")}</Text>
          <Text style={[s.body, s.center, { maxWidth: 640, alignSelf: "center" }]}>
            {tr("Everything runs on credits. A clip costs credits per second of video; a made frame costs a few credits; scene cuts are free. If a clip is unusable, request a refund and tell us why; we look at every request.")}
          </Text>
          {!plans && !planError && <ActivityIndicator style={{ marginVertical: 24 }} />}
          {planError && <Text style={[s.body, s.center]}>{tr("The price list could not load. Sign in to see it under Credits & plan.")}</Text>}
          {monthly.length > 0 && (<>
            <Text style={[s.h3, font.display, { marginTop: 22 }]}>{tr("Monthly plans")}</Text>
            <Grid min={240} gap={14}>
              {monthly.map((p) => (
                <FloatCard key={p.id} style={{ padding: 22 }}>
                  <Text style={[{ color: c.ink, fontSize: 18 }, font.display]}>{p.name}</Text>
                  <Text style={[{ color: c.ink, fontSize: 32, marginTop: 6 }, font.display]}>{money(p.price_cents)}<Text style={{ color: c.sub, fontSize: 14 }}>{tr(" / month")}</Text></Text>
                  <Text style={[s.body, font.mono]}>{tr("{v0} CREDITS A MONTH", { v0: p.credits.toLocaleString(locale()) })}</Text>
                </FloatCard>
              ))}
            </Grid>
          </>)}
          {packs.length > 0 && (<>
            <Text style={[s.h3, font.display, { marginTop: 22 }]}>{tr("Credit packs")}</Text>
            <Grid min={200} gap={14}>
              {packs.map((p) => (
                <FloatCard key={p.id} compact style={{ padding: 18 }}>
                  <Text style={[{ color: c.ink, fontSize: 16 }, font.display]}>{p.name}</Text>
                  <Text style={[{ color: c.ink, fontSize: 26, marginTop: 4 }, font.display]}>{money(p.price_cents)}</Text>
                  <Text style={[s.body, font.mono]}>{tr("{v0} CREDITS · ONE TIME", { v0: p.credits.toLocaleString(locale()) })}</Text>
                </FloatCard>
              ))}
            </Grid>
          </>)}
        </View>

        <View style={{ marginTop: 40 }}>
          <Ambient>
            <FloatCard style={{ padding: 28, alignItems: "center", gap: 10 }}>
              <Text style={[s.h2, font.display, s.center, { marginTop: 0 }]}>{tr("Your first scene is on us")}</Text>
              <Text style={[s.body, s.center]}>{tr("Confirm your email and your starter credits are waiting.")}</Text>
              <Pressable style={({ pressed }) => [s.cta, pressed && s.pressed]} onPress={() => router.navigate(signedIn ? "/" : "/start")} accessibilityRole="link">
                <Text style={s.ctaText}>{signedIn ? tr("Open the studio") : tr("Create your account")}</Text>
              </Pressable>
            </FloatCard>
          </Ambient>
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
  // second action is type; cards are glass surfaces (components/FloatCard), not hairline boxes.
  cta: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.accent, borderRadius: 10, paddingHorizontal: 22, paddingVertical: 14,
         shadowColor: c.accent, shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 0 } },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.92 },
  ctaText: { color: c.onAccent, fontWeight: "700", fontSize: 16 },
  ghost: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 14 },
});

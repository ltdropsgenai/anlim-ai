// Home (2026-11-19). Prompt first ("What are we making today?", components/Composer), then where the creator left
// off, recent work, and what anlim does: features, the models (live from studio.models and the tested routes), tools. @anlim
import { useCallback, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, HomeData } from "../lib/api";
import { c, font } from "../lib/theme";
import { Grid } from "../components/Grid";
import { Icon, IconName } from "../components/Icon";
import { FEATURES } from "../lib/marketing";
import { Composer } from "../components/Composer";
import { Ambient, FloatCard } from "../components/FloatCard";
import { Mark } from "../components/Mark";
import { SplashBanner } from "../components/SplashBanner";
import { SunStage } from "../components/SunLight";

const KIND: Record<string, string> = { walking: "walking", sit_stand: "sitting and standing", handling: "handling props", talking: "talking", other: "other shots" };
const LOOK: Record<string, string> = { cartoon: "Cartoon", photoreal: "Photoreal" };

// Image models are chosen by the look, not by a route table (studio.request_start_frame / request_end_frame / request_plate).
const IMAGE_MODELS = [
  { name: "Nano Banana 2", what: "Cartoon start and end frames, empty-room plates", price: "20 credits a frame" },
  { name: "GPT Image 2.6", what: "Photoreal new setups (characters placed in the room)", price: "17 credits + 3 a person" },
];

const TOOLS: { icon: IconName; title: string; body: string; href: "/workspace" | "/motion" | "/storage" | "/review" | "/library" | "/shots" | "/billing" }[] = [
  { icon: "workspace", title: "Workspace", body: "Write shots, make frames, render.", href: "/workspace" },
  { icon: "motion", title: "Motion transfer", body: "Recast your own clip as your characters.", href: "/motion" },
  { icon: "studio", title: "Scene board", body: "Every shot of every scene at a glance.", href: "/shots" },
  { icon: "review", title: "Review", body: "Keep or reject what was made.", href: "/review" },
  { icon: "assets", title: "Assets", body: "Find and download your work.", href: "/storage" },
  { icon: "cast", title: "Cast & places", body: "Characters, locations, series look.", href: "/library" },
  { icon: "credits", title: "Credits & plan", body: "Top up or change plan.", href: "/billing" },
];

function Section({ kicker, title, children }: { kicker: string; title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 44 }}>
      <Text style={[s.kicker, font.mono]}>{kicker}</Text>
      <Text style={[s.h2, font.display]}>{title}</Text>
      {children}
    </View>
  );
}

export default function Home() {
  const { width } = useWindowDimensions();
  const narrow = width < 760;
  const [d, setD] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => { api.home().then((x) => { setD(x); setError(null); }).catch((e) => setError((e as Error).message)); }, []));

  const stats: [string, number | undefined][] = [
    ["SERIES", d?.counts.series], ["SHOTS", d?.counts.shots], ["CLIPS KEPT", d?.counts.kept], ["TO REVIEW", d?.counts.to_review], ["SCENE CUTS", d?.counts.cuts],
  ];

  return (
    <SunStage>
    <ScrollView style={{ backgroundColor: "transparent" }} contentContainerStyle={[s.page, narrow && { padding: 16 }]}>
      {/* prompt first (2026-11-19, Londi: like other tools, "What are we making today?" with a prompt window) */}
      {/* splash banner (2026-11-20): a slow reel of clips made in anlim, above the prompt */}
      <SplashBanner height={narrow ? 170 : 280} />
      <Composer narrow={narrow} afterBanner />

      {/* where the creator left off; a brand-new account has none of this yet */}
      {d && (d.last || d.counts.series > 0) && (
        <View style={[s.hero, narrow && { padding: 18 }, { marginTop: 40 }]}>
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <View style={{ flex: 1, minWidth: 220 }}>
              <Text style={[s.kicker, font.mono]}>PICK UP WHERE YOU LEFT OFF</Text>
              {d.last && <Text style={[s.h3, font.display]} numberOfLines={2}>{d.last.series_name} · {d.last.scene_title}, shot {d.last.ord}</Text>}
            </View>
            <View style={s.row}>
              {d.last && (
                <Pressable style={s.cta} accessibilityRole="link"
                  onPress={() => router.navigate({ pathname: "/workspace", params: { series: d.last!.series_id, scene: d.last!.scene_id, shot: d.last!.shot_id } })}>
                  <Text style={s.ctaText}>Continue</Text><Icon name="arrow" size={18} color={c.onAccent} />
                </Pressable>
              )}
              <Pressable style={s.ghost} onPress={() => router.navigate("/workspace")} accessibilityRole="link">
                <Text style={{ color: c.ink, fontWeight: "600" }}>Open the Workspace</Text>
              </Pressable>
            </View>
          </View>
          <View style={[s.stats, narrow && { gap: 18 }]}>
            {stats.map(([k, v]) => (
              <View key={k}>
                <Text style={[{ color: c.ink, fontSize: 26 }, font.display]}>{v ?? "–"}</Text>
                <Text style={[s.statLabel, font.mono]}>{k}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
      {error && <Text style={{ color: c.fail, marginTop: 12 }}>{error}</Text>}

      {d && d.recent.length > 0 && (
        <Section kicker="RECENT" title="Your latest work">
          <Grid min={170} gap={12}>
            {d.recent.map((r) => (
              <Pressable key={r.id} style={s.card} accessibilityRole="link" accessibilityLabel={r.title}
                onPress={() => r.kind === "clip" ? router.navigate({ pathname: "/clip/[id]", params: { id: r.id } })
                  : router.navigate({ pathname: "/cut/[scene]", params: { scene: r.scene_id! } })}>
                <View style={{ backgroundColor: c.card2 }}>
                  {r.thumb_url ? <Image source={{ uri: r.thumb_url }} style={s.thumb} resizeMode="cover" /> : <View style={s.thumb} />}
                  <Text style={[s.tag, font.mono]}>{r.kind === "cut" ? "SCENE CUT" : "CLIP"}</Text>
                </View>
                <View style={{ padding: 10 }}>
                  <Text style={{ color: c.ink, fontSize: 13 }} numberOfLines={1}>{r.title}</Text>
                  <Text style={{ color: c.sub, fontSize: 12, marginTop: 2 }} numberOfLines={1}>{r.series_name}</Text>
                </View>
              </Pressable>
            ))}
          </Grid>
        </Section>
      )}

      <Section kicker="FEATURES" title="What anlim does">
        {/* 2026-11-20: the same glass cards and marks as the public page (no square icon tiles) */}
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
      </Section>

      <Section kicker="MODELS" title="The models behind it">
        <Text style={[s.body, { marginBottom: 14, maxWidth: 760 }]}>
          Video models turn your start frame into a clip. Auto sends each kind of shot to the one that did best in our tests; you can still pick one yourself on any shot.
        </Text>
        {!d && !error && <ActivityIndicator style={{ marginVertical: 20 }} />}
        <Grid min={320} gap={14}>
          {(d?.models ?? []).map((m) => {
            const byLook: Record<string, string[]> = {};
            for (const r of m.auto_for) (byLook[r.look] ||= []).push(KIND[r.kind] ?? r.kind);
            return (
              <View key={m.id} style={[s.card, { padding: 20 }]}>
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <Text style={[s.h3, font.display, { marginTop: 0 }]}>{m.label ?? m.id}</Text>
                  <Text style={[s.pill, font.mono]}>VIDEO · {m.resolution.toUpperCase()}</Text>
                </View>
                <Text style={[s.meta, font.mono]}>{m.credits_per_second} CREDITS / SECOND · {m.min_duration_s}–{m.max_duration_s} S CLIPS</Text>
                <Text style={[s.small, { marginTop: 12 }]}>Auto's pick for</Text>
                {Object.keys(byLook).length === 0 ? <Text style={s.body}>No kind of shot yet: available when you choose it yourself.</Text>
                  : Object.entries(byLook).map(([look, kinds]) => (
                    <Text key={look} style={s.body}><Text style={{ color: c.ink, fontWeight: "600" }}>{LOOK[look] ?? look}: </Text>{kinds.join(", ")}</Text>
                  ))}
              </View>
            );
          })}
          {IMAGE_MODELS.map((m) => (
            <View key={m.name} style={[s.card, { padding: 20 }]}>
              <View style={[s.row, { justifyContent: "space-between" }]}>
                <Text style={[s.h3, font.display, { marginTop: 0 }]}>{m.name}</Text>
                <Text style={[s.pill, font.mono]}>IMAGE</Text>
              </View>
              <Text style={[s.meta, font.mono]}>{m.price.toUpperCase()}</Text>
              <Text style={[s.small, { marginTop: 12 }]}>Used for</Text>
              <Text style={s.body}>{m.what}</Text>
            </View>
          ))}
        </Grid>
      </Section>

      <Section kicker="TOOLS" title="Where to go">
        <Grid min={240} gap={12}>
          {/* 2026-11-20: compact glass surface, no 1 px outline */}
          {TOOLS.map((t) => (
            <FloatCard key={t.href} compact hover>
              <Pressable style={s.tool} onPress={() => router.navigate(t.href)} accessibilityRole="link">
                <Icon name={t.icon} size={22} color={c.ink} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.ink, fontWeight: "700", fontSize: 15 }}>{t.title}</Text>
                  <Text style={{ color: c.sub, fontSize: 13, marginTop: 2 }}>{t.body}</Text>
                </View>
                <Icon name="arrow" size={18} color={c.sub} />
              </Pressable>
            </FloatCard>
          ))}
        </Grid>
      </Section>
      <View style={{ height: 40 }} />
    </ScrollView>
    </SunStage>
  );
}

const s = StyleSheet.create({
  page: { padding: 28, maxWidth: 1240, width: "100%", alignSelf: "center" },
  hero: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 24, padding: 28, overflow: "hidden" },
  kicker: { color: c.sub, fontSize: 12, letterSpacing: 1 },
  h1: { color: c.ink, fontSize: 48, lineHeight: 52, marginTop: 12, maxWidth: 820 },
  h2: { color: c.ink, fontSize: 28, textTransform: "uppercase", marginTop: 4, marginBottom: 16 },
  h3: { color: c.ink, fontSize: 18, marginTop: 14 },
  lead: { color: c.sub, fontSize: 17, lineHeight: 26, marginTop: 14, maxWidth: 680 },
  body: { color: c.sub, fontSize: 14, lineHeight: 21, marginTop: 6 },
  small: { color: c.muted, fontSize: 12 },
  meta: { color: c.sub, fontSize: 11, letterSpacing: 0.6, marginTop: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  cta: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 20, paddingVertical: 13 },
  ctaText: { color: c.onAccent, fontWeight: "700", fontSize: 15 },
  ghost: { borderWidth: 1, borderColor: c.line, backgroundColor: c.field, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 12, maxWidth: 360 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 36, marginTop: 30, paddingTop: 22, borderTopWidth: 1, borderTopColor: c.line },
  statLabel: { color: c.muted, fontSize: 11, letterSpacing: 0.8, marginTop: 2 },
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 16, overflow: "hidden" },
  thumb: { width: "100%", aspectRatio: 16 / 9 },
  tag: { position: "absolute", top: 8, left: 8, color: c.ink, backgroundColor: "rgba(8,8,10,0.78)", fontSize: 10, letterSpacing: 0.6, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3, overflow: "hidden" },
  pill: { color: c.sub, borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, fontSize: 10, letterSpacing: 0.6 },
  tool: { flexDirection: "row", alignItems: "center", gap: 14, padding: 18 },
});

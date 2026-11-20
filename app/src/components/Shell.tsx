// App frame (2026-11-19, direction D): icon rail (bottom tab bar on phone widths) + top bar with the page title,
// back, credits and Upgrade. Pages render inside it. @anlim
import { ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { Notices } from "./Notices";
import { router, usePathname } from "expo-router";
import { api } from "../lib/api";
import { c, font } from "../lib/theme";
import { Icon, IconName } from "./Icon";
import { Logo } from "./Logo";
import { NavGlow } from "./NavGlow";
export { Logo };

type Item = { href: "/" | "/workspace" | "/storage" | "/review" | "/library" | "/billing"; label: string; icon: IconName;
  match: (p: string) => boolean; phone: boolean };
// 2026-11-19 (Londi): Home (features, models, tools), Workspace (where things are made), Assets (everything made).
const ITEMS: Item[] = [
  { href: "/", label: "Home", icon: "home", match: (p) => p === "/", phone: true },
  { href: "/workspace", label: "Workspace", icon: "workspace", phone: true,
    match: (p) => p.startsWith("/workspace") || p.startsWith("/shots") || p.startsWith("/shot/") || p.startsWith("/cut/") },
  { href: "/storage", label: "Assets", icon: "assets", match: (p) => p.startsWith("/storage"), phone: true },
  { href: "/review", label: "Review", icon: "review", match: (p) => p.startsWith("/review") || p.startsWith("/clip/"), phone: true },
  { href: "/library", label: "Cast", icon: "cast", match: (p) => p.startsWith("/library"), phone: true },
  { href: "/billing", label: "Credits", icon: "credits", match: (p) => p.startsWith("/billing"), phone: false },
];
// rail geometry (the tally light's position is computed from it)
const RAIL_W = 76, ITEM_H = 60, TAB_H = 58, GAP = 14, TALLY = 22, GROUP_BREAK = 4;   // Cast and Credits sit apart from the making pages
const TITLES: [RegExp, string][] = [
  [/^\/$/, "Home"], [/^\/workspace/, "Workspace"], [/^\/storage/, "Assets"], [/^\/review/, "Review"],
  [/^\/clip\//, "Review a clip"], [/^\/shots/, "Scene board"], [/^\/shot\//, "Shot"], [/^\/cut\//, "Scene cut"],
  [/^\/library/, "Cast & places"], [/^\/billing/, "Credits & plan"], [/^\/account/, "Account"],
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { width } = useWindowDimensions();
  const narrow = width < 760;
  const [me, setMe] = useState<{ email?: string; balance: number; reserved: number; plan_status: string | null; is_admin?: boolean } | null>(null);
  useEffect(() => { api.me().then(setMe).catch(() => setMe(null)); }, [path]);
  const title = TITLES.find(([r]) => r.test(path))?.[1] ?? "anlim.ai";
  // the browser tab says where you are (2026-11-19: Stack titles did not reach the tab with the header hidden)
  useEffect(() => { if (Platform.OS === "web") document.title = title === "Home" ? "anlim.ai" : `${title} · anlim.ai`; }, [title]);
  const deep = /^\/(clip|shot|cut)\//.test(path) || path.startsWith("/shots");
  const hasPlan = me?.plan_status === "active" || me?.plan_status === "trialing";

  // Rail (2026-11-20, Londi: "really well designed ... a very premium feel without ending up looking tacky"). No boxes
  // and no outlines: the current page is a tungsten tally light on the rail's edge (the logo's recording dot), a warm
  // glow behind its glyph and the glyph's solid fill; hover is light, not a shape. Mono caps labels, like a slate.
  const shown = ITEMS.filter((it) => !narrow || it.phone);
  const activeIdx = shown.findIndex((it) => it.match(path));
  const [hover, setHover] = useState<string | null>(null);
  const label = (txt: string, on: boolean, hv: boolean) => (
    <Text style={[{ color: on ? c.ink : hv ? "#D4D4D8" : c.muted, fontSize: narrow ? 8.5 : 9, letterSpacing: 0.7,
                    textTransform: "uppercase", fontWeight: "500" }, font.mono]} numberOfLines={1}>{txt}</Text>
  );
  const glyph = (name: IconName, on: boolean, hv: boolean) => (
    <View style={{ width: 44, height: 32, alignItems: "center", justifyContent: "center" }}>
      <NavGlow tone={on ? "on" : hv ? "hover" : "off"} />
      <Icon name={name} size={22} weight={1.6} active={on} color={on ? c.ink : hv ? "#D4D4D8" : c.muted} />
    </View>
  );
  const rail = shown.map((it, i) => {
    const on = i === activeIdx, hv = hover === it.href && !on;
    return (
      <View key={it.href} style={{ width: narrow ? undefined : RAIL_W, flex: narrow ? 1 : undefined }}>
        {!narrow && i === GROUP_BREAK && <View style={{ height: GAP }} />}
        <Pressable onPress={() => router.navigate(it.href)} onHoverIn={() => setHover(it.href)} onHoverOut={() => setHover(null)}
          accessibilityRole="link" accessibilityLabel={it.label} accessibilityState={{ selected: on }}
          style={({ pressed }) => ({ height: narrow ? TAB_H : ITEM_H, alignItems: "center", justifyContent: "center", gap: 5,
                                     transform: [{ scale: pressed ? 0.95 : 1 }] })}>
          {glyph(it.icon, on, hv)}
          {label(it.label, on, hv)}
        </Pressable>
      </View>
    );
  });
  // the tally light slides to the current page; it hides on pages outside the rail (account, refunds)
  const tallyPos = useRef(new Animated.Value(0)).current;
  const [tabW, setTabW] = useState(0);
  useEffect(() => {
    if (activeIdx < 0) return;
    const to = narrow ? activeIdx * tabW + (tabW - TALLY) / 2
      : activeIdx * ITEM_H + (activeIdx >= GROUP_BREAK ? GAP : 0) + (ITEM_H - TALLY) / 2;
    Animated.spring(tallyPos, { toValue: to, useNativeDriver: Platform.OS !== "web", stiffness: 260, damping: 26, mass: 0.9 }).start();
  }, [activeIdx, narrow, tabW, tallyPos]);
  const tally = activeIdx < 0 ? null : (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", backgroundColor: c.accent, shadowColor: c.accent,
        shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
      narrow ? { top: 0, left: 0, width: TALLY, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3,
                 transform: [{ translateX: tallyPos }] }
             : { left: 0, top: 0, width: 3, height: TALLY, borderTopRightRadius: 3, borderBottomRightRadius: 3,
                 transform: [{ translateY: tallyPos }] }]} />
  );
  const acctOn = path.startsWith("/account"), acctHv = hover === "/account" && !acctOn;
  const initial = (me?.email ?? "").trim().charAt(0).toUpperCase() || "·";

  // Top bar (2026-11-20): no hairline under it and no outlined pills; it separates from the page by value, and its
  // controls are type with light on hover. Upgrade is the one filled control (accent, squared corners).
  const hv = (k: string) => hover === k;
  const top = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: narrow ? 10 : 18, paddingHorizontal: narrow ? 14 : 28,
                   paddingVertical: narrow ? 10 : 14, backgroundColor: c.bg }}>
      {deep && (
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.navigate("/workspace"))} accessibilityRole="button"
          accessibilityLabel="Back" onHoverIn={() => setHover("back")} onHoverOut={() => setHover(null)}
          style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center",
                                     backgroundColor: hv("back") ? "#17171B" : "transparent", transform: [{ scale: pressed ? 0.94 : 1 }] })}>
          <Icon name="back" size={18} color={hv("back") ? c.ink : c.sub} />
        </Pressable>
      )}
      {narrow && !deep && <Logo size={28} />}
      <Text style={[{ color: c.ink, fontSize: narrow ? 17 : 19, textTransform: "uppercase", letterSpacing: 0.4 }, font.display]} numberOfLines={1}>{title}</Text>
      <View style={{ flex: 1 }} />
      {me?.is_admin && (
        <Pressable onPress={() => router.navigate("/refunds" as never)} accessibilityRole="link" accessibilityLabel="Refund requests"
          onHoverIn={() => setHover("refunds")} onHoverOut={() => setHover(null)}>
          <Text style={[{ color: hv("refunds") ? c.ink : c.muted, fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase" }, font.mono]}>Refunds</Text>
        </Pressable>
      )}
      {me && (
        <Pressable onPress={() => router.navigate("/billing")} accessibilityRole="link" accessibilityLabel={`${me.balance - me.reserved} credits available`}
          onHoverIn={() => setHover("bal")} onHoverOut={() => setHover(null)} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name="credits" size={16} weight={1.6} color={hv("bal") ? c.ink : c.muted} />
          <Text style={[{ color: hv("bal") ? c.ink : c.sub, fontSize: 13, fontWeight: "600" }, font.mono]}>
            {(me.balance - me.reserved).toLocaleString("en-US")}<Text style={{ color: c.muted, fontWeight: "400" }}> cr</Text>
          </Text>
        </Pressable>
      )}
      {!hasPlan && (
        <Pressable onPress={() => router.navigate("/billing")} accessibilityRole="link" onHoverIn={() => setHover("up")} onHoverOut={() => setHover(null)}
          style={({ pressed }) => ({ backgroundColor: hv("up") ? "#FF8A33" : c.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8,
                                     transform: [{ scale: pressed ? 0.96 : 1 }], shadowColor: c.accent, shadowOpacity: hv("up") ? 0.45 : 0.25,
                                     shadowRadius: 14, shadowOffset: { width: 0, height: 0 } })}>
          <Text style={{ color: c.onAccent, fontWeight: "700", fontSize: 13, letterSpacing: 0.2 }}>Upgrade</Text>
        </Pressable>
      )}
      {narrow && (
        <Pressable onPress={() => router.navigate("/account")} accessibilityRole="link" accessibilityLabel="Account"
          style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: "#1C1C21", alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#D4D4D8", fontSize: 11, fontWeight: "600" }}>{initial}</Text>
        </Pressable>
      )}
    </View>
  );

  if (narrow) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        {top}
        <View style={{ flex: 1 }}>{children}<Notices /></View>
        <View accessibilityRole="tablist" onLayout={(e) => setTabW(e.nativeEvent.layout.width / shown.length)}
          style={{ flexDirection: "row", backgroundColor: c.rail, shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 24,
                   shadowOffset: { width: 0, height: -8 } }}>
          {rail}
          {tabW > 0 && tally}
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.bg }}>
      <View style={{ width: RAIL_W, backgroundColor: c.rail, alignItems: "center", paddingTop: 18, paddingBottom: 14, zIndex: 2,
                     shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 30, shadowOffset: { width: 10, height: 0 } }}>
        <Pressable onPress={() => router.navigate("/")} accessibilityRole="link" accessibilityLabel="anlim.ai home"
          style={({ pressed }) => ({ marginBottom: 26, transform: [{ scale: pressed ? 0.95 : 1 }] })}>
          <Logo size={34} />
        </Pressable>
        <View accessibilityRole="tablist" style={{ width: RAIL_W }}>
          {rail}
          {tally}
        </View>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.navigate("/account")} onHoverIn={() => setHover("/account")} onHoverOut={() => setHover(null)}
          accessibilityRole="link" accessibilityLabel="Account" accessibilityState={{ selected: acctOn }}
          style={({ pressed }) => ({ width: RAIL_W, height: ITEM_H, alignItems: "center", justifyContent: "center", gap: 6,
                                     transform: [{ scale: pressed ? 0.95 : 1 }] })}>
          {acctOn && <View style={{ position: "absolute", left: 0, top: (ITEM_H - TALLY) / 2, width: 3, height: TALLY,
                                    backgroundColor: c.accent, borderTopRightRadius: 3, borderBottomRightRadius: 3, shadowColor: c.accent,
                                    shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } }} />}
          <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center",
                         backgroundColor: acctOn ? "#2A2A31" : acctHv ? "#24242A" : "#1C1C21",
                         shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }}>
            <Text style={{ color: acctOn || acctHv ? c.ink : "#D4D4D8", fontSize: 12, fontWeight: "600" }}>{initial}</Text>
          </View>
          {label("Account", acctOn, acctHv)}
        </Pressable>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {top}
        <View style={{ flex: 1 }}>{children}<Notices /></View>
      </View>
    </View>
  );
}

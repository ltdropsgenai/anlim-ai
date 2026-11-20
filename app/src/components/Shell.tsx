// App frame. 2026-11-20 (Londi picked direction B, "studio sidebar", with the icons2 set): a full sidebar on wide
// screens (grouped pages, the project last worked on, a credits gauge, the account), the compact rail on mid widths,
// a bottom tab bar on phones. Londi's rules hold throughout: no outlined boxes, no pills; the current page is a
// tungsten tally light (the logo's recording dot) plus a warm wash and the glyph's orange accent; hover is light,
// not a shape. Pages render inside it. @anlim
import { ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { Notices } from "./Notices";
import { router, usePathname } from "expo-router";
import { api, HomeData } from "../lib/api";
import { c, font } from "../lib/theme";
import { Icon, IconName } from "./Icon";
import { Logo } from "./Logo";
import { NavGlow, Wash } from "./NavGlow";
export { Logo };

type Href = "/" | "/workspace" | "/motion" | "/storage" | "/review" | "/library" | "/billing";
type Item = { href: Href; label: string; long?: string; icon: IconName; match: (p: string) => boolean; phone: boolean };
// 2026-11-19 (Londi): Home (features, models, tools), Workspace (where things are made), Assets (everything made).
const ITEMS: Item[] = [
  { href: "/", label: "Home", icon: "home", match: (p) => p === "/", phone: true },
  { href: "/workspace", label: "Workspace", icon: "workspace", phone: true,
    match: (p) => p.startsWith("/workspace") || p.startsWith("/shots") || p.startsWith("/shot/") || p.startsWith("/cut/") },
  // 2026-11-20: motion transfer; not in the phone tab bar (five tabs already), reached from Home on a phone
  { href: "/motion", label: "Motion", long: "Motion transfer", icon: "motion", match: (p) => p.startsWith("/motion"), phone: false },
  { href: "/storage", label: "Assets", icon: "assets", match: (p) => p.startsWith("/storage"), phone: true },
  { href: "/review", label: "Review", icon: "review", match: (p) => p.startsWith("/review") || p.startsWith("/clip/"), phone: true },
  { href: "/library", label: "Cast", long: "Cast & places", icon: "cast", match: (p) => p.startsWith("/library"), phone: true },
  { href: "/billing", label: "Credits", icon: "credits", match: (p) => p.startsWith("/billing"), phone: false },
];
// compact rail and tab bar geometry (the tally light's position is computed from it)
const RAIL_W = 72, ITEM_H = 52, TAB_H = 58, GAP = 14, TALLY = 22, GROUP_BREAK = 5;   // Cast and Credits sit apart (index of Cast in the rail)
const SIDE_W = 248, ROW_H = 40;
const CLIP_5S = 200;   // credits of a 5 s Kling 4.0 clip (40 cr/s, studio.models), for "about N clips" on the gauge
const TITLES: [RegExp, string][] = [
  [/^\/$/, "Home"], [/^\/workspace/, "Workspace"], [/^\/storage/, "Assets"], [/^\/review/, "Review"],
  [/^\/clip\//, "Review a clip"], [/^\/shots/, "Scene board"], [/^\/shot\//, "Shot"], [/^\/cut\//, "Scene cut"],
  [/^\/library/, "Cast & places"], [/^\/billing/, "Credits & plan"], [/^\/account/, "Account"], [/^\/refunds/, "Refund requests"],
];
// 7685 -> "7.7k", 950 -> "950": the mini gauge's label
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
type Me = { email?: string; balance: number; reserved: number; plan_status: string | null; plan_id?: string | null;
            plan_credits?: number; is_admin?: boolean };

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { width } = useWindowDimensions();
  const narrow = width < 760, wide = width >= 1100;
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { api.me().then(setMe).catch(() => setMe(null)); }, [path]);
  const [hover, setHover] = useState<string | null>(null);
  // Collapsible sidebar (2026-11-20, Londi: "expanded will show the titles, collapsed just the icons, which still
  // display the name when pointed at"). The choice is remembered in this browser; mid widths are always collapsed.
  const [collapsedPref, setCollapsedPref] = useState<boolean>(() => {
    try { return Platform.OS === "web" && window.localStorage.getItem("anlim.sidebar") === "collapsed"; } catch { return false; }
  });
  const toggleSidebar = () => {
    const next = !collapsedPref;
    setCollapsedPref(next); setHover(null);
    try { window.localStorage.setItem("anlim.sidebar", next ? "collapsed" : "expanded"); } catch { /* private window */ }
  };
  const expanded = wide && !collapsedPref;
  // the sidebar's project card and Review count come from "home"; refreshed at most every 30 s
  const [home, setHome] = useState<HomeData | null>(null);
  const homeAt = useRef(0);
  useEffect(() => {
    if (!expanded || Date.now() - homeAt.current < 30000) return;
    homeAt.current = Date.now();
    api.home().then(setHome).catch(() => {});
  }, [path, expanded]);
  const title = TITLES.find(([r]) => r.test(path))?.[1] ?? "anlim.ai";
  // the browser tab says where you are (2026-11-19: Stack titles did not reach the tab with the header hidden)
  useEffect(() => { if (Platform.OS === "web") document.title = title === "Home" ? "anlim.ai" : `${title} · anlim.ai`; }, [title]);
  const deep = /^\/(clip|shot|cut)\//.test(path) || path.startsWith("/shots");
  const hasPlan = me?.plan_status === "active" || me?.plan_status === "trialing";
  const toReview = home?.counts.to_review ?? 0;
  const avail = me ? me.balance - me.reserved : 0;
  const initial = (me?.email ?? "").trim().charAt(0).toUpperCase() || "·";
  const hv = (k: string) => hover === k;
  const hoverProps = (k: string) => ({ onHoverIn: () => setHover(k), onHoverOut: () => setHover(null) });
  const tone = (on: boolean, h: boolean) => (on ? c.ink : h ? "#E4E4E7" : c.muted);

  // ---- compact rail (mid widths) and phone tab bar ----
  // the collapsed rail shows credits as a mini gauge at the bottom instead of a nav item (2026-11-20, Londi)
  const shown = ITEMS.filter((it) => (narrow ? it.phone : it.href !== "/billing"));
  const activeIdx = shown.findIndex((it) => it.match(path));
  const railLabel = (txt: string, on: boolean, h: boolean) => (
    <Text style={[{ color: on ? c.ink : h ? "#D4D4D8" : c.muted, fontSize: narrow ? 8.5 : 9, letterSpacing: 0.7,
                    textTransform: "uppercase", fontWeight: "500" }, font.mono]} numberOfLines={1}>{txt}</Text>
  );
  // the name of a collapsed item, floating beside it while pointed at
  const tip = (txt: string, h: number, sub?: string) => (
    <View pointerEvents="none" style={{ position: "absolute", left: RAIL_W - 6, top: (h - 32) / 2, height: 32, justifyContent: "center",
                                        paddingHorizontal: 11, borderRadius: 8, backgroundColor: "#1E1E24", zIndex: 50,
                                        shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }}>
      <Text style={{ color: c.ink, fontSize: 12.5, fontWeight: "500" }} numberOfLines={1}>
        {txt}{sub ? <Text style={[{ color: c.muted, fontSize: 11.5 }, font.mono]}>{`  ${sub}`}</Text> : null}
      </Text>
    </View>
  );
  const rail = shown.map((it, i) => {
    const on = i === activeIdx, h = hv(it.href) && !on;
    return (
      <View key={it.href} style={{ width: narrow ? undefined : RAIL_W, flex: narrow ? 1 : undefined }}>
        {!narrow && i === GROUP_BREAK && <View style={{ height: GAP }} />}
        <Pressable onPress={() => router.navigate(it.href)} {...hoverProps(it.href)}
          accessibilityRole="link" accessibilityLabel={it.label} accessibilityState={{ selected: on }}
          style={({ pressed }) => ({ height: narrow ? TAB_H : ITEM_H, alignItems: "center", justifyContent: "center", gap: 5,
                                     transform: [{ scale: pressed ? 0.95 : 1 }] })}>
          <View style={{ width: 44, height: 32, alignItems: "center", justifyContent: "center" }}>
            <NavGlow tone={on ? "on" : h ? "hover" : "off"} />
            <Icon name={it.icon} size={22} weight={1.7} active={on} color={tone(on, h)} />
          </View>
          {narrow && railLabel(it.label, on, h)}
        </Pressable>
        {!narrow && hv(it.href) && tip(it.long ?? it.label, ITEM_H,
          it.href === "/billing" && me ? `${avail.toLocaleString("en-US")} cr` : it.href === "/review" && toReview > 0 ? String(toReview) : undefined)}
      </View>
    );
  });
  const tallyPos = useRef(new Animated.Value(0)).current;
  const [tabW, setTabW] = useState(0);
  useEffect(() => {
    if (activeIdx < 0 || expanded) return;
    const to = narrow ? activeIdx * tabW + (tabW - TALLY) / 2
      : activeIdx * ITEM_H + (activeIdx >= GROUP_BREAK ? GAP : 0) + (ITEM_H - TALLY) / 2;
    Animated.spring(tallyPos, { toValue: to, useNativeDriver: Platform.OS !== "web", stiffness: 260, damping: 26, mass: 0.9 }).start();
  }, [activeIdx, narrow, expanded, tabW, tallyPos]);
  const tallyStyle = { position: "absolute" as const, backgroundColor: c.accent, shadowColor: c.accent, shadowOpacity: 0.9,
                       shadowRadius: 8, shadowOffset: { width: 0, height: 0 } };
  const tally = activeIdx < 0 ? null : (
    <Animated.View pointerEvents="none" style={[tallyStyle,
      narrow ? { top: 0, left: 0, width: TALLY, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, transform: [{ translateX: tallyPos }] }
             : { left: 0, top: 0, width: 3, height: TALLY, borderTopRightRadius: 3, borderBottomRightRadius: 3, transform: [{ translateY: tallyPos }] }]} />
  );

  // ---- full sidebar (wide) ----
  const sideRow = (key: string, icon: IconName, txt: string, on: boolean, go: () => void, meta?: string | null) => {
    const h = hv(key) && !on;
    return (
      <Pressable key={key} onPress={go} {...hoverProps(key)} accessibilityRole="link" accessibilityLabel={txt} accessibilityState={{ selected: on }}
        style={({ pressed }) => ({ height: ROW_H, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, borderRadius: 10,
                                   backgroundColor: h ? "rgba(255,255,255,0.04)" : "transparent", transform: [{ scale: pressed ? 0.98 : 1 }] })}>
        {on && <Wash />}
        {on && <View pointerEvents="none" style={[tallyStyle, { left: -14, top: (ROW_H - 20) / 2, width: 3, height: 20,
                                                                 borderTopRightRadius: 3, borderBottomRightRadius: 3 }]} />}
        <Icon name={icon} size={19} weight={1.7} active={on} color={tone(on, h)} />
        <Text style={{ color: on ? c.ink : h ? "#E4E4E7" : c.sub, fontSize: 14, fontWeight: on ? "600" : "500", flex: 1 }} numberOfLines={1}>{txt}</Text>
        {meta ? <Text style={[{ color: on ? c.sub : c.muted, fontSize: 11 }, font.mono]}>{meta}</Text> : null}
      </Pressable>
    );
  };
  const section = (txt: string) => (
    <Text style={[{ color: "#5A5A63", fontSize: 10, letterSpacing: 1.4, paddingTop: 20, paddingBottom: 8, paddingHorizontal: 12 }, font.mono]}>{txt}</Text>
  );
  const last = home?.last ?? null;
  // gauge: what is left of the month's plan credits, or of the balance when there is no plan
  const cap = Math.max(me?.plan_credits ?? 0, avail, 1);
  const pct = Math.max(0.03, Math.min(1, avail / cap));
  const clips = Math.floor(avail / CLIP_5S);
  const sidebar = (
    <View style={{ width: SIDE_W, backgroundColor: c.rail, paddingTop: 18, paddingBottom: 14, paddingHorizontal: 14, zIndex: 2,
                   shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 36, shadowOffset: { width: 14, height: 0 } }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 6 }}>
        <Pressable onPress={() => router.navigate("/")} accessibilityRole="link" accessibilityLabel="anlim.ai home"
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, flex: 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}>
          <Logo size={30} />
          <Text style={[{ color: c.ink, fontSize: 17 }, font.display]}>anlim<Text style={{ color: c.accent }}>.</Text>ai</Text>
        </Pressable>
        <Pressable onPress={toggleSidebar} {...hoverProps("fold")} accessibilityRole="button" accessibilityLabel="Collapse the sidebar"
          style={({ pressed }) => ({ width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center",
                                     backgroundColor: hv("fold") ? "rgba(255,255,255,0.06)" : "transparent", transform: [{ scale: pressed ? 0.92 : 1 }] })}>
          <Icon name="fold" size={18} weight={1.6} color={hv("fold") ? c.ink : c.muted} />
        </Pressable>
      </View>

      {last && (
        <Pressable onPress={() => router.navigate({ pathname: "/workspace", params: { series: last.series_id, scene: last.scene_id } })}
          {...hoverProps("proj")} accessibilityRole="link" accessibilityLabel={`Open ${last.series_name}`}
          style={({ pressed }) => ({ marginTop: 18, padding: 10, borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 10,
                                     backgroundColor: hv("proj") ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.035)",
                                     transform: [{ scale: pressed ? 0.98 : 1 }] })}>
          <View style={{ width: 30, height: 30, borderRadius: 8, overflow: "hidden", backgroundColor: "#B4440A" }}>
            <Wash solid />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>{last.series_name}</Text>
            <Text style={[{ color: c.muted, fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", marginTop: 2 }, font.mono]} numberOfLines={1}>
              Last worked on · {last.scene_title}
            </Text>
          </View>
        </Pressable>
      )}

      {section("MAKE")}
      {ITEMS.slice(0, 5).map((it) => sideRow(it.href, it.icon, it.long ?? it.label, it.match(path), () => router.navigate(it.href),
        it.href === "/review" && toReview > 0 ? String(toReview) : null))}
      {section("LIBRARY")}
      {sideRow("/library", "cast", "Cast & places", ITEMS[5].match(path), () => router.navigate("/library"))}
      {me?.is_admin && <>
        {section("ADMIN")}
        {sideRow("/refunds", "review", "Refund requests", path.startsWith("/refunds"), () => router.navigate("/refunds" as never))}
      </>}

      <View style={{ flex: 1 }} />

      {me && (
        <Pressable onPress={() => router.navigate("/billing")} {...hoverProps("gauge")} accessibilityRole="link"
          accessibilityLabel={`${avail} credits available, about ${clips} five-second clips`}
          style={({ pressed }) => ({ padding: 14, borderRadius: 12, transform: [{ scale: pressed ? 0.98 : 1 }],
                                     backgroundColor: path.startsWith("/billing") ? "rgba(255,122,26,0.08)" : hv("gauge") ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.03)" })}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="credits" size={15} weight={1.6} active={path.startsWith("/billing")} color={c.muted} />
            <Text style={[{ color: "#5A5A63", fontSize: 10, letterSpacing: 1.4, flex: 1 }, font.mono]}>CREDITS</Text>
            <Text style={[{ color: c.ink, fontSize: 13, fontWeight: "600" }, font.mono]}>{avail.toLocaleString("en-US")}</Text>
          </View>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: "#1E1E23", marginTop: 11, overflow: "hidden" }}>
            <View style={{ width: `${pct * 100}%`, height: 4, borderRadius: 2, backgroundColor: c.accent,
                           shadowColor: c.accent, shadowOpacity: 0.6, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }} />
          </View>
          <Text style={{ color: c.muted, fontSize: 11, marginTop: 8 }}>
            {clips > 0 ? `About ${clips} clip${clips === 1 ? "" : "s"} at 5 s` : "Add credits to make clips"}
          </Text>
        </Pressable>
      )}

      <Pressable onPress={() => router.navigate("/account")} {...hoverProps("acct")} accessibilityRole="link" accessibilityLabel="Account"
        accessibilityState={{ selected: path.startsWith("/account") }}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingVertical: 10, marginTop: 10,
                                   borderRadius: 10, backgroundColor: hv("acct") || path.startsWith("/account") ? "rgba(255,255,255,0.04)" : "transparent",
                                   transform: [{ scale: pressed ? 0.98 : 1 }] })}>
        <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: "#24242A",
                       shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }}>
          <Text style={{ color: c.ink, fontSize: 12, fontWeight: "600" }}>{initial}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: c.ink, fontSize: 13, fontWeight: "500" }} numberOfLines={1}>{me?.email?.split("@")[0] ?? "Account"}</Text>
          <Text style={{ color: c.muted, fontSize: 11 }} numberOfLines={1}>{hasPlan ? "Plan active" : "Free account"}</Text>
        </View>
      </Pressable>
    </View>
  );

  // ---- top bar ----
  // no hairline under it and no outlined pills; it separates from the page by value, and its controls are type with
  // light on hover. Upgrade is the one filled control (accent, squared corners). The balance lives in the sidebar on wide screens.
  const top = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: narrow ? 10 : 18, paddingHorizontal: narrow ? 14 : 28,
                   paddingVertical: narrow ? 10 : 14, backgroundColor: c.bg }}>
      {deep && (
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.navigate("/workspace"))} accessibilityRole="button"
          accessibilityLabel="Back" {...hoverProps("back")}
          style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center",
                                     backgroundColor: hv("back") ? "#17171B" : "transparent", transform: [{ scale: pressed ? 0.94 : 1 }] })}>
          <Icon name="back" size={18} color={hv("back") ? c.ink : c.sub} />
        </Pressable>
      )}
      {narrow && !deep && <Logo size={28} />}
      <Text style={[{ color: c.ink, fontSize: narrow ? 17 : 19, textTransform: "uppercase", letterSpacing: 0.4 }, font.display]} numberOfLines={1}>{title}</Text>
      <View style={{ flex: 1 }} />
      {me?.is_admin && !expanded && (
        <Pressable onPress={() => router.navigate("/refunds" as never)} accessibilityRole="link" accessibilityLabel="Refund requests" {...hoverProps("refunds")}>
          <Text style={[{ color: hv("refunds") ? c.ink : c.muted, fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase" }, font.mono]}>Refunds</Text>
        </Pressable>
      )}
      {me && !expanded && (
        <Pressable onPress={() => router.navigate("/billing")} accessibilityRole="link" accessibilityLabel={`${avail} credits available`}
          {...hoverProps("bal")} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name="credits" size={16} weight={1.6} color={hv("bal") ? c.ink : c.muted} />
          <Text style={[{ color: hv("bal") ? c.ink : c.sub, fontSize: 13, fontWeight: "600" }, font.mono]}>
            {avail.toLocaleString("en-US")}<Text style={{ color: c.muted, fontWeight: "400" }}> cr</Text>
          </Text>
        </Pressable>
      )}
      {!hasPlan && (
        <Pressable onPress={() => router.navigate("/billing")} accessibilityRole="link" {...hoverProps("up")}
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
  const compact = (
    <View style={{ width: RAIL_W, backgroundColor: c.rail, alignItems: "center", paddingTop: 18, paddingBottom: 14, zIndex: 2,
                   shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 30, shadowOffset: { width: 10, height: 0 } }}>
      <Pressable onPress={() => router.navigate("/")} accessibilityRole="link" accessibilityLabel="anlim.ai home"
        style={({ pressed }) => ({ marginBottom: 26, transform: [{ scale: pressed ? 0.95 : 1 }] })}>
        <Logo size={34} />
      </Pressable>
      {wide && (
        <View style={{ width: RAIL_W, alignItems: "center", marginTop: -14, marginBottom: 12 }}>
          <Pressable onPress={toggleSidebar} {...hoverProps("unfold")} accessibilityRole="button" accessibilityLabel="Expand the sidebar"
            style={({ pressed }) => ({ width: 34, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center",
                                       backgroundColor: hv("unfold") ? "rgba(255,255,255,0.06)" : "transparent", transform: [{ scale: pressed ? 0.92 : 1 }] })}>
            <Icon name="unfold" size={18} weight={1.6} color={hv("unfold") ? c.ink : c.muted} />
          </Pressable>
          {hv("unfold") && tip("Expand", 30)}
        </View>
      )}
      <View accessibilityRole="tablist" style={{ width: RAIL_W }}>
        {rail}
        {tally}
      </View>
      <View style={{ flex: 1 }} />
      {me && (
        <View style={{ width: RAIL_W, alignItems: "center", marginBottom: 6 }}>
          <Pressable onPress={() => router.navigate("/billing")} {...hoverProps("mgauge")} accessibilityRole="link"
            accessibilityLabel={`${avail} credits available, about ${clips} five-second clips`}
            style={({ pressed }) => ({ width: 48, paddingVertical: 10, borderRadius: 10, alignItems: "center", gap: 8,
                                       backgroundColor: path.startsWith("/billing") ? "rgba(255,122,26,0.08)" : hv("mgauge") ? "rgba(255,255,255,0.05)" : "transparent",
                                       transform: [{ scale: pressed ? 0.95 : 1 }] })}>
            <View style={{ width: 5, height: 44, borderRadius: 3, backgroundColor: "#1E1E23", justifyContent: "flex-end", overflow: "hidden" }}>
              <View style={{ width: 5, height: `${pct * 100}%`, borderRadius: 3, backgroundColor: c.accent,
                             shadowColor: c.accent, shadowOpacity: 0.7, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }} />
            </View>
            <Text style={[{ color: hv("mgauge") || path.startsWith("/billing") ? c.ink : c.sub, fontSize: 10, fontWeight: "600" }, font.mono]}>{short(avail)}</Text>
          </Pressable>
          {hv("mgauge") && tip("Credits", 84, `${avail.toLocaleString("en-US")} cr · about ${clips} clip${clips === 1 ? "" : "s"} at 5 s`)}
        </View>
      )}
      <Pressable onPress={() => router.navigate("/account")} {...hoverProps("/account")} accessibilityRole="link" accessibilityLabel="Account"
        style={({ pressed }) => ({ width: RAIL_W, height: ITEM_H, alignItems: "center", justifyContent: "center", gap: 6,
                                   transform: [{ scale: pressed ? 0.95 : 1 }] })}>
        <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center",
                       backgroundColor: path.startsWith("/account") ? "#2A2A31" : hv("/account") ? "#24242A" : "#1C1C21" }}>
          <Text style={{ color: c.ink, fontSize: 12, fontWeight: "600" }}>{initial}</Text>
        </View>
      </Pressable>
      {hv("/account") && <View style={{ position: "absolute", left: 0, bottom: 14, width: RAIL_W, height: ITEM_H }} pointerEvents="none">
        {tip(me?.email?.split("@")[0] ?? "Account", ITEM_H, hasPlan ? "plan active" : "free")}</View>}
    </View>
  );
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.bg }}>
      {expanded ? sidebar : compact}
      <View style={{ flex: 1, minWidth: 0 }}>
        {top}
        <View style={{ flex: 1 }}>{children}<Notices /></View>
      </View>
    </View>
  );
}

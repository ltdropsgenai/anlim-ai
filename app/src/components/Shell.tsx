// App frame (2026-11-19, direction D): icon rail (bottom tab bar on phone widths) + top bar with the page title,
// back, credits and Upgrade. Pages render inside it. @anlim
import { ReactNode, useEffect, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { router, usePathname } from "expo-router";
import { api } from "../lib/api";
import { c, font } from "../lib/theme";
import { Icon, IconName } from "./Icon";

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
const TITLES: [RegExp, string][] = [
  [/^\/$/, "Home"], [/^\/workspace/, "Workspace"], [/^\/storage/, "Assets"], [/^\/review/, "Review"],
  [/^\/clip\//, "Review a clip"], [/^\/shots/, "Scene board"], [/^\/shot\//, "Shot"], [/^\/cut\//, "Scene cut"],
  [/^\/library/, "Cast & places"], [/^\/billing/, "Credits & plan"], [/^\/account/, "Account"],
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { width } = useWindowDimensions();
  const narrow = width < 760;
  const [me, setMe] = useState<{ balance: number; reserved: number; plan_status: string | null } | null>(null);
  useEffect(() => { api.me().then(setMe).catch(() => setMe(null)); }, [path]);
  const title = TITLES.find(([r]) => r.test(path))?.[1] ?? "anlim.ai";
  const deep = /^\/(clip|shot|cut)\//.test(path) || path.startsWith("/shots");
  const hasPlan = me?.plan_status === "active" || me?.plan_status === "trialing";

  const rail = ITEMS.filter((it) => !narrow || it.phone).map((it) => {
    const on = it.match(path);
    return (
      <Pressable key={it.href} onPress={() => router.navigate(it.href)} accessibilityRole="link" accessibilityState={{ selected: on }}
        style={{ width: narrow ? undefined : 64, flex: narrow ? 1 : undefined, paddingTop: 10, paddingBottom: 8, borderRadius: 12,
                 alignItems: "center", gap: 5, backgroundColor: on ? "#1C1C21" : "transparent" }}>
        <Icon name={it.icon} color={on ? c.ink : c.sub} />
        <Text style={{ color: on ? c.ink : c.sub, fontSize: narrow ? 10 : 11, fontWeight: "600" }} numberOfLines={1}>{it.label}</Text>
      </Pressable>
    );
  });

  const top = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: narrow ? 14 : 24, paddingVertical: 12,
                   borderBottomWidth: 1, borderBottomColor: c.line, backgroundColor: c.bg }}>
      {deep && (
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.navigate("/workspace"))} accessibilityRole="button"
          accessibilityLabel="Back" style={{ width: 36, height: 36, borderRadius: 10, borderWidth: 1, borderColor: c.line,
                                             alignItems: "center", justifyContent: "center" }}>
          <Icon name="back" size={18} color={c.ink} />
        </Pressable>
      )}
      {narrow && !deep && <Logo size={30} />}
      <Text style={[{ color: c.ink, fontSize: narrow ? 18 : 20, textTransform: "uppercase" }, font.display]} numberOfLines={1}>{title}</Text>
      <View style={{ flex: 1 }} />
      {me && (
        <Pressable onPress={() => router.navigate("/billing")} accessibilityRole="link" accessibilityLabel={`${me.balance - me.reserved} credits available`}
          style={{ borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 }}>
          <Text style={[{ color: c.ink, fontSize: 13, fontWeight: "600" }, font.mono]}>{me.balance - me.reserved} cr</Text>
        </Pressable>
      )}
      {!hasPlan && (
        <Pressable onPress={() => router.navigate("/billing")} accessibilityRole="link"
          style={{ backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }}>
          <Text style={{ color: c.onAccent, fontWeight: "700", fontSize: 14 }}>Upgrade</Text>
        </Pressable>
      )}
      {narrow && (
        <Pressable onPress={() => router.navigate("/account")} accessibilityRole="link" accessibilityLabel="Account">
          <Icon name="account" color={c.sub} />
        </Pressable>
      )}
    </View>
  );

  if (narrow) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        {top}
        <View style={{ flex: 1 }}>{children}</View>
        <View accessibilityRole="tablist" style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.rail, paddingHorizontal: 6 }}>
          {rail}
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.bg }}>
      <View style={{ width: 80, backgroundColor: c.rail, borderRightWidth: 1, borderRightColor: c.line, alignItems: "center",
                     paddingVertical: 16, gap: 6 }}>
        <Pressable onPress={() => router.navigate("/")} accessibilityRole="link" accessibilityLabel="anlim.ai home" style={{ marginBottom: 16 }}>
          <Logo size={40} />
        </Pressable>
        {rail}
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.navigate("/account")} accessibilityRole="link" accessibilityState={{ selected: path.startsWith("/account") }}
          style={{ width: 60, paddingVertical: 10, borderRadius: 12, alignItems: "center", gap: 5,
                   backgroundColor: path.startsWith("/account") ? "#1C1C21" : "transparent" }}>
          <Icon name="account" color={path.startsWith("/account") ? c.ink : c.sub} />
          <Text style={{ color: path.startsWith("/account") ? c.ink : c.sub, fontSize: 11, fontWeight: "600" }}>Account</Text>
        </Pressable>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {top}
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    </View>
  );
}

// Placeholder mark until the logo is chosen (2026-11-19: logo options on the design canvas).
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: c.accent, alignItems: "center", justifyContent: "center" }}>
      <Text style={[{ color: c.onAccent, fontSize: size * 0.5, lineHeight: size * 0.62 }, font.display]}>a.</Text>
    </View>
  );
}

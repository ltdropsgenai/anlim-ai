// Root layout: sends signed-out visitors to /login; a password-reset link lands on /reset-password. @anlim
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Stack, router, useSegments } from "expo-router";
import type { Session } from "@supabase/supabase-js";
import { authFlags, supabase } from "../lib/supabase";
import { c } from "../lib/theme";
import { Shell } from "../components/Shell";

// Web: the studio fonts and page-level styles (dark scrollbars, base text font). Native keeps the system font.
function useWebLook() {
  useEffect(() => {
    if (Platform.OS !== "web" || document.getElementById("anlim-look")) return;
    const pre = document.createElement("link"); pre.rel = "preconnect"; pre.href = "https://fonts.googleapis.com";
    const css = document.createElement("link"); css.id = "anlim-look"; css.rel = "stylesheet";
    css.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&family=JetBrains+Mono:wght@500;600&display=swap";
    const st = document.createElement("style");
    st.textContent = `html,body{background:${c.bg};color-scheme:dark}
html body [class]{font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
::selection{background:${c.accent};color:${c.onAccent}}
*{scrollbar-color:#2A2A31 ${c.bg}}
input,textarea{color-scheme:dark}`;
    document.head.append(pre, css, st);
  }, []);
}

// A screen that throws shows this instead of a blank page (expo-router ErrorBoundary, review 2026-11-19).
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ color: c.ink, fontSize: 20, fontWeight: "700" }}>Something went wrong on this screen</Text>
      <Text style={{ color: c.sub, fontSize: 14, textAlign: "center", maxWidth: 520 }}>{error.message}</Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable onPress={retry} accessibilityRole="button" style={{ backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10 }}>
          <Text style={{ color: c.onAccent, fontWeight: "700" }}>Try again</Text>
        </Pressable>
        <Pressable onPress={() => router.replace("/")} accessibilityRole="link" style={{ borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10 }}>
          <Text style={{ color: c.ink, fontWeight: "600" }}>Go home</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function RootLayout() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const segments = useSegments();
  useWebLook();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // the reset email's link signs the creator in for one purpose: choosing a new password
      if (event === "PASSWORD_RECOVERY") { authFlags.recovery = true; router.replace("/reset-password"); }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // Pages anyone may open (2026-11-19): the landing page, the try-it prompt (start), sign-in, Terms, Privacy, Help.
  // Signed-out visitors to any other page go to the landing page.
  const PUBLIC = ["welcome", "start", "login", "terms", "privacy", "support"];
  const seg = (segments[0] as string | undefined) ?? "";
  useEffect(() => {
    if (session === undefined) return;
    const onLogin = seg === "login";
    if (!session && !PUBLIC.includes(seg)) router.replace("/welcome");   // includes /reset-password without a recovery session
    if (session && onLogin && !authFlags.recovery) router.replace("/");
  }, [session, seg]);   // eslint-disable-line react-hooks/exhaustive-deps

  const bare = PUBLIC.includes(seg) || seg === "reset-password" || !session;   // no studio frame on public pages
  const stack = (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
      <Stack.Screen name="index" options={{ title: "anlim.ai" }} />
      <Stack.Screen name="workspace" options={{ title: "Workspace · anlim.ai" }} />
      <Stack.Screen name="storage" options={{ title: "Assets · anlim.ai" }} />
      <Stack.Screen name="review" options={{ title: "Review · anlim.ai" }} />
      <Stack.Screen name="login" options={{ title: "Sign in" }} />
      <Stack.Screen name="clip/[id]" options={{ title: "Review a clip" }} />
      <Stack.Screen name="shots" options={{ title: "Scene board" }} />
      <Stack.Screen name="shot/[id]" options={{ title: "Shot" }} />
      <Stack.Screen name="cut/[scene]" options={{ title: "Scene cut" }} />
      <Stack.Screen name="library" options={{ title: "Cast & places" }} />
      <Stack.Screen name="billing" options={{ title: "Credits & plan" }} />
      <Stack.Screen name="account" options={{ title: "Account" }} />
      <Stack.Screen name="reset-password" options={{ title: "New password" }} />
      <Stack.Screen name="welcome" options={{ title: "anlim.ai" }} />
      <Stack.Screen name="start" options={{ title: "Start · anlim.ai" }} />
      <Stack.Screen name="terms" options={{ title: "Terms" }} />
      <Stack.Screen name="privacy" options={{ title: "Privacy" }} />
      <Stack.Screen name="support" options={{ title: "Help & contact" }} />
    </Stack>
  );
  return bare ? stack : <Shell>{stack}</Shell>;
}

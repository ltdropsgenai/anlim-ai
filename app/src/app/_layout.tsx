// Root layout: sends signed-out visitors to /login; a password-reset link lands on /reset-password. @anlim
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { DarkTheme, Stack, ThemeProvider, router, usePathname, useSegments } from "expo-router";
import type { Session } from "@supabase/supabase-js";
import { authFlags, supabase } from "../lib/supabase";
import { setOauthReturn, takeOauthReturn } from "../lib/oauthReturn";
import { c, pageBg } from "../lib/theme";
import { SunStage } from "../components/SunLight";
import { Shell } from "../components/Shell";
import { installErrorHandlers, reloadIfStaleBundle, reportError, trackView } from "../lib/telemetry";
import { api } from "../lib/api";
import { tr, getLang, setLang, onLang, Lang } from "../lib/i18n";

// Web: the studio fonts and page-level styles (dark scrollbars, base text font). Native keeps the system font.
// 2026-11-20: plus the glass card and ambient light CSS used by components/FloatCard.web.tsx.
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
input,textarea{color-scheme:dark}
.anlim-glass{position:relative;display:flex;flex-direction:column;height:100%;border-radius:20px;background:linear-gradient(160deg,rgba(255,255,255,.065),rgba(255,255,255,.025) 40%,rgba(255,255,255,.012)),rgba(14,14,17,.84);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),inset 0 -1px 0 rgba(0,0,0,.35),0 30px 60px -28px rgba(0,0,0,.95);transition:transform .45s cubic-bezier(.2,.7,.2,1),background .45s ease}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.anlim-glass{-webkit-backdrop-filter:blur(22px) saturate(140%);backdrop-filter:blur(22px) saturate(140%)}}
@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.anlim-glass{background:linear-gradient(160deg,rgba(255,255,255,.065),rgba(255,255,255,.025) 40%,rgba(255,255,255,.012)),#131316}}
.anlim-glass--compact{border-radius:14px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 16px 32px -20px rgba(0,0,0,.9)}
.anlim-glass--hover:hover{transform:translateY(-4px);background-color:rgba(20,20,24,.86)}
.anlim-glass--compact.anlim-glass--hover:hover{transform:translateY(-2px)}
.anlim-ambient{position:relative;isolation:isolate}
.anlim-ambient::before{content:"";position:absolute;z-index:-1;pointer-events:none;left:0;right:0;top:-40px;bottom:-40px;background:radial-gradient(50% 50% at 50% 55%,rgba(255,122,26,.13),rgba(255,122,26,.04) 55%,rgba(255,122,26,0))}
@media (prefers-reduced-motion:reduce){.anlim-glass{transition:none}.anlim-glass--hover:hover{transform:none}}
.anlim-stage{position:relative;flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;isolation:isolate;overflow:hidden;background:${c.bg};--flash:.3}
.anlim-sun{position:absolute;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
.anlim-sun>*{position:absolute;left:var(--sx);top:var(--sy)}
.anlim-sun__pulse{width:0;height:0;will-change:transform,opacity;transform:scale(calc(.78 + .35*var(--flash)));opacity:calc(.2 + .8*var(--flash))}
.anlim-sun__rays{position:absolute;width:260vmax;height:260vmax;left:-130vmax;top:-130vmax;border-radius:50%;will-change:transform;animation:anlim-turn 120s linear infinite;
background:repeating-conic-gradient(rgba(255,190,130,0) 0deg,rgba(255,205,155,.32) 1.6deg,rgba(255,190,130,0) 4.2deg,rgba(255,190,130,0) 13deg);filter:blur(6px);
-webkit-mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 8%,rgba(0,0,0,.2) 20%,transparent 40%);mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 8%,rgba(0,0,0,.2) 20%,transparent 40%)}
.anlim-sun__rays--b{background:repeating-conic-gradient(from 31deg,rgba(255,150,80,0) 0deg,rgba(255,160,90,.2) 3deg,rgba(255,150,80,0) 7.5deg,rgba(255,150,80,0) 23deg);filter:blur(14px);animation:anlim-turn 85s linear infinite reverse}
@keyframes anlim-turn{to{transform:rotate(360deg)}}
.anlim-sun__halo{width:120vmin;height:120vmin;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(closest-side,rgba(255,190,130,.34),rgba(255,122,26,.11) 40%,rgba(255,122,26,0));opacity:calc(.45 + .55*var(--flash))}
.anlim-sun__core{width:150px;height:150px;border-radius:50%;background:radial-gradient(closest-side,#fff 0%,rgba(255,246,236,.9) 13%,rgba(255,206,160,.45) 32%,rgba(255,140,60,.1) 60%,rgba(255,122,26,0));transform:translate(-50%,-50%) scale(calc(.6 + .45*var(--flash)))}
.anlim-stage .anlim-glass{background:linear-gradient(160deg,rgba(255,255,255,.065),rgba(255,255,255,.025) 40%,rgba(255,255,255,.012)),rgba(14,14,17,.76);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),inset 0 -1px 0 rgba(0,0,0,.35),0 30px 60px -28px rgba(0,0,0,.95),0 0 50px -12px rgba(255,170,110,calc(.26*var(--flash)*var(--near,.5)))}
.anlim-stage .anlim-glass::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;background:linear-gradient(var(--to-sun,0deg),rgba(255,200,160,0) 30%,rgba(255,190,140,.4) 75%,rgba(255,246,236,.95));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);opacity:calc((.3 + .7*var(--flash))*(.4 + .6*var(--near,.5)))}
@media (max-width:760px){.anlim-sun{opacity:.75}}
.anlim-glass.anlim-float{border-radius:24px;height:auto;background:linear-gradient(170deg,rgba(255,255,255,.09),rgba(255,255,255,.03) 35%,rgba(255,255,255,.012)),rgba(16,16,20,.8);
box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 -1px 0 rgba(0,0,0,.45),0 2px 4px rgba(0,0,0,.5),0 24px 40px -18px rgba(0,0,0,.9),0 70px 110px -40px rgba(0,0,0,1),0 0 70px -20px rgba(255,170,110,calc(.12 + .3*var(--flash,.3)));
animation:anlim-drift 7s ease-in-out infinite;transition:transform .5s cubic-bezier(.2,.7,.2,1)}
@keyframes anlim-drift{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
.anlim-glass.anlim-float:focus-within{animation:none;transform:translateY(-3px)}
@media (prefers-reduced-motion:reduce){.anlim-glass.anlim-float{animation:none}}
@media (prefers-reduced-motion:reduce){.anlim-sun__rays{animation:none}.anlim-stage{--flash:.45}}`;
    document.head.append(pre, css, st);
  }, []);
}

// A screen that throws shows this instead of a blank page (expo-router ErrorBoundary, review 2026-11-19).
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  useEffect(() => { reportError("screen", error); reloadIfStaleBundle(error); }, [error]);   // monitoring (2026-11-23); stale tab after a deploy (2026-11-25)
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ color: c.ink, fontSize: 20, fontWeight: "700" }}>{tr("Something went wrong on this screen")}</Text>
      <Text style={{ color: c.sub, fontSize: 14, textAlign: "center", maxWidth: 520 }}>{error.message}</Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable onPress={retry} accessibilityRole="button" style={{ backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10 }}>
          <Text style={{ color: c.onAccent, fontWeight: "700" }}>{tr("Try again")}</Text>
        </Pressable>
        <Pressable onPress={() => router.replace("/")} accessibilityRole="link" style={{ borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10 }}>
          <Text style={{ color: c.ink, fontWeight: "600" }}>{tr("Go home")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function RootLayout() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // Two-step sign-in (2026-11-25): a session made with the password alone, on an account that has an authenticator
  // turned on, may only finish signing in (/login asks for the code). undefined = still checking.
  const [needCode, setNeedCode] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (session === undefined) return;
    if (!session) { setNeedCode(false); return; }
    let live = true;
    supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      .then(({ data }) => { if (live) setNeedCode(data?.nextLevel === "aal2" && data?.currentLevel !== "aal2"); })
      .catch(() => { if (live) setNeedCode(false); });
    return () => { live = false; };
  }, [session?.access_token]);   // eslint-disable-line react-hooks/exhaustive-deps
  const segments = useSegments();
  const pathname = usePathname();
  useWebLook();
  useEffect(() => { installErrorHandlers(); }, []);
  // Referrals (2026-11-23): an invite link (?ref=CODE) is remembered on this browser, then claimed once signed in
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref && /^[a-z0-9]{6,12}$/i.test(ref)) localStorage.setItem("anlim_ref", ref.toLowerCase());
    } catch { /* storage blocked: no referral */ }
  }, []);
  useEffect(() => {
    if (!session || Platform.OS !== "web") return;
    let ref: string | null = null;
    try { ref = localStorage.getItem("anlim_ref"); } catch { return; }
    if (!ref) return;
    api.claimReferral(ref).catch(() => null).finally(() => { try { localStorage.removeItem("anlim_ref"); } catch { /* ignore */ } });
  }, [session]);
  // Language (2026-11-24): the account's choice wins; a new account gets this device's language saved to it, so emails
  // and what anlim makes follow it. Changing the language remounts the app below (key), so every tr() re-reads it.
  const [lang, setLangState] = useState<Lang>(getLang());
  useEffect(() => onLang(setLangState), []);
  useEffect(() => { if (Platform.OS === "web" && typeof document !== "undefined") document.documentElement.lang = lang; }, [lang]);
  useEffect(() => {
    if (!session) return;
    api.me().then((m) => {
      if (m.language) setLang(m.language);
      else api.setLanguage(getLang()).catch(() => null);
    }).catch(() => null);
  }, [session?.user?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  // page views of signed-in creators (2026-11-23): the path only (ids become :id), to see where people stop
  useEffect(() => { if (session) trackView(pathname); }, [session, pathname]);

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
  const PUBLIC = ["welcome", "start", "login", "terms", "privacy", "support", "oauth"];   // oauth: the AI-tool consent page (2026-11-21)
  const seg = (segments[0] as string | undefined) ?? "";
  useEffect(() => {
    if (session === undefined || (session && needCode === undefined)) return;
    const onLogin = seg === "login";
    if (session && needCode) { if (!onLogin) router.replace("/login"); return; }   // finish signing in: the code
    if (!session && seg === "upload") { setOauthReturn("/upload"); router.replace("/login"); return; }   // AI-tool uploads: sign in, then back
    if (!session && !PUBLIC.includes(seg)) router.replace("/welcome");   // includes /reset-password without a recovery session
    if (session && onLogin && !authFlags.recovery) router.replace((takeOauthReturn() ?? "/") as never);   // back to the consent page if it sent them
  }, [session, seg, needCode]);   // eslint-disable-line react-hooks/exhaustive-deps

  const bare = PUBLIC.includes(seg) || seg === "reset-password" || !session || needCode !== false;   // no studio frame on public pages
  const stack = (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: pageBg } }}>
      <Stack.Screen name="index" options={{ title: "anlim.ai" }} />
      <Stack.Screen name="workspace" options={{ title: tr("Workspace · anlim.ai") }} />
      <Stack.Screen name="storage" options={{ title: tr("Assets · anlim.ai") }} />
      <Stack.Screen name="review" options={{ title: tr("Review · anlim.ai") }} />
      <Stack.Screen name="login" options={{ title: tr("Sign in") }} />
      <Stack.Screen name="clip/[id]" options={{ title: tr("Review a clip") }} />
      <Stack.Screen name="shots" options={{ title: tr("Scene board") }} />
      <Stack.Screen name="shot/[id]" options={{ title: tr("Shot") }} />
      <Stack.Screen name="cut/[scene]" options={{ title: tr("Scene cut") }} />
      <Stack.Screen name="library" options={{ title: tr("Cast & places") }} />
      <Stack.Screen name="billing" options={{ title: tr("Credits & plan") }} />
      <Stack.Screen name="account" options={{ title: tr("Account") }} />
      <Stack.Screen name="reset-password" options={{ title: tr("New password") }} />
      <Stack.Screen name="welcome" options={{ title: "anlim.ai" }} />
      <Stack.Screen name="start" options={{ title: tr("Start · anlim.ai") }} />
      <Stack.Screen name="terms" options={{ title: tr("Terms") }} />
      <Stack.Screen name="privacy" options={{ title: tr("Privacy") }} />
      <Stack.Screen name="support" options={{ title: tr("Help & contact") }} />
      <Stack.Screen name="upload" options={{ title: tr("Upload · anlim.ai") }} />
      <Stack.Screen name="oauth/consent" options={{ title: tr("Connect an AI tool · anlim.ai") }} />
      <Stack.Screen name="refunds" options={{ title: tr("Refund requests") }} />
      <Stack.Screen name="insights" options={{ title: tr("Insights") }} />
      <Stack.Screen name="admin/index" options={{ title: tr("Admin console") }} />
      <Stack.Screen name="admin/user/[id]" options={{ title: tr("Account details") }} />
    </Stack>
  );
  // 2026-11-20 (Londi): the sun light sits behind every page. Studio pages get it from the Shell (behind the page,
  // not the sidebar); public pages get it here. The navigator's own background is transparent on the web so it shows.
  const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: pageBg, card: c.bg } };
  return <ThemeProvider key={lang} value={theme}>{bare ? <SunStage>{stack}</SunStage> : <Shell>{stack}</Shell>}</ThemeProvider>;
}

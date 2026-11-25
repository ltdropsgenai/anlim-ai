// Sign in, create an account, or get a password-reset email. @anlim
// New accounts confirm their email first (Supabase sends a link and a code); the welcome credits arrive on confirmation.
// The code is the fallback when a mail scanner opens the link first and uses it up (Supabase auth-email docs).
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Captcha, CAPTCHA_ON } from "../components/Captcha";
import { appUrl, authFlags, supabase } from "../lib/supabase";
import { c, pageBg } from "../lib/theme";
import { Logo } from "../components/Logo";
import { peekDraft } from "../lib/draft";
import { tr, trMap, tMsg } from "../lib/i18n";
import { usePageTitle } from "../lib/pageTitle";

type Mode = "signin" | "signup" | "forgot" | "code";
const TITLES: Record<Mode, string> = trMap({ signin: "Sign in", signup: "Create your account", forgot: "Reset your password", code: "Enter the code from the email" });
const BUTTONS: Record<Mode, string> = trMap({ signin: "Sign in", signup: "Create account", forgot: "Send reset link", code: "Continue" });

// Supabase's messages are mostly clear; these two are the ones creators hit and misread.
function friendly(msg: string) {
  if (/banned/i.test(msg)) return tr("This account is blocked. Contact support@anlim.ai.");   // admin console block (2026-11-25)
  if (/email not confirmed/i.test(msg)) return tr("Confirm your email first: open the link we sent you, then sign in.");
  if (/invalid login credentials/i.test(msg)) return tr("That email and password don't match an account.");
  if (/captcha/i.test(msg)) return tr("The security check didn't go through. Tick it again, then try once more.");
  if (/rate limit/i.test(msg)) return tr("Too many emails sent just now. Wait a few minutes and try again.");
  if (/expired|invalid/i.test(msg) && /token|otp/i.test(msg)) return tr("That code is wrong or has expired. Ask for a new email and use the newest code.");
  return msg;
}

export default function Login() {
  usePageTitle(tr("Sign in"));
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<Mode>(params.mode === "signup" ? "signup" : "signin");
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);   // a new widget after each try: a token works once
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeFor, setCodeFor] = useState<"signup" | "recovery">("signup");
  const [draft] = useState(() => peekDraft());   // a prompt typed on /start before signing up

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const ready = mode === "code" ? emailOk && /^\d{6,10}$/.test(code.trim())
    : emailOk && (mode === "forgot" || password.length >= (mode === "signup" ? 8 : 1)) && (mode !== "signup" || password === password2)
      && (!CAPTCHA_ON || !!captcha);

  function go(m: Mode) { setMode(m); setError(null); setNotice(null); setPassword(""); setPassword2(""); setCode(""); }

  async function submit() {
    if (!ready || busy) return;
    setBusy(true); setError(null); setNotice(null);
    const e = email.trim();
    const captchaToken = captcha ?? undefined;
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: e, password, options: { captchaToken } });
        if (error) throw error;
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: e, password, options: { emailRedirectTo: appUrl("/"), captchaToken } });
        if (error) throw error;
        // With email confirmation on, there is no session yet. Supabase also returns no error for an address that
        // already has an account (so the form can't be used to find out who has one): same message either way.
        if (!data.session) {
          setNotice(tr("Check {e}: open the link, or enter the code from the email here. Your 300 welcome credits arrive when you confirm.", { e }));
          setCodeFor("signup"); go2("code");
        }
      } else if (mode === "code") {
        if (codeFor === "recovery") authFlags.recovery = true;            // before the sign-in event reaches the layout
        const { error } = await supabase.auth.verifyOtp({ email: e, token: code.trim(), type: codeFor });
        if (error) { authFlags.recovery = false; throw error; }
        if (codeFor === "recovery") router.replace("/reset-password");   // signed in to choose a new password
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(e, { redirectTo: appUrl("/reset-password"), captchaToken });
        if (error) throw error;
        setNotice(tr("If {e} has an account, an email is on its way. Open its link, or enter its code here, to choose a new password.", { e }));
        setCodeFor("recovery"); go2("code");
      }
    } catch (err) { setError(friendly((err as Error).message)); }
    if (CAPTCHA_ON) { setCaptcha(null); setCaptchaKey((k) => k + 1); }
    setBusy(false);
  }
  // switch mode but keep the notice and the email
  function go2(m: Mode) { setMode(m); setPassword(""); setPassword2(""); setCode(""); }

  return (
    <View style={s.page}>
      <View style={s.card}>
        <Pressable onPress={() => router.navigate("/welcome")} accessibilityRole="link" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Logo size={34} /><Text style={s.title}>{tr("anlim.ai")}</Text>
        </Pressable>
        <Text style={s.sub}>{TITLES[mode]}</Text>
        {draft && mode !== "forgot" && (
          <Text style={s.notice}>{tr("Your shot is waiting: \"{v0}\". {v1}", { v0: draft.text.length > 90 ? draft.text.slice(0, 90) + "…" : draft.text, v1: mode === "signin"
            ? "Sign in and we'll make its first frame." : "Create your account and we'll make its first frame, paid from your free starter credits." })}</Text>
        )}
        {notice && <Text style={s.notice}>{notice}</Text>}
        <TextInput style={s.input} placeholder={tr("Email")} autoCapitalize="none" keyboardType="email-address" autoComplete="email"
          placeholderTextColor={c.muted} value={email} onChangeText={setEmail} accessibilityLabel={tr("Email")} onSubmitEditing={submit} />
        {mode === "code" && (
          <TextInput style={[s.input, { letterSpacing: 4 }]} placeholder={tr("Code")} keyboardType="number-pad" autoComplete="one-time-code"
            placeholderTextColor={c.muted} value={code} onChangeText={setCode} onSubmitEditing={submit} accessibilityLabel={tr("Code from the email")} />
        )}
        {mode !== "forgot" && mode !== "code" && (
          <TextInput style={s.input} placeholder={mode === "signup" ? tr("Password (8 characters or more)") : tr("Password")} secureTextEntry
            autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholderTextColor={c.muted}
            value={password} onChangeText={setPassword} onSubmitEditing={submit} accessibilityLabel={tr("Password")} />
        )}
        {mode === "signup" && (
          <TextInput style={s.input} placeholder={tr("Password again")} secureTextEntry autoComplete="new-password" placeholderTextColor={c.muted}
            value={password2} onChangeText={setPassword2} onSubmitEditing={submit} accessibilityLabel={tr("Password again")} />
        )}
        {mode === "signup" && password2.length > 0 && password !== password2 && <Text style={s.hint}>{tr("The passwords don't match.")}</Text>}
        {mode !== "code" && <Captcha key={captchaKey} onToken={setCaptcha} />}
        {error && <Text style={s.error}>{tMsg(error)}</Text>}
        <Pressable style={[s.button, (!ready || busy) && { opacity: 0.6 }]} onPress={submit} disabled={!ready || busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={c.onAccent} /> : <Text style={s.buttonText}>{BUTTONS[mode]}</Text>}
        </Pressable>
        <View style={s.links}>
          {mode !== "signin" && <Pressable onPress={() => go("signin")} accessibilityRole="link"><Text style={s.link}>{tr("I have an account: sign in")}</Text></Pressable>}
          {mode !== "signup" && <Pressable onPress={() => go("signup")} accessibilityRole="link"><Text style={s.link}>{tr("New here? Create an account")}</Text></Pressable>}
          {mode === "signin" && <Pressable onPress={() => go("forgot")} accessibilityRole="link"><Text style={s.link}>{tr("Forgot your password?")}</Text></Pressable>}
        </View>
        {mode === "signup" && (
          <Text style={{ color: c.sub, fontSize: 12 }}>{tr("By creating an account you agree to the")}{" "}
            <Text style={{ color: c.link }} onPress={() => router.navigate("/terms")} accessibilityRole="link">{tr("Terms")}</Text>{tr(" and the")}{" "}
            <Text style={{ color: c.link }} onPress={() => router.navigate("/privacy")} accessibilityRole="link">{tr("Privacy policy")}</Text>.</Text>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, backgroundColor: pageBg },
  // 2026-11-20 (no outlined boxes): a raised surface; the fields are filled wells, not outlined boxes
  card: { width: "100%", maxWidth: 400, backgroundColor: "#0F0F13", borderRadius: 16, padding: 24, gap: 12,
          shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 32, shadowOffset: { width: 0, height: 16 } },
  title: { fontSize: 24, fontWeight: "700", color: c.ink },
  sub: { color: c.sub, marginBottom: 4, fontSize: 16 },
  input: { borderRadius: 10, padding: 13, fontSize: 16, color: c.ink, backgroundColor: "#18181D" },
  error: { color: c.fail }, hint: { color: c.sub, fontSize: 13 },
  notice: { color: c.ink, backgroundColor: c.passBg, borderRadius: 8, padding: 10 },
  button: { backgroundColor: c.accent, borderRadius: 8, padding: 14, alignItems: "center", marginTop: 4 },
  buttonText: { color: c.onAccent, fontWeight: "600", fontSize: 16 },
  links: { gap: 8, marginTop: 4 }, link: { color: c.accent, fontSize: 14 },
});

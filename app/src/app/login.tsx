// Sign in, create an account, or get a password-reset email. @anlim
// New accounts confirm their email first (Supabase sends a link and a code); the welcome credits arrive on confirmation.
// The code is the fallback when a mail scanner opens the link first and uses it up (Supabase auth-email docs).
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Captcha, CAPTCHA_ON } from "../components/Captcha";
import { appUrl, authFlags, supabase } from "../lib/supabase";
import { c } from "../lib/theme";
import { Logo } from "../components/Logo";
import { peekDraft } from "../lib/draft";

type Mode = "signin" | "signup" | "forgot" | "code";
const TITLES: Record<Mode, string> = { signin: "Sign in", signup: "Create your account", forgot: "Reset your password", code: "Enter the code from the email" };
const BUTTONS: Record<Mode, string> = { signin: "Sign in", signup: "Create account", forgot: "Send reset link", code: "Continue" };

// Supabase's messages are mostly clear; these two are the ones creators hit and misread.
function friendly(msg: string) {
  if (/email not confirmed/i.test(msg)) return "Confirm your email first: open the link we sent you, then sign in.";
  if (/invalid login credentials/i.test(msg)) return "That email and password don't match an account.";
  if (/captcha/i.test(msg)) return "The security check didn't go through. Tick it again, then try once more.";
  if (/rate limit/i.test(msg)) return "Too many emails sent just now. Wait a few minutes and try again.";
  if (/expired|invalid/i.test(msg) && /token|otp/i.test(msg)) return "That code is wrong or has expired. Ask for a new email and use the newest code.";
  return msg;
}

export default function Login() {
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
          setNotice(`Check ${e}: open the link, or enter the code from the email here. Your 300 welcome credits arrive when you confirm.`);
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
        setNotice(`If ${e} has an account, an email is on its way. Open its link, or enter its code here, to choose a new password.`);
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
          <Logo size={34} /><Text style={s.title}>anlim.ai</Text>
        </Pressable>
        <Text style={s.sub}>{TITLES[mode]}</Text>
        {draft && mode !== "forgot" && (
          <Text style={s.notice}>Your shot is waiting: "{draft.text.length > 90 ? draft.text.slice(0, 90) + "…" : draft.text}". {mode === "signin"
            ? "Sign in and we'll make its first frame." : "Create your account and we'll make its first frame, paid from your free starter credits."}</Text>
        )}
        {notice && <Text style={s.notice}>{notice}</Text>}
        <TextInput style={s.input} placeholder="Email" autoCapitalize="none" keyboardType="email-address" autoComplete="email"
          placeholderTextColor={c.muted} value={email} onChangeText={setEmail} accessibilityLabel="Email" onSubmitEditing={submit} />
        {mode === "code" && (
          <TextInput style={[s.input, { letterSpacing: 4 }]} placeholder="Code" keyboardType="number-pad" autoComplete="one-time-code"
            placeholderTextColor={c.muted} value={code} onChangeText={setCode} onSubmitEditing={submit} accessibilityLabel="Code from the email" />
        )}
        {mode !== "forgot" && mode !== "code" && (
          <TextInput style={s.input} placeholder={mode === "signup" ? "Password (8 characters or more)" : "Password"} secureTextEntry
            autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholderTextColor={c.muted}
            value={password} onChangeText={setPassword} onSubmitEditing={submit} accessibilityLabel="Password" />
        )}
        {mode === "signup" && (
          <TextInput style={s.input} placeholder="Password again" secureTextEntry autoComplete="new-password" placeholderTextColor={c.muted}
            value={password2} onChangeText={setPassword2} onSubmitEditing={submit} accessibilityLabel="Password again" />
        )}
        {mode === "signup" && password2.length > 0 && password !== password2 && <Text style={s.hint}>The passwords don't match.</Text>}
        {mode !== "code" && <Captcha key={captchaKey} onToken={setCaptcha} />}
        {error && <Text style={s.error}>{error}</Text>}
        <Pressable style={[s.button, (!ready || busy) && { opacity: 0.6 }]} onPress={submit} disabled={!ready || busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={c.onAccent} /> : <Text style={s.buttonText}>{BUTTONS[mode]}</Text>}
        </Pressable>
        <View style={s.links}>
          {mode !== "signin" && <Pressable onPress={() => go("signin")} accessibilityRole="link"><Text style={s.link}>I have an account: sign in</Text></Pressable>}
          {mode !== "signup" && <Pressable onPress={() => go("signup")} accessibilityRole="link"><Text style={s.link}>New here? Create an account</Text></Pressable>}
          {mode === "signin" && <Pressable onPress={() => go("forgot")} accessibilityRole="link"><Text style={s.link}>Forgot your password?</Text></Pressable>}
        </View>
        {mode === "signup" && (
          <Text style={{ color: c.sub, fontSize: 12 }}>By creating an account you agree to the{" "}
            <Text style={{ color: c.link }} onPress={() => router.navigate("/terms")} accessibilityRole="link">Terms</Text> and the{" "}
            <Text style={{ color: c.link }} onPress={() => router.navigate("/privacy")} accessibilityRole="link">Privacy policy</Text>.</Text>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, backgroundColor: c.bg },
  card: { width: "100%", maxWidth: 400, backgroundColor: c.card, borderRadius: 14, padding: 24, borderWidth: 1, borderColor: c.line, gap: 12 },
  title: { fontSize: 24, fontWeight: "700", color: c.ink },
  sub: { color: c.sub, marginBottom: 4, fontSize: 16 },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 12, fontSize: 16, color: c.ink, backgroundColor: c.field },
  error: { color: c.fail }, hint: { color: c.sub, fontSize: 13 },
  notice: { color: c.ink, backgroundColor: c.passBg, borderRadius: 8, padding: 10 },
  button: { backgroundColor: c.accent, borderRadius: 8, padding: 14, alignItems: "center", marginTop: 4 },
  buttonText: { color: c.onAccent, fontWeight: "600", fontSize: 16 },
  links: { gap: 8, marginTop: 4 }, link: { color: c.accent, fontSize: 14 },
});

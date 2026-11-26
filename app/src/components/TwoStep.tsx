// Two-step sign-in for every account (2026-11-25, Londi chose option 1 after the admin page stopped offering it):
// an authenticator app's 6-digit code, asked for at every sign-in once it is on (Supabase Auth MFA, TOTP). The account
// page turns it on and off; studio-api and checkout refuse a session without the code when the account has it on.
// It is also how a future admin gets a code before the owner adds them (studio.admin_add requires one). @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, Text, TextInput, View } from "react-native";
import { supabase } from "../lib/supabase";
import { c, font } from "../lib/theme";
import { tr } from "../lib/i18n";

// Supabase gives the QR code as "data:image/svg+xml;utf-8,<svg ...>" with the SVG unescaped; the web Image puts it in a
// CSS url(), where its quotes and # break it. Re-encoded here.
export function qrUri(raw: string) {
  const at = raw.indexOf("<svg");
  return at >= 0 ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw.slice(at))}` : raw;
}

export function CodeField({ value, onChange, onSubmit }: { value: string; onChange: (s: string) => void; onSubmit: () => void }) {
  return (
    <TextInput value={value} onChangeText={(t) => onChange(t.replace(/\D/g, "").slice(0, 6))} onSubmitEditing={onSubmit}
      placeholder="123456" placeholderTextColor={c.sub} keyboardType="number-pad" autoFocus
      {...(Platform.OS === "web" ? { autoComplete: "one-time-code" as const } : {})} accessibilityLabel={tr("Six-digit code")}
      style={[{ color: c.ink, fontSize: 24, letterSpacing: 8, backgroundColor: "#2A2A31", borderRadius: 10, paddingHorizontal: 14,
                paddingVertical: 10, textAlign: "center" }, font.mono]} />
  );
}

export const codeError = (m: string) =>
  /invalid/i.test(m) ? tr("That code did not match. Codes change every 30 seconds: try the current one.") : m;

// The account page's card: on (with a way to turn it off) or off (with the set-up).
export function TwoStepCard() {
  const [state, setState] = useState<"loading" | "off" | "setup" | "on">("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [armOff, setArmOff] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) { setErr(error.message); setState("off"); return; }
    const v = (data?.totp ?? []).find((x) => x.status === "verified");
    if (v) { setFactorId(v.id); setState("on"); } else { setFactorId(null); setState("off"); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      const { data: f } = await supabase.auth.mfa.listFactors();
      for (const x of f?.all ?? []) if (x.factor_type === "totp" && x.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: x.id });
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "anlim" });
      if (error || !data) throw error ?? new Error("could not start the set-up");
      setFactorId(data.id); setQr(qrUri(data.totp.qr_code)); setSecret(data.totp.secret); setCode(""); setState("setup");
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const verify = async () => {
    if (!factorId || code.length !== 6) { setErr(tr("Enter the 6-digit code from your authenticator app.")); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    setBusy(false);
    if (error) { setErr(codeError(error.message)); return; }
    setQr(null); setSecret(null); setState("on");
  };
  const turnOff = async () => {
    if (!armOff) { setArmOff(true); return; }
    setArmOff(false); setBusy(true); setErr(null);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factorId! });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await supabase.auth.refreshSession().catch(() => null);
    load();
  };

  const btn = (label: string, onPress: () => void, tone: "accent" | "plain" = "accent") => (
    <Pressable onPress={onPress} disabled={busy} accessibilityRole="button"
      style={({ pressed }) => ({ alignSelf: "flex-start", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9, opacity: busy ? 0.6 : 1,
                                 backgroundColor: tone === "accent" ? c.accent : "#24242A", transform: [{ scale: pressed ? 0.97 : 1 }] })}>
      <Text style={{ color: tone === "accent" ? c.onAccent : c.ink, fontWeight: "700", fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ backgroundColor: c.card, borderRadius: 14, padding: 16, gap: 10 }}>
      <Text style={{ color: c.sub, fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>{tr("Two-step sign-in")}</Text>
      {state === "loading" && <ActivityIndicator />}
      {state === "off" && (<>
        <Text style={{ color: c.ink, fontSize: 14, lineHeight: 21 }}>
          {tr("Off. Turn it on and anlim asks for a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator) every time you sign in, so your password alone is not enough.")}
        </Text>
        {btn(tr("Turn on"), start)}
      </>)}
      {state === "setup" && (<>
        <Text style={{ color: c.ink, fontSize: 14, lineHeight: 21 }}>{tr("Scan this with your authenticator app, then type the 6-digit code it shows.")}</Text>
        {qr && <View style={{ alignSelf: "center", backgroundColor: "#fff", padding: 10, borderRadius: 8 }}>
          <Image source={{ uri: qr }} style={{ width: 200, height: 200 }} accessibilityLabel={tr("Authenticator set-up code")} />
        </View>}
        <Text style={{ color: c.sub, fontSize: 12 }}>{tr("Can't scan? Enter this key in the app instead:")}</Text>
        <Text selectable style={[{ color: c.ink, fontSize: 13 }, font.mono]}>{secret}</Text>
        <CodeField value={code} onChange={setCode} onSubmit={verify} />
        <View style={{ flexDirection: "row", gap: 8 }}>{btn(tr("Turn on"), verify)}{btn(tr("Cancel"), () => load(), "plain")}</View>
        <Text style={{ color: c.sub, fontSize: 12, lineHeight: 18 }}>{tr("Keep the app on your phone: without it you cannot sign in. If you lose it, write to support@anlim.ai from this account's email.")}</Text>
      </>)}
      {state === "on" && (<>
        <Text style={{ color: c.ink, fontSize: 14, lineHeight: 21 }}>{tr("On. anlim asks for a code from your authenticator app every time you sign in.")}</Text>
        {btn(armOff ? tr("Confirm: turn off") : tr("Turn off"), turnOff, "plain")}
      </>)}
      {err && <Text style={{ color: c.fail, fontSize: 13 }}>{err}</Text>}
    </View>
  );
}

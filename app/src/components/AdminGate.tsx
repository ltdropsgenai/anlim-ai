// Admin pages' door (2026-11-25, admin console; Londi: two-step code required). Only accounts in studio.admins get
// past it, and only with a session signed in with an authenticator-app code (Supabase Auth MFA, TOTP: the session's
// assurance level becomes aal2). The first time, it sets the authenticator up (QR code, then one code). The server
// checks the same thing on every admin call (studio-api + studio.admin_guard), so this page is the convenience,
// not the lock. @anlim
import { ComponentProps, ReactNode, useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { api } from "../lib/api";
import { supabase } from "../lib/supabase";
import { c, font, pageBg } from "../lib/theme";

type State =
  | { k: "loading" }
  | { k: "no" }   // not an admin: sent Home
  | { k: "enroll"; factorId: string; qr: string; secret: string; admin: boolean }
  | { k: "code"; factorId: string }
  | { k: "ok" }
  | { k: "error"; msg: string };

export function AdminGate({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<State>({ k: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = useCallback(async () => {
    setSt({ k: "loading" }); setErr(null); setCode("");
    try {
      const me = await api.me();
      const admin = !!me.is_admin;
      // 2026-11-25 (Londi: "/admin should not be reachable to any account if it is not an admin account"): anyone else
      // is sent to Home and shown nothing that says an admin page exists.
      if (!admin) { setSt({ k: "no" }); router.replace("/"); return; }
      const { data: f, error: fErr } = await supabase.auth.mfa.listFactors();
      if (fErr) throw fErr;
      const verified = (f?.totp ?? []).find((x) => x.status === "verified");
      if (admin) {
        const { data: aal, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalErr) throw aalErr;
        if (aal?.currentLevel === "aal2") { setSt({ k: "ok" }); return; }
        if (verified) { setSt({ k: "code", factorId: verified.id }); return; }
      }
      // an unfinished set-up from before is removed first (enroll refuses a second factor with the same name)
      for (const x of f?.all ?? []) if (x.factor_type === "totp" && x.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: x.id });
      const { data: e, error: eErr } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "anlim admin" });
      if (eErr || !e) throw eErr ?? new Error("could not start the set-up");
      // Supabase gives the QR code as "data:image/svg+xml;utf-8,<svg ...>" with the SVG unescaped; the web Image puts it in
      // a CSS url(), where its quotes and # break it (2026-11-25: Londi saw no QR code). Re-encode it.
      const raw = e.totp.qr_code, at = raw.indexOf("<svg");
      const qr = at >= 0 ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw.slice(at))}` : raw;
      setSt({ k: "enroll", factorId: e.id, qr, secret: e.totp.secret, admin });
    } catch (x) {
      setSt({ k: "error", msg: (x as Error).message || "Something went wrong" });
    }
  }, []);
  useEffect(() => { start(); }, [start]);

  const verify = async (factorId: string, admin = true) => {
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) { setErr("Enter the 6-digit code from your authenticator app."); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: clean });
    setBusy(false);
    if (error) { setErr(error.message.includes("Invalid") ? "That code did not match. Codes change every 30 seconds: try the current one." : error.message); return; }
    if (admin) setSt({ k: "ok" });
  };

  if (st.k === "ok") return <>{children}</>;
  if (st.k === "loading" || st.k === "no") return <ActivityIndicator style={{ marginTop: 40 }} />;   // nothing that names the page
  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={{ padding: 24, alignItems: "center" }}>
      <View style={{ maxWidth: 480, width: "100%", backgroundColor: c.card, borderRadius: 14, padding: 22, gap: 12 }}>
        <Text style={[{ color: c.ink, fontSize: 22 }, font.display]}>Admin console</Text>
        {st.k === "error" && (<>
          <Text style={{ color: c.fail, fontSize: 14 }}>{st.msg}</Text>
          <Btn label="Try again" onPress={start} />
        </>)}
        {st.k === "enroll" && (<>
          <Text style={{ color: c.sub, fontSize: 15, lineHeight: 22 }}>
            Admin pages need a second step when you sign in. Scan this code with an authenticator app (Google Authenticator,
            1Password, Authy, Microsoft Authenticator), then type the 6-digit code it shows.
          </Text>
          <View style={{ alignSelf: "center", backgroundColor: "#fff", padding: 10, borderRadius: 8 }}>
            <Image source={{ uri: st.qr }} style={{ width: 200, height: 200 }} accessibilityLabel="Authenticator set-up code" />
          </View>
          <Text style={{ color: c.muted, fontSize: 12 }}>Can't scan? Enter this key in the app instead:</Text>
          <Text selectable style={[{ color: c.ink, fontSize: 13 }, font.mono]}>{st.secret}</Text>
          <CodeBox value={code} onChange={setCode} onSubmit={() => verify(st.factorId, st.admin)} />
          <Btn label={busy ? "Checking…" : "Turn on and continue"} onPress={() => verify(st.factorId, st.admin)} disabled={busy} />
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>
            Keep the authenticator on your phone: without it you cannot open the admin console. If the phone is lost, the
            factor is removed in Supabase (Authentication, Users, the account, MFA factors).
          </Text>
        </>)}
        {st.k === "code" && (<>
          <Text style={{ color: c.sub, fontSize: 15 }}>Enter the 6-digit code from your authenticator app.</Text>
          <CodeBox value={code} onChange={setCode} onSubmit={() => verify(st.factorId)} />
          <Btn label={busy ? "Checking…" : "Continue"} onPress={() => verify(st.factorId)} disabled={busy} />
        </>)}
        {err && <Text style={{ color: c.fail, fontSize: 14 }}>{err}</Text>}
      </View>
    </ScrollView>
  );
}

function CodeBox({ value, onChange, onSubmit }: { value: string; onChange: (s: string) => void; onSubmit: () => void }) {
  return (
    <TextInput value={value} onChangeText={(t) => onChange(t.replace(/\D/g, "").slice(0, 6))} onSubmitEditing={onSubmit}
      placeholder="123456" placeholderTextColor={c.muted} keyboardType="number-pad" autoFocus
      {...(Platform.OS === "web" ? { autoComplete: "one-time-code" as const } : {})} accessibilityLabel="Six-digit code"
      style={[{ color: c.ink, fontSize: 24, letterSpacing: 8, backgroundColor: c.card2, borderRadius: 10, paddingHorizontal: 14,
                paddingVertical: 10, textAlign: "center" }, font.mono]} />
  );
}

export function Btn({ label, onPress, disabled, tone = "accent" }: { label: string; onPress: () => void; disabled?: boolean; tone?: "accent" | "danger" | "plain" }) {
  const bg = tone === "accent" ? c.accent : tone === "danger" ? c.fail : c.card2;
  const fg = tone === "plain" ? c.ink : c.onAccent;
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button"
      style={({ pressed }) => ({ backgroundColor: bg, opacity: disabled ? 0.5 : 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9,
                                 alignSelf: "flex-start", transform: [{ scale: pressed ? 0.97 : 1 }] })}>
      <Text style={{ color: fg, fontWeight: "700", fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

// A text field that cannot be missed (2026-11-25, Londi: "I genuinely could not see" the reason box): a clearly lighter
// fill than the card, readable placeholder text, and an orange glow while typing. No outline (Londi's rule).
export function Field({ style, ...p }: ComponentProps<typeof TextInput>) {
  const [focus, setFocus] = useState(false);
  return (
    <TextInput placeholderTextColor={c.sub} {...p}
      onFocus={(e) => { setFocus(true); p.onFocus?.(e); }} onBlur={(e) => { setFocus(false); p.onBlur?.(e); }}
      style={[{ color: c.ink, backgroundColor: focus ? "#33333B" : "#2A2A31", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
                fontSize: 15, minHeight: 46, shadowColor: c.accent, shadowOpacity: focus ? 0.55 : 0, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
               Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null, style]} />
  );
}

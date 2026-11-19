// Verify a phone number to receive the welcome credits (2026-11-19). Shown only when the account is waiting for it
// (welcome_status "needs_phone": studio.settings welcome_requires_phone is on). Supabase Auth sends the SMS code
// (its phone provider must be set up); verifying sets phone_confirmed_at, and the database grants the credits. @anlim
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { supabase } from "../lib/supabase";
import { c, font } from "../lib/theme";

export function PhoneCheck({ credits = 300, onDone }: { credits?: number; onDone: () => void }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const e164 = "+" + phone.replace(/[^0-9]/g, "");
  const phoneOk = /^\+[1-9][0-9]{7,14}$/.test(e164);
  return (
    <View style={s.card}>
      <Text style={[s.kicker, font.mono]}>FREE CREDITS</Text>
      <Text style={{ color: c.ink, fontSize: 15 }}>Verify your phone to get your {credits} welcome credits.</Text>
      <Text style={s.sub}>One phone number gets the welcome credits once. We only use it for this check.</Text>
      {!sent ? (
        <View style={s.row}>
          <TextInput value={phone} onChangeText={setPhone} placeholder="+1 555 123 4567" placeholderTextColor={c.muted} keyboardType="phone-pad"
            autoComplete="tel" style={[s.input, { flex: 1, minWidth: 180 }]} accessibilityLabel="Phone number with country code" />
          <Pressable style={[s.btn, (!phoneOk || busy) && { opacity: 0.5 }]} disabled={!phoneOk || busy} accessibilityRole="button"
            onPress={async () => {
              setBusy(true); setError(null);
              const { error } = await supabase.auth.updateUser({ phone: e164 });
              if (error) setError(error.message); else setSent(true);
              setBusy(false);
            }}>
            <Text style={s.btnText}>Text me a code</Text>
          </Pressable>
        </View>
      ) : (
        <View style={s.row}>
          <TextInput value={code} onChangeText={setCode} placeholder="Code" placeholderTextColor={c.muted} keyboardType="number-pad"
            autoComplete="one-time-code" style={[s.input, { width: 140, letterSpacing: 4 }]} accessibilityLabel="Code from the text message" />
          <Pressable style={[s.btn, (!/^\d{4,10}$/.test(code.trim()) || busy) && { opacity: 0.5 }]} disabled={!/^\d{4,10}$/.test(code.trim()) || busy}
            accessibilityRole="button"
            onPress={async () => {
              setBusy(true); setError(null);
              const { error } = await supabase.auth.verifyOtp({ phone: e164, token: code.trim(), type: "phone_change" });
              if (error) setError(/expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Ask for a new one." : error.message);
              else onDone();
              setBusy(false);
            }}>
            <Text style={s.btnText}>Verify</Text>
          </Pressable>
          <Pressable onPress={() => { setSent(false); setCode(""); }} accessibilityRole="button"><Text style={s.link}>Change number</Text></Pressable>
        </View>
      )}
      {error && <Text style={{ color: c.fail }}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 16, gap: 8 },
  kicker: { color: c.accent, fontSize: 11, letterSpacing: 0.9 },
  sub: { color: c.sub, fontSize: 13 }, link: { color: c.link, fontSize: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 11, color: c.ink, backgroundColor: c.field, fontSize: 15 },
  btn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 11, paddingHorizontal: 16 }, btnText: { color: c.onAccent, fontWeight: "700" },
});

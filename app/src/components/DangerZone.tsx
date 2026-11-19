// Delete the account (2026-11-19; App Store guideline 5.1.1(v)). The creator types their email to confirm; the server
// cancels any plan with Stripe, deletes their ElevenLabs key, every file and every row, then the sign-in itself. @anlim
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "../lib/api";
import { supabase } from "../lib/supabase";
import { c, font } from "../lib/theme";

export function DangerZone({ email }: { email: string | null }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = !!email && typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <View style={s.card}>
      <Text style={[s.kicker, font.mono]}>DELETE ACCOUNT</Text>
      {!open ? (<>
        <Text style={s.sub}>Deletes your account, every series, shot, clip, cut and sound you made, your credits and your ElevenLabs connection. An active plan is cancelled. This cannot be undone.</Text>
        <Pressable style={s.ghost} onPress={() => setOpen(true)} accessibilityRole="button"><Text style={{ color: c.fail }}>Delete my account…</Text></Pressable>
      </>) : (<>
        <Text style={{ color: c.ink, fontSize: 14 }}>To confirm, type your email address: <Text style={font.mono}>{email}</Text></Text>
        <Text style={s.sub}>Unused credits are not refunded. Download anything you want to keep first (Assets › Download).</Text>
        <TextInput value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} placeholder="Your email" placeholderTextColor={c.muted}
          style={s.input} accessibilityLabel="Type your email to confirm deleting the account" />
        <View style={s.row}>
          <Pressable style={[s.btn, (!ok || busy) && { opacity: 0.5 }]} disabled={!ok || busy} accessibilityRole="button"
            onPress={async () => {
              setBusy(true); setError(null);
              try { await api.deleteAccount(typed.trim()); await supabase.auth.signOut({ scope: "local" }); }
              catch (e) { setError((e as Error).message); }
              setBusy(false);
            }}>
            <Text style={s.btnText}>{busy ? "Deleting everything…" : "Delete my account for good"}</Text>
          </Pressable>
          <Pressable onPress={() => { setOpen(false); setTyped(""); }} accessibilityRole="button"><Text style={s.link}>Keep my account</Text></Pressable>
        </View>
      </>)}
      {error && <Text style={{ color: c.fail }}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.failLine, padding: 16, gap: 8 },
  kicker: { color: c.fail, fontSize: 11, letterSpacing: 0.9 },
  sub: { color: c.sub, fontSize: 13, lineHeight: 19 }, link: { color: c.link, fontSize: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 11, color: c.ink, backgroundColor: c.field, fontSize: 14 },
  btn: { backgroundColor: c.fail, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 }, btnText: { color: "#1A0607", fontWeight: "700" },
  ghost: { borderWidth: 1, borderColor: c.failLine, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: c.field, alignSelf: "flex-start" },
});

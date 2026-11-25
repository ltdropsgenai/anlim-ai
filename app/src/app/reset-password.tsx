// Choose a new password: the page the reset email links to. Supabase signs the creator in from the link
// (recovery session), and updateUser sets the new password. Also reachable from Account to change it. @anlim
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { authFlags, supabase } from "../lib/supabase";
import { c, pageBg } from "../lib/theme";
import { tr, tMsg } from "../lib/i18n";
import { usePageTitle } from "../lib/pageTitle";

export default function ResetPassword() {
  usePageTitle(tr("Choose a new password"));
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ready = password.length >= 8 && password === password2;

  async function save() {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setError(/same/i.test(error.message) ? tr("That is your current password: choose a different one.") : error.message);
    else { authFlags.recovery = false; setDone(true); }
  }

  return (
    <View style={s.page}>
      <View style={s.card}>
        <Text style={s.title}>{tr("Choose a new password")}</Text>
        {done ? (<>
          <Text style={s.notice}>{tr("Your password is changed.")}</Text>
          <Pressable style={s.button} onPress={() => router.replace("/")} accessibilityRole="button"><Text style={s.buttonText}>{tr("Continue")}</Text></Pressable>
        </>) : (<>
          <TextInput style={s.input} placeholder={tr("New password (8 characters or more)")} secureTextEntry autoComplete="new-password"
            placeholderTextColor={c.muted} value={password} onChangeText={setPassword} accessibilityLabel={tr("New password")} />
          <TextInput style={s.input} placeholder={tr("New password again")} secureTextEntry autoComplete="new-password"
            placeholderTextColor={c.muted} value={password2} onChangeText={setPassword2} onSubmitEditing={save} accessibilityLabel={tr("New password again")} />
          {password2.length > 0 && password !== password2 && <Text style={s.hint}>{tr("The passwords don't match.")}</Text>}
          {error && <Text style={s.error}>{tMsg(error)}</Text>}
          <Pressable style={[s.button, (!ready || busy) && { opacity: 0.6 }]} onPress={save} disabled={!ready || busy} accessibilityRole="button">
            {busy ? <ActivityIndicator color={c.onAccent} /> : <Text style={s.buttonText}>{tr("Save new password")}</Text>}
          </Pressable>
        </>)}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, backgroundColor: pageBg },
  card: { width: "100%", maxWidth: 400, backgroundColor: c.card, borderRadius: 14, padding: 24, borderWidth: 1, borderColor: c.line, gap: 12 },
  title: { fontSize: 22, fontWeight: "700", color: c.ink },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 12, fontSize: 16, color: c.ink, backgroundColor: c.field },
  error: { color: c.fail }, hint: { color: c.sub, fontSize: 13 },
  notice: { color: c.ink, backgroundColor: c.passBg, borderRadius: 8, padding: 10 },
  button: { backgroundColor: c.accent, borderRadius: 8, padding: 14, alignItems: "center", marginTop: 4 },
  buttonText: { color: c.onAccent, fontWeight: "600", fontSize: 16 },
});

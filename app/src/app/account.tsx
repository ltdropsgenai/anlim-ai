// Account: who is signed in, connections (ElevenLabs), change password, sign out (this device or everywhere). @anlim
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Link, router } from "expo-router";
import { supabase } from "../lib/supabase";
import { c } from "../lib/theme";
import { Connections } from "../components/Connections";
import { DangerZone } from "../components/DangerZone";
import { PhoneCheck } from "../components/PhoneCheck";
import { api, WelcomeStatus } from "../lib/api";

export default function Account() {
  const [email, setEmail] = useState<string | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState<WelcomeStatus>(null);
  const loadMe = () => api.me().then((m) => setWelcome(m.welcome_status)).catch(() => null);
  useEffect(() => { loadMe(); }, []);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      setSince(data.user?.created_at ? new Date(data.user.created_at).toLocaleDateString() : null);
    });
  }, []);
  async function out(scope: "local" | "global") {
    const { error } = await supabase.auth.signOut({ scope });
    if (error) setError(error.message);
  }
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={s.page}>
      <View style={s.card}>
        <Text style={s.label}>Signed in as</Text>
        <Text style={s.big}>{email ?? " "}</Text>
        {since && <Text style={s.sub}>Creator since {since}</Text>}
      </View>
      {welcome === "needs_phone" && <PhoneCheck onDone={loadMe} />}
      <Connections />
      <View style={s.card}>
        <Pressable style={s.ghost} onPress={() => router.push("/reset-password")} accessibilityRole="button"><Text style={s.ghostText}>Change password</Text></Pressable>
        <Link href="/billing" asChild><Pressable style={s.ghost} accessibilityRole="button"><Text style={s.ghostText}>Credits & plan</Text></Pressable></Link>
        <Pressable style={s.ghost} onPress={() => out("local")} accessibilityRole="button"><Text style={s.ghostText}>Sign out</Text></Pressable>
        <Pressable style={s.ghost} onPress={() => out("global")} accessibilityRole="button">
          <Text style={s.ghostText}>Sign out on every device</Text>
        </Pressable>
        {error && <Text style={s.error}>{error}</Text>}
      </View>
      <View style={[s.card, { flexDirection: "row", gap: 16, flexWrap: "wrap" }]}>
        <Link href="/terms" style={{ color: c.link }}>Terms</Link>
        <Link href="/privacy" style={{ color: c.link }}>Privacy</Link>
        <Link href="/support" style={{ color: c.link }}>Help & contact</Link>
      </View>
      <DangerZone email={email} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 12, maxWidth: 600, width: "100%", alignSelf: "center" },
  card: { backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 16, gap: 8 },
  label: { color: c.sub, fontSize: 13 }, big: { color: c.ink, fontSize: 18, fontWeight: "700" }, sub: { color: c.sub, fontSize: 13 },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: c.field },
  ghostText: { color: c.ink }, error: { color: c.fail },
});

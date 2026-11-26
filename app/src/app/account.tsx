// Account: who is signed in, connections (ElevenLabs), change password, sign out (this device or everywhere). @anlim
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Link, router } from "expo-router";
import { supabase } from "../lib/supabase";
import { c, pageBg } from "../lib/theme";
import { Connections } from "../components/Connections";
import { DangerZone } from "../components/DangerZone";
import { LanguagePicker } from "../components/LanguagePicker";
import { PhoneCheck } from "../components/PhoneCheck";
import { TwoStepCard } from "../components/TwoStep";
import { api, WelcomeStatus } from "../lib/api";
import { tr, locale, trp, tMsg } from "../lib/i18n";

export default function Account() {
  const [email, setEmail] = useState<string | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState<WelcomeStatus>(null);
  const [mail, setMail] = useState<boolean | null>(null);   // "ready" emails (2026-11-23)
  const [ref, setRef] = useState<{ code: string; credits: number; referred_credits?: number; invited: number; rewarded: number } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.myReferral().then(setRef).catch(() => null); }, []);
  const loadMe = () => api.me().then((m) => { setWelcome(m.welcome_status); setMail(m.email_ready !== false); }).catch(() => null);
  // 2026-11-23: how much this account stores (studio.my_storage)
  const [use, setUse] = useState<{ bytes: number; files: number } | null>(null);
  useEffect(() => { loadMe(); api.storageUse().then(setUse).catch(() => null); }, []);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      setSince(data.user?.created_at ? new Date(data.user.created_at).toLocaleDateString(locale()) : null);
    });
  }, []);
  async function out(scope: "local" | "global") {
    const { error } = await supabase.auth.signOut({ scope });
    if (error) setError(error.message);
  }
  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={s.page}>
      <View style={s.card}>
        <Text style={s.label}>{tr("Signed in as")}</Text>
        <Text style={s.big}>{email ?? " "}</Text>
        {since && <Text style={s.sub}>{tr("Creator since {since}", { since })}</Text>}
        {use && <Text style={s.sub}>{trp(use.files, "Storage: {size} in {count} file. Clips that failed or were rejected, discarded frames and old cuts (beyond each scene's 3 newest) are removed after 30 days; everything you keep stays.", "Storage: {size} in {count} files. Clips that failed or were rejected, discarded frames and old cuts (beyond each scene's 3 newest) are removed after 30 days; everything you keep stays.", { size: use.bytes >= 1e9 ? `${(use.bytes / 1e9).toFixed(2)} GB` : `${Math.round(use.bytes / 1e6)} MB`, count: use.files.toLocaleString(locale()) })}</Text>}
      </View>
      {welcome === "needs_phone" && <PhoneCheck onDone={loadMe} />}
      {ref && ref.credits > 0 && (
        <View style={s.card}>
          <Text style={s.label}>{tr("Invite a creator")}</Text>
          <Text style={{ color: c.ink }}>{ref.referred_credits
            ? tr("When someone signs up from your link and buys credits or a plan, you get {mine} credits and they get {theirs} on top of their welcome credits.", { mine: ref.credits.toLocaleString(locale()), theirs: ref.referred_credits.toLocaleString(locale()) })
            : tr("When someone signs up from your link and buys credits or a plan, you get {mine} credits.", { mine: ref.credits.toLocaleString(locale()) })}</Text>
          <Pressable onPress={async () => { try { await navigator.clipboard.writeText(`https://anlim.ai/welcome?ref=${ref.code}`); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* shown anyway */ } }}
            accessibilityRole="button" style={s.ghost}>
            <Text style={s.ghostText} selectable>{copied ? tr("Copied") : `anlim.ai/welcome?ref=${ref.code}`}</Text>
          </Pressable>
          <Text style={s.sub}>{tr("{invited} signed up from your link · {rewarded} earned you credits.", { invited: ref.invited, rewarded: ref.rewarded })}</Text>
        </View>
      )}
      <View style={s.card}>
        <Text style={s.label}>{tr("Language")}</Text>
        <Text style={s.sub}>{tr("The app, your emails, end cards and anlim's messages use it.")}</Text>
        <LanguagePicker signedIn />
      </View>
      <TwoStepCard />
      <Connections />
      {mail !== null && (
        <View style={s.card}>
          <Text style={s.label}>{tr("Emails")}</Text>
          <Pressable onPress={() => { const v = !mail; setMail(v); api.setEmailReady(v).catch((e) => { setMail(!v); setError((e as Error).message); }); }}
            accessibilityRole="switch" accessibilityState={{ checked: mail }} style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <View style={[s.toggle, mail && s.toggleOn]}><View style={[s.knob, mail && { alignSelf: "flex-end" }]} /></View>
            <Text style={{ color: c.ink, flex: 1 }}>{tr("Email me when a clip or a cut I started is ready (or could not be made) while I'm away")}</Text>
          </Pressable>
        </View>
      )}
      <View style={s.card}>
        <Pressable style={s.ghost} onPress={() => router.push("/reset-password")} accessibilityRole="button"><Text style={s.ghostText}>{tr("Change password")}</Text></Pressable>
        <Link href="/billing" asChild><Pressable style={s.ghost} accessibilityRole="button"><Text style={s.ghostText}>{tr("Credits & plan")}</Text></Pressable></Link>
        <Pressable style={s.ghost} onPress={() => out("local")} accessibilityRole="button"><Text style={s.ghostText}>{tr("Sign out")}</Text></Pressable>
        <Pressable style={s.ghost} onPress={() => out("global")} accessibilityRole="button">
          <Text style={s.ghostText}>{tr("Sign out on every device")}</Text>
        </Pressable>
        {error && <Text style={s.error}>{tMsg(error)}</Text>}
      </View>
      <View style={[s.card, { flexDirection: "row", gap: 16, flexWrap: "wrap" }]}>
        <Link href="/terms" style={{ color: c.link }}>{tr("Terms")}</Link>
        <Link href="/privacy" style={{ color: c.link }}>{tr("Privacy")}</Link>
        <Link href="/support" style={{ color: c.link }}>{tr("Help & contact")}</Link>
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
  toggle: { width: 40, height: 22, borderRadius: 11, backgroundColor: c.line, padding: 3, justifyContent: "center" },
  toggleOn: { backgroundColor: c.accent }, knob: { width: 16, height: 16, borderRadius: 8, backgroundColor: c.ink },
});

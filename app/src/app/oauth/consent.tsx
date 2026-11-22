// OAuth consent (2026-11-21): an AI tool (Claude, ChatGPT, any MCP client) asks to use the creator's anlim account
// through mcp.anlim.ai. Supabase Auth's OAuth server sends the creator here with ?authorization_id=...; they approve
// or deny, and Supabase sends them back to the tool. Signed-out visitors sign in first and come back here
// (oauthReturn, read by the root layout). The MCP spec asks the consent screen to show where the browser is sent
// back to (the redirect host), so it is shown. @anlim
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { supabase } from "../../lib/supabase";
import { setOauthReturn } from "../../lib/oauthReturn";
import { c, font, pageBg } from "../../lib/theme";

type Details = { authorization_id: string; redirect_uri: string; client: { id: string; name: string; uri: string; logo_uri: string };
                 user: { id: string; email: string }; scope: string };

export default function Consent() {
  const { authorization_id: id } = useLocalSearchParams<{ authorization_id?: string }>();
  const [d, setD] = useState<Details | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    (async () => {
      if (!id) { setErr("This sign-in link is missing its request. Start the connection again from your AI tool."); return; }
      const { data: s } = await supabase.auth.getSession();
      if (!s.session) { setSignedOut(true); return; }
      const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
      if (error) { setErr(error.message); return; }
      if (!("authorization_id" in data)) { window.location.assign((data as { redirect_url: string }).redirect_url); return; }   // approved before
      setD(data as unknown as Details);
    })().catch((e) => setErr((e as Error).message));
  }, [id]);

  const host = (u?: string) => { try { return u ? new URL(u).host : ""; } catch { return u ?? ""; } };
  async function decide(approve: boolean) {
    if (!id) return;
    setBusy(true); setErr(null);
    const { data, error } = approve ? await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })
                                    : await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    if (error) { setErr(error.message); setBusy(false); return; }
    window.location.assign(data.redirect_url);
  }
  const loopback = d && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host(d.redirect_uri));

  return (
    <View style={[s.page, { backgroundColor: pageBg }]}>
      <View style={s.card}>
        <Text style={[s.small, font.mono]}>ANLIM.AI · CONNECT AN AI TOOL</Text>
        {Platform.OS !== "web" ? <Text style={s.body}>Open this link in a web browser.</Text>
          : signedOut ? (<>
            <Text style={s.title}>Sign in to continue</Text>
            <Text style={s.body}>An AI tool asked to connect to your anlim account. Sign in first; you come back here to approve or deny it.</Text>
            <Pressable style={[s.btn, s.primary]} accessibilityRole="button"
              onPress={() => { setOauthReturn(`/oauth/consent?authorization_id=${encodeURIComponent(id ?? "")}`); router.replace("/login"); }}>
              <Text style={s.primaryText}>Sign in</Text>
            </Pressable>
          </>)
          : !d && !err ? <ActivityIndicator color={c.accent} />
          : d ? (<>
            <Text style={s.title}>{d.client.name || "An AI tool"} wants to use your anlim account</Text>
            <Text style={s.body}>Signed in as {d.user.email}. It will be able to:</Text>
            <Text style={s.li}>• see your projects, your recent clips and your credit balance</Text>
            <Text style={s.li}>• make images and clips with your credits when you ask it to (paid accounts; up to 5 every 10 minutes)</Text>
            <Text style={s.body}>It cannot buy credits, delete anything or change your account. You can disconnect it any time in the AI tool.</Text>
            <Text style={[s.small, { marginTop: 10 }]}>After you choose, you go back to: <Text style={{ color: c.ink }}>{host(d.redirect_uri)}</Text></Text>
            {loopback ? <Text style={[s.small, { color: c.flag }]}>That is a program on this computer. Approve only if you just started the connection yourself.</Text> : null}
            <View style={s.row}>
              <Pressable style={[s.btn, s.primary, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => decide(true)} accessibilityRole="button">
                <Text style={s.primaryText}>Approve</Text>
              </Pressable>
              <Pressable style={[s.btn, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => decide(false)} accessibilityRole="button">
                <Text style={{ color: c.ink, fontWeight: "600" }}>Deny</Text>
              </Pressable>
            </View>
          </>) : null}
        {err ? <Text style={[s.body, { color: c.fail }]}>{err}</Text> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  card: { width: "100%", maxWidth: 520, backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 20, padding: 24, gap: 8 },
  title: { color: c.ink, fontSize: 22, lineHeight: 28, fontWeight: "700" },
  body: { color: c.sub, fontSize: 15, lineHeight: 22 },
  li: { color: c.sub, fontSize: 15, lineHeight: 22, paddingLeft: 6 },
  small: { color: c.muted, fontSize: 12 },
  row: { flexDirection: "row", gap: 10, marginTop: 14 },
  btn: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10, backgroundColor: c.card2 },
  primary: { backgroundColor: c.accent, borderColor: c.accent },
  primaryText: { color: c.onAccent, fontWeight: "700" },
});

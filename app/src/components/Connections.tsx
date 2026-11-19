// Connections (2026-11-19): the creator's own ElevenLabs account, for voiceover, sound effects and generated scores.
// The key is sent once to studio-api, checked with ElevenLabs and kept encrypted (Supabase Vault); the app only ever
// shows its last four characters. @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { api, Connection } from "../lib/api";
import { c, font } from "../lib/theme";

export function Connections() {
  const [conn, setConn] = useState<Connection | null | undefined>(undefined);
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const list = await api.connections(); setConn(list.find((x) => x.provider === "elevenlabs") ?? null); }
    catch (e) { setError((e as Error).message); setConn(null); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); setKey(""); setEditing(false); await load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  const acc = conn?.account;
  return (
    <View style={s.card}>
      <Text style={[s.kicker, font.mono]}>CONNECTIONS</Text>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={[{ color: c.ink, fontSize: 18 }, font.display]}>ElevenLabs</Text>
        {conn && <Text style={[s.badge, conn.status === "ok" ? { color: c.pass, borderColor: c.passLine } : { color: c.fail, borderColor: c.failLine }]}>
          {conn.status === "ok" ? "Connected" : "Key refused"}</Text>}
      </View>
      <Text style={s.sub}>Voiceover, sound effects and generated music scores for your scene cuts, made on your own ElevenLabs account and its credits. anlim charges nothing for them.</Text>
      {conn === undefined && <ActivityIndicator style={{ alignSelf: "flex-start" }} />}
      {conn && !editing && (<>
        <Text style={s.line}>Key <Text style={font.mono}>{conn.key_hint}</Text>{acc?.tier ? ` · ${acc.tier} plan` : ""}
          {acc?.character_limit ? ` · ${(acc.character_count ?? 0).toLocaleString()} of ${acc.character_limit.toLocaleString()} credits used` : ""}</Text>
        {acc?.note && <Text style={s.sub}>{acc.note}</Text>}
        {conn.status === "invalid" && <Text style={{ color: c.fail }}>ElevenLabs refused this key the last time it was used. Paste a new one.</Text>}
        <View style={s.row}>
          <Pressable style={s.ghost} disabled={busy} onPress={() => run(api.checkConnection)} accessibilityRole="button"><Text style={s.ghostText}>Check it</Text></Pressable>
          <Pressable style={s.ghost} disabled={busy} onPress={() => setEditing(true)} accessibilityRole="button"><Text style={s.ghostText}>Use a different key</Text></Pressable>
          <Pressable style={s.ghost} disabled={busy} onPress={() => run(api.disconnect)} accessibilityRole="button"><Text style={[s.ghostText, { color: c.fail }]}>Disconnect</Text></Pressable>
        </View>
      </>)}
      {conn !== undefined && (!conn || editing) && (<>
        <Text style={s.sub}>
          In ElevenLabs, open Developers › API Keys and create a key for anlim. Give it only what anlim uses: Text to Speech,
          Sound Effects, Music and Voices (read), plus User (read) to show your credits here. A credit limit on the key is a good idea.
        </Text>
        <Pressable onPress={() => Linking.openURL("https://elevenlabs.io/app/developers/api-keys")} accessibilityRole="link">
          <Text style={s.link}>Open ElevenLabs API keys</Text>
        </Pressable>
        <TextInput value={key} onChangeText={setKey} placeholder="Paste your ElevenLabs API key" placeholderTextColor={c.muted}
          secureTextEntry autoCapitalize="none" autoCorrect={false} style={s.input} accessibilityLabel="ElevenLabs API key" />
        <View style={s.row}>
          <Pressable style={[s.btn, (!key.trim() || busy) && { opacity: 0.5 }]} disabled={!key.trim() || busy}
            onPress={() => run(() => api.connect(key.trim()))} accessibilityRole="button">
            <Text style={s.btnText}>{busy ? "Checking…" : "Connect"}</Text>
          </Pressable>
          {editing && <Pressable onPress={() => { setEditing(false); setKey(""); }} accessibilityRole="button"><Text style={s.link}>Cancel</Text></Pressable>}
        </View>
        <Text style={s.small}>Your key is stored encrypted and is only used to make audio you ask for. You can disconnect at any time; that deletes it.</Text>
      </>)}
      {error && <Text style={{ color: c.fail }}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 16, gap: 8 },
  kicker: { color: c.sub, fontSize: 11, letterSpacing: 0.9 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, fontSize: 12, fontWeight: "700" },
  sub: { color: c.sub, fontSize: 13, lineHeight: 19 }, small: { color: c.muted, fontSize: 12 }, line: { color: c.ink, fontSize: 14 },
  link: { color: c.link, fontSize: 14 },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 11, color: c.ink, backgroundColor: c.field, fontSize: 14 },
  btn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 }, btnText: { color: c.onAccent, fontWeight: "700" },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 12, backgroundColor: c.field },
  ghostText: { color: c.ink },
});

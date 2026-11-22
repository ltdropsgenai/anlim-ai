// "Next shot · what happens?" director bar: write the movement, get a new shot (2026-11-19 shared by board + Workspace). @anlim
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { api } from "../lib/api";
import { c, font } from "../lib/theme";
import { suggestedSeconds, WALKING } from "../lib/shotStatus";

export function AddShot({ sceneId, onDone, onCreated }: { sceneId: string; onDone: (err?: string) => void; onCreated?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState("");
  const [dur, setDur] = useState("5");
  const [durTouched, setDurTouched] = useState(false);   // once the creator types a number, it stays theirs
  const [busy, setBusy] = useState(false);
  if (!open) return (
    <Pressable onPress={() => setOpen(true)} accessibilityRole="button" style={s.newShot}>
      <Text style={[{ color: c.sub, fontSize: 12, letterSpacing: 0.8 }, font.mono]}>NEXT SHOT · WHAT HAPPENS?</Text>
      <Text style={{ color: c.muted, fontSize: 15, marginTop: 6 }}>Describe the movement, naming each character as on their card…</Text>
    </Pressable>
  );
  const n = Number(dur);
  const ok = action.trim() && Number.isInteger(n) && n >= 3 && n <= 30;
  return (
    <View style={s.form}>
      <Text style={[{ color: c.sub, fontSize: 12, letterSpacing: 0.8 }, font.mono]}>NEXT SHOT · WHAT HAPPENS?</Text>
      <Text style={s.label}>The movement, from the first moment to the last. Name each character as on their card.</Text>
      <TextInput style={s.input} multiline value={action}
        onChangeText={(v) => { setAction(v); if (!durTouched) setDur(String(suggestedSeconds(v))); }}
        placeholderTextColor={c.muted} placeholder="e.g. Sam walks across the room to the window; Ana watches him from the table. Add camera words if you want them (slow push-in, handheld, locked)." />
      <View style={s.row}>
        <Text style={s.label}>Seconds</Text>
        <TextInput style={[s.input, { width: 70, minHeight: 0 }]} value={dur} onChangeText={(v) => { setDur(v); setDurTouched(true); }} keyboardType="number-pad" />
        <Pressable style={[s.btn, !ok && { opacity: 0.5 }]} disabled={!ok || busy} accessibilityRole="button"
          onPress={async () => {
            setBusy(true);
            try { const r = await api.createShot(sceneId, action, n); setAction(""); setOpen(false); setDurTouched(false); onDone(); onCreated ? onCreated(r.id) : router.push({ pathname: "/shot/[id]", params: { id: r.id } }); }
            catch (e) { onDone((e as Error).message); }
            setBusy(false);
          }}>
          <Text style={s.btnText}>Create shot</Text>
        </Pressable>
        <Pressable onPress={() => setOpen(false)} accessibilityRole="button"><Text style={s.link}>Cancel</Text></Pressable>
      </View>
      {WALKING.test(action) && n < 7 ? (
        <Text style={s.meta}>Walks need about 7 seconds: shorter clips tend to end with the character frozen mid-step.</Text>
      ) : null}
    </View>
  );
}


const s = StyleSheet.create({
  newShot: { borderWidth: 1, borderStyle: "dashed", borderColor: "#34343C", backgroundColor: c.field, borderRadius: 18, padding: 18 },
  form: { backgroundColor: c.field, borderRadius: 18, borderWidth: 1, borderColor: "#2A2A31", padding: 18, gap: 10 },
  label: { color: c.sub, fontSize: 13 }, meta: { color: c.sub, fontSize: 11 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 12, minHeight: 60, color: c.ink, backgroundColor: c.bg, fontSize: 15 },
  btn: { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 18 }, btnText: { color: c.onAccent, fontWeight: "700" },
  link: { color: c.link, fontSize: 14, marginVertical: 6 },
});

// Admin console: one account (2026-11-25). What it has, what it did, what admins did to it; block or unblock it and give
// credits. Every action is confirmed with a second press and written to the admin log (studio.admin_log). @anlim
import { ReactNode, useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api, AdminUser } from "../../../lib/api";
import { c, font, pageBg } from "../../../lib/theme";
import { AdminGate, Btn } from "../../../components/AdminGate";
import { ago, detailText, s, when } from "../../../components/adminUi";

export default function AdminUserPage() {
  return <AdminGate><UserView /></AdminGate>;
}

const DURATIONS: [string, number | null][] = [["24 hours", 24], ["7 days", 168], ["30 days", 720], ["Until lifted", null]];

function UserView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [u, setU] = useState<AdminUser | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setErr(null); api.adminUser(String(id)).then(setU).catch((e) => setErr((e as Error).message)); }, [id]);
  useEffect(load, [load]);

  // block / unblock
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState<number | null>(168);
  const [arm, setArm] = useState<string | null>(null);   // which action waits for its confirming press
  // 2026-11-25 (Londi: "the block button ... was not clickable"): buttons no longer grey out while a field is empty; a
  // press says what is missing instead. The first press arms the action, the second ("Confirm …") runs it.
  const run = async (key: string, fn: () => Promise<string>, missing?: string | null) => {
    if (missing) { setArm(null); setMsg(null); setErr(missing); return; }
    if (arm !== key) { setArm(key); setErr(null); return; }
    setArm(null); setBusy(true); setErr(null); setMsg(null);
    try { setMsg(await fn()); load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  // credits
  const [credits, setCredits] = useState("");
  const [note, setNote] = useState("");

  if (err && !u) return <View style={s.page}><Text style={s.err}>{err}</Text></View>;
  if (!u) return <ActivityIndicator style={{ marginTop: 40 }} />;
  const a = u.account ?? {};
  const avail = (a.balance ?? 0) - (a.reserved ?? 0);
  const paid = u.payments.reduce((t, p) => t + p.amount_cents - (p.refunded_cents ?? 0), 0);

  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={s.page}>
      <View style={s.row}>
        <Text style={[s.h1, font.display, { fontSize: 24 }]} selectable>{u.email ?? "(no email)"}</Text>
        {u.role && <Text style={[s.badge, s.badgeOn]}>{u.role.toUpperCase()}</Text>}
        {u.block && <Text style={[s.badge, s.badgeBad]}>BLOCKED</Text>}
        {!u.confirmed && <Text style={s.badge}>EMAIL NOT CONFIRMED</Text>}
      </View>
      <Text style={[s.small, font.mono]} selectable>{u.id}</Text>

      <View style={s.tiles}>
        {([["Credits available", avail.toLocaleString()], ["Paid, net", `$${(paid / 100).toFixed(2)}`], ["Plan", a.plan_id ? `${a.plan_id} (${a.plan_status})` : "none"],
           ["Projects", u.counts.projects], ["Clips", `${u.counts.clips} (${u.counts.clips_failed} failed)`], ["Images", u.counts.images],
           ["Working now", u.counts.in_flight], ["Connector calls, 7 d", u.counts.mcp_calls_7d]] as [string, string | number][]).map(([k, v]) => (
          <View key={k} style={s.tile}><Text style={[s.tileN, font.mono, { fontSize: 18 }]}>{v}</Text><Text style={s.small}>{k}</Text></View>
        ))}
      </View>
      <Text style={s.sub}>
        Joined {when(u.created_at)} · last sign-in {ago(u.last_sign_in_at)} · last seen in the app {ago(a.last_seen_at as string | null)}
        {a.debt ? ` · owes ${a.debt} credits` : ""}{u.mfa ? " · two-step code on" : ""}{a.language ? ` · language ${a.language}` : ""}
      </Text>

      {msg && <Text style={s.ok}>{msg}</Text>}
      {err && <Text style={s.err}>{err}</Text>}

      {/* block */}
      <View style={s.card}>
        <Text style={s.h2}>{u.block ? "Blocked" : "Block this account"}</Text>
        {u.block ? (<>
          <Text style={s.cell}>
            Since {when(u.block.blocked_at)}{u.block.by_email ? ` by ${u.block.by_email}` : ""} · {u.block.until ? `until ${when(u.block.until)}` : "until lifted"}
          </Text>
          <Text style={s.cell}>Reason: {u.block.reason}</Text>
          <Text style={s.label}>Note (optional)</Text>
          <TextInput value={reason} onChangeText={setReason} placeholder="Note for the log (optional)" placeholderTextColor={c.muted} style={s.input} />
          <Btn label={arm === "unblock" ? "Confirm unblock" : "Unblock"} disabled={busy}
            onPress={() => run("unblock", async () => { const r = await api.adminUnblock(u.id, reason); setReason(""); return r.warning ?? "Unblocked. They can sign in again."; })} />
        </>) : u.role ? (
          <Text style={s.sub}>Admins cannot be blocked. The owner removes them from the admins first (Admins tab).</Text>
        ) : (<>
          <Text style={s.sub}>
            A blocked account cannot sign in, its open sessions end, and it cannot make, upload, buy or use the AI-tool connector.
            Work already queued finishes. It does not cancel a plan: if they have one, cancel it in Stripe.
            {a.subscription ? " This account has a plan subscription." : ""}
          </Text>
          <Text style={s.label}>Reason</Text>
          <TextInput value={reason} onChangeText={setReason} placeholder="Why you are blocking them (kept in the log; not shown to them)" placeholderTextColor={c.muted} style={s.input} />
          <Text style={s.label}>How long</Text>
          <View style={s.row}>
            {DURATIONS.map(([label, h]) => (
              <Pressable key={label} onPress={() => setHours(h)} style={[s.chip, hours === h && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: hours === h }}>
                <Text style={{ color: hours === h ? c.onAccent : c.ink, fontWeight: "600", fontSize: 13 }}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <Btn label={arm === "block" ? "Confirm block" : "Block"} tone="danger" disabled={busy}
            onPress={() => run("block", async () => { const r = await api.adminBlock(u.id, reason, hours); setReason("");
              return r.warning ?? (r.until ? `Blocked until ${when(r.until)}.` : "Blocked until lifted."); },
              reason.trim() ? null : "Type a reason first (it goes in the log).")} />
          {arm === "block" && <Text style={s.sub}>Press Confirm block to block {u.email}.</Text>}
        </>)}
      </View>

      {/* credits */}
      <View style={s.card}>
        <Text style={s.h2}>Give credits</Text>
        <Text style={s.sub}>For support (a failed job, goodwill). 1 to 20,000 at a time; recorded in their credit history as a grant.</Text>
        <View style={s.row}>
          <TextInput value={credits} onChangeText={(t) => setCredits(t.replace(/\D/g, "").slice(0, 5))} placeholder="Credits" placeholderTextColor={c.muted}
            keyboardType="number-pad" style={[s.input, { width: 110 }]} accessibilityLabel="Credits to give" />
          <TextInput value={note} onChangeText={setNote} placeholder="Reason" placeholderTextColor={c.muted} style={[s.input, { flex: 1, minWidth: 200 }]} accessibilityLabel="Reason" />
          <Btn label={arm === "grant" ? `Confirm ${credits || 0} credits` : "Give"} disabled={busy}
            onPress={() => run("grant", async () => { const r = await api.adminGrant(u.id, Number(credits), note); setCredits(""); setNote("");
              return `Done. Balance is now ${r.balance.toLocaleString()} credits.`; },
              !Number(credits) ? "Enter how many credits to give." : !note.trim() ? "Type a reason first (it goes in the log)." : null)} />
        </View>
      </View>

      <Section title={`Recent work (${u.jobs.length})`} empty="No work yet.">
        {u.jobs.map((j) => (
          <View key={j.kind + j.id} style={s.line}>
            <Text style={[s.small, font.mono]}>{when(j.created_at)} · {j.kind}{j.detail ? ` · ${j.detail}` : ""} · {j.status}{j.credits ? ` · ${j.credits} cr` : ""}</Text>
            {!!j.error && <Text style={[s.cell, { color: c.fail }]} selectable>{j.error}</Text>}
          </View>
        ))}
      </Section>
      <Section title="Credit history (latest 30)" empty="None.">
        {u.ledger.map((l, i) => (
          <Text key={i} style={[s.small, font.mono]}>{when(l.created_at)} · {l.kind} · {l.credits > 0 && l.kind !== "reserve" && l.kind !== "charge" ? "+" : ""}{l.credits}{l.note ? ` · ${l.note}` : ""}</Text>
        ))}
      </Section>
      <Section title="Payments" empty="Never paid.">
        {u.payments.map((p, i) => (
          <Text key={i} style={[s.small, font.mono]}>{when(p.at)} · {p.plan_id ?? "?"} · ${(p.amount_cents / 100).toFixed(2)} · {p.credits} cr{p.refunded_cents ? ` · refunded $${(p.refunded_cents / 100).toFixed(2)}` : ""}</Text>
        ))}
      </Section>
      <Section title="Refund requests" empty="None.">
        {u.refunds.map((r) => (
          <Text key={r.id} style={[s.small, font.mono]}>{when(r.created_at)} · {r.status} · {r.credits} cr · {(r.reasons || []).join(", ")}</Text>
        ))}
      </Section>
      <Section title="Errors they hit" empty="None.">
        {u.errors.map((e, i) => (
          <View key={i} style={s.line}>
            <Text style={[s.small, font.mono]}>{when(e.at)} · {e.source} · {e.place ?? "?"}</Text>
            <Text style={s.cell} selectable>{e.message}</Text>
          </View>
        ))}
      </Section>
      <Section title="Admin actions on this account" empty="None.">
        {u.log.map((l, i) => (
          <Text key={i} style={s.cell}>{when(l.at)} · {l.admin_email ?? "?"} · {l.action}{detailText(l.detail)}</Text>
        ))}
      </Section>
    </ScrollView>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <View style={s.card}>
      <Text style={s.h2}>{title}</Text>
      {children.length === 0 ? <Text style={s.sub}>{empty}</Text> : children}
    </View>
  );
}

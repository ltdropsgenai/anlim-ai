// Admin console (2026-11-25, Londi: "a true Admin panel for me to manage users and app issues ... accessible to only one
// true admin account ... able to add new admin accounts, be able to block/ban users"). Overview, Users, Issues, Admins
// (only the owner adds or removes them) and the Log of every admin action. Behind AdminGate (two-step code).
// Data: studio.admin_* functions through studio-api (migration studio_admin_console). @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { api, AdminEntry, AdminIssues, AdminLogEntry, AdminOverview, AdminUserRow } from "../../lib/api";
import { c, font, pageBg } from "../../lib/theme";
import { AdminGate, Btn } from "../../components/AdminGate";
import { ago, detailText, s, when } from "../../components/adminUi";

type Tab = "overview" | "users" | "issues" | "admins" | "log";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "users", label: "Users" }, { id: "issues", label: "Issues" },
  { id: "admins", label: "Admins" }, { id: "log", label: "Log" },
];
const openUser = (id: string) => router.push(`/admin/user/${id}` as never);

export default function AdminPage() {
  return <AdminGate><Console /></AdminGate>;
}

function Console() {
  const [tab, setTab] = useState<Tab>("overview");
  const [ov, setOv] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadOv = useCallback(() => { api.adminOverview().then(setOv).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(loadOv, [loadOv]);

  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={s.page}>
      <View style={s.row}>
        <Text style={[s.h1, font.display]}>Admin console</Text>
        {ov && <Text style={[s.badge, ov.role === "owner" && s.badgeOn]}>{ov.role === "owner" ? "OWNER" : "ADMIN"}</Text>}
      </View>
      <View style={s.row} accessibilityRole="tablist">
        {TABS.map((t) => (
          <Pressable key={t.id} onPress={() => setTab(t.id)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.id }}
            style={[s.chip, tab === t.id && s.chipOn]}>
            <Text style={{ color: tab === t.id ? c.onAccent : c.ink, fontWeight: "600" }}>
              {t.label}{t.id === "issues" && ov && ov.failed_24h + ov.errors_24h > 0 ? ` · ${ov.failed_24h + ov.errors_24h}` : ""}
            </Text>
          </Pressable>
        ))}
      </View>
      {err && <Text style={s.err}>{err}</Text>}
      {tab === "overview" && <Overview ov={ov} reload={loadOv} go={setTab} />}
      {tab === "users" && <Users />}
      {tab === "issues" && <Issues />}
      {tab === "admins" && <Admins owner={ov?.role === "owner"} />}
      {tab === "log" && <Log />}
    </ScrollView>
  );
}

function Overview({ ov, reload, go }: { ov: AdminOverview | null; reload: () => void; go: (t: Tab) => void }) {
  if (!ov) return <ActivityIndicator style={{ marginTop: 30 }} />;
  const tiles: [string, number, (() => void) | null][] = [
    ["Accounts", ov.users, () => go("users")], ["New, last 7 days", ov.new_7d, () => go("users")], ["Active, last 7 days", ov.active_7d, () => go("users")],
    ["Ever paid", ov.paying, () => go("users")], ["Blocked", ov.blocked, () => go("users")], ["Admins", ov.admins, () => go("admins")],
    ["Work in progress", ov.in_flight, () => go("issues")], ["Failed, last 24 h", ov.failed_24h, () => go("issues")],
    ["App errors, last 24 h", ov.errors_24h, () => go("issues")], ["Refund requests waiting", ov.refunds_pending, () => router.navigate("/refunds" as never)],
  ];
  return (<>
    <View style={s.tiles}>
      {tiles.map(([label, n, onPress]) => (
        <Pressable key={label} onPress={onPress ?? undefined} style={s.tile} accessibilityRole="button">
          <Text style={[s.tileN, font.mono]}>{n.toLocaleString()}</Text>
          <Text style={s.small}>{label}</Text>
        </Pressable>
      ))}
    </View>
    <View style={s.row}>
      <Btn label="Refresh" tone="plain" onPress={reload} />
      <Btn label="Refund requests" tone="plain" onPress={() => router.navigate("/refunds" as never)} />
      <Btn label="Insights (funnel, page views)" tone="plain" onPress={() => router.navigate("/insights" as never)} />
    </View>
    <Text style={s.small}>Health alerts email sysadmin@codeascent.online every 15 minutes when work stalls, gets stuck, fails in a burst or a provider refuses for money.</Text>
  </>);
}

const FILTERS = [["all", "All"], ["active", "Active 7 d"], ["paying", "Paid"], ["blocked", "Blocked"], ["admins", "Admins"]] as const;
function Users() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [items, setItems] = useState<AdminUserRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback((offset = 0) => {
    setErr(null); if (!offset) setItems(null);
    api.adminUsers(q, filter, offset).then((r) => { setTotal(r.total); setItems((prev) => (offset && prev ? [...prev, ...r.items] : r.items)); })
      .catch((e) => setErr((e as Error).message));
  }, [q, filter]);
  useEffect(() => { const t = setTimeout(() => load(0), 250); return () => clearTimeout(t); }, [load]);
  return (<>
    <View style={s.row}>
      <TextInput value={q} onChangeText={setQ} placeholder="Search by email or account id" placeholderTextColor={c.muted}
        style={[s.input, { flex: 1, minWidth: 220 }]} autoCapitalize="none" accessibilityLabel="Search accounts" />
      {FILTERS.map(([id, label]) => (
        <Pressable key={id} onPress={() => setFilter(id)} style={[s.chip, filter === id && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: filter === id }}>
          <Text style={{ color: filter === id ? c.onAccent : c.ink, fontWeight: "600", fontSize: 13 }}>{label}</Text>
        </Pressable>
      ))}
    </View>
    {err && <Text style={s.err}>{err}</Text>}
    {!items && !err && <ActivityIndicator style={{ marginTop: 20 }} />}
    {items && <Text style={s.small}>{total} account{total === 1 ? "" : "s"}</Text>}
    {items?.map((u) => (
      <Pressable key={u.id} onPress={() => openUser(u.id)} style={({ hovered }: { hovered?: boolean }) => [s.card, s.userRow, hovered && { backgroundColor: c.card2 }]}
        accessibilityRole="link" accessibilityLabel={`Open ${u.email ?? u.id}`}>
        <View style={{ flex: 1, minWidth: 220, gap: 3 }}>
          <View style={s.row}>
            <Text style={s.email} numberOfLines={1}>{u.email ?? "(no email)"}</Text>
            {u.role && <Text style={[s.badge, s.badgeOn]}>{u.role.toUpperCase()}</Text>}
            {u.blocked && <Text style={[s.badge, s.badgeBad]}>BLOCKED{u.block_until ? ` until ${new Date(u.block_until).toLocaleDateString()}` : ""}</Text>}
            {!u.confirmed && <Text style={s.badge}>UNCONFIRMED</Text>}
          </View>
          <Text style={s.small}>Joined {when(u.created_at)} · seen {ago(u.last_seen_at ?? u.last_sign_in_at)}</Text>
        </View>
        <Text style={[s.cell, font.mono]}>{((u.balance ?? 0) - (u.reserved ?? 0)).toLocaleString()} cr</Text>
        <Text style={[s.cell, font.mono]}>${(u.paid_cents / 100).toFixed(2)}</Text>
        <Text style={[s.cell, font.mono]}>{u.clips} clips{u.failed ? ` · ${u.failed} failed` : ""}</Text>
      </Pressable>
    ))}
    {items && items.length < total && <Btn label="Show more" tone="plain" onPress={() => load(items.length)} />}
  </>);
}

function Issues() {
  const [d, setD] = useState<AdminIssues | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { setD(null); setErr(null); api.adminIssues().then(setD).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(load, [load]);
  if (err) return <Text style={s.err}>{err}</Text>;
  if (!d) return <ActivityIndicator style={{ marginTop: 20 }} />;
  return (<>
    <Btn label="Refresh" tone="plain" onPress={load} />
    <View style={s.card}>
      <Text style={s.h2}>Waiting too long</Text>
      <Text style={s.sub}>Queued for more than 10 minutes, or running with no progress for more than 75. Usually means the worker is down.</Text>
      {d.waiting.length === 0 && <Text style={s.ok}>Nothing stuck.</Text>}
      {d.waiting.map((w) => (
        <IssueRow key={w.kind + w.id} head={`${w.kind} · ${w.status} · since ${ago(w.since)}`} email={w.email} owner={w.owner} body={w.error} />
      ))}
    </View>
    <View style={s.card}>
      <Text style={s.h2}>Failed in the last 48 hours ({d.failed.length})</Text>
      {d.failed.length === 0 && <Text style={s.ok}>No failures.</Text>}
      {d.failed.map((f) => (
        <IssueRow key={f.kind + f.id} head={`${f.kind}${f.detail ? ` · ${f.detail}` : ""} · ${ago(f.at)}`} email={f.email} owner={f.owner} body={f.error} />
      ))}
    </View>
    <View style={s.card}>
      <Text style={s.h2}>App and server errors, last 24 hours</Text>
      {d.errors.length === 0 && <Text style={s.ok}>None.</Text>}
      {d.errors.map((e, i) => (
        <View key={i} style={s.line}>
          <Text style={[s.small, font.mono]}>{e.source} · {e.place || "?"} · {e.n}× · {e.accounts} account{e.accounts === 1 ? "" : "s"} · last {ago(e.last)}</Text>
          <Text style={s.cell} selectable>{e.message}</Text>
        </View>
      ))}
    </View>
    <View style={s.card}>
      <Text style={s.h2}>Refund requests waiting: {d.refunds_pending}</Text>
      <Btn label="Open refund requests" tone="plain" onPress={() => router.navigate("/refunds" as never)} />
    </View>
  </>);
}

function IssueRow({ head, email, owner, body }: { head: string; email: string | null; owner: string; body: string | null }) {
  return (
    <View style={s.line}>
      <View style={s.row}>
        <Text style={[s.small, font.mono]}>{head}</Text>
        <Pressable onPress={() => openUser(owner)} accessibilityRole="link"><Text style={s.link}>{email ?? owner}</Text></Pressable>
      </View>
      {!!body && <Text style={s.cell} selectable>{body}</Text>}
    </View>
  );
}

function Admins({ owner }: { owner: boolean }) {
  const [items, setItems] = useState<AdminEntry[] | null>(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = useCallback(() => { api.adminAdmins().then(setItems).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(load, [load]);
  const add = async () => {
    setErr(null); setMsg(null);
    try { await api.adminAdd(email.trim()); setMsg(`${email.trim()} is now an admin. They need the two-step code to open this console.`); setEmail(""); load(); }
    catch (e) { setErr((e as Error).message); }
  };
  const remove = async (a: AdminEntry) => {
    if (confirm !== a.user_id) { setConfirm(a.user_id); return; }
    setConfirm(null); setErr(null); setMsg(null);
    try { await api.adminRemove(a.user_id); setMsg(`${a.email} is no longer an admin.`); load(); } catch (e) { setErr((e as Error).message); }
  };
  return (<>
    <View style={s.card}>
      <Text style={s.h2}>Admins</Text>
      <Text style={s.sub}>Admins can see every account, block and unblock accounts, give credits and decide refund requests.
        Only the owner adds or removes admins, and the owner cannot be removed or blocked.</Text>
      {!items && !err && <ActivityIndicator />}
      {items?.map((a) => (
        <View key={a.user_id} style={[s.line, s.row]}>
          <Pressable onPress={() => openUser(a.user_id)} style={{ flex: 1, minWidth: 200 }} accessibilityRole="link">
            <Text style={s.email}>{a.email}</Text>
            <Text style={s.small}>Added {when(a.added_at)}{a.added_by ? ` by ${a.added_by}` : ""}</Text>
          </Pressable>
          <Text style={[s.badge, a.role === "owner" && s.badgeOn]}>{a.role.toUpperCase()}</Text>
          <Text style={[s.badge, !a.mfa && s.badgeBad]}>{a.mfa ? "2-STEP ON" : "2-STEP NOT SET UP"}</Text>
          {owner && a.role !== "owner" && (
            <Btn label={confirm === a.user_id ? "Confirm remove" : "Remove"} tone="danger" onPress={() => remove(a)} />
          )}
        </View>
      ))}
    </View>
    {owner ? (
      <View style={s.card}>
        <Text style={s.h2}>Add an admin</Text>
        <Text style={s.sub}>The person signs up on anlim.ai first; then add them by that account's email.</Text>
        <View style={s.row}>
          <TextInput value={email} onChangeText={setEmail} placeholder="name@example.com" placeholderTextColor={c.muted}
            style={[s.input, { flex: 1, minWidth: 220 }]} autoCapitalize="none" keyboardType="email-address" onSubmitEditing={add} accessibilityLabel="Email of the new admin" />
          <Btn label="Add admin" onPress={add} />
        </View>
      </View>
    ) : <Text style={s.small}>Only the owner can add or remove admins.</Text>}
    {msg && <Text style={s.ok}>{msg}</Text>}
    {err && <Text style={s.err}>{err}</Text>}
  </>);
}

const ACTION: Record<string, string> = { block: "Blocked", unblock: "Unblocked", grant_credits: "Gave credits", add_admin: "Added admin", remove_admin: "Removed admin" };
function Log() {
  const [items, setItems] = useState<AdminLogEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const load = useCallback((before?: number) => {
    api.adminLog(before).then((r) => { setMore(r.length >= 100); setItems((p) => (before && p ? [...p, ...r] : r)); }).catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => load(), [load]);
  if (err) return <Text style={s.err}>{err}</Text>;
  if (!items) return <ActivityIndicator style={{ marginTop: 20 }} />;
  return (
    <View style={s.card}>
      <Text style={s.h2}>Every admin action</Text>
      {items.length === 0 && <Text style={s.sub}>Nothing yet.</Text>}
      {items.map((l) => (
        <View key={l.id} style={s.line}>
          <Text style={[s.small, font.mono]}>{when(l.at)} · {l.admin_email ?? "?"}</Text>
          <Text style={s.cell}>
            {ACTION[l.action] ?? l.action}{" "}
            {l.target && <Text style={s.link} onPress={() => openUser(l.target!)}>{l.target_email ?? l.target}</Text>}
            {detailText(l.detail)}
          </Text>
        </View>
      ))}
      {more && items.length > 0 && <Btn label="Older" tone="plain" onPress={() => load(items[items.length - 1].id)} />}
    </View>
  );
}

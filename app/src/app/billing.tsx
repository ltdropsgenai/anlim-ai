// Credits & plan: what the creator has (plan credits this month + purchased credits), monthly/annual plans,
// one-time packs, and the Stripe billing portal for changing or cancelling the plan. Payment itself happens on
// Stripe's own pages (Checkout); the credits arrive when Stripe tells the backend the payment went through. @anlim
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, Billing, PricePlan } from "../lib/api";
import { c, font, pageBg } from "../lib/theme";
import { tr, locale, trp, tMsg, trMap } from "../lib/i18n";

const usd = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const SHORT_CREDITS = 1650;   // one mixed Short ≈ $6.44 cost ≈ 1,650 credits (design doc rev 82)
const STATUS: Record<string, string> = trMap({
  active: "active", trialing: "trial", past_due: "payment failed: update your card to get next month's credits",
  canceled: "cancelled", unpaid: "unpaid", incomplete: "waiting for the first payment",
});
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale(), { month: "short", day: "numeric", year: "numeric" }) : "");

function go(url: string) {
  if (Platform.OS === "web") window.location.assign(url); else Linking.openURL(url);
}
function here() {
  return Platform.OS === "web" ? window.location.origin + "/billing" : "http://localhost:8081/billing";
}

export default function BillingScreen() {
  const params = useLocalSearchParams<{ paid?: string; cancelled?: string }>();
  const [b, setB] = useState<Billing | null>(null);
  const [yearly, setYearly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitTries, setWaitTries] = useState(0);

  const load = useCallback(async () => {
    try { setB(await api.billing()); setError(null); } catch (e) { setError((e as Error).message); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  // back from Stripe: the credits arrive with Stripe's webhook, usually within seconds; check a few times
  useEffect(() => {
    if (!params.paid || waitTries >= 10) return;
    const t = setTimeout(() => { load(); setWaitTries((n) => n + 1); }, 3000);
    return () => clearTimeout(t);
  }, [params.paid, waitTries, load]);

  async function start(key: string, fn: () => Promise<{ url: string }>) {
    setBusy(key); setError(null);
    try { go((await fn()).url); } catch (e) { setError((e as Error).message); setBusy(null); }
  }

  if (!b) return error ? <Text style={[s.err, { padding: 16 }]}>{tMsg(error)}</Text> : <ActivityIndicator style={{ marginTop: 40 }} />;
  const a = b.account, available = a ? a.balance - a.reserved : 0;
  const hasPlan = !!a?.plan_status && ["active", "trialing", "past_due"].includes(a.plan_status);
  const current = b.plans.find((p) => p.id === a?.plan_id);
  const plans = b.plans.filter((p) => p.kind === "plan" && p.billing_interval === (yearly ? "year" : "month"));
  const monthlyOf = (p: PricePlan) => b.plans.find((x) => x.kind === "plan" && x.tier === p.tier && x.billing_interval === "month");
  const packs = b.plans.filter((p) => p.kind === "pack");

  return (
    <ScrollView style={{ backgroundColor: pageBg }} contentContainerStyle={s.page}>
      {!b.ready && <Text style={[s.note, { color: c.flag }]}>{tr("Purchases open soon.")}</Text>}
      {b.ready && b.mode === "test" && <Text style={s.note}>{tr("Test account: checkout uses the Stripe sandbox (no real charge).")}</Text>}
      {params.paid && <Text style={[s.note, { color: c.pass }]}>
        {waitTries < 10 ? tr("Payment received by Stripe. Your credits appear here in a few seconds…") : tr("Payment received by Stripe. If the credits are not here yet, refresh in a minute.")}</Text>}
      {params.cancelled && <Text style={s.note}>{tr("Checkout cancelled: nothing was charged.")}</Text>}
      {error && <Text style={s.err}>{tMsg(error)}</Text>}

      <View style={s.card}>
        <Text style={s.big}>{tr("{n} credits available", { n: available.toLocaleString(locale()) })}</Text>
        <Text style={s.sub}>
          {[a?.plan_credits ? tr("{n} from your plan this month (used first; they end {day})", { n: a.plan_credits.toLocaleString(locale()), day: day(a.plan_next_refresh) }) : null,
            tr("{n} bought (never expire)", { n: ((a?.balance ?? 0) - (a?.plan_credits ?? 0)).toLocaleString(locale()) }),
            a?.reserved ? tr("{n} held for work in progress", { n: a.reserved.toLocaleString(locale()) }) : null].filter(Boolean).join(" · ")}</Text>
        {hasPlan && current && (<>
          <Text style={s.title}>{current.billing_interval === "year" ? tr("{name} plan, billed yearly: {status}", { name: current.name, status: STATUS[a!.plan_status!] ?? a!.plan_status ?? "" })
            : tr("{name} plan, billed monthly: {status}", { name: current.name, status: STATUS[a!.plan_status!] ?? a!.plan_status ?? "" })}</Text>
          <Text style={s.sub}>
            {a!.plan_cancel_at_period_end ? tr("Cancelled: ends {v0}. Your plan credits stay until then; you can undo it in Manage plan.", { v0: day(a!.plan_cancel_at ?? a!.plan_period_end) }) : tr("Renews {v0}.", { v0: day(a!.plan_period_end) })}
            {current.billing_interval === "year" ? " " + tr("{n} credits arrive each month.", { n: current.credits.toLocaleString(locale()) }) : ""}
          </Text>
        </>)}
        {a?.has_customer && (
          <Pressable style={s.ghost} disabled={!!busy} accessibilityRole="button" onPress={() => start("portal", () => api.portal(here()))}>
            <Text style={{ color: c.ink }}>{busy === "portal" ? tr("Opening…") : hasPlan ? tr("Manage plan, card and invoices") : tr("Card and invoices")}</Text>
          </Pressable>
        )}
      </View>

      <View style={s.headRow}>
        <Text style={[s.h, font.display]}>{tr("Plans")}</Text>
        <View style={s.toggle}>
          {[false, true].map((y) => (
            <Pressable key={String(y)} onPress={() => setYearly(y)} style={[s.tab, yearly === y && s.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: yearly === y }}>
              <Text style={yearly === y ? { color: c.onAccent, fontWeight: "600" } : { color: c.ink }}>{y ? tr("Yearly · save 20%") : tr("Monthly")}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Text style={s.sub}>{tr("Plan credits are the cheapest credits. They are given every month (yearly plans too) and end at the end of the month; they are spent before bought credits.")}</Text>
      <View style={s.grid}>
        {plans.map((p) => {
          const perMonth = p.billing_interval === "year" ? p.price_cents / 12 : p.price_cents, m = monthlyOf(p);
          const isCurrent = hasPlan && current?.id === p.id;
          return (
            <View key={p.id} style={[s.card, s.cell, isCurrent && { borderColor: c.accent, borderWidth: 2 }]}>
              <Text style={s.title}>{p.name}</Text>
              <Text style={s.price}>{usd(perMonth)}<Text style={s.sub}>{tr(" / month")}</Text></Text>
              {p.billing_interval === "year" && <Text style={s.sub}>{m ? tr("{price} billed yearly (instead of {full})", { price: usd(p.price_cents), full: usd(m.price_cents * 12) }) : tr("{price} billed yearly", { price: usd(p.price_cents) })}</Text>}
              <Text style={s.line}>{tr("{v0} credits every month", { v0: p.credits.toLocaleString(locale()) })}</Text>
              <Text style={s.sub}>{trp(Math.max(1, Math.floor(p.credits / SHORT_CREDITS)), "≈ {n} Short a month · {cents}¢ per credit", "≈ {n} Shorts a month · {cents}¢ per credit", { cents: (perMonth / p.credits).toFixed(2) })}</Text>
              {isCurrent ? <Text style={[s.badge, { color: c.accent, borderColor: c.accent }]}>{tr("Your plan")}</Text>
                : hasPlan ? <Text style={s.sub}>{tr("Switch from \"Manage plan\".")}</Text>
                : (
                  <Pressable style={[s.btn, (!b.ready || !!busy) && { opacity: 0.5 }]} disabled={!b.ready || !!busy} accessibilityRole="button"
                    onPress={() => start(p.id, () => api.checkout(p.id, here()))}>
                    <Text style={s.btnText}>{busy === p.id ? tr("Opening Stripe…") : tr("Choose {name}", { name: p.name })}</Text>
                  </Pressable>
                )}
            </View>
          );
        })}
      </View>

      <Text style={[s.h, font.display]}>{tr("Credit packs")}</Text>
      <Text style={s.sub}>{tr("One-time top-ups at 1¢ per credit. Bought credits never expire.")}</Text>
      <View style={s.grid}>
        {packs.map((p) => (
          <View key={p.id} style={[s.card, s.cell]}>
            <Text style={s.title}>{tr("{v0} credits", { v0: p.credits.toLocaleString(locale()) })}</Text>
            <Text style={s.price}>{usd(p.price_cents)}</Text>
            <Pressable style={[s.btn, (!b.ready || !!busy) && { opacity: 0.5 }]} disabled={!b.ready || !!busy} accessibilityRole="button"
              onPress={() => start(p.id, () => api.checkout(p.id, here()))}>
              <Text style={s.btnText}>{busy === p.id ? tr("Opening Stripe…") : tr("Buy")}</Text>
            </Pressable>
          </View>
        ))}
      </View>
      <Text style={[s.sub, { marginTop: 16 }]}>{tr("A 5-second clip costs 75 credits (MiniMax) or 200 (Kling); a made start or end frame 20.")}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, maxWidth: 1000, width: "100%", alignSelf: "center", gap: 8 },
  h: { fontSize: 18, fontWeight: "700", color: c.ink, marginTop: 18 },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 },
  big: { fontSize: 22, fontWeight: "700", color: c.ink },
  title: { color: c.ink, fontWeight: "700", fontSize: 16 },
  price: { color: c.ink, fontWeight: "700", fontSize: 26 },
  line: { color: c.ink, fontWeight: "600" },
  sub: { color: c.sub, fontSize: 13 }, note: { color: c.sub, marginBottom: 4 },
  err: { color: c.fail, marginBottom: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 14, gap: 6 },
  cell: { flexGrow: 1, flexBasis: 240, minWidth: 0 },
  toggle: { flexDirection: "row", borderWidth: 1, borderColor: c.line, borderRadius: 999, overflow: "hidden", backgroundColor: c.field },
  tab: { paddingHorizontal: 14, paddingVertical: 7 }, tabOn: { backgroundColor: c.accent },
  btn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: "center", marginTop: 6 },
  btnText: { color: c.onAccent, fontWeight: "600" },
  ghost: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14, alignItems: "center", backgroundColor: c.field, alignSelf: "flex-start", marginTop: 6 },
  badge: { alignSelf: "flex-start", borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, fontSize: 12, fontWeight: "600", marginTop: 6 },
});

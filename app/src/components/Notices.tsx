// Notices when work finishes while the creator is elsewhere in the app (2026-11-19): a clip ready to review, a frame
// to approve, a cut or a piece of audio done, or something that failed. Polls studio-api "activity" every 20 s while
// the page is visible; only things that finish after the app opened are announced. @anlim
import { useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Activity, api } from "../lib/api";
import { c, font } from "../lib/theme";
import { tr, tMsg } from "../lib/i18n";

type Notice = { key: string; text: string; tone: "ok" | "bad"; go: () => void };

function toNotice(a: Activity): Notice {
  const shot = a.ord != null ? `Shot ${a.ord} of ${a.scene_title}` : a.scene_title;
  const bad = a.status === "failed";
  if (a.kind === "clip") return { key: a.id + a.status, tone: bad ? "bad" : "ok",
    text: bad ? tr("{shot}: the render didn't work", { shot }) : tr("{shot} is ready to review", { shot }),
    go: () => bad ? router.navigate({ pathname: "/shot/[id]", params: { id: a.shot_id! } }) : router.navigate({ pathname: "/clip/[id]", params: { id: a.id } }) };
  if (a.kind === "frame") return { key: a.id + a.status, tone: bad ? "bad" : "ok",
    text: bad ? tr("{shot}: a frame couldn't be made", { shot }) : tr("{shot}: a new frame is ready to approve", { shot }),
    go: () => router.navigate({ pathname: "/shot/[id]", params: { id: a.shot_id! } }) };
  if (a.kind === "cut") return { key: a.id + a.status, tone: bad ? "bad" : "ok",
    text: bad ? tr("The cut of {scene_title} didn't work", { scene_title: a.scene_title }) : tr("The cut of {scene_title} is ready", { scene_title: a.scene_title }),
    go: () => router.navigate({ pathname: "/cut/[scene]", params: { scene: a.scene_id } }) };
  return { key: a.id + a.status, tone: bad ? "bad" : "ok",
    text: bad ? tr("{shot}: audio couldn't be made", { shot }) : tr("{shot}: audio is ready", { shot }),
    go: () => router.navigate({ pathname: "/cut/[scene]", params: { scene: a.scene_id } }) };
}

// Messages from anlim that stay until read (2026-11-20: refund confirmed / reversed): shown on top, dismissed on click.
type Sticky = { id: string; title: string; body: string | null; link: string | null };

export function Notices() {
  const [list, setList] = useState<Notice[]>([]);
  const [sticky, setSticky] = useState<Sticky[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.notifications().then((n) => alive && setSticky(n.slice(0, 3))).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const dismiss = (n: Sticky, go: boolean) => {
    setSticky((l) => l.filter((x) => x.id !== n.id));
    api.readNotifications([n.id]).catch(() => {});
    if (go && n.link) router.navigate(n.link as never);
  };
  const since = useRef(Date.now());
  const seen = useRef(new Set<string>());
  useEffect(() => {
    let alive = true;
    const visible = () => Platform.OS === "web" ? document.visibilityState === "visible" : AppState.currentState === "active";
    const tick = async () => {
      if (!visible()) return;
      try {
        const r = await api.activity(since.current - 2000);   // a little overlap; "seen" stops repeats
        since.current = r.now;
        const fresh = r.items.map(toNotice).filter((n) => !seen.current.has(n.key));
        fresh.forEach((n) => seen.current.add(n.key));
        if (alive && fresh.length) {
          setList((l) => [...l, ...fresh].slice(-3));
          fresh.forEach((n) => setTimeout(() => alive && setList((l) => l.filter((x) => x.key !== n.key)), 12000));
        }
      } catch { /* a missed poll is fine */ }
    };
    const t = setInterval(tick, 20000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!list.length && !sticky.length) return null;
  return (
    <View style={{ position: "absolute", right: 16, bottom: 16, gap: 8, maxWidth: 380, width: "92%", alignItems: "flex-end" }} pointerEvents="box-none">
      {sticky.map((n) => (
        <View key={n.id} accessibilityLiveRegion="polite"
          style={{ backgroundColor: c.card2, borderWidth: 1, borderColor: c.line, borderLeftWidth: 3, borderLeftColor: c.flag, borderRadius: 12,
                   paddingVertical: 12, paddingHorizontal: 14, width: "100%", gap: 6 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{tMsg(n.title)}</Text>
          {n.body ? <Text style={{ color: c.sub, fontSize: 13 }}>{tMsg(n.body)}</Text> : null}
          <View style={{ flexDirection: "row", gap: 14 }}>
            {n.link ? <Pressable onPress={() => dismiss(n, true)} accessibilityRole="link"><Text style={{ color: c.link, fontSize: 13 }}>{tr("Open the clip")}</Text></Pressable> : null}
            <Pressable onPress={() => dismiss(n, false)} accessibilityRole="button"><Text style={{ color: c.muted, fontSize: 13 }}>{tr("Dismiss")}</Text></Pressable>
          </View>
        </View>
      ))}
      {list.map((n) => (
        <Pressable key={n.key} onPress={() => { setList((l) => l.filter((x) => x.key !== n.key)); n.go(); }} accessibilityRole="button"
          accessibilityLiveRegion="polite"
          style={{ backgroundColor: c.card2, borderWidth: 1, borderColor: n.tone === "bad" ? c.failLine : c.line, borderLeftWidth: 3,
                   borderLeftColor: n.tone === "bad" ? c.fail : c.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14,
                   flexDirection: "row", gap: 10, alignItems: "center", shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 16 }}>
          <Text style={{ color: c.ink, fontSize: 14, flexShrink: 1 }}>{n.text}</Text>
          <Text style={[{ color: c.link, fontSize: 12 }, font.mono]}>{tr("OPEN")}</Text>
        </Pressable>
      ))}
    </View>
  );
}

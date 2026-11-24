// Assets, at /storage because the dev server and web export reserve /assets for static files (2026-11-19, Londi: "an assets (storage) space where the assets generated will be accessed, separated by
// type, genre, etc."). Everything made in the creator's series (studio.my_assets) plus their music, filtered by type,
// series, look, genre and status, with search, a preview and download. Free accounts see watermarked clips and cuts,
// as everywhere else. @anlim
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, Asset, AssetKind, ASSET_KIND_NAMES, AssetQuery, AssetStatus, Genre, GENRE_NAMES, Look, Series } from "../lib/api";
import { c, font, verdictLabel, pageBg } from "../lib/theme";
import { Grid } from "../components/Grid";
import { Icon, IconName } from "../components/Icon";
import { MediaView } from "../components/MediaView";
import { downloadFile } from "../lib/download";
import { tr, locale, trMap, tMsg, shotText } from "../lib/i18n";

const KINDS: (AssetKind | null)[] = [null, "clip", "cut", "still", "character", "place", "voice", "sfx", "music"];
const KIND_ICON: Record<AssetKind, IconName> = { clip: "play", cut: "cut", still: "image", character: "cast", place: "image", voice: "music", sfx: "music", music: "music" };
const KIND_TAG: Record<AssetKind, string> = trMap({ clip: "CLIP", cut: "SCENE CUT", still: "FRAME", character: "CHARACTER", place: "PLACE", voice: "VOICEOVER", sfx: "SOUND EFFECT", music: "MUSIC" });
const STATUS_NAMES: Record<AssetStatus, string> = trMap({ kept: "Kept", to_review: "To review", rejected: "Rejected" });
const STATUS_COL: Record<AssetStatus, string> = { kept: c.pass, to_review: c.flag, rejected: c.muted };
const PAGE = 48;

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.filterRow}>
      <Text style={[s.filterLabel, font.mono]}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingRight: 12 }}>{children}</ScrollView>
    </View>
  );
}
function Chip({ on, text, onPress }: { on: boolean; text: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, on && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
      <Text style={{ color: on ? c.onAccent : c.ink, fontSize: 13 }} numberOfLines={1}>{text}</Text>
    </Pressable>
  );
}

function Card({ a, onPress }: { a: Asset; onPress: () => void }) {
  const tall = a.kind === "character";
  return (
    <Pressable style={s.card} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${ASSET_KIND_NAMES[a.kind]}: ${a.title}`}>
      <View style={[s.thumbBox, tall && { aspectRatio: 16 / 9 }]}>
        {a.thumb_url ? <Image source={{ uri: a.thumb_url }} style={StyleSheet.absoluteFill} resizeMode={tall ? "contain" : "cover"} />
          : <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}><Icon name={KIND_ICON[a.kind]} size={30} color={c.muted} /></View>}
        <Text style={[s.tag, font.mono]}>{KIND_TAG[a.kind]}</Text>
        {(a.kind === "clip" || a.kind === "cut") && <View style={s.play}><Icon name="play" size={16} color={c.ink} /></View>}
        {a.kind !== "music" && a.status !== "kept" && (
          <Text style={[s.status, { color: STATUS_COL[a.status], borderColor: STATUS_COL[a.status] }]}>{STATUS_NAMES[a.status]}</Text>
        )}
      </View>
      <View style={{ padding: 12, gap: 3 }}>
        <Text style={{ color: c.ink, fontSize: 14, lineHeight: 19 }} numberOfLines={2}>{a.kind === "still" ? tMsg(a.title) : shotText(a.title)}</Text>
        <Text style={{ color: c.sub, fontSize: 12 }} numberOfLines={1}>
          {[a.series_name, a.scene_title].filter(Boolean).join(" · ") || tMsg(a.subtitle)}</Text>
        <Text style={[s.meta, font.mono]} numberOfLines={1}>
          {[a.look?.toUpperCase(), a.genre ? GENRE_NAMES[a.genre].toUpperCase() : null, a.model?.toUpperCase(),
            a.duration_s ? `${Math.round(Number(a.duration_s))} S` : null].filter(Boolean).join(" · ") || new Date(a.created_at).toLocaleDateString(locale())}</Text>
      </View>
    </Pressable>
  );
}

function Preview({ a, onClose, onDeleted }: { a: Asset; onClose: () => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canDelete = !["character", "place"].includes(a.kind) && !(a.kind === "clip" && a.status === "kept");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ext = (a.url?.split("?")[0].split(".").pop() || "").toLowerCase().slice(0, 5);
  const fileName = `${a.title.replace(/[^\w\s-]/g, "").trim().slice(0, 60).replace(/\s+/g, "-") || a.kind}${a.watermarked ? "-preview" : ""}.${ext || "bin"}`;
  return (
    <View style={s.overlay}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={tr("Close preview")} />
      <View style={s.sheet}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <Text style={[s.kicker, font.mono]}>{KIND_TAG[a.kind]}{a.watermarked ? tr(" · WATERMARKED (FREE ACCOUNT)") : ""}</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={tr("Close")}><Text style={{ color: c.sub, fontSize: 22 }}>×</Text></Pressable>
          </View>
          {a.url ? <MediaView kind={a.kind} url={a.url} poster={a.thumb_url} /> : <Text style={s.sub}>{tr("This file could not be opened.")}</Text>}
          <Text style={[{ color: c.ink, fontSize: 20 }, font.display]}>{a.kind === "still" ? tMsg(a.title) : shotText(a.title)}</Text>
          {a.subtitle && a.subtitle !== a.title && a.subtitle !== a.model && <Text style={s.sub}>{tMsg(a.subtitle)}</Text>}
          <View style={s.facts}>
            {([
              [tr("Series"), a.series_name], [tr("Scene"), a.scene_title], [tr("Shot"), a.shot_ord ? String(a.shot_ord) : null],
              [tr("Look"), a.look === "photoreal" ? tr("Photoreal") : a.look === "cartoon" ? tr("Cartoon") : null], [tr("Genre"), a.genre ? GENRE_NAMES[a.genre] : null],
              [tr("Model"), a.model], [tr("Length"), a.duration_s ? `${Number(a.duration_s).toFixed(1)} s` : null],
              [tr("Check"), a.kind === "clip" ? verdictLabel(a.verdict) : null], [tr("Status"), a.kind === "music" ? null : STATUS_NAMES[a.status]],
              [tr("Made"), new Date(a.created_at).toLocaleString(locale())],
            ] as [string, string | null][]).filter(([, v]) => v).map(([k, v]) => (
              <View key={k} style={{ minWidth: 120 }}>
                <Text style={[s.filterLabel, font.mono]}>{k.toUpperCase()}</Text>
                <Text style={{ color: c.ink, fontSize: 14, marginTop: 2 }}>{v}</Text>
              </View>
            ))}
          </View>
          {err && <Text style={{ color: c.fail }}>{tMsg(err)}</Text>}
          {a.watermarked && <Text style={s.sub}>{tr("Free accounts get a watermarked copy. Buy credits or pick a plan and every clip and cut downloads clean.")}</Text>}
          <View style={s.row}>
            {a.url && (
              <Pressable style={[s.btn, saving && { opacity: 0.6 }]} disabled={saving} accessibilityRole="button"
                onPress={async () => { setSaving(true); setErr(null); try { await downloadFile(a.url!, fileName); } catch (e) { setErr((e as Error).message); } setSaving(false); }}>
                <Text style={s.btnText}>{saving ? tr("Saving…") : tr("Download")}</Text>
              </Pressable>
            )}
            {a.kind === "clip" && (
              <Pressable style={s.ghost} onPress={() => { onClose(); router.navigate({ pathname: "/clip/[id]", params: { id: a.id } }); }} accessibilityRole="link">
                <Text style={{ color: c.ink, fontWeight: "600" }}>{a.status === "to_review" ? tr("Review it") : tr("See the check")}</Text>
              </Pressable>
            )}
            {(a.kind === "clip" || a.kind === "still") && a.shot_id && (
              <Pressable style={s.ghost} accessibilityRole="link"
                onPress={() => { onClose(); router.navigate({ pathname: "/workspace", params: { series: a.series_id!, scene: a.scene_id!, shot: a.shot_id! } }); }}>
                <Text style={{ color: c.ink, fontWeight: "600" }}>{tr("Open shot in Workspace")}</Text>
              </Pressable>
            )}
            {a.kind === "cut" && a.scene_id && (
              <Pressable style={s.ghost} onPress={() => { onClose(); router.navigate({ pathname: "/cut/[scene]", params: { scene: a.scene_id! } }); }} accessibilityRole="link">
                <Text style={{ color: c.ink, fontWeight: "600" }}>{tr("Scene cut page")}</Text>
              </Pressable>
            )}
            {canDelete && !confirm && (
              <Pressable style={s.ghost} onPress={() => setConfirm(true)} accessibilityRole="button">
                <Text style={{ color: c.fail, fontWeight: "600" }}>{tr("Delete")}</Text>
              </Pressable>
            )}
            {canDelete && confirm && (
              <Pressable style={[s.ghost, { borderColor: c.failLine, backgroundColor: c.failBg }]} disabled={deleting} accessibilityRole="button"
                onPress={async () => {
                  setDeleting(true); setErr(null);
                  try { await api.deleteAsset(a.kind, a.id, a.upload_path ?? undefined); onDeleted(); }
                  catch (e) { setErr((e as Error).message); setConfirm(false); }
                  setDeleting(false);
                }}>
                <Text style={{ color: c.fail, fontWeight: "700" }}>{deleting ? tr("Deleting…") : tr("Delete for good? It cannot be undone")}</Text>
              </Pressable>
            )}
            {a.kind === "clip" && a.status === "kept" && <Text style={[s.sub, { fontSize: 12 }]}>{tr("This is a shot's kept clip, so it can't be deleted here.")}</Text>}
            {(a.kind === "character" || a.kind === "place") && a.series_id && (
              <Pressable style={s.ghost} onPress={() => { onClose(); router.navigate({ pathname: "/library", params: { series: a.series_id! } }); }} accessibilityRole="link">
                <Text style={{ color: c.ink, fontWeight: "600" }}>{tr("Open in Cast & places")}</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

export default function Assets() {
  const { width } = useWindowDimensions();
  const narrow = width < 760;
  const [series, setSeries] = useState<Series[]>([]);
  const [f, setF] = useState<AssetQuery>({ sort: "newest" });
  const [qText, setQText] = useState("");
  const [items, setItems] = useState<Asset[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<Asset | null>(null);
  const [showFilters, setShowFilters] = useState(!narrow);

  useFocusEffect(useCallback(() => { api.series().then(setSeries).catch(() => null); }, []));
  const seq = useRef(0);
  const load = useCallback(async (append = false, from = 0) => {
    const mine = ++seq.current;   // only the newest request may fill the grid
    try {
      const r = await api.assets({ ...f, limit: PAGE, offset: from });
      if (mine !== seq.current) return;
      setItems((cur) => (append && cur ? [...cur, ...r.items] : r.items)); setTotal(r.total); setCounts(r.counts); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [f]);
  useEffect(() => { setItems(null); load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => setF((x) => (x.q ?? "") === qText.trim() ? x : { ...x, q: qText.trim() || undefined }), 350); return () => clearTimeout(t); }, [qText]);

  const genres = useMemo(() => Array.from(new Set(series.map((x) => x.genre).filter(Boolean))) as Genre[], [series]);
  const set = (patch: Partial<AssetQuery>) => setF((x) => ({ ...x, ...patch }));
  const active = [f.series_id, f.look, f.genre, f.status].filter(Boolean).length;

  return (
    <View style={{ flex: 1, backgroundColor: pageBg }}>
      <ScrollView contentContainerStyle={[s.page, narrow && { padding: 14 }]}>
        <View style={[s.row, { gap: 10 }]}>
          <View style={s.search}>
            <Icon name="search" size={18} color={c.sub} />
            <TextInput value={qText} onChangeText={setQText} placeholder={tr("Search by shot, scene, series or name")} placeholderTextColor={c.muted}
              style={{ flex: 1, color: c.ink, fontSize: 15, paddingVertical: 10 }} accessibilityLabel={tr("Search assets")} />
          </View>
          <Pressable style={s.ghostSm} onPress={() => set({ sort: f.sort === "oldest" ? "newest" : "oldest" })} accessibilityRole="button">
            <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{f.sort === "oldest" ? tr("Oldest first") : tr("Newest first")}</Text>
          </Pressable>
          {narrow && (
            <Pressable style={[s.ghostSm, active > 0 && { borderColor: c.accent }]} onPress={() => setShowFilters((v) => !v)} accessibilityRole="button">
              <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{tr("Filters{v0}", { v0: active ? ` · ${active}` : "" })}</Text>
            </Pressable>
          )}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabs}>
          {KINDS.map((k) => {
            const on = (f.kind ?? null) === k, n = counts[k ?? "all"] ?? 0;
            return (
              <Pressable key={k ?? "all"} onPress={() => set({ kind: k })} style={[s.tab, on && s.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
                <Text style={{ color: on ? c.ink : c.sub, fontWeight: "600", fontSize: 14 }}>{k ? ASSET_KIND_NAMES[k] : tr("All")}</Text>
                <Text style={[{ color: on ? c.accent : c.muted, fontSize: 12 }, font.mono]}>{n}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {showFilters && (
          <View style={s.filters}>
            <FilterRow label={tr("SERIES")}>
              <Chip on={!f.series_id} text={tr("All")} onPress={() => set({ series_id: null })} />
              {series.map((x) => <Chip key={x.id} on={f.series_id === x.id} text={x.name} onPress={() => set({ series_id: f.series_id === x.id ? null : x.id })} />)}
            </FilterRow>
            <FilterRow label={tr("LOOK")}>
              <Chip on={!f.look} text={tr("All")} onPress={() => set({ look: null })} />
              {(["cartoon", "photoreal"] as Look[]).map((l) => <Chip key={l} on={f.look === l} text={l === "cartoon" ? tr("Cartoon") : tr("Photoreal")} onPress={() => set({ look: f.look === l ? null : l })} />)}
            </FilterRow>
            <FilterRow label={tr("GENRE")}>
              <Chip on={!f.genre} text={tr("All")} onPress={() => set({ genre: null })} />
              {genres.map((g) => <Chip key={g} on={f.genre === g} text={GENRE_NAMES[g]} onPress={() => set({ genre: f.genre === g ? null : g })} />)}
              {genres.length === 0 && (
                <Pressable onPress={() => router.navigate("/library")} accessibilityRole="link" style={{ justifyContent: "center" }}>
                  <Text style={{ color: c.link, fontSize: 13 }}>{tr("No genres yet: set one on a series in Cast & places")}</Text>
                </Pressable>
              )}
            </FilterRow>
            <FilterRow label={tr("STATUS")}>
              <Chip on={!f.status} text={tr("All")} onPress={() => set({ status: null })} />
              {(["kept", "to_review", "rejected"] as AssetStatus[]).map((st) => <Chip key={st} on={f.status === st} text={STATUS_NAMES[st]} onPress={() => set({ status: f.status === st ? null : st })} />)}
            </FilterRow>
            {active > 0 && (
              <Pressable onPress={() => set({ series_id: null, look: null, genre: null, status: null })} accessibilityRole="button">
                <Text style={{ color: c.link, fontSize: 13 }}>{tr("Clear filters")}</Text>
              </Pressable>
            )}
          </View>
        )}

        {error && <Text style={{ color: c.fail, marginVertical: 10 }}>{tMsg(error)}</Text>}
        {!items && !error && <ActivityIndicator style={{ marginTop: 40 }} />}
        {items && (
          <Text style={[s.kicker, font.mono, { marginVertical: 12 }]}>{total} {total === 1 ? tr("ITEM") : tr("ITEMS")}{f.status === "rejected" ? tr(" · REJECTED CLIPS STAY HERE SO YOU CAN COMPARE") : ""}</Text>
        )}
        {items && items.length === 0 && (
          <View style={s.empty}>
            <Icon name="assets" size={32} color={c.muted} />
            <Text style={[s.sub, { marginTop: 10, textAlign: "center" }]}>
              {active || f.q || f.kind ? tr("Nothing matches these filters.") : tr("Nothing made yet. What you make in the Workspace shows up here.")}</Text>
          </View>
        )}
        {items && items.length > 0 && (
          <Grid min={narrow ? 150 : 250} gap={narrow ? 10 : 16}>{items.map((a) => <Card key={`${a.kind}-${a.id}`} a={a} onPress={() => setOpen(a)} />)}</Grid>
        )}
        {items && items.length < total && (
          <Pressable style={[s.ghostSm, { alignSelf: "center", marginTop: 8 }]} disabled={more} accessibilityRole="button"
            onPress={async () => { setMore(true); await load(true, items.length); setMore(false); }}>
            <Text style={{ color: c.ink, fontWeight: "600" }}>{more ? tr("Loading…") : tr("Show more ({v0} left)", { v0: total - items.length })}</Text>
          </Pressable>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
      {open && <Preview a={open} onClose={() => setOpen(null)} onDeleted={() => { setOpen(null); load(); }} />}
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: 24, maxWidth: 1400, width: "100%", alignSelf: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  kicker: { color: c.sub, fontSize: 11, letterSpacing: 0.9 },
  search: { flex: 1, minWidth: 220, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.field, borderRadius: 12, paddingHorizontal: 12 },
  tabs: { gap: 4, marginTop: 16, borderBottomWidth: 1, borderBottomColor: c.line, paddingRight: 12 },
  tab: { flexDirection: "row", gap: 8, alignItems: "center", paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabOn: { borderBottomColor: c.accent },
  filters: { gap: 10, marginTop: 14, padding: 14, backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 14 },
  filterRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  filterLabel: { color: c.muted, fontSize: 10, letterSpacing: 0.9, width: 58 },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.field, maxWidth: 240 },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  card: { backgroundColor: c.card, borderRadius: 14, borderWidth: 1, borderColor: c.line, overflow: "hidden" },
  thumbBox: { width: "100%", aspectRatio: 16 / 9, backgroundColor: c.card2 },
  tag: { position: "absolute", top: 8, left: 8, color: c.ink, backgroundColor: "rgba(8,8,10,0.8)", fontSize: 10, letterSpacing: 0.6, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3, overflow: "hidden" },
  status: { position: "absolute", top: 8, right: 8, fontSize: 10, fontWeight: "700", borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: "rgba(8,8,10,0.85)", overflow: "hidden" },
  play: { position: "absolute", bottom: 8, left: 8, width: 30, height: 30, borderRadius: 15, backgroundColor: "rgba(8,8,10,0.78)", alignItems: "center", justifyContent: "center" },
  meta: { color: c.muted, fontSize: 10, letterSpacing: 0.5, marginTop: 2 },
  sub: { color: c.sub, fontSize: 14 },
  empty: { alignItems: "center", padding: 50, borderWidth: 1, borderStyle: "dashed", borderColor: c.line, borderRadius: 16 },
  ghostSm: { borderWidth: 1, borderColor: c.line, backgroundColor: c.field, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10 },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.72)", alignItems: "center", justifyContent: "center", padding: 16 },
  sheet: { width: "100%", maxWidth: 900, maxHeight: "94%", backgroundColor: c.card, borderRadius: 18, borderWidth: 1, borderColor: c.line, overflow: "hidden" },
  facts: { flexDirection: "row", flexWrap: "wrap", gap: 16, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.line },
  btn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 18 }, btnText: { color: c.onAccent, fontWeight: "700" },
  ghost: { borderWidth: 1, borderColor: c.line, backgroundColor: c.field, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 16 },
});

// Calls the studio-api Edge Function as the signed-in creator.
import { supabase } from "./supabase";
import { tr, tMsg, trMap, trDeep, setTranslator } from "./i18n";

export type Flag = { t_s: number | null; frame: string; verdict: string; rules: string[]; note: string };
export type QueueItem = {
  id: string; status: string; created_at: string; free_retry: boolean; credits_reserved: number; credits_charged: number;
  settled: string | null; error: string | null; shot_ord: number; action: string; shot_status: string;
  scene_title: string; series_name: string; verdict: string | null; check_usd: string | null; flag_count: number | null;
  decision: string | null; thumb_url: string | null; model_id: string; shot_id: string;
};
export type Clip = {
  id: string; status: string; settled: string | null; credits_reserved: number; free_retry: boolean; error: string | null;
  action: string; camera: string | null; duration_s: number; scene_title: string; series_name: string;
  verdict: string | null; flags: Flag[] | null; reasons: string[] | null;
  action_check: { verdict?: string; confidence?: string; differs?: string; why?: string } | null;
  review_usd: string | null; verify_usd: string | null; action_usd: string | null; passthrough_usd: string | null;
  passthrough: { verdict?: string; confidence?: string } | null;
  clip_url: string | null; start_url: string | null; decision: string | null;
  watermarked: boolean;   // free account: clip_url is the watermarked copy (2026-11-18)
  model_id: string; route_kind: string | null; route_reason: string | null;   // route_kind null = the creator chose the model
  shot_id: string;
  refund: { status: "pending" | "upheld" | "reversed"; created_at: string; decision_note: string | null } | null;   // 2026-11-20
};

export type ShotRow = {
  id: string; ord: number; action: string; status: string; duration_s: number; camera: string | null;
  has_end_frame: boolean; end_frame_approved: boolean; has_start_frame: boolean; start_frame_approved: boolean;
  scene_id: string; scene_title: string; scene_ord: number; series_id: string; series_name: string;
  gen_status: string | null; gen_id: string | null; frame_status: string | null; frame_kind: "end" | "start" | null;
  thumb_url: string | null; has_approved_clip: boolean; gen_model: string | null;   // 2026-11-19 board
  trim_start_s?: number | string; trim_end_s?: number | string; speed?: number | string;   // 2026-11-22: the cut's trims and speed
  clip_s?: number | string | null;   // 2026-11-23: the kept clip's real length (null for clips made before)
  words?: ShotWord[] | null;          // 2026-11-23: words drawn over the shot in the cut
};
// A word drawn over a shot in the cut (studio.set_shot_words): it appears at at_s seconds into the shot as it plays in the
// cut (after trims and speed), at x,y (fractions of the frame, from the top left), falls and fades over dur_s seconds.
export type ShotWord = { text: string; at_s: number; x: number; y: number; dur_s: number };
// A shot's length in the scene cut, exactly as the worker's assemble.js makes it (2026-11-23, review): the clip's real
// length (or the shot's asked length), trims in whole frames with at least 1 s of the clip kept, then the speed.
const FPS = 24;
export const cutSeconds = (r: ShotRow) => {
  const frames = Math.round((Number(r.clip_s) || Number(r.duration_s) || 0) * FPS);
  const skip = Math.max(0, Math.round(Number(r.trim_start_s || 0) * FPS)), cut = Math.max(0, Math.round(Number(r.trim_end_s || 0) * FPS));
  const keep = Math.max(Math.min(FPS, frames), frames - skip - cut);
  const speed = Math.min(2, Math.max(0.5, Number(r.speed) || 1));
  return Math.max(1, Math.round(keep / speed)) / FPS;
};
export type ScoreSection = { label: string; seconds: number; styles: string; avoid?: string };
// The score's sections, one per kept shot (same rules as the connector's make_score, studio-mcp): a shot under 3 s
// (ElevenLabs' shortest section) joins the section before it, or the one after it when it is first; section ends are
// rounded on the running total so rounding never adds up; the last section runs 1 s past the cut; each section takes
// the mood of its longest shot. `joins` says, per shot, where a short shot went.
export function scoreSections(shots: ShotRow[], moodOf: (r: ShotRow) => string) {
  const lens = shots.map(cutSeconds);
  if (lens.length) lens[lens.length - 1] += 1;
  const groups: { idx: number[]; len: number }[] = [];
  const joins: ("" | "before" | "after")[] = shots.map(() => "");
  let carry: { idx: number[]; len: number } | null = null;
  lens.forEach((len, i) => {
    let g = { idx: [i], len };
    if (carry) { g = { idx: [...carry.idx, i], len: carry.len + len }; carry = null; }
    if (g.len >= 3) groups.push(g);
    else if (groups.length) { groups[groups.length - 1].idx.push(...g.idx); groups[groups.length - 1].len += g.len; g.idx.forEach((k) => { joins[k] = "before"; }); }
    else { carry = g; g.idx.forEach((k) => { joins[k] = "after"; }); }
  });
  if (carry) { const c: { idx: number[]; len: number } = carry; groups.push({ ...c, len: Math.max(3, c.len) }); c.idx.forEach((k) => { joins[k] = ""; }); }
  let end = 0, prev = 0;
  const sections: ScoreSection[] = groups.map((g) => {
    end += g.len;
    const r = Math.round(end * 10) / 10, seconds = Math.round((r - prev) * 10) / 10;
    prev = r;
    const main = g.idx.reduce((m, i) => (lens[i] > lens[m] ? i : m), g.idx[0]);
    return { label: `Shot ${String(shots[g.idx[0]].ord).padStart(2, "0")}`, seconds: Math.max(3, seconds), styles: moodOf(shots[main]).trim() };
  });
  return { sections, lens, joins, total: Math.round(sections.reduce((t, x) => t + x.seconds, 0) * 10) / 10 };
}
export type HeightCheck = { verdict: "OK" | "WRONG" | "UNSURE" | "NOT CHECKED"; problems: string[]; notes: string[] };
// 2026-11-17: is everyone physically doing what was asked (sitting ON the seat, feet on the floor, hands holding)?
export type StagingCheck = { verdict: "OK" | "WRONG" | "UNSURE" | "NOT CHECKED"; problems: string[]; notes?: string[] };
export type EndCheck = { verdict: "PASS" | "FLAG"; drift: { box: number[]; area_pct: number }[]; why: string | null; height?: HeightCheck; staging?: StagingCheck;
  revealed?: { box: number[]; area_pct: number; source: "plate" | "edit" }[]; plate_used?: boolean };
export type FrameJob = {
  id: string; status: "queued" | "running" | "composing" | "ready" | "failed" | "approved" | "discarded";
  instruction: string; check_result: EndCheck | null; composed_url: string | null; error: string | null; created_at: string;
};
export type StartMode = "prompt" | "continue" | "reposition" | "new_setup" | "restyle";   // restyle: an uploaded picture redrawn (2026-11-24)   // prompt: drawn from the description (2026-11-19)
export type StartSource = "prev_last" | "this_start" | "prev_start";
export type StartJob = FrameJob & { mode: StartMode };
export type ShotContext = {
  scene_id: string; series_id: string; location_id: string | null; location_name: string | null; has_plate: boolean | null;
  prev_id: string | null; prev_clip_approved: boolean | null; prev_start_approved: boolean | null; cast_ids: string[];
  characters: { id: string; name: string; has_ref: boolean; in_shot: boolean }[];
};
export type Shot = {
  id: string; ord: number; action: string; status: string; duration_s: number; camera: string | null;
  start_url: string | null; start_frame_approved: boolean; end_url: string | null; end_frame_path: string | null;
  end_frame_approved: boolean; end_instruction: string | null; scene_title: string; series_name: string; look: Look; aspect?: Aspect;
  job: FrameJob | null;
  route: { kind: string; model_id: string; reason: string; evidence: string; label: string | null; credits: number } | null;
  quality: Quality; series_id: string; models: { id: string; label: string | null; credits: number }[];
  can_pick?: boolean;   // false: a free account, Auto only (2026-11-20)
  route_error: string | null; latest: { id: string; status: string } | null; owner: string;
  start_job: StartJob | null; context: ShotContext | null;
  // height check of an uploaded start still (frame_jobs kind 'height', 2026-11-16)
  height_job: { id: string; status: FrameJob["status"]; check_result: { height?: HeightCheck } | null; error: string | null } | null;
};
export type LibCharacter = { id: string; name: string; kind: Kind; what: string | null; height_units: string | null; wardrobe: string | null; ref_front_path: string | null; ref_url: string | null };
export type LibLocation = {
  id: string; name: string; description: string | null; layout_path: string | null; plate_url: string | null; scene_ids: string[];
  other_plates?: number;
  job_id: string | null; job_status: FrameJob["status"] | null; job_url: string | null; job_check: EndCheck | null; job_error: string | null;
};
export type PricePlan = { id: string; kind: "pack" | "plan"; tier: string | null; billing_interval: "month" | "year" | null;
  name: string; price_cents: number; credits: number };
export type Billing = {
  plans: PricePlan[]; ready: boolean; mode?: "live" | "test";
  account: { balance: number; reserved: number; plan_credits: number; plan_id: string | null; plan_status: string | null;
             plan_period_end: string | null; plan_next_refresh: string | null; plan_cancel_at_period_end: boolean;
             plan_cancel_at: string | null; has_customer: boolean } | null;
};
// why a creator did or didn't get welcome credits (trial guard, 2026-11-18); null = older account
export type WelcomeStatus = "granted" | "repeat" | "disposable" | "held" | "off" | "needs_phone" | null;
// finished work since the last look, for the app's notices (2026-11-19)
export type Activity = { kind: "clip" | "frame" | "cut" | "audio"; id: string; status: string; updated_at: string; ord: number | null;
  scene_title: string; scene_id: string; shot_id: string | null };
export type Library = { characters: LibCharacter[]; locations: LibLocation[]; owner: string };
// cartoon = drawn; photoreal = looks filmed. Picks the checker's rules, the image-prompt wording and the video route.
export type Look = "cartoon" | "photoreal";
// A project's shape (2026-11-21): every text-to-video model in use takes these six (fal pages read 2026-11-21).
export type Aspect = "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9";
export const ASPECTS: { id: Aspect; label: string; hint: string }[] = trDeep([
  { id: "16:9", label: "16:9", hint: "Landscape: YouTube, websites" },
  { id: "9:16", label: "9:16", hint: "Vertical: Shorts, Reels, TikTok" },
  { id: "1:1", label: "1:1", hint: "Square: feeds" },
  { id: "4:3", label: "4:3", hint: "Classic TV" },
  { id: "3:4", label: "3:4", hint: "Portrait" },
  { id: "21:9", label: "21:9", hint: "Cinema widescreen" },
], ["hint"]);
export const ratioOf = (a?: string | null) => { const [w, h] = String(a || "16:9").split(":").map(Number); return w > 0 && h > 0 ? w / h : 16 / 9; };
// a cast member: a person, an animal or an object, in either look (2026-11-16)
export type Kind = "person" | "animal" | "object";
// which tested route table Auto uses for a series (2026-11-19); balanced = the tested picks
export type Quality = "best" | "balanced" | "economy";
export const QUALITY_NAMES: Record<string, string> = trMap({ best: "Best quality", balanced: "Balanced", economy: "Lowest cost" });
export const QUALITY_HELP: Record<string, string> = trMap({
  best: "Picks the model that tested best for each kind of shot, even when it costs more.",
  balanced: "Picks the tested model that gives good results for the price. Recommended.",
  economy: "Picks the cheapest model that still passed our tests for that kind of shot.",
});
// a scene cut (studio.assemblies, 2026-11-19)
export type CutFormat = "16x9" | "9x16" | "4x5" | "1x1" | "4x3" | "3x4" | "21x9";
// 2026-11-23: a cut's edit style (worker editstyle.js); null or absent is the plain cut
export type EditTransition = "mixed" | "flash" | "whip" | "zoom" | "spin" | "glitch" | "punch" | "cut";
export type EditStyle = { preset: "story"; transitions: EditTransition; grade: boolean; push: boolean; rain: boolean; hits: boolean;
                          beat_sync: boolean; title: string | null; handle: string | null; drops?: boolean; look_ref?: string | null };
export type Cut = {
  id: string; format: CutFormat; options: { fade: boolean; end_card: boolean; music_path: string | null; voice?: boolean; sfx?: boolean; style?: EditStyle | null };
  status: "queued" | "running" | "done" | "failed"; duration_s: string | null; error: string | null; skipped: number[]; shots: number;
  report: { checks: { name: string; ok: boolean; detail: string }[]; notes: string[]; voiceovers?: number; narration?: boolean; effects?: number;
            captions?: { lines: number; srt: string } | null;
            style?: { preset: string; changes: Record<string, number>; on_beat: number; hits: number } | null } | null;
  watermarked: boolean; url: string | null; srt_url?: string | null; created_at: string;
};
export type Series = {
  id: string; name: string; look: Look; aspect?: Aspect; quality: Quality; genre: Genre | null; style_prompt: string | null; scenes: { id: string; title: string; ord: number; location_id: string | null }[];
  locations: { id: string; name: string; has_plate: boolean }[];
  has_cast?: boolean;   // the project has characters: a Home video starts from an image of them (quick_create)
};
// Genre: optional, files and filters work in Assets; it changes nothing about how frames or clips are made (2026-11-19).
export type Genre = "drama" | "comedy" | "action" | "kids" | "horror" | "romance" | "documentary" | "music_video" | "ad" | "explainer" | "other";
export const GENRE_NAMES: Record<Genre, string> = trMap({
  drama: "Drama", comedy: "Comedy", action: "Action", kids: "Kids", horror: "Horror", romance: "Romance",
  documentary: "Documentary", music_video: "Music video", ad: "Ad / promo", explainer: "Explainer", other: "Other",
});
// Assets library (studio.my_assets + music, 2026-11-19)
export type AssetKind = "clip" | "cut" | "still" | "character" | "place" | "voice" | "sfx" | "music";
export const ASSET_KIND_NAMES: Record<AssetKind, string> = trMap({
  clip: "Clips", cut: "Scene cuts", still: "Frames", character: "Characters", place: "Places", voice: "Voiceover", sfx: "Sound effects", music: "Music",
});
export type AssetStatus = "kept" | "to_review" | "rejected";
export type Asset = {
  kind: AssetKind; id: string; created_at: string; series_id: string | null; series_name: string | null; look: Look | null;
  genre: Genre | null; scene_id: string | null; scene_title: string | null; shot_id: string | null; shot_ord: number | null;
  title: string; subtitle: string | null; model: string | null; duration_s: string | null; status: AssetStatus; verdict: string | null;
  thumb_url: string | null; url: string | null; watermarked: boolean; upload_path: string | null;
};
export type AssetQuery = { kind?: AssetKind | null; series_id?: string | null; look?: Look | null; genre?: Genre | null;
  status?: AssetStatus | null; q?: string; sort?: "newest" | "oldest"; limit?: number; offset?: number };
// Video models a paid account may pick at the Home prompt (studio-api prompt_models, 2026-11-20)
export type PromptModel = { id: string; label: string | null; credits_per_second: number; min_duration_s: number; max_duration_s: number;
  looks: Look[] | null };
export type HomeData = {
  models: { id: string; label: string | null; resolution: string; credits_per_second: number; min_duration_s: number; max_duration_s: number;
            auto_for: { look: Look; kind: string }[] }[];
  counts: { series: number; shots: number; kept: number; to_review: number; cuts: number };
  recent: { kind: "clip" | "cut"; id: string; title: string; series_name: string; scene_title: string | null; shot_id: string | null;
            scene_id: string | null; thumb_url: string | null; created_at: string }[];
  last: { shot_id: string; ord: number; action: string; scene_id: string; scene_title: string; series_id: string; series_name: string;
          thumb_url: string | null } | null;
};

// ElevenLabs connection and audio for scene cuts (2026-11-19). The key never comes back from the server.
export type Connection = { provider: "elevenlabs"; key_hint: string | null; status: "ok" | "invalid"; checked_at: string | null; created_at: string;
  account: { tier: string | null; character_count?: number | null; character_limit?: number | null; next_reset_unix?: number | null; note?: string } | null };
export type Voice = { id: string; name: string; category: string | null; gender: string | null; accent: string | null; age: string | null;
  description: string | null; preview_url: string | null };
export type AudioKind = "voiceover" | "sfx" | "music";
export type AudioJob = { id: string; shot_id: string | null; kind: AudioKind; status: "queued" | "running" | "done" | "failed"; in_cut: boolean;
  duration_s: string | null; error: string | null; created_at: string; url: string | null;
  input: { text: string; voice_id?: string; voice_name?: string; duration_s?: number | null; length_s?: number; instrumental?: boolean;
           at_s?: number } };   // at_s: where the scene's narration (a voiceover with no shot) starts in the cut

export const END_FRAME_CREDITS = 20;   // studio.request_end_frame: Nano Banana 2 edit, $0.08 at the house margin
export const FRAME_CREDITS = 20;       // start still (reposition / new setup) and plate: one Nano Banana 2 edit; "continue" is free
// photoreal New setup: GPT Image 2.6 Sunburst edit, priced by cast size (2026-11-18, Londi): $0.068 + $0.012 a person
// (measured $0.092 with 2 people), 250 credits a dollar -> 17 + 3 x people. Must match studio.request_start_frame.
export const photoSetupCredits = (people: number) => 17 + 3 * Math.max(1, people);
export const startFrameCredits = (mode: string, look?: string | null, people = 2) =>
  mode === "continue" ? 0 : mode === "new_setup" && look === "photoreal" ? photoSetupCredits(people) : FRAME_CREDITS;

// Display names for the video models (studio.models ids).
export const MODEL_NAMES: Record<string, string> = {
  "kling-v4-i2v-720p": "Kling 4.0", "minimax-h3-i2v-768p": "MiniMax H3", "mock-i2v": "Test model", "kling-lipsync": "Kling LipSync", "veed-lipsync": "VEED Lipsync", "seedance-2-0-i2v-720p": "Seedance 2.0",
};
export const KIND_NAMES: Record<string, string> = trMap({
  walking: "walking shots", sit_stand: "sitting and standing", handling: "handling props", talking: "talking shots", other: "this kind of shot",
});

// The public price list for the landing page (no sign-in needed).
export async function publicPlans(): Promise<PricePlan[]> {
  const r = await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/studio-billing?public=plans`, {
    method: "POST", headers: { apikey: process.env.EXPO_PUBLIC_SUPABASE_KEY!, "Content-Type": "application/json" }, body: "{}",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(tMsg(j.error) || tr("Request failed ({status})", { status: r.status }));
  return j.plans as PricePlan[];
}

async function call<T>(body: Record<string, unknown>, fn = "studio-api"): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error(tr("Please sign in again."));
  const r = await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: process.env.EXPO_PUBLIC_SUPABASE_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(tMsg(j.error) || tr("Request failed ({status})", { status: r.status }));
  return j as T;
}

// Run-time messages in Spanish or French (2026-11-24): tMsg asks for the ones not in the catalog (i18n.ts)
setTranslator(async (texts, lang) => (await call<{ out: Record<string, string> }>({ op: "translate", texts, lang })).out || {});

// A whole project as zip files (2026-11-23)
export type ProjectExport = { id: string; status: "queued" | "running" | "done" | "failed"; files: number | null; bytes: number | null;
  error: string | null; created_at: string; parts: { name: string; bytes: number; files: number; url: string | null }[] };

// Lip sync (2026-11-23): the price of lip-syncing a shot's kept clip to its voiceover, or why it cannot be made now
export type LipsyncQuote = { ok: boolean; why: string | null; seconds: number; clip_s: number | null; credits: number;
  last: { generation_id: string; status: string; error: string | null; kept: boolean } | null };

// Insights (admins only, 2026-11-23)
export type Insights = { days: number; since: string; blocked: number;
  funnel: { step: string; n: number; median_h?: number | null }[];
  jobs: { kind: string; total: number; failed: number }[];
  errors: { source: string; place: string | null; message: string; n: number; accounts: number; last: string }[];
  views: { route: string; n: number; accounts: number }[] };

// Quick create from the Home prompt (2026-11-20): an image, or an image and a clip, in an "Untitled project"
export type Output = "image" | "video";
export type QuickCreated = { series_id: string; scene_id: string; shot_id: string; job_id: string; series_name: string;
  output: Output; clip_credits: number; aspect?: Aspect };
export type Creation = { shot_id: string; action: string; duration_s: number; scene_id: string; series_id: string; series_name: string;
  look: Look; aspect?: Aspect; job_id: string | null; frame_status: string | null; frame_error: string | null; then_render: boolean | null;
  render_error: string | null; gen_id: string | null; gen_status: string | null; gen_error: string | null; model_id: string | null;
  model_label: string | null; credits_reserved: number | null; settled: boolean | null; watermarked: boolean;
  image_url: string | null; video_url: string | null; from_text?: boolean; motion?: boolean; poster_url?: string | null };
// Motion transfer (2026-11-20): a model the creator picks to recast their own clip (studio.models kind 'motion')
export type MotionModel = { id: string; label: string | null; resolution: string; credits_per_second: number;
  min_duration_s: number; max_duration_s: number };

export type AppNotification = { id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string };
export type AdminRefund = { id: string; generation_id: string; owner: string; email: string | null; reasons: string[]; note: string;
  at_s: number | null; credits: number; checker_verdict: string | null; status: "pending" | "upheld" | "reversed"; created_at: string;
  decided_at: string | null; decision_note: string | null; action: string; model_id: string; qc_reasons: string[] | null;
  owner_requests: number; owner_reversed: number; clip_url: string | null; start_url: string | null };

// Admin console (2026-11-25, migration studio_admin_console). Every call needs the two-step code (aal2).
export type AdminRole = "owner" | "admin";
export type AdminOverview = { role: AdminRole; users: number; new_7d: number; active_7d: number; paying: number; blocked: number; admins: number;
  refunds_pending: number; failed_24h: number; errors_24h: number; in_flight: number };
export type AdminUserRow = { id: string; email: string | null; created_at: string | null; last_sign_in_at: string | null; confirmed: boolean;
  balance: number | null; reserved: number | null; plan_id: string | null; plan_status: string | null; last_seen_at: string | null;
  role: AdminRole | null; blocked: boolean; block_reason: string | null; block_until: string | null; paid_cents: number; clips: number; failed: number };
export type AdminUser = { id: string; email: string | null; created_at: string | null; last_sign_in_at: string | null; confirmed: boolean;
  banned_until: string | null; phone: string | null; mfa: number; role: AdminRole | null;
  account: (Record<string, unknown> & { balance?: number; reserved?: number; plan_id?: string | null; plan_status?: string | null; debt?: number;
    last_seen_at?: string | null; language?: string | null; welcome_status?: string | null; has_stripe?: boolean; subscription?: boolean }) | null;
  block: { reason: string; until: string | null; blocked_at: string; by_email: string | null } | null;
  counts: { projects: number; clips: number; clips_failed: number; images: number; in_flight: number; mcp_calls_7d: number };
  payments: { at: string; plan_id: string | null; amount_cents: number; credits: number; refunded_cents: number | null }[];
  ledger: { created_at: string; kind: string; credits: number; note: string | null }[];
  jobs: { kind: string; id: string; status: string; detail: string | null; error: string | null; created_at: string; credits: number | null }[];
  refunds: { id: string; status: string; credits: number; created_at: string; reasons: string[] }[];
  errors: { at: string; source: string; place: string | null; message: string }[];
  log: { at: string; admin_email: string | null; action: string; detail: Record<string, unknown> }[] };
export type AdminIssues = {
  waiting: { kind: string; id: string; owner: string; email: string | null; status: string; since: string; error: string | null }[];
  failed: { kind: string; id: string; owner: string; email: string | null; detail: string | null; error: string | null; at: string }[];
  errors: { source: string; place: string | null; message: string; n: number; accounts: number; last: string }[];
  refunds_pending: number };
export type AdminEntry = { user_id: string; email: string | null; role: AdminRole; added_at: string; added_by: string | null; mfa: boolean };
export type AdminLogEntry = { id: number; at: string; admin_id: string | null; admin_email: string | null; action: string; target: string | null;
  target_email: string | null; detail: Record<string, unknown> };

export const api = {
  adminOverview: () => call<AdminOverview>({ op: "admin_overview" }),
  adminUsers: (q: string, filter: string, offset = 0) => call<{ total: number; items: AdminUserRow[] }>({ op: "admin_users", q, filter, offset, limit: 50 }),
  adminUser: (userId: string) => call<AdminUser>({ op: "admin_user", user_id: userId }),
  adminIssues: () => call<AdminIssues>({ op: "admin_issues" }),
  adminAdmins: () => call<{ items: AdminEntry[] }>({ op: "admin_admins" }).then((r) => r.items),
  adminLog: (before?: number) => call<{ items: AdminLogEntry[] }>({ op: "admin_log", before: before ?? null }).then((r) => r.items),
  adminBlock: (userId: string, reason: string, hours: number | null) =>
    call<{ ok: boolean; until: string | null; warning?: string }>({ op: "admin_block", user_id: userId, reason, hours }),
  adminUnblock: (userId: string, note: string) => call<{ ok: boolean; warning?: string }>({ op: "admin_unblock", user_id: userId, note }),
  adminGrant: (userId: string, credits: number, note: string) => call<{ ok: boolean; balance: number }>({ op: "admin_grant", user_id: userId, credits, note }),
  adminAdd: (email: string) => call<{ ok: boolean; user_id: string }>({ op: "admin_add", email }),
  adminRemove: (userId: string) => call<{ ok: boolean }>({ op: "admin_remove", user_id: userId }),
  me: () => call<{ user_id: string; email: string; balance: number; reserved: number; plan_credits: number; is_admin?: boolean; debt?: number; paid?: boolean; email_ready?: boolean; language?: "en" | "es" | "fr" | null;
                   plan_id: string | null; plan_status: string | null;
                   welcome_status: WelcomeStatus; blocked?: { until: string | null } | null }>({ op: "me" }),
  // billing (studio-billing Edge Function: Stripe Checkout and billing portal)
  billing: () => call<Billing>({ op: "plans" }, "studio-billing"),
  checkout: (planId: string, returnUrl: string) => call<{ url: string }>({ op: "checkout", plan_id: planId, return_url: returnUrl }, "studio-billing"),
  portal: (returnUrl: string) => call<{ url: string }>({ op: "portal", return_url: returnUrl }, "studio-billing"),
  queue: () => call<{ items: QueueItem[] }>({ op: "queue" }).then((r) => r.items),
  clip: (id: string) => call<Clip>({ op: "clip", generation_id: id }),
  // 2026-11-21: Reject needs the reason and opens a refund request (credits come back only if anlim upholds it)
  decide: (id: string, decision: "approve" | "reject", reasons: string[], note: string, atS: number | null = null) =>
    call<{ ok: boolean }>({ op: "decide", generation_id: id, decision, reasons, note, at_s: atS }),
  shots: () => call<{ items: ShotRow[] }>({ op: "shots" }).then((r) => r.items),
  // how a kept shot plays in the scene cut: only the fields given change (2026-11-23)
  shotCutEdit: (id: string, patch: { speed?: number; trim_start_s?: number; trim_end_s?: number; words?: ShotWord[] }) =>
    call<{ ok: boolean }>({ op: "shot_cut_edit", shot_id: id, ...patch }),
  shot: (id: string) => call<Shot>({ op: "shot", shot_id: id }),
  requestEndFrame: (id: string, instruction: string) => call<{ job_id: string }>({ op: "end_frame", shot_id: id, instruction }),
  decideEndFrame: (job: string, decision: "approve" | "discard") => call<{ ok: boolean }>({ op: "end_frame_decide", job_id: job, decision }),
  clearEndFrame: (id: string) => call<{ ok: boolean }>({ op: "end_frame_clear", shot_id: id }),
  render: (id: string, model?: string) => call<{ generation_id: string }>({ op: "render", shot_id: id, model }),
  series: () => call<{ items: Series[] }>({ op: "series" }).then((r) => r.items),
  createScene: (seriesId: string, title: string) => call<{ id: string }>({ op: "scene_create", series_id: seriesId, title }),
  createShot: (sceneId: string, action: string, durationS: number, camera: string | null = null) =>
    call<{ id: string }>({ op: "shot_create", scene_id: sceneId, action, duration_s: durationS, camera }),
  updateShot: (id: string, action: string, camera: string | null, durationS: number) =>
    call<{ ok: boolean }>({ op: "shot_update", shot_id: id, action, camera, duration_s: durationS }),
  // consent: the creator ticked the likeness consent box (components/LikenessConsent, 2026-11-24)
  setStartFrame: (id: string, path: string, consent = false) => call<{ ok: boolean }>({ op: "shot_start_frame", shot_id: id, path, consent }),
  approveStartFrame: (id: string) => call<{ ok: boolean }>({ op: "shot_start_approve", shot_id: id }),
  deleteShot: (id: string) => call<{ ok: boolean }>({ op: "shot_delete", shot_id: id }),
  requestStartFrame: (id: string, mode: StartMode, instruction?: string, source?: StartSource | string) =>
    call<{ job_id: string }>({ op: "start_frame", shot_id: id, mode, instruction: instruction ?? null, source: source ?? null }),
  decideFrame: (job: string, decision: "approve" | "discard") => call<{ ok: boolean }>({ op: "frame_decide", job_id: job, decision }),
  requestPlate: (locationId: string, shotId: string) => call<{ job_id: string }>({ op: "plate", location_id: locationId, shot_id: shotId }),
  library: (seriesId: string) => call<Library>({ op: "library", series_id: seriesId }),
  createSeries: (name: string, look: Look, style?: string, genre?: Genre | null, aspect?: Aspect) =>
    call<{ id: string }>({ op: "series_create", name, look, style: style ?? null, genre: genre ?? null, aspect: aspect ?? null }),
  setSeriesAspect: (seriesId: string, aspect: Aspect) => call<{ ok: true }>({ op: "series_aspect", series_id: seriesId, aspect }),
  setSeriesGenre: (seriesId: string, genre: Genre | null) => call<{ ok: true }>({ op: "series_genre", series_id: seriesId, genre }),
  assets: (q: AssetQuery) => call<{ items: Asset[]; total: number; counts: Record<string, number> }>({ op: "assets", ...q }),
  home: () => call<HomeData>({ op: "home" }),
  storageUse: () => call<{ bytes: number; files: number }>({ op: "storage_use" }),
  quickCreate: (prompt: string, look: Look, durationS: number, output: Output, seriesId: string | null, model: string | null = null,
                aspect: Aspect = "16:9") =>
    call<QuickCreated>({ op: "quick_create", prompt, look, duration_s: durationS, output, series_id: seriesId, model, aspect }),
  promptModels: () => call<{ paid: boolean; models: PromptModel[] }>({ op: "prompt_models" }),
  motionModels: () => call<{ paid: boolean; models: MotionModel[] }>({ op: "motion_models" }),
  motionCreate: (sourcePath: string, refPaths: string[], prompt: string, seconds: number, model: string, seriesId: string | null, look: Look,
                 consent = false) =>
    call<{ series_id: string; scene_id: string; shot_id: string; generation_id: string; series_name: string; seconds: number; credits: number }>(
      { op: "motion_create", source_path: sourcePath, ref_paths: refPaths, prompt, seconds, model, series_id: seriesId, look, consent }),
  exportCreate: (seriesId: string) => call<{ ok: boolean; id: string }>({ op: "export_create", series_id: seriesId }),
  exportLatest: (seriesId: string) => call<{ export: ProjectExport | null }>({ op: "export_latest", series_id: seriesId }).then((r) => r.export),
  setEmailReady: (on: boolean) => call<{ ok: boolean }>({ op: "email_ready", on }),
  // the account's language (2026-11-24): the app, emails, end cards and replies from anlim use it
  setLanguage: (language: "en" | "es" | "fr") => call<{ ok: boolean }>({ op: "language", language }),
  lipsyncQuote: (shotId: string) => call<LipsyncQuote>({ op: "lipsync_quote", shot_id: shotId }),
  lipsyncCreate: (shotId: string) => call<{ generation_id: string; credits: number; seconds: number }>({ op: "lipsync_create", shot_id: shotId }),
  adminInsights: (days: number) => call<Insights>({ op: "admin_insights", days }),
  likenessConsent: (paths: string[], kind: "upload" | "character" | "start_still" | "motion" = "upload") =>
    call<{ ok: boolean; n: number }>({ op: "likeness_consent", paths, kind }),
  creation: (shotId: string) => call<Creation>({ op: "creation", shot_id: shotId }),
  keepCreation: (generationId: string) => call<{ ok: true }>({ op: "creation_keep", generation_id: generationId }),
  // refunds (2026-11-20): credits back at once, reviewed by anlim, may be reversed with a reason
  requestRefund: (generationId: string, reasons: string[], note: string, atS: number | null) =>
    call<{ ok: true; id: string }>({ op: "refund_request", generation_id: generationId, reasons, note, at_s: atS }),
  notifications: () => call<{ items: AppNotification[] }>({ op: "notifications" }).then((r) => r.items),
  readNotifications: (ids: string[]) => call<{ ok: true }>({ op: "notifications_read", ids }),
  adminRefunds: (status: "pending" | "upheld" | "reversed" | null) => call<{ items: AdminRefund[] }>({ op: "admin_refunds", status }).then((r) => r.items),
  decideRefund: (id: string, decision: "uphold" | "reverse", note: string) => call<{ ok: true }>({ op: "admin_refund_decide", id, decision, note }),
  setSeriesQuality: (seriesId: string, quality: Quality) => call<{ ok: true }>({ op: "series_quality", series_id: seriesId, quality }),
  // managing work (2026-11-19)
  renameSeries: (id: string, name: string) => call<{ ok: true }>({ op: "series_rename", series_id: id, name }),
  renameScene: (id: string, title: string) => call<{ ok: true }>({ op: "scene_rename", scene_id: id, title }),
  deleteSeries: (id: string) => call<{ ok: true; files: number }>({ op: "series_delete", series_id: id }),
  deleteScene: (id: string) => call<{ ok: true; files: number }>({ op: "scene_delete", scene_id: id }),
  duplicateSeries: (id: string) => call<{ id: string }>({ op: "series_duplicate", series_id: id }).then((r) => r.id),
  duplicateScene: (id: string) => call<{ id: string }>({ op: "scene_duplicate", scene_id: id }).then((r) => r.id),
  myReferral: () => call<{ code: string; credits: number; referred_credits?: number; invited: number; rewarded: number }>({ op: "referral_me" }),
  claimReferral: (code: string) => call<{ ok: boolean }>({ op: "referral_claim", code }),
  moveShot: (id: string, dir: -1 | 1) => call<{ ok: true }>({ op: "shot_move", shot_id: id, dir }),
  deleteAsset: (kind: AssetKind, id: string, path?: string) => call<{ ok: true; files: number }>({ op: "asset_delete", kind, id, path: path ?? null }),
  activity: (since: number) => call<{ items: Activity[]; now: number }>({ op: "activity", since }),
  deleteAccount: (confirm: string) => call<{ ok: true; files: number }>({ op: "account_delete", confirm }, "studio-billing"),
  connections: () => call<{ items: Connection[] }>({ op: "connections" }).then((r) => r.items),
  connect: (key: string) => call<{ ok: true; key_hint: string; account: Connection["account"] }>({ op: "connection_set", provider: "elevenlabs", key }),
  checkConnection: () => call<{ ok: boolean }>({ op: "connection_check" }),
  disconnect: () => call<{ ok: true }>({ op: "connection_remove" }),
  voices: (search?: string) => call<{ items: Voice[] }>({ op: "voices", search: search ?? null }).then((r) => r.items),
  makeAudio: (a: { scene_id: string; shot_id?: string | null; kind: AudioKind; text: string; voice_id?: string; voice_name?: string;
                   duration_s?: number | null; length_s?: number; instrumental?: boolean; styles?: string; sections?: ScoreSection[];
                   at_s?: number }) =>
    call<{ id: string }>({ op: "audio_create", ...a }),
  narrationStart: (id: string, atS: number) => call<{ ok: true }>({ op: "narration_start", id, at_s: atS }),
  audio: (sceneId: string) => call<{ items: AudioJob[] }>({ op: "audio_list", scene_id: sceneId }).then((r) => r.items),
  useAudio: (id: string, on: boolean) => call<{ ok: true }>({ op: "audio_use", id, on }),
  makeCut: (sceneId: string, format: CutFormat, opts: { fade: boolean; end_card: boolean; music_path: string | null; voice?: boolean; sfx?: boolean; captions?: boolean;
                                                         style?: EditStyle | null }) =>
    call<{ id: string }>({ op: "assembly_create", scene_id: sceneId, format, ...opts }),
  cuts: (sceneId: string) => call<{ items: Cut[] }>({ op: "assemblies", scene_id: sceneId }).then((r) => r.items),
  updateSeries: (seriesId: string, look?: Look, style?: string) =>
    call<{ ok: true }>({ op: "series_update", series_id: seriesId, look: look ?? null, style: style ?? null }),
  createCharacter: (seriesId: string, name: string, height: string, wardrobe: string, kind: Kind = "person", what = "") =>
    call<{ id: string }>({ op: "character_create", series_id: seriesId, name, height: height.trim() || null, wardrobe: wardrobe.trim() || null,
                           kind, what: what.trim() || null }),
  setCharacterRef: (id: string, path: string, consent = false) => call<{ ok: boolean }>({ op: "character_ref", character_id: id, path, consent }),
  // edit a character's card (2026-11-18): new frames and renders use it; finished ones keep what they were given
  updateCharacter: (id: string, name: string, height: string, wardrobe: string, kind: Kind, what: string) =>
    call<{ ok: boolean }>({ op: "character_update", character_id: id, name, height, wardrobe, kind, what }),
  createLocation: (seriesId: string, name: string, description: string) =>
    call<{ id: string }>({ op: "location_create", series_id: seriesId, name, description: description.trim() || null }),
  setLocationPlate: (id: string, path: string) => call<{ ok: boolean }>({ op: "location_plate", location_id: id, path }),
  setSceneLocation: (sceneId: string, locationId: string | null) => call<{ ok: boolean }>({ op: "scene_location", scene_id: sceneId, location_id: locationId }),
  setShotCast: (id: string, cast: string[]) => call<{ ok: boolean }>({ op: "shot_cast", shot_id: id, cast }),
  requestHeightCheck: (shotId: string) => call<{ job_id: string }>({ op: "height_request", shot_id: shotId }),
  requestCutouts: (shotId: string) => call<{ job_id: string }>({ op: "cutout_request", shot_id: shotId }),
  cutouts: (shotId: string) => call<{ job: CutoutJob | null }>({ op: "cutouts", shot_id: shotId }).then((r) => r.job),
  useCutout: (jobId: string, index: number, characterId: string) =>
    call<{ ok: boolean; path: string }>({ op: "cutout_use", job_id: jobId, index, character_id: characterId }),
};

// Reference cut-outs (2026-11-16): each character of a shot's start still cut out onto white, left to right.
export type Cutout = { index: number; path: string; url: string | null; box: number[]; warnings: string[]; plate_used?: boolean };
export type CutoutJob = { id: string; status: string; error: string | null; cutouts: Cutout[] };

// Any image the creator adds goes straight to storage with their own session, under <owner>/<folder>/
// (stills = start frames, characters = reference images, locations = empty-room plates).
export async function uploadImage(owner: string, folder: "stills" | "characters" | "locations", name: string, file: Blob, type: string): Promise<string> {
  const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
  const path = `${owner}/${folder}/${name}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("studio").upload(path, file, { contentType: type, upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

// A music track for a scene cut, uploaded with the creator's own session to <owner>/music/ (2026-11-19).
export async function uploadMusic(owner: string, file: Blob, name: string, type: string): Promise<string> {
  const ext = (name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "mp3";
  const path = `${owner}/music/track-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("studio").upload(path, file, { contentType: type || "audio/mpeg", upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

// Motion transfer files (2026-11-20): the source clip and reference images, to <owner>/motion/ (storage policy
// studio_files_write allows mp4 / mov / webm and png / jpg / webp there).
export async function uploadMotionFile(owner: string, kind: "source" | "ref", file: Blob, type: string): Promise<string> {
  const ext = type === "video/quicktime" ? "mov" : type === "video/webm" ? "webm" : type.startsWith("video/") ? "mp4"
    : type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
  const path = `${owner}/motion/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await supabase.storage.from("studio").upload(path, file, { contentType: type, upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

// Start stills go straight to storage with the creator's own session (bucket "studio", folder <owner>/stills/).
export const uploadStill = (owner: string, shotId: string, file: Blob, type: string) => uploadImage(owner, "stills", shotId, file, type);

// Frames the second opinion dismissed: reasons lines look like "ANATOMY: f20 REJECTED: ... | f24 REJECTED: ...".
export function dismissedFrames(reasons: string[] | null): Set<string> {
  const out = new Set<string>();
  for (const line of reasons || []) for (const m of line.matchAll(/\b(f\d+) REJECTED\b/g)) out.add(m[1]);
  return out;
}

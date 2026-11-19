// Shot status in plain words (direction B), shared by the scene board and the Workspace (2026-11-19). @anlim
import { c } from "./theme";
import type { ShotRow } from "./api";

export const GEN: Record<string, string> = {
  queued: "Queued", running: "Rendering", checking: "Checking", review: "Waiting for you", succeeded: "Done", failed: "Failed",
};

// The board's status chip, in plain words (2026-11-19, direction B wording): tone picks the colour.
export type Tone = "ok" | "call" | "busy" | "bad" | "idle";
export function chip(r: ShotRow): { text: string; tone: Tone } {
  const busy = (x: string | null) => !!x && ["queued", "running", "composing"].includes(x);
  if (r.has_approved_clip) return { text: "✓ Kept", tone: "ok" };
  if (r.frame_kind === "start" && busy(r.frame_status)) return { text: "Making start frame", tone: "busy" };
  if (r.frame_kind === "start" && r.frame_status === "ready") return { text: "! Start frame to check", tone: "call" };
  if (!r.has_start_frame) return { text: "Needs a start frame", tone: "idle" };
  if (!r.start_frame_approved) return { text: "! Approve start frame", tone: "call" };
  if (r.gen_status && ["queued", "running", "checking"].includes(r.gen_status)) return { text: "Rendering", tone: "busy" };
  if (r.gen_status === "review") return { text: "! Your call", tone: "call" };
  if (r.gen_status === "succeeded") return { text: "✓ Checked: keep it?", tone: "call" };
  if (r.gen_status === "failed") return { text: "Didn't pass: render again", tone: "bad" };
  if (r.frame_kind === "end" && busy(r.frame_status)) return { text: "Making end frame", tone: "busy" };
  return { text: "Ready to render", tone: "idle" };
}
export const TONE: Record<Tone, { bg: string; fg: string; line: string }> = {
  ok: { bg: c.passBg, fg: c.pass, line: c.passLine }, call: { bg: c.flagBg, fg: c.flag, line: c.flagLine },
  bad: { bg: c.failBg, fg: c.fail, line: c.failLine }, busy: { bg: "rgba(8,8,10,0.8)", fg: c.ink, line: c.line },
  idle: { bg: "rgba(8,8,10,0.8)", fg: c.sub, line: c.line },
};
export const pad2 = (n: number) => String(n).padStart(2, "0");

// Same words as studio.shot_kind's "walking" (keep in step). 2026-11-14, Londi's MiniMax labels: all 4 walks that
// ended frozen mid-stride ("ready to sprint") were 5 s clips; none of the 9 at 7 s did. Walks default to 7 s.
export const WALKING = /\b(walks?|walking|runs?|running|cross(es|ing)?|goes to|go to|moves? to|dances?|dancing|skips?|hops?|chases?|crawls?)\b/i;
export const suggestedSeconds = (action: string) => (WALKING.test(action) ? 7 : 5);


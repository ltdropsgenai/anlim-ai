// Shot compiler v1: series record -> provider input + checker spec. @anlim
// Words always ride with the approved start frame (the Phase 0 route: Kling 4.0, start frame only).
// Template wording is a first guess (design doc: "tune with the Phase 0 benchmark").

// A cast member is a person, an animal or an object (kind, 2026-11-16); "what" says which ("golden retriever").
const castLine = (c) => {
  const parts = [c.wardrobe, c.build].filter(Boolean);
  const who = c.what ? `${c.name} (${c.what})` : c.kind && c.kind !== "person" ? `${c.name} (${c.kind})` : c.name;
  return `${who}${parts.length ? `: ${parts.join("; ")}` : ""}`;
};

// Look words (2026-11-16): the prompts said "drawing style" for every series; photoreal ones keep a filmed look.
export const lookWords = (look) => look === "photoreal"
  ? "photographic look (real-world lighting, lens and colour grade; photoreal, not drawn or animated)"
  : "drawing style";
// What the checker's people count can rely on: only people, and only when no animal is in the shot (the detector calls
// cartoon animals and chibi children "teddy bear", which the count treats as people).
export const peopleCount = (chars) =>
  chars.some((c) => c.kind === "animal") ? undefined : chars.filter((c) => (c.kind || "person") === "person").length;
// The cast as the checker's frame routes take it (detector classes and matting, frame_check end_frame.subjects).
export const subjects = (chars) => chars.map((c) => ({ name: c.name, kind: c.kind || "person", what: c.what || null }));

// Height order sentence from height_units (the S2 start still had King bigger than Layana; the checker and the
// prompt both need the order stated).
function heightOrder(chars) {
  const h = chars.filter((c) => c.height_units != null).sort((a, b) => b.height_units - a.height_units);
  if (h.length < 2) return "";
  return `Relative heights, tallest first: ${h.map((c) => c.name).join(", ")}.`;
}

// Bump on every prompt change; the worker prints it at start and saves it with each job (2026-11-12: a worker started
// before a prompt change rendered 3 clips with the old prompt and nothing showed it).
export const COMPILER_VERSION = "2026-11-17.1 (look: cartoon/photoreal; cast kinds; path rule, watchers, end frame, minimax static shot, walk end)";

// Actions that move a character across the floor (same idea as frame_check/passthrough_check.MOVES).
const MOVES = /\b(walk|walks|walking|step|steps|run|runs|running|cross|crosses|goes|go to|moves? to|dances?)\b/i;

// 2026-11-12: Phase 0 S3 ("walks from the window across the room to the toy shelf") was rendered as a straight line
// at the coffee table's own depth in 4 of 4 bad clips - feet between the table's legs or on them (Londi's read).
// Saying the route costs nothing; catching it afterwards costs a render plus the check.
const PATH_RULE = "[PATH] Walking characters go AROUND furniture, never through it: pass in front of a table or sofa " +
  "(feet nearer the camera than its front legs) or behind it (hidden by it), curving around its end; feet never touch " +
  "the floor between a table's legs or on its legs.";

// 2026-11-12 (Londi): when one child moves, the others watch her - a character staring ahead while a playmate crosses
// the room reads as a cut-out. Added whenever a moving action has 2+ characters.
const WATCH_RULE = "[REACT] Every character who is not moving follows the moving character with their eyes and head the " +
  "whole time, turning as she or he passes; they stay where they are unless the action says otherwise.";

// 2026-11-13: MiniMax H3 moved the camera on 6 of 30 locked-camera renders (5 on S4/S5: push-in, pull-out, tilt).
// Hailuo's prompting guide recommends opening with "[Static shot]" and restating it in words
// (hailuoai.video/pages/blog/camera-movement-prompt-cheatsheet); it does not name H3, so this is under test.
// MiniMax only: Kling's prompt is unchanged.
const isLocked = (shot) => !shot.camera || /lock|static/i.test(shot.camera);
const MINIMAX_STATIC = "[CAMERA] Locked-off tripod: the camera stays completely still for the whole shot - no zoom, " +
  "no push-in or pull-out, no pan, no tilt. The framing, the room and the furniture stay exactly as in the first frame.";

// 2026-11-14 (Londi's MiniMax labels): 4 of 13 walks ended frozen mid-stride, "ready to sprint" - all 5 s clips; the
// 9 at 7 s, whose action also said "she stops", ended standing. Walks now default to 7 s (app) and always get an
// explicit ending. Same words as studio.shot_kind's "walking".
const WALKING = /\b(walks?|walking|runs?|running|cross(es|ing)?|goes to|go to|moves? to|dances?|dancing|skips?|hops?|chases?|crawls?)\b/i;
const WALK_END = "[END] The movement is finished well before the clip ends: for the last second the moving character stands " +
  "still with every foot planted on the floor and weight on all of them - not mid-stride, not leaning forward.";

export function prompt(shot, chars) {
  const moving = MOVES.test(shot.action);
  const minimax = /^minimax\//.test(shot.endpoint || "");
  const camera = minimax && isLocked(shot) ? MINIMAX_STATIC : shot.camera ? `[CAMERA] ${shot.camera}` : "[CAMERA] locked";
  return [
    minimax && isLocked(shot) ? "[Static shot]" : null,
    shot.style_prompt ? `[STYLE] ${shot.style_prompt}` : null,
    `[CAST] ${chars.map(castLine).join(" | ")}. ${heightOrder(chars)}`.trim(),
    shot.location_name ? `[SET] ${shot.location_name}${shot.location_description ? ` - ${shot.location_description}` : ""}` : null,
    `[ACTION] ${shot.action}`,
    moving ? PATH_RULE : null,
    moving && chars.filter((c) => c.kind !== "object").length > 1 ? WATCH_RULE : null,
    WALKING.test(shot.action) ? WALK_END : null,
    camera,
    `[RULES] Start exactly on the given first frame. Same characters, proportions and ${lookWords(shot.look)} throughout. ` +
      "Nobody else appears. No text or letters. No sound.",
  ].filter(Boolean).join("\n");
}

// Field names differ per model (fal pages read 2026-11-12):
//   Kling 4.0 (kling/v4/image-to-video): start_image_url, end_image_url, duration, resolution "720p"
//   MiniMax H3 (minimax/h3/image-to-video): image_url, end_image_url, duration, resolution "480P"|"768P"|"2K"|"4K",
//     prompt_expansion_mode (default "balanced" rewrites our prompt; "disabled" keeps it as written)
export function providerInput(shot, chars, startUrl, endUrl) {
  const p = prompt(shot, chars) + (endUrl ? "\n[END] Finish exactly on the given last frame." : "");
  const input = /^minimax\//.test(shot.endpoint || "")
    ? { prompt: p, image_url: startUrl, duration: shot.duration_s, resolution: shot.resolution, prompt_expansion_mode: "disabled" }
    : { prompt: p, start_image_url: startUrl, duration: shot.duration_s, resolution: shot.resolution };
  if (endUrl) input.end_image_url = endUrl;
  return input;
}

// Spec in the form frame_check/shot_qc.py reads (same keys as the Phase 0 cases).
export function checkerSpec(shot, chars, clip, out, startFrameLocal) {
  const cast = {};
  for (const c of chars) {
    cast[c.name.toUpperCase()] = [c.kind && c.kind !== "person" ? c.kind : null, c.what, c.wardrobe, c.build,
                                  c.height_units != null ? `height ${c.height_units}` : null]
      .filter(Boolean).join("; ") || "as in the reference";
  }
  const order = heightOrder(chars);
  return {
    shot_id: shot.id, clip, out,
    action: shot.action,
    cast,
    style: shot.look === "photoreal" ? "photo" : "cartoon",     // frame_check names; was always "cartoon" until 2026-11-16
    notes: [shot.style_prompt, `Exactly ${chars.length} characters (${chars.map((c) => c.kind || "person").join(", ")}); nobody else.`, order,
            `The clip must start on the approved start frame and stay in the same set and ${lookWords(shot.look)}. No text or letters.`]
      .filter(Boolean).join(" "),
    people: peopleCount(chars),
    subjects: subjects(chars),
    start_frame: startFrameLocal,
    camera: !shot.camera || /lock|static/i.test(shot.camera) ? "locked" : undefined,
    fps: 24,
    frame_check: {},
  };
}

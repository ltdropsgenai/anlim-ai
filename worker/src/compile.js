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
// No cast at all (a Home prompt: "an angry coach after his team lost") is not "0 people": the prompt itself says who is in
// it, so there is no count to hold the clip to (2026-11-21: every such clip said "0 people", the start frame showed 3,
// and the spec check stopped the review - NOT_REVIEWED). @anlim
// 2026-11-21 (global audit): a cast of 1 in "Maya walks through a busy market" is not "1 person in frame" either: the
// people the action asks for beyond the cast (a crowd, passers-by, an audience, a team) are expected, so there is no
// exact count. The test was built on Londi's own shots, which never had extras.
const EXTRAS = /\b(crowds?|crowded|busy|bustling|passers?-?by|pedestrians|audience|spectators|fans|onlookers|strangers|people|others|everyone|team(mates)?|players|class(mates|room)?|students|guests|customers|shoppers|commuters|dancers|band|choir|army|soldiers|party|wedding|market|stadium|concert|festival|parade|protest|queue)\b/i;
export const wantsExtras = (action) => EXTRAS.test(action || "");
// someone with a face in the shot (for the gaze line): a person word or a crowd word
const PEOPLE = /\b(man|men|woman|women|boy|girl|kid|child|children|person|people|player|players|goalkeeper|keeper|striker|teacher|students?|crowd|fans?|he|she|they|her|his)\b/i;
export const peopleCount = (chars, action = "") =>
  !chars.length || wantsExtras(action) || chars.some((c) => c.kind === "animal") ? undefined
    : chars.filter((c) => (c.kind || "person") === "person").length;
// Text: Londi's series never wanted words on screen, other creators do (a sign, a title, letters for a learning video).
const TEXT_WORDS = /\b(text|words?|letters?|alphabet|numbers?|digits?|sign|signs|signage|poster|banner|billboard|title|caption|subtitle|logo|label|menu|headline|writes?|writing|written|reads?|spells?|chalkboard|whiteboard|blackboard|neon)\b|["\u201c][^"\u201d]+["\u201d]/i;
export const wantsText = (action) => TEXT_WORDS.test(action || "");
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
export const COMPILER_VERSION = "2026-11-27.1";   // camera moving through the cut (2026-11-27)

// Actions that move a character across the floor (same idea as frame_check/passthrough_check.MOVES).
const MOVES = /\b(walk|walks|walking|step|steps|run|runs|running|cross|crosses|goes|go to|moves? to|dances?)\b/i;

// 2026-11-12: Phase 0 S3 ("walks from the window across the room to the toy shelf") was rendered as a straight line
// at the coffee table's own depth in 4 of 4 bad clips - feet between the table's legs or on them (Londi's read).
// Saying the route costs nothing; catching it afterwards costs a render plus the check.
const PATH_RULE = "[PATH] If there is furniture, walking characters go AROUND it, never through it: pass in front of a table or sofa " +
  "(feet nearer the camera than its front legs) or behind it (hidden by it), curving around its end; feet never touch " +
  "the floor between a table's legs or on its legs.";

// 2026-11-12 (Londi): when one child moves, the others watch her - a character staring ahead while a playmate crosses
// the room reads as a cut-out. Added whenever a moving action has 2+ characters.
// 2026-11-21 (global audit): softened - "watch her the whole time" was the look of Londi's kids' episodes, not a rule
// for every creator's scene (people at a party do not all turn to stare at one walker).
const WATCH_RULE = "[REACT] Characters who are not moving stay aware of the one who moves (they do not stare blankly ahead " +
  "like cut-outs); they stay where they are unless the action says otherwise.";

// 2026-11-13: MiniMax H3 moved the camera on 6 of 30 locked-camera renders (5 on S4/S5: push-in, pull-out, tilt).
// Hailuo's prompting guide recommends opening with "[Static shot]" and restating it in words
// (hailuoai.video/pages/blog/camera-movement-prompt-cheatsheet); it does not name H3, so this is under test.
// MiniMax only: Kling's prompt is unchanged.
// 2026-11-21 (global audit): the camera is locked only when the creator says so. It was locked whenever nothing was said -
// right for Londi's fixed-camera episodes, wrong for everyone else: the first new user's "children learning video" was
// flagged for a camera move nobody had forbidden. No camera words = the model's choice, and no locked-camera check.
const isLocked = (shot) => !!shot.camera && /lock|static|tripod|still camera/i.test(shot.camera);

// 2026-11-20 (held-out test): a Home prompt has no camera field, so every model was told "camera locked" and the
// checker failed clips whose camera moved - even when the prompt itself asked for "a slow push-in" or "a tracking
// shot" (MiniMax espresso, Wan / Seedance Tokyo alley). When the action describes the camera, the camera follows
// the action's words: no lock line, no locked-camera check.
const CAMERA_WORDS = new RegExp("\\bcamera\\s+(?:\\w+ly\\s+)?(?:track|follow|move|glide|pan|tilt|orbit|rise|pull|push|zoom|" +
  "dolly|dollie|crane|circle|swoop|sweep|fly|flie|race|dive|rack|settle)\\w*|\\btracking shot|\\bpush[- ]in|" +
  "\\bpull[- ]?(?:back|out)\\b|\\bdolly\\b|\\bpanning\\b|\\bpans? (?:left|right|across|to)|\\btilts? (?:up|down)|" +
  "\\bzoom[- ](?:in|out)\\b|\\borbit(?:s|ing)?\\b|\\bcrane shot|\\bhandheld|\\b(?:drone|aerial|fpv) shot|\\bdolly zoom", "i");
export const describesCamera = (text) => CAMERA_WORDS.test(text || "");
const cameraFree = (shot) => !shot.camera && describesCamera(shot.action);
const MINIMAX_STATIC = "[CAMERA] Locked-off tripod: the camera stays completely still for the whole shot - no zoom, " +
  "no push-in or pull-out, no pan, no tilt. The framing, the room and the furniture stay exactly as in the first frame.";

// 2026-11-14 (Londi's MiniMax labels): 4 of 13 walks ended frozen mid-stride, "ready to sprint" - all 5 s clips; the
// 9 at 7 s, whose action also said "she stops", ended standing. Walks now default to 7 s (app) and always get an
// explicit ending. Same words as studio.shot_kind's "walking".
const WALKING = /\b(walks?|walking|runs?|running|cross(es|ing)?|goes to|go to|moves? to|dances?|dancing|skips?|hops?|chases?|crawls?)\b/i;
// 2026-11-21 (global audit): no longer forces a stop (a chase or a run-and-jump may keep going to the end); it still
// rules out the frozen mid-stride ending.
const WALK_END = "[END] The clip never ends frozen mid-stride: by the last second the movement has either finished, with " +
  "feet planted and weight on them, or is still clearly under way.";

const noText = (shot) => wantsText(shot.action) ? "Only the text the action asks for, spelled correctly; no other text. "
  : "No text or letters. ";

// 2026-11-22 (Londi's promo, shot db987418): Kling 4.0 put a hard cut at 2.0 s of a 10 s clip, from a medium shot to a
// full-body wide, which read as the camera jumping. A shot is one take unless its words ask for a cut.
const CUT_WORDS = /\b(cuts? to|smash cut|jump cut|montage|split screen|several shots|multiple shots)\b/i;
const oneTake = (shot) => CUT_WORDS.test(`${shot.action || ""} ${shot.camera || ""}`) ? ""
  : "One continuous take: no cuts, no jump to another framing or angle; the framing changes only by the camera move described. ";

// 2026-11-23 (Londi's lip sync test): a clip whose people already talk fights the lip sync; the mouths move to the
// video model's own made-up speech, and the synced take followed the voice no better than the unsynced one. When the
// shot's voiceover exists before the clip is made, the people keep their mouths closed and the lip sync adds the
// speech. The one test clip made this way synced well (VEED; frame_check/lipsync_check.py r 0.46).
const MOUTHS = "[MOUTHS] Nobody speaks or mouths words: lips stay closed and still. Faces stay alive through the eyes, brows " +
  "and small head movements. The voice and its lip movements are added afterwards.";

// 2026-11-24 (crowd test, Londi): 2 of 3 crowd clips came out with a frozen crowd (a stadium painted on, a class that
// never moved) and the market's shoppers popped in and out. Crowd shots say the crowd stays alive and stable.
const CROWD = "[CROWD] The background people stay alive the whole time: they keep doing what the action gives them " +
  "(cheering, walking, browsing, or small natural movements while they watch or listen); nobody freezes like a painted backdrop. " +
  "They stay the same people in the same clothes: each one walks in or out through a frame edge or behind something, " +
  "never appears, vanishes or splits in the open. Their mouths stay closed unless the action has them cheer, shout, sing or talk.";
export const crowdLine = (action) => wantsExtras(action) ? CROWD : null;

// 2026-11-24 (Londi, first end-to-end story cut): three things the reference edit had and our shots did not.
// 1. Slow motion: the cut's speed setting stops at 50% and smears there; a strike slowed to 60% still read as real time.
//    When the shot asks for slow motion, the video model is asked to film it that way (a high-speed camera look).
const SLOW = /\b(slow[ -]?motion|slow[ -]?mo|slowmo|in slow mo)\b/i;
export const slowLine = (action) => SLOW.test(action || "")
  ? "[SPEED] Filmed in true slow motion, like a high-speed camera: every movement, the ball, the rain and any spray move " +
    "about four times slower than real time, smooth and continuous, with no stutter and no freeze." : null;
// 2. Gaze: the goalkeeper faced the camera instead of the play. People look at what they are doing, not into the lens.
export const GAZE = "People look at what they are doing or watching (the ball, the play, the person speaking, the " +
  "thing in their hands), never into the camera, unless the description asks for it.";
// 3. Camera: fast action with no camera words was often filmed from a still camera; the reference's shots move.
//    Only when the creator wrote no camera words and the action is energetic; a camera they name always wins.
const ENERGETIC = /\b(sprints?|sprinting|dribbles?|dribbling|strikes?|kicks?|kicking|shoots?|shooting|scores?|dives?|diving|chases?|chasing|races?|racing|leaps?|jumps?|tackles?|slides?|fights?|punch(es)?|swings?|spins?|charges?|celebrates?)\b/i;
export const actionCameraLine = (shot) => !shot.camera && !describesCamera(shot.action) && ENERGETIC.test(shot.action || "")
  ? "[CAMERA] A moving, cinematic camera that follows the action (tracking alongside, or a fast push-in); not a static view." : null;

// 4. Moving at the cut (2026-11-27, Buzzy ad analysis: its shot changes land while the camera is moving, so one move
//    carries into the next and the cut hides). Only when the creator named no camera for this shot and its action does
//    not describe one: if the shot before or after it names a camera direction (its camera field or its action, in
//    English, Spanish or French; the neighbours are not translated, so this costs nothing), this shot starts or ends
//    moving the same way. A locked or static neighbour, or none with a direction, adds nothing.
const DIRS = [
  ["left", /\b(?:pans?|panning|tracks?|tracking|trucks?|moves?|moving|glides?|slides?|swings?|whips?|dollies|dolly|orbits?|circles?)\s+(?:\w+\s+)?(?:to the )?left\b|\b(?:izquierda|gauche)\b/i],
  ["right", /\b(?:pans?|panning|tracks?|tracking|trucks?|moves?|moving|glides?|slides?|swings?|whips?|dollies|dolly|orbits?|circles?)\s+(?:\w+\s+)?(?:to the )?right\b|\b(?:derecha|droite)\b/i],
  ["forward", /\bpush(?:es|ing)?[- ]in\b|\bdolly(?:ing)?[- ]in\b|\bzoom(?:s|ing)?[- ]in\b|\bmoves? (?:in|forward|closer)\b|\bacerc|\bavance|\bse rapproch|\bzoom avant/i],
  ["back", /\bpull(?:s|ing)?[- ]?(?:back|out)\b|\bdolly(?:ing)?[- ]out\b|\bzoom(?:s|ing)?[- ]out\b|\bmoves? (?:back|away)\b|\baleja|\brecul|\bzoom arri[eè]re/i],
  ["up", /\btilts? up\b|\bcranes? up\b|\brises?\b|\bpedestal up\b|\bsube\b|\bmonte\b/i],
  ["down", /\btilts? down\b|\bcranes? down\b|\bdescends?\b|\bpedestal down\b|\bbaja\b|\bdescend\b/i],
];
const LOCKED = /lock|static|tripod|still camera|fija|fixe|tr[ií]pode/i;
export function cameraDir(n) {
  if (!n) return null;
  const text = n.camera || (describesCamera(n.action) ? n.action : "");
  if (!text || LOCKED.test(n.camera || "")) return null;
  return (DIRS.find(([, re]) => re.test(text)) || [null])[0];
}
const DIR_WORDS = { left: "to the left", right: "to the right", forward: "forward (pushing in)", back: "backward (pulling out)",
                    up: "upward", down: "downward" };
export function cutMotionLine(shot) {
  if (shot.camera || describesCamera(shot.action)) return null;
  const from = cameraDir(shot.prev_shot), to = cameraDir(shot.next_shot);
  if (!from && !to) return null;
  return "[CUT] So the edit can cut on movement: " + [
    from ? `the camera is already moving ${DIR_WORDS[from]} in the first half second, carrying on the previous shot's move, then settles into this shot` : null,
    to ? `${from ? "and " : "the camera "}drifts ${DIR_WORDS[to]} in the last half second, leading into the next shot's move` : null,
  ].filter(Boolean).join(" ") + ". Smooth and gentle, never a jump.";
}

export function prompt(shot, chars) {
  const moving = MOVES.test(shot.action);
  const minimax = /^minimax\//.test(shot.endpoint || "");
  const camera = minimax && isLocked(shot) ? MINIMAX_STATIC : shot.camera ? `[CAMERA] ${shot.camera}`
    : cameraFree(shot) ? "[CAMERA] As the action describes." : actionCameraLine(shot);
  return [
    minimax && isLocked(shot) ? "[Static shot]" : null,
    shot.style_prompt ? `[STYLE] ${shot.style_prompt}`
      : shot.from_text ? `[STYLE] ${shot.look === "photoreal" ? "Photoreal live action: real-world lighting, lens and colour grade, not drawn or animated."
                                                              : "Cartoon animation: a drawn, animated look, not photographic."}` : null,
    chars.length ? `[CAST] ${chars.map(castLine).join(" | ")}. ${heightOrder(chars)}`.trim() : null,
    shot.location_name ? `[SET] ${shot.location_name}${shot.location_description ? ` - ${shot.location_description}` : ""}` : null,
    `[ACTION] ${shot.action}`,
    shot.has_voiceover && chars.some((c) => (c.kind || "person") === "person") ? MOUTHS : null,
    crowdLine(shot.action),
    slowLine(shot.action),
    chars.length || PEOPLE.test(shot.action || "") ? `[GAZE] ${GAZE}` : null,
    moving ? PATH_RULE : null,
    moving && chars.filter((c) => c.kind !== "object").length > 1 ? WATCH_RULE : null,
    WALKING.test(shot.action) ? WALK_END : null,
    camera,
    minimax && isLocked(shot) ? null : cutMotionLine(shot),
    shot.from_text
      ? `[RULES] ${oneTake(shot)}Only what the action describes appears. ${noText(shot)}No sound.`
      : `[RULES] Start exactly on the given first frame. ${oneTake(shot)}Same characters, proportions and ${lookWords(shot.look)} throughout. ` +
        `${wantsExtras(shot.action) ? "Only the extras the action calls for join them." : "Nobody else appears."} ${noText(shot)}No sound.`,
  ].filter(Boolean).join("\n");
}

// Field names differ per model. One adapter per fal endpoint family; an endpoint with no adapter is refused (it used
// to get Kling-shaped input silently). Schemas read from each model's fal llms.txt page, 2026-11-19 (Kling 4.0 and
// MiniMax H3 2026-11-12). Model audio is always off where the model allows it (it is stripped after download anyway).
//   Kling 4.0 (kling/v4/image-to-video): start_image_url, end_image_url, duration (number), resolution "720p"
//   MiniMax H3 (minimax/h3/image-to-video): image_url, end_image_url, duration, resolution "768P", prompt_expansion_mode
//   Kling 3.0 Pro (fal-ai/kling-video/v3/pro/image-to-video): start_image_url, end_image_url, duration "3".."15" (string),
//     generate_audio (default true; $0.112/s off vs $0.168/s on), no resolution field
//   Wan 2.7 (fal-ai/wan/v2.7/image-to-video): image_url, end_image_url, duration 2..15 (number), resolution "720p"|"1080p"
//     (default 1080p), enable_prompt_expansion (default true rewrites our prompt)
//   Seedance 2.0 (bytedance/seedance-2.0/image-to-video): image_url, end_image_url, duration "4".."15"|"auto" (string),
//     resolution "720p", aspect_ratio "auto" (from the image), generate_audio (same price either way)
//   Kling 4.0 text-to-video (kling/v4/text-to-video, 2026-11-20): prompt, duration 3..30, resolution "720p",
//     aspect_ratio (default 16:9; Home's prompt stills are 16:9 too), no image fields
const ADAPTERS = [
  // 2026-11-21: the project's shape (series.aspect); all three take 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 (fal pages read 2026-11-21)
  { match: /^kling\/v4\/text-to-video/, build: (p, s) => ({ prompt: p, duration: s.duration_s, resolution: s.resolution, aspect_ratio: s.aspect || "16:9" }) },
  // MiniMax H3 (minimax/h3/text-to-video) and Seedance 2.0 (bytedance/seedance-2.0/text-to-video), fal pages read
  // 2026-11-20: same fields as their image-to-video minus the image, plus aspect_ratio (16:9 like Kling's)
  { match: /^minimax\/h3\/text-to-video/, build: (p, s) => ({ prompt: p, duration: s.duration_s, resolution: s.resolution,
                                                                 aspect_ratio: s.aspect || "16:9", prompt_expansion_mode: "disabled" }) },
  { match: /^bytedance\/seedance-2\.0\/text-to-video/, build: (p, s) => ({ prompt: p, duration: String(s.duration_s),
                                                                 resolution: s.resolution, aspect_ratio: s.aspect || "16:9", generate_audio: false }) },
  { match: /^mock\/t2v/, build: (p, s) => ({ prompt: p, duration: s.duration_s, resolution: s.resolution, aspect_ratio: s.aspect || "16:9" }) },
  { match: /^kling\/v4\//, build: (p, s, u) => ({ prompt: p, start_image_url: u, duration: s.duration_s, resolution: s.resolution }) },
  { match: /^minimax\//, build: (p, s, u) => ({ prompt: p, image_url: u, duration: s.duration_s, resolution: s.resolution,
                                                prompt_expansion_mode: "disabled" }) },
  { match: /^fal-ai\/kling-video\/v3\//, build: (p, s, u) => ({ prompt: p, start_image_url: u, duration: String(s.duration_s),
                                                                  generate_audio: false }) },
  { match: /^fal-ai\/wan\/v2\.7\//, build: (p, s, u) => ({ prompt: p, image_url: u, duration: s.duration_s, resolution: s.resolution,
                                                             enable_prompt_expansion: false }) },
  { match: /^bytedance\/seedance-2\.0\//, build: (p, s, u) => ({ prompt: p, image_url: u, duration: String(s.duration_s),
                                                                  resolution: s.resolution, aspect_ratio: "auto", generate_audio: false }) },
  { match: /^mock\//, build: (p, s, u) => ({ prompt: p, start_image_url: u, duration: s.duration_s, resolution: s.resolution }) },
];

export function providerInput(shot, chars, startUrl, endUrl) {
  const a = ADAPTERS.find((x) => x.match.test(shot.endpoint || ""));
  if (!a) throw Object.assign(new Error(`no input adapter for model endpoint ${shot.endpoint}`), { permanent: true });
  const p = prompt(shot, chars) + (endUrl ? "\n[END] Finish exactly on the given last frame." : "");
  const input = a.build(p, shot, startUrl);
  if (endUrl) input.end_image_url = endUrl;
  return input;
}

// Spec in the form frame_check/shot_qc.py reads (same keys as the Phase 0 cases).
export function checkerSpec(shot, chars, clip, out, startFrameLocal, fps = 24) {
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
    notes: [shot.style_prompt,
            chars.length ? `${chars.length} cast character${chars.length > 1 ? "s" : ""} (${chars.map((c) => c.kind || "person").join(", ")})` +
              (wantsExtras(shot.action) ? "; extras the action calls for are expected." : "; nobody else.") : null, order,
            `The clip must start on the approved start frame and stay in the same set and ${lookWords(shot.look)}.` +
              (wantsText(shot.action) ? " Text the action asks for is expected." : " No text or letters.")]
      .filter(Boolean).join(" "),
    people: peopleCount(chars, shot.action),
    crowd: wantsExtras(shot.action) || undefined,       // 2026-11-24: the checker's crowd rules (ai_review CROWD)
    subjects: subjects(chars),
    start_frame: startFrameLocal,
    camera: isLocked(shot) ? "locked" : undefined,     // a camera the action describes is not checked as locked
    fps,                                  // the clip's own rate (Wan 2.7 delivers 30 fps; was always 24)
    frame_check: {},
  };
}

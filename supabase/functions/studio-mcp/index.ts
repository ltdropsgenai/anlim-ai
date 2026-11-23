// studio-mcp: anlim as an MCP server, so a creator can work on their anlim projects from Claude, ChatGPT or any MCP
// client (2026-11-21, Londi). @anlim
//
// Transport: MCP Streamable HTTP, stateless, JSON responses (no SSE stream). Served at https://mcp.anlim.ai/mcp
// (a Vercel rewrite on anlim-web to this function).
// Auth: OAuth 2.1 through Supabase Auth's OAuth server (dynamic client registration). Every call needs the creator's
// access token; without one the answer is 401 with a pointer to the protected-resource metadata, which names
// Supabase Auth as the authorization server (claude.com/docs/connectors/building/authentication).
// What a call can do is what the creator can do in the app: every query runs as the creator (RLS), and "create"
// goes through studio.quick_create with its own balance checks. Decisions (Londi, 2026-11-21): only paid accounts may
// create from chat; no credit cap per call; at most 5 creates per 10 minutes per account from chat.
// v2 (2026-11-22, Londi: "We need it to be fully functional from chat"): uploads (through a link to anlim.ai/upload,
// since a chat cannot hand files to a server), characters with reference photos, locations and backgrounds, shots,
// start images (including a new setup with the cast), animating, keeping or rejecting clips, motion transfer, models
// and scene cuts. Every tool that spends credits is paid-only and shares one limit: 10 per 10 minutes from chat
// ("create" keeps its own 5).
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const BUCKET = "studio";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const RESOURCE = Deno.env.get("MCP_RESOURCE_URL") || "https://mcp.anlim.ai/mcp";
const METADATA_URL = new URL("/.well-known/oauth-protected-resource", RESOURCE).toString();
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const CREATE_LIMIT = 5, CREATE_WINDOW_MIN = 10, SPEND_LIMIT = 10;
// 2026-11-23 (review): sound runs on the creator's own ElevenLabs credits and cuts on anlim's worker; neither had a limit
// from chat, so a looping agent could drain one or hold the other.
const AUDIO_TOOLS = ["make_voiceover", "make_sound_effect", "make_score"], AUDIO_LIMIT = 15, CUT_LIMIT = 6;
const SPEND_TOOLS = ["make_start_image", "make_end_image", "animate", "motion_transfer", "add_location"];
const APP = "https://anlim.ai";
const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};
const json = (o: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } });

function asUser<T>(uid: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true),
                    set_config('request.jwt.claim.sub', ${uid}, true)`;
    await tx`set local role authenticated`;
    return fn(tx);
  });
}
async function sign(path: string | null) {
  if (!path) return null;
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, 3600);
  return error ? null : data.signedUrl;
}

// ---- tools
const TOOLS = [
  { name: "list_projects", title: "List projects",
    description: "Lists the creator's anlim projects (id, name, look, shape and number of shots). Use a project's id with create to add a shot to it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "get_balance", title: "Credit balance",
    description: "The creator's anlim credit balance (credits available to spend), their plan, and whether the account can create from chat (paid accounts only).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "list_recent_clips", title: "Recent clips",
    description: "The creator's most recent clips, newest first: title (the prompt), project, status (to_review, kept, rejected) and shot id. Use get_creation with a shot id for a link to the clip.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20, default: 10 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "get_creation", title: "Check an image or clip",
    description: "Status of a shot (by shot id): its start image (and whether it waits for approval), its clip, the check's findings, " +
      "with links once they are ready. Clips usually take 3 to 5 minutes (motion transfer 8 to 15); links last one hour.",
    inputSchema: { type: "object", properties: { shot_id: { type: "string", description: "The shot_id that create returned" } }, required: ["shot_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "create", title: "Make an image or a video clip",
    description: "Makes an image, or a short video clip, from a description, using the creator's anlim credits (paid accounts only; " +
      "a 5 s clip costs about 200 credits, an image 20). Saved in a new project, or in project_id. Returns a shot_id: call get_creation " +
      "with it to follow progress and get the links. Describe one shot: who or what is in it, what happens, the setting, and camera words if wanted.",
    inputSchema: { type: "object", properties: {
      prompt: { type: "string", minLength: 8, maxLength: 2000, description: "What the shot shows and what happens in it" },
      output: { type: "string", enum: ["video", "image"], default: "video" },
      look: { type: "string", enum: ["cartoon", "photoreal"], default: "cartoon", description: "For a new project (an existing project keeps its look)" },
      seconds: { type: "integer", enum: [5, 10], default: 5, description: "Clip length (videos)" },
      aspect: { type: "string", enum: ASPECTS, default: "16:9", description: "Frame shape for a new project: 16:9 landscape, 9:16 vertical (Shorts, Reels, TikTok), 1:1 square, 4:3, 3:4, 21:9" },
      project_id: { type: "string", description: "Add the shot to this project (from list_projects); leave out for a new project" },
    }, required: ["prompt"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  // ---- v2: files, cast, shots, review, motion transfer, cuts (2026-11-22)
  { name: "get_upload_link", title: "Upload photos or videos",
    description: "A chat cannot send files to anlim directly. This returns a link to anlim.ai/upload: give it to the creator, they drop " +
      "their photos (reference images, backgrounds, start images) or videos (motion transfer sources) there, and each file gets an " +
      "upload id. Then call list_uploads to see them and use the ids with add_character, add_location, set_start_image or motion_transfer.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "list_uploads", title: "Uploaded files",
    description: "The creator's recent uploads from anlim.ai/upload, newest first: upload id, kind (image or video), length for videos, when.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 30, default: 10 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "get_project", title: "Project details",
    description: "One project: look, shape, scenes, its characters (with or without a reference photo), locations (with or without a " +
      "background), and every shot with its start image, clip and review state. Use it to see what a project needs next.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "new_project", title: "New project",
    description: "Creates an empty project (no credits). Use it before adding characters, locations and shots by hand.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      look: { type: "string", enum: ["cartoon", "photoreal"], default: "photoreal" },
      aspect: { type: "string", enum: ASPECTS, default: "16:9" },
      style: { type: "string", maxLength: 1000, description: "Optional style notes applied to every image and clip" },
    }, required: ["name"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "add_character", title: "Add a character",
    description: "Adds a character to a project with a reference photo (an upload id from list_uploads), so start images can show that " +
      "person, animal or object. For a real person, use a clear photo of the face, ideally from the front. Free.",
    inputSchema: { type: "object", properties: {
      project_id: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 100 },
      upload_id: { type: "string", description: "The reference photo, from list_uploads" },
      kind: { type: "string", enum: ["person", "animal", "object"], default: "person" },
      description: { type: "string", maxLength: 200, description: "Optional, e.g. 'a tall man in his thirties with a short beard'" },
      wardrobe: { type: "string", maxLength: 500, description: "Optional: what they wear in this project" },
    }, required: ["project_id", "name", "upload_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "add_location", title: "Add a location",
    description: "Adds a location (a setting) to a project and makes it the location of the project's latest scene. Its background (an " +
      "empty view of the setting, needed for a new setup with the cast) comes from an upload (upload_id, free), or from the image of " +
      "a shot (from_shot_id: the image is used as it is, free; set remove_people true to have the people taken out first, 20 credits).",
    inputSchema: { type: "object", properties: {
      project_id: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 100 },
      description: { type: "string", maxLength: 500 },
      upload_id: { type: "string" }, from_shot_id: { type: "string" },
      remove_people: { type: "boolean", default: false },
    }, required: ["project_id", "name"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "add_shot", title: "Add a shot",
    description: "Adds a shot to the project's latest scene (free): what happens, its length, optional camera words, and which characters " +
      "are in it (names; all of them if left out). Then make its start image with make_start_image (or set_start_image) and animate it.",
    inputSchema: { type: "object", properties: {
      project_id: { type: "string" },
      action: { type: "string", minLength: 8, maxLength: 2000, description: "What happens in the shot" },
      seconds: { type: "integer", minimum: 3, maximum: 15, default: 5 },
      camera: { type: "string", maxLength: 200, description: "Optional: 'locked', 'slow push-in', 'handheld'... Left out, the model chooses." },
      characters: { type: "array", items: { type: "string" }, maxItems: 6, description: "Character names in this shot" },
    }, required: ["project_id", "action"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  // ---- v2.1 (2026-11-22, the promo test: no way to change a wardrobe, a shot's words, or the order of shots from chat)
  { name: "update_character", title: "Change a character",
    description: "Changes a character's description or wardrobe (what they wear in this project; for a person it replaces the clothes " +
      "of their reference photo in new start images). Optionally a new reference photo (upload id). Free.",
    inputSchema: { type: "object", properties: {
      project_id: { type: "string" }, name: { type: "string", description: "The character's current name" },
      new_name: { type: "string", minLength: 1, maxLength: 100 }, description: { type: "string", maxLength: 200 },
      wardrobe: { type: "string", maxLength: 500 }, upload_id: { type: "string", description: "A new reference photo" },
    }, required: ["project_id", "name"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "update_shot", title: "Change a shot",
    description: "Changes a shot's words (what happens), camera or length before it is animated again. Free.",
    inputSchema: { type: "object", properties: {
      shot_id: { type: "string" }, action: { type: "string", minLength: 8, maxLength: 2000 },
      camera: { type: "string", maxLength: 200 }, seconds: { type: "integer", minimum: 3, maximum: 15 },
    }, required: ["shot_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "move_shot", title: "Move a shot",
    description: "Moves a shot one place earlier or later in its scene (cuts follow this order). Free.",
    inputSchema: { type: "object", properties: { shot_id: { type: "string" }, direction: { type: "string", enum: ["earlier", "later"] } },
      required: ["shot_id", "direction"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "delete_shot", title: "Delete a shot",
    description: "Deletes a shot that has no clips yet (shots with clips are kept; leave them out of a cut by not keeping them, " +
      "or move them). Cannot be undone: confirm with the creator first.",
    inputSchema: { type: "object", properties: { shot_id: { type: "string" } }, required: ["shot_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  // ---- v2.2 (2026-11-22): end images with the cast, and trimming clips
  { name: "make_end_image", title: "Make a shot's end image",
    description: "Makes the image a shot's clip must end on (paid accounts; about 20 credits). The video model then moves from the " +
      "start image to it. Mode 'with_cast' (default) places the shot's characters from their reference photos onto the approved start " +
      "image: the way to have someone appear, re-form or walk in with their real face. Mode 'edit' changes the start image as the " +
      "instruction says, with no reference photos. Check it with get_creation, then approve_end_image.",
    inputSchema: { type: "object", properties: {
      shot_id: { type: "string" }, instruction: { type: "string", minLength: 8, maxLength: 1000, description: "Where everyone is and what they are doing at the end" },
      mode: { type: "string", enum: ["with_cast", "edit"], default: "with_cast" },
    }, required: ["shot_id", "instruction"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "approve_end_image", title: "Approve or discard an end image",
    description: "Approves the shot's end image that is waiting (the next animate uses it), or discards it.",
    inputSchema: { type: "object", properties: { shot_id: { type: "string" }, decision: { type: "string", enum: ["approve", "discard"] } },
      required: ["shot_id", "decision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "remove_end_image", title: "Remove a shot's end image",
    description: "Removes the shot's end image, so the next clip ends wherever the video model takes it. Free.",
    inputSchema: { type: "object", properties: { shot_id: { type: "string" } }, required: ["shot_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "trim_clip", title: "Trim a shot's clip",
    description: "Sets how many seconds the scene's cut leaves out at the start and at the end of the shot's kept clip (the clip " +
      "itself is not changed; 0 and 0 undoes it). At least 1 s is kept. Then make_cut again. Free.",
    inputSchema: { type: "object", properties: {
      shot_id: { type: "string" },
      cut_start_seconds: { type: "number", minimum: 0, maximum: 60, default: 0 },
      cut_end_seconds: { type: "number", minimum: 0, maximum: 60, default: 0 },
    }, required: ["shot_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "set_clip_speed", title: "Slow down or speed up a shot",
    description: "Sets the speed of the shot's kept clip in the scene's cut: 0.5 (half speed) to 2 (double); 1 is normal. Slower " +
      "speeds use motion interpolation (new in-between frames), good to about 0.7; beyond that, re-animating a longer shot looks " +
      "more natural. Trims count in the clip's own seconds, before the speed change. Then make_cut again. Free.",
    inputSchema: { type: "object", properties: { shot_id: { type: "string" }, speed: { type: "number", minimum: 0.5, maximum: 2 } },
      required: ["shot_id", "speed"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  // ---- v2.4 (2026-11-22): sound, on the creator's own ElevenLabs account (connected in anlim: Account > Connections)
  { name: "list_voices", title: "Voices",
    description: "The voices in the creator's ElevenLabs library (their cloned voices, saved and default voices): id, name, kind. " +
      "Needs ElevenLabs connected in anlim (Account > Connections).",
    inputSchema: { type: "object", properties: { search: { type: "string", maxLength: 60 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: "make_voiceover", title: "Make a shot's voiceover",
    description: "Speaks a line over a shot with an ElevenLabs voice (eleven_v3: audio tags like [whispers], [sighs], [pause] set the " +
      "delivery). It starts with the shot in the cut. Uses the creator's ElevenLabs credits, not anlim's. Follow it with list_audio.",
    inputSchema: { type: "object", properties: {
      shot_id: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 3000 },
      voice_id: { type: "string", description: "From list_voices" },
    }, required: ["shot_id", "text", "voice_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: "make_sound_effect", title: "Make a shot's sound effect",
    description: "A sound effect for a shot (ElevenLabs), 0.5 to 30 s, starting with the shot. Creator's ElevenLabs credits.",
    inputSchema: { type: "object", properties: {
      shot_id: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 450 },
      seconds: { type: "number", minimum: 0.5, maximum: 30 },
    }, required: ["shot_id", "text"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: "make_score", title: "Compose the scene's score",
    description: "Composes an instrumental score for the project's latest scene (ElevenLabs Music v2.5, the creator's ElevenLabs " +
      "credits). styles: the whole score (genre, instruments, tempo). By default it follows the shots: one section per kept shot, " +
      "exactly as long as the shot is in the cut (trims and speed included), so the music changes on the cut; moods gives each " +
      "section its own mood, in shot order. follow_shots false makes one piece the length of the cut. Follow it with list_audio.",
    inputSchema: { type: "object", properties: {
      project_id: { type: "string" }, styles: { type: "string", minLength: 3, maxLength: 1000 },
      moods: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 30, description: "One per kept shot, in order" },
      follow_shots: { type: "boolean", default: true },
    }, required: ["project_id", "styles"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: "list_audio", title: "Sound in a project",
    description: "The voiceovers, sound effects and scores of the project's latest scene: id, shot, length, which take is in the cut, " +
      "status or error, and a link (one hour).",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "use_audio", title: "Choose the take for the cut",
    description: "Puts a finished take (audio id from list_audio) in the cut, replacing the other take of the same kind for that shot " +
      "(or the scene's score), or leaves it out.",
    inputSchema: { type: "object", properties: { audio_id: { type: "string" }, use: { type: "boolean", default: true } },
      required: ["audio_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "make_start_image", title: "Make a shot's start image",
    description: "Makes the first frame of a shot (paid accounts; about 20 credits). Modes: 'new_setup' places the shot's characters " +
      "(their reference photos) in the scene's location background as the instruction says, the way to put a real person in a shot; " +
      "'prompt' draws it from words only; 'continue' starts from the last frame of the previous shot's kept clip (free); 'reposition' " +
      "moves the characters of an existing frame. Then check it with get_creation and approve it (approve_start_image) or animate it.",
    inputSchema: { type: "object", properties: {
      shot_id: { type: "string" },
      mode: { type: "string", enum: ["new_setup", "prompt", "continue", "reposition"] },
      instruction: { type: "string", maxLength: 1000, description: "Where everyone is and what they are doing at the start" },
    }, required: ["shot_id", "mode"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "set_start_image", title: "Use an uploaded image as a start image",
    description: "Uses one of the creator's uploaded images (upload id) as a shot's first frame, approved. Free.",
    inputSchema: { type: "object", properties: { shot_id: { type: "string" }, upload_id: { type: "string" } },
      required: ["shot_id", "upload_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "approve_start_image", title: "Approve or discard a start image",
    description: "Approves the shot's start image that is waiting (so it can be animated), or discards it to make another.",
    inputSchema: { type: "object", properties: { shot_id: { type: "string" }, decision: { type: "string", enum: ["approve", "discard"] } },
      required: ["shot_id", "decision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "animate", title: "Animate a shot",
    description: "Makes the shot's clip from its start image (a start image that is ready is approved first). Paid accounts; credits per " +
      "second by model (list_models); model left out = anlim picks. Follow it with get_creation.",
    inputSchema: { type: "object", properties: { shot_id: { type: "string" }, model: { type: "string", description: "A clip model id from list_models" } },
      required: ["shot_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "review_clip", title: "Keep or reject a clip",
    description: "Keeps the shot's latest clip (it goes into cuts), or rejects it. A rejected clip stays charged until anlim reviews the " +
      "request: say what is wrong (reasons and a sentence of at least 15 characters); the credits come back if the problem is clear.",
    inputSchema: { type: "object", properties: {
      shot_id: { type: "string" }, decision: { type: "string", enum: ["keep", "reject"] },
      reasons: { type: "array", items: { type: "string" }, maxItems: 10, description: "For reject, e.g. 'face changed', 'wrong action'" },
      note: { type: "string", maxLength: 1000 }, at_seconds: { type: "number", minimum: 0, description: "Where in the clip the problem is" },
    }, required: ["shot_id", "decision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "motion_transfer", title: "Recast a video (motion transfer)",
    description: "Recasts an uploaded video (the motion source) with the people in uploaded reference images: same movement, new faces " +
      "and clothes. Paid accounts; credits per second of the source (list_models). Follow it with get_creation (8 to 15 minutes).",
    inputSchema: { type: "object", properties: {
      source_upload_id: { type: "string", description: "The video, from list_uploads" },
      reference_upload_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
      prompt: { type: "string", maxLength: 2000, description: "Optional: who is who, setting notes" },
      model: { type: "string", description: "A motion model id from list_models" },
      look: { type: "string", enum: ["cartoon", "photoreal"], default: "photoreal" },
      project_id: { type: "string" },
    }, required: ["source_upload_id", "reference_upload_ids", "model"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "list_models", title: "Models and prices",
    description: "The video models anlim uses, with credits per second and lengths: clip models (for animate) and motion transfer models.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "make_cut", title: "Make the scene's cut",
    description: "Joins the kept clips of the project's latest scene, in shot order, into one video (free). Formats: 16x9, 9x16, 1x1, " +
      "4x5, 4x3, 3x4, 21x9 (default: the project's shape). end_card puts 'Made with anlim.ai' over the last 2 s of the final shot. Follow it with get_cut.",
    inputSchema: { type: "object", properties: {
      project_id: { type: "string" }, format: { type: "string", enum: ["16x9", "9x16", "1x1", "4x5", "4x3", "3x4", "21x9"] },
      end_card: { type: "boolean", default: true }, fade: { type: "boolean", default: true },
      voiceover: { type: "boolean", default: true }, sound_effects: { type: "boolean", default: true },
      music: { type: "boolean", default: true, description: "The scene's score in the cut (from make_score), if there is one" },
    }, required: ["project_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "get_cut", title: "Get the scene's cut",
    description: "The latest cuts of the project's latest scene, with a download link once done (links last one hour).",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
];

type Args = Record<string, unknown>;
const text = (t: string, structured?: unknown, isError = false) =>
  ({ content: [{ type: "text", text: t }], ...(structured !== undefined ? { structuredContent: structured } : {}), ...(isError ? { isError } : {}) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function callTool(uid: string, name: string, a: Args) {
  switch (name) {
    case "list_projects": {
      const rows = await asUser(uid, (tx) => tx`
        select se.id, se.name, se.look, se.aspect, (select count(*)::int from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id
                where sc.series_id = se.id) as shots
          from studio.series se order by se.name limit 100`);
      return text(rows.length ? rows.map((r) => `${r.name} (${r.look}, ${r.aspect}, ${r.shots} shots) id ${r.id}`).join("\n") : "No projects yet.", { projects: rows });
    }
    case "get_balance": {
      const [acc] = await asUser(uid, (tx) => tx`select balance, reserved, plan_id, plan_status from studio.accounts where owner = ${uid}`);
      const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
      const avail = Math.max(0, (acc?.balance ?? 0) - (acc?.reserved ?? 0));
      return text(`${avail} credits available${acc?.plan_id ? ` (plan ${acc.plan_id}, ${acc.plan_status ?? "active"})` : ""}. ` +
        (paid ? "This account can create from chat." : "Creating from chat needs a paid account (buy credits or a plan at anlim.ai)."),
        { available: avail, reserved: acc?.reserved ?? 0, plan: acc?.plan_id ?? null, can_create: !!paid });
    }
    case "list_recent_clips": {
      const n = Math.min(Math.max(Number(a.limit) || 10, 1), 20);
      const rows = await asUser(uid, (tx) => tx`
        select title, series_name, status, shot_id, created_at from studio.my_assets()
         where kind = 'clip' order by created_at desc limit ${n}`);
      return text(rows.length ? rows.map((r) => `${String(r.title).slice(0, 80)} | ${r.series_name} | ${r.status} | shot ${r.shot_id}`).join("\n") : "No clips yet.", { clips: rows });
    }
    case "get_creation": {
      const id = String(a.shot_id || "");
      if (!UUID.test(id)) return text("shot_id must be the id that create or add_shot returned.", undefined, true);
      const [x] = await asUser(uid, (tx) => tx`
        select sh.action, sh.from_text, sh.start_frame_path, sh.start_frame_approved, sh.motion_source_path is not null as motion,
               sh.end_frame_path, sh.end_frame_approved, sh.trim_start_s, sh.trim_end_s,
               (select row_to_json(e) from (select status, composed_path, error from studio.frame_jobs where shot_id = sh.id and kind = 'end'
                  order by created_at desc limit 1) e) as end_job,
               sh.approved_generation_id, se.name as series_name, se.aspect,
               f.status as frame_status, f.composed_path, f.error as frame_error, f.then_render, f.render_error, f.check_result,
               f.created_at as frame_at, g.created_at as gen_at, g.id as gen_id, g.status as gen_status, g.output_path, g.preview_path, g.error as gen_error,
               q.verdict, q.raw -> 'reasons' as reasons
          from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
          left join lateral (select * from studio.frame_jobs where shot_id = sh.id and kind = 'start' order by created_at desc limit 1) f on true
          left join lateral (select * from studio.generations where shot_id = sh.id order by created_at desc limit 1) g on true
          left join lateral (select * from studio.qc_runs q where q.generation_id = g.id order by created_at desc limit 1) q on true
         where sh.id = ${id}`);
      if (!x) return text("Not found (or not yours).", undefined, true);
      // a start image made after the latest clip (a redo after a rejected clip) is what the shot is on now
      if (x.gen_id && x.frame_at && x.gen_at && new Date(x.frame_at) > new Date(x.gen_at)) {
        x.gen_id = null; x.gen_status = null; x.output_path = null; x.preview_path = null; x.gen_error = null; x.verdict = null; x.reasons = null;
      }
      const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
      const image = x.frame_status === "ready" || x.frame_status === "approved" ? await sign(x.composed_path)
        : x.start_frame_path ? await sign(x.start_frame_path) : null;
      const delivered = ["checking", "review", "succeeded"].includes(x.gen_status);
      const video = delivered && x.output_path ? (paid ? await sign(x.output_path) : await sign(x.preview_path)) : null;
      const waits = x.frame_status === "ready" && !x.then_render;
      const state = x.frame_status === "failed" && !x.gen_id ? `The start image could not be made: ${x.frame_error ?? "unknown error"}. Nothing was charged for it.`
        : x.gen_status === "failed" ? (x.gen_error === "rejected by creator" ? "This clip was rejected; anlim reviews the refund request."
            : `The clip did not finish (${x.gen_error ?? "unknown error"}). Nothing was charged for it.`)
        : x.render_error ? `The image is ready; the clip did not start: ${x.render_error}`
        : x.gen_status === "queued" || x.gen_status === "running" ? `The clip is being made (usually ${x.motion ? "8 to 15" : "3 to 5"} minutes). Check again shortly.`
        : x.gen_status === "checking" ? "The clip is made and being checked; it can be watched now."
        : x.gen_status === "review" ? "The clip is ready and waits for review: keep it or reject it with review_clip."
        : x.gen_status === "succeeded" ? (x.approved_generation_id === x.gen_id ? "The clip is ready and kept." : "The clip is ready.")
        : waits ? "The start image is ready and waits for approval: approve_start_image, or animate (which approves it)."
        : x.frame_status === "queued" || x.frame_status === "running" || x.frame_status === "composing" ? "The start image is being made (usually under a minute)."
        : image ? (x.then_render ? "The image is ready; the clip starts next." : x.start_frame_approved ? "The start image is approved; animate it next." : "The image is ready.")
        : "No start image yet: make_start_image or set_start_image.";
      const findings = x.gen_error?.startsWith("checker found: ") ? x.gen_error.slice(15, 400)
        : Array.isArray(x.reasons) && x.reasons.length && x.verdict && x.verdict !== "PASS" ? (x.reasons as string[]).slice(0, 4).join("; ").slice(0, 600) : null;
      const ej = x.end_job as { status: string; composed_path: string | null; error: string | null } | null;
      const endImg = x.end_frame_path ? await sign(x.end_frame_path) : ej && ej.status === "ready" ? await sign(ej.composed_path) : null;
      const endLine = x.end_frame_path && x.end_frame_approved ? `End image (approved): ${endImg}`
        : ej?.status === "ready" ? `End image waiting for approval (approve_end_image): ${endImg}`
        : ej && ["queued", "running", "composing"].includes(ej.status) ? "The end image is being made."
        : ej?.status === "failed" ? `The end image could not be made: ${ej.error ?? "unknown error"}. Nothing was charged for it.` : null;
      const trimLine = Number(x.trim_start_s) || Number(x.trim_end_s) ? `Trim in the cut: ${Number(x.trim_start_s)} s off the start, ${Number(x.trim_end_s)} s off the end.` : null;
      return text([state, findings ? `The check (${x.verdict ?? "flag"}): ${findings}` : x.verdict === "PASS" ? "The check passed it." : null,
                   image ? `Image: ${image}` : null, endLine, trimLine, video ? `Video${paid ? "" : " (watermarked: free account)"}: ${video}` : null,
                   `Project: ${x.series_name} (${x.aspect}). Open it at ${APP}`].filter(Boolean).join("\n"),
        { status: x.gen_status ?? x.frame_status ?? "starting", start_image_waits: waits, image_url: image, video_url: video,
          check: x.verdict ?? null, project: x.series_name, aspect: x.aspect });
    }
    case "create": {
      const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
      if (!paid) return text("Creating from chat comes with a paid anlim account. Buy credits or a plan at https://anlim.ai, then try again.", undefined, true);
      const prompt = String(a.prompt || "").trim();
      const output = a.output === "image" ? "image" : "video";
      const look = a.look === "photoreal" ? "photoreal" : "cartoon";
      const seconds = Number(a.seconds) === 10 ? 10 : 5;
      const aspect = ASPECTS.includes(String(a.aspect)) ? String(a.aspect) : "16:9";
      const project = a.project_id ? String(a.project_id) : null;
      if (project && !UUID.test(project)) return text("project_id must be an id from list_projects.", undefined, true);
      // counted even if it fails below
      if (!await rateGate(uid, "create", ["create"], CREATE_LIMIT))
        return text(`Limit reached: ${CREATE_LIMIT} creates per ${CREATE_WINDOW_MIN} minutes from chat. Wait a few minutes, or use anlim.ai.`, undefined, true);
      const [r] = await asUser(uid, (tx) => tx`select studio.quick_create(${prompt}, ${look}, ${seconds}::int, ${output}, ${null},
        ${project}::uuid, ${null}::text, ${aspect}::text) as r`);
      const q = r.r as Record<string, unknown>;
      const cost = output === "image" ? 20 : Number(q.clip_credits || 0) + (q.from_text ? 0 : 20);
      return text(`Started: ${output === "image" ? "an image" : `a ${seconds} s clip`} in "${q.series_name}" (${q.aspect}), about ${cost} credits. ` +
        `shot_id ${q.shot_id}; project_id ${q.series_id} (pass it to create to add more shots to this project). ` +
        `Call get_creation with the shot_id to follow progress and get the links.`,
        { shot_id: q.shot_id, project_id: q.series_id, project: q.series_name, aspect: q.aspect, output, credits: cost });
    }

    // ---- v2 tools (2026-11-22)
    case "get_upload_link":
      return text(`Ask the creator to open ${APP}/upload (signed in to anlim), drop their photos or videos there, then say when it is done. ` +
        "Each file gets an upload id; call list_uploads to see them.", { url: `${APP}/upload` });
    case "list_uploads": {
      const n = Math.min(Math.max(Number(a.limit) || 10, 1), 30);
      const ups = await uploads(uid, n);
      return text(ups.length ? ups.map((u) => `${u.id}  ${u.kind}${u.seconds ? ` ${u.seconds} s` : ""}  ${u.at}`).join("\n")
        : `No uploads yet. The creator uploads at ${APP}/upload.`, { uploads: ups });
    }
    case "get_project": {
      const pid = String(a.project_id || "");
      if (!UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const [p] = await asUser(uid, (tx) => tx`select id, name, look, aspect, style_prompt from studio.series where id = ${pid}`);
      if (!p) return text("Project not found.", undefined, true);
      const [chars, locs, shots] = await asUser(uid, async (tx) => [
        await tx`select name, kind, ref_front_path is not null as has_photo from studio.characters where series_id = ${pid} order by name`,
        await tx`select l.name, l.layout_path is not null as has_background,
                        (select coalesce(json_agg(sc.title), '[]') from studio.scenes sc where sc.location_id = l.id) as scenes
                   from studio.locations l where l.series_id = ${pid} order by l.name`,
        await tx`select sh.id, sc.title as scene, sh.ord, left(sh.action, 90) as action, sh.duration_s, sh.start_frame_approved,
                        f.status as frame, g.status as clip, sh.approved_generation_id is not null as kept,
                        (select coalesce(json_agg(c.name), '[]') from studio.characters c where c.id = any(sh.cast_ids)) as cast_names
                   from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id
                   left join lateral (select status from studio.frame_jobs where shot_id = sh.id and kind = 'start' order by created_at desc limit 1) f on true
                   left join lateral (select status from studio.generations where shot_id = sh.id order by created_at desc limit 1) g on true
                  where sc.series_id = ${pid} order by sc.ord, sh.ord limit 100`]);
      const lines = [`${p.name}: ${p.look}, ${p.aspect}${p.style_prompt ? `, style "${String(p.style_prompt).slice(0, 80)}"` : ""}`,
        `Characters: ${chars.length ? chars.map((c) => `${c.name} (${c.kind}${c.has_photo ? "" : ", no photo yet"})`).join(", ") : "none"}`,
        `Locations: ${locs.length ? locs.map((l) => `${l.name}${l.has_background ? "" : " (no background yet)"}`).join(", ") : "none"}`,
        ...shots.map((sh) => `Shot ${sh.ord} [${sh.id}] ${sh.duration_s} s: ${sh.action}` +
          ` | start image: ${sh.start_frame_approved ? "approved" : sh.frame ?? "none"} | clip: ${sh.kept ? "kept" : sh.clip ?? "none"}`)];
      return text(lines.join("\n"), { project: p, characters: chars, locations: locs, shots });
    }
    case "new_project": {
      const look = a.look === "cartoon" ? "cartoon" : "photoreal", aspect = ASPECTS.includes(String(a.aspect)) ? String(a.aspect) : "16:9";
      const id = await asUser(uid, async (tx) => {
        const [r] = await tx`select studio.create_series(${String(a.name || "")}, ${a.style ? String(a.style) : null}, ${look}) as id`;
        await tx`select studio.set_series_aspect(${r.id}, ${aspect})`;
        await tx`select studio.create_scene(${r.id}, 'Scene 1')`;
        return r.id as string;
      });
      return text(`Project "${a.name}" created (${look}, ${aspect}). project_id ${id}.`, { project_id: id });
    }
    case "add_character": {
      const pid = String(a.project_id || "");
      if (!UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const up = await findUpload(uid, String(a.upload_id || ""));
      if (!up || up.kind !== "image") return text("upload_id must be an image from list_uploads.", undefined, true);
      const path = await copyUpload(uid, up, "characters");
      const kind = ["person", "animal", "object"].includes(String(a.kind)) ? String(a.kind) : "person";
      const id = await asUser(uid, async (tx) => {
        const [r] = await tx`select studio.create_character(${pid}, ${String(a.name || "")}, ${null}::numeric,
          ${a.wardrobe ? String(a.wardrobe) : null}, ${kind}, ${a.description ? String(a.description) : null}) as id`;
        await tx`select studio.set_character_ref(${r.id}, ${path})`;
        return r.id as string;
      });
      return text(`${a.name} added with the reference photo. Shots in this project can now place ${a.name} with make_start_image mode new_setup.`,
        { character_id: id });
    }
    case "add_location": {
      const pid = String(a.project_id || "");
      if (!UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const scene = await latestScene(uid, pid);
      let plate: string | null = null, plateShot: string | null = null;
      if (a.upload_id) {
        const up = await findUpload(uid, String(a.upload_id));
        if (!up || up.kind !== "image") return text("upload_id must be an image from list_uploads.", undefined, true);
        plate = await copyUpload(uid, up, "locations");
      } else if (a.from_shot_id) {
        const sid = String(a.from_shot_id);
        if (!UUID.test(sid)) return text("from_shot_id must be a shot id.", undefined, true);
        const [f] = await asUser(uid, (tx) => tx`
          select sh.start_frame_path, (select composed_path from studio.frame_jobs where shot_id = sh.id and kind = 'start'
                  and status in ('ready', 'approved') order by created_at desc limit 1) as composed
            from studio.shots sh where sh.id = ${sid}`);
        const src = f?.start_frame_path ?? f?.composed ?? null;
        if (!src) return text("That shot has no image yet.", undefined, true);
        if (a.remove_people) {
          const gate = await spendGate(uid, "add_location");
          if (gate) return gate;
          plateShot = sid;   // the start image is approved in the same transaction as the plate request (below)
        } else plate = await copyStored(src, `${uid}/locations/plate-${Date.now()}-${rand()}.${ext(src)}`);
      }
      const locId = await asUser(uid, async (tx) => {
        const [r] = await tx`select studio.create_location(${pid}, ${String(a.name || "")}, ${a.description ? String(a.description) : null}) as id`;
        await tx`select studio.set_scene_location(${scene}, ${r.id})`;
        if (plate) await tx`select studio.set_location_plate(${r.id}, ${plate})`;
        if (plateShot) {
          // the plate is made from the shot's (approved) start image; approving it and asking for the plate succeed or fail
          // together, so a refused plate (credits) leaves the start image as it was (review 2026-11-23)
          const [j] = await tx`select f.id from studio.frame_jobs f join studio.shots sh on sh.id = f.shot_id
                                where f.shot_id = ${plateShot} and f.kind = 'start' and f.status = 'ready' and sh.start_frame_path is null
                                order by f.created_at desc limit 1`;
          if (j) await tx`select studio.decide_frame(${j.id}, 'approve')`;
          await tx`select studio.request_plate(${r.id}, ${plateShot})`;
        }
        return r.id as string;
      });
      return text(`Location "${a.name}" added and set for the project's latest scene. ` +
        (plate ? "Its background is set." : plateShot ? "Its background is being made with the people removed (about a minute)."
          : "It has no background yet: add one with add_location again, or in the app."), { location_id: locId });
    }
    case "add_shot": {
      const pid = String(a.project_id || "");
      if (!UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const scene = await latestScene(uid, pid);
      const secs = Math.min(Math.max(Math.round(Number(a.seconds) || 5), 3), 15);
      const names = Array.isArray(a.characters) ? (a.characters as unknown[]).map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
      const id = await asUser(uid, async (tx) => {
        const [r] = await tx`select studio.create_shot(${scene}, ${String(a.action || "")}, ${a.camera ? String(a.camera) : null}, ${secs}::int) as id`;
        if (names.length) {
          const cs = await tx`select id, lower(name) as n from studio.characters where series_id = ${pid}`;
          const ids = names.map((n) => cs.find((c) => c.n === n)?.id);
          const missing = names.filter((_, i) => !ids[i]);
          if (missing.length) throw Object.assign(new Error(`No character called ${missing.join(", ")} in this project.`), { code: "P0001" });
          await tx`select studio.set_shot_cast(${r.id}, ${"{" + ids.join(",") + "}"}::uuid[])`;
        }
        return r.id as string;
      });
      return text(`Shot added (${secs} s). shot_id ${id}. Next: make_start_image (new_setup to place the characters, or prompt), then animate.`, { shot_id: id });
    }
    // ---- v2.1 tools: the studio.* functions replace every field, so unchanged fields are passed back as they are
    case "update_character": {
      const pid = String(a.project_id || "");
      if (!UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const [c] = await asUser(uid, (tx) => tx`select id, name, height_units, wardrobe, kind, what from studio.characters
                                                 where series_id = ${pid} and lower(name) = lower(${String(a.name || "").trim()})`);
      if (!c) return text(`No character called ${a.name} in this project.`, undefined, true);
      let path: string | null = null;
      if (a.upload_id) {
        const up = await findUpload(uid, String(a.upload_id));
        if (!up || up.kind !== "image") return text("upload_id must be an image from list_uploads.", undefined, true);
        path = await copyUpload(uid, up, "characters");
      }
      const name = a.new_name ? String(a.new_name) : c.name;
      await asUser(uid, async (tx) => {
        await tx`select studio.update_character(${c.id}, ${name}, ${c.height_units}::numeric,
          ${a.wardrobe !== undefined ? String(a.wardrobe) : c.wardrobe}, ${c.kind}, ${a.description !== undefined ? String(a.description) : c.what})`;
        if (path) await tx`select studio.set_character_ref(${c.id}, ${path})`;
      });
      return text(`${name} updated${path ? " with the new reference photo" : ""}. New start images use it; existing images and clips stay as they are.`);
    }
    case "update_shot": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const [sh] = await asUser(uid, (tx) => tx`select action, camera, duration_s from studio.shots where id = ${sid}`);
      if (!sh) return text("Shot not found.", undefined, true);
      const secs = a.seconds !== undefined ? Math.round(Number(a.seconds)) : sh.duration_s;
      await asUser(uid, (tx) => tx`select studio.update_shot(${sid}, ${a.action !== undefined ? String(a.action) : sh.action},
        ${a.camera !== undefined ? String(a.camera) : sh.camera}, ${secs}::int)`);
      return text("Shot updated. The next start image or clip of this shot uses the new words.");
    }
    case "move_shot": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      await asUser(uid, (tx) => tx`select studio.move_shot(${sid}, ${a.direction === "earlier" ? -1 : 1}::int)`);
      return text(`Shot moved ${a.direction === "earlier" ? "earlier" : "later"}. get_project shows the new order.`);
    }
    case "delete_shot": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      await asUser(uid, (tx) => tx`select studio.delete_shot(${sid})`);
      return text("Shot deleted.");
    }
    // ---- v2.2 tools
    case "make_end_image": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const ins = String(a.instruction || "").trim();
      if (ins.length < 8) return text("Say where everyone is and what they are doing at the end.", undefined, true);
      const gate = await spendGate(uid, "make_end_image");
      if (gate) return gate;
      const [r] = await asUser(uid, (tx) => a.mode === "edit" ? tx`select studio.request_end_frame(${sid}, ${ins}) as id`
                                                               : tx`select studio.request_end_setup(${sid}, ${ins}) as id`);
      return text(`The end image is being made (usually under a minute). Check it with get_creation (shot_id ${sid}), then approve_end_image.`, { job_id: r.id });
    }
    case "approve_end_image": {
      const sid = String(a.shot_id || ""), d = a.decision === "discard" ? "discard" : "approve";
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const [j] = await asUser(uid, (tx) => tx`select id from studio.frame_jobs where shot_id = ${sid} and kind = 'end' and status = 'ready' order by created_at desc limit 1`);
      if (!j) return text("No end image is waiting for a decision on this shot.", undefined, true);
      await asUser(uid, (tx) => tx`select studio.decide_frame(${j.id}, ${d})`);
      return text(d === "approve" ? "End image approved: the next animate ends on it." : "End image discarded.");
    }
    case "remove_end_image": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      await asUser(uid, (tx) => tx`select studio.clear_end_frame(${sid})`);
      return text("End image removed.");
    }
    case "trim_clip": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const st = Math.max(0, Number(a.cut_start_seconds) || 0), en = Math.max(0, Number(a.cut_end_seconds) || 0);
      await asUser(uid, (tx) => tx`select studio.set_shot_trim(${sid}, ${st}::numeric, ${en}::numeric)`);
      return text(st || en ? `The cut leaves out ${st} s at the start and ${en} s at the end of this shot. Run make_cut to see it.`
                           : "Trim removed: the whole clip goes into the cut.");
    }
    case "set_clip_speed": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const sp = Number(a.speed);
      if (!(sp >= 0.5 && sp <= 2)) return text("speed is 0.5 to 2 (1 is normal).", undefined, true);
      await asUser(uid, (tx) => tx`select studio.set_shot_speed(${sid}, ${sp}::numeric)`);
      return text(sp === 1 ? "Normal speed." : `This shot plays at ${Math.round(sp * 100)}% speed in the cut. Run make_cut to see it.`);
    }
    // ---- v2.4 sound
    case "list_voices": {
      const key = await xiKey(uid);
      if (!key) return text(`Connect ElevenLabs in anlim first: ${APP}, Account > Connections.`, undefined, true);
      const q = a.search ? `&search=${encodeURIComponent(String(a.search).slice(0, 60))}` : "";
      const r = await fetch(`https://api.elevenlabs.io/v2/voices?page_size=100&sort=name&sort_direction=asc${q}`, { headers: { "xi-api-key": key } });
      if (!r.ok) return text(r.status === 401 ? "ElevenLabs refused the key; reconnect it in anlim (Account > Connections)." : `ElevenLabs error ${r.status}.`, undefined, true);
      const vs = ((await r.json())?.voices || []).map((v: any) => ({ id: v.voice_id, name: v.name, kind: v.category,
        gender: v.labels?.gender ?? null, accent: v.labels?.accent ?? null }));
      return text(vs.length ? vs.map((v: any) => `${v.name} (${v.kind}${v.gender ? `, ${v.gender}` : ""}) id ${v.id}`).join("\n") : "No voices match.", { voices: vs });
    }
    case "make_voiceover":
    case "make_sound_effect": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const [sh] = await asUser(uid, (tx) => tx`select scene_id from studio.shots where id = ${sid}`);
      if (!sh) return text("Shot not found.", undefined, true);
      const gate = await audioGate(uid, name);
      if (gate) return gate;
      const vo = name === "make_voiceover";
      let voiceName = "";
      if (vo) {
        const key = await xiKey(uid);
        if (key) {
          const r = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(String(a.voice_id || ""))}`, { headers: { "xi-api-key": key } });
          if (r.ok) voiceName = String((await r.json())?.name || "").slice(0, 80);
        }
      }
      const input = vo ? { text: String(a.text || ""), voice_id: String(a.voice_id || ""), voice_name: voiceName }
                       : { text: String(a.text || ""), duration_s: a.seconds == null ? null : Number(a.seconds) };
      const [r] = await asUser(uid, (tx) => tx`select studio.request_audio(${sh.scene_id}, ${sid}, ${vo ? "voiceover" : "sfx"}, ${tx.json(input)}) as id`);
      return text(`The ${vo ? "voiceover" : "sound effect"} is being made (usually under a minute) on your ElevenLabs credits. ` +
        `audio_id ${r.id}. Check it with list_audio; the newest finished take goes in the cut.`, { audio_id: r.id });
    }
    case "make_score": {
      const pid = String(a.project_id || "");
      if (!UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const scene = await latestScene(uid, pid);
      const styles = String(a.styles || "").trim();
      const shots = await asUser(uid, (tx) => tx`select sh.ord, sh.duration_s, sh.trim_start_s, sh.trim_end_s, sh.speed, g.clip_s
                                                   from studio.shots sh join studio.generations g on g.id = sh.approved_generation_id
                                                  where sh.scene_id = ${scene} order by sh.ord`);
      if (!shots.length) return text("Keep at least one clip in this scene first.", undefined, true);
      const gate = await audioGate(uid, "make_score");
      if (gate) return gate;
      const moods = Array.isArray(a.moods) ? (a.moods as unknown[]).map((x) => String(x).slice(0, 500)) : [];
      const secs = scoreSections(shots, moods);
      const total = Math.round(secs.reduce((t, x) => t + x.seconds, 0) * 10) / 10;
      const input: Record<string, unknown> = a.follow_shots !== false
        ? { text: styles, styles, sections: secs, instrumental: true }
        : { text: styles, length_s: Math.max(3, total), instrumental: true };
      const [r] = await asUser(uid, (tx) => tx`select studio.request_audio(${scene}, ${null}, 'music', ${tx.json(input)}) as id`);
      const n = a.follow_shots !== false ? secs.length : 0;
      return text(`The score is being composed: ${total} s${n ? ` in ${n} section${n > 1 ? "s" : ""}, one per shot` : ""}, instrumental, ` +
        `on your ElevenLabs credits (usually a minute or two). audio_id ${r.id}. Check it with list_audio.`, { audio_id: r.id, seconds: total });
    }
    case "list_audio": {
      const pid = String(a.project_id || "");
      if (!UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const scene = await latestScene(uid, pid);
      const rows = await asUser(uid, (tx) => tx`select a.id, a.kind, a.status, a.in_cut, a.duration_s, a.error, a.output_path, a.input,
                                                       sh.ord as shot_ord from studio.audio_jobs a left join studio.shots sh on sh.id = a.shot_id
                                                 where a.scene_id = ${scene} order by a.created_at desc limit 30`);
      if (!rows.length) return text("No sound yet: make_voiceover, make_sound_effect or make_score.");
      const items = await Promise.all(rows.map(async (x: any) => ({ id: x.id, kind: x.kind, shot: x.shot_ord ?? null, status: x.status,
        in_cut: x.in_cut, seconds: x.duration_s == null ? null : Number(x.duration_s), error: x.error,
        text: String(x.input?.text ?? "").slice(0, 80), url: x.status === "done" ? await sign(x.output_path) : null })));
      return text(items.map((x) => `${x.kind}${x.shot ? ` shot ${x.shot}` : ""} [${x.id}] ${x.status}${x.seconds ? ` ${x.seconds.toFixed(1)} s` : ""}` +
        `${x.in_cut ? " (in the cut)" : ""}${x.error ? `: ${x.error}` : ""}${x.url ? `: ${x.url}` : ""}`).join("\n"), { audio: items });
    }
    case "use_audio": {
      const id = String(a.audio_id || "");
      if (!UUID.test(id)) return text("audio_id must be an id from list_audio.", undefined, true);
      await asUser(uid, (tx) => tx`select studio.use_audio(${id}, ${a.use !== false})`);
      return text(a.use !== false ? "In the cut." : "Left out of the cut.");
    }
    case "make_start_image": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const mode = ["new_setup", "prompt", "continue", "reposition"].includes(String(a.mode)) ? String(a.mode) : "";
      if (!mode) return text("mode must be new_setup, prompt, continue or reposition.", undefined, true);
      const gate = await spendGate(uid, "make_start_image");
      if (gate) return gate;
      const [r] = await asUser(uid, (tx) => tx`select studio.request_start_frame(${sid}, ${mode}, ${a.instruction ? String(a.instruction) : null}, ${null}) as id`);
      // 2026-11-22 (promo shot 2): continuing from a frame the cast is not in left the video model nothing to draw their faces
      // from, and it invented a different man. The reply says so whenever a continued shot has a cast.
      const [cast] = mode === "continue" ? await asUser(uid, (tx) => tx`select coalesce(cardinality(cast_ids), 0) as n from studio.shots where id = ${sid}`) : [{ n: 0 }];
      return text(`The start image is being made (usually under a minute). Check it with get_creation (shot_id ${sid}).` +
        (cast?.n ? " Note: 'continue' gives the video model only the previous clip's last frame. If the characters are not clearly " +
          "visible in it (they left, vanished, or are tiny), it invents their faces: use new_setup instead to place them from their photos." : ""),
        { job_id: r.id });
    }
    case "set_start_image": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const up = await findUpload(uid, String(a.upload_id || ""));
      if (!up || up.kind !== "image") return text("upload_id must be an image from list_uploads.", undefined, true);
      const path = await copyUpload(uid, up, "stills");
      await asUser(uid, async (tx) => { await tx`select studio.set_start_frame(${sid}, ${path})`; await tx`select studio.approve_start_frame(${sid})`; });
      return text("The uploaded image is now the shot's approved start image. Next: animate.");
    }
    case "approve_start_image": {
      const sid = String(a.shot_id || ""), d = a.decision === "discard" ? "discard" : "approve";
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const [j] = await asUser(uid, (tx) => tx`select id from studio.frame_jobs where shot_id = ${sid} and kind = 'start' and status = 'ready' order by created_at desc limit 1`);
      if (!j) return text("No start image is waiting for a decision on this shot.", undefined, true);
      await asUser(uid, (tx) => tx`select studio.decide_frame(${j.id}, ${d})`);
      return text(d === "approve" ? "Start image approved. Next: animate." : "Start image discarded. Make another with make_start_image.");
    }
    case "animate": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const gate = await spendGate(uid, "animate");
      if (gate) return gate;
      const model = a.model ? String(a.model) : null;
      const r = await asUser(uid, async (tx) => {
        const [j] = await tx`select f.id from studio.frame_jobs f join studio.shots sh on sh.id = f.shot_id
                               where f.shot_id = ${sid} and f.kind = 'start' and f.status = 'ready' and not sh.start_frame_approved
                               order by f.created_at desc limit 1`;
        if (j) await tx`select studio.decide_frame(${j.id}, 'approve')`;
        const [g] = await tx`select studio.enqueue_generation(${sid}, ${model}) as id`;
        const [m] = await tx`select m.label, g.credits_reserved from studio.generations g join studio.models m on m.id = g.model_id where g.id = ${g.id}`;
        return { id: g.id as string, label: m?.label as string, credits: m?.credits_reserved as number };
      });
      return text(`Animating with ${r.label ?? "the chosen model"} (about ${r.credits} credits, charged when the clip is delivered). ` +
        `Follow it with get_creation (shot_id ${sid}).`, { generation_id: r.id, credits: r.credits });
    }
    case "review_clip": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const [g] = await asUser(uid, (tx) => tx`select id, status from studio.generations where shot_id = ${sid} order by created_at desc limit 1`);
      if (!g) return text("This shot has no clip yet.", undefined, true);
      const keep = a.decision !== "reject";
      const reasons = Array.isArray(a.reasons) ? (a.reasons as unknown[]).map(String).slice(0, 10) : [];
      const at = a.at_seconds == null ? null : Number(a.at_seconds);
      await asUser(uid, (tx) => tx`select studio.review_generation(${g.id}, ${keep ? "approve" : "reject"}, ${reasons}::text[],
        ${a.note ? String(a.note).slice(0, 1000) : null}, ${at != null && isFinite(at) ? at : null})`);
      return text(keep ? "Kept: it goes into this scene's cut." : "Rejected. anlim reviews the request and refunds the credits if the problem is clear.");
    }
    case "motion_transfer": {
      const src = await findUpload(uid, String(a.source_upload_id || ""));
      if (!src || src.kind !== "video") return text("source_upload_id must be a video from list_uploads.", undefined, true);
      if (!src.seconds) return text("The video's length is unknown; upload it again at anlim.ai/upload.", undefined, true);
      const refIds = Array.isArray(a.reference_upload_ids) ? (a.reference_upload_ids as unknown[]).map(String).slice(0, 8) : [];
      const refs: string[] = [];
      for (const r of refIds) {
        const u = await findUpload(uid, r);
        if (!u || u.kind !== "image") return text(`${r} is not an image from list_uploads.`, undefined, true);
        refs.push(u.path);
      }
      const pid = a.project_id ? String(a.project_id) : null;
      if (pid && !UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const gate = await spendGate(uid, "motion_transfer");
      if (gate) return gate;
      const [r] = await asUser(uid, (tx) => tx`select studio.motion_create(${src.path}, ${refs}::text[], ${String(a.prompt || "")},
        ${src.seconds}::numeric, ${String(a.model || "")}, ${pid}::uuid, ${a.look === "cartoon" ? "cartoon" : "photoreal"}) as r`);
      const q = r.r as Record<string, unknown>;
      return text(`Motion transfer started: ${q.seconds} s, about ${q.credits} credits, in "${q.series_name}". shot_id ${q.shot_id}; ` +
        `project_id ${q.series_id}. It usually takes 8 to 15 minutes; follow it with get_creation.`, q);
    }
    case "list_models": {
      const rows = await sql`select id, kind, label, credits_per_second, min_duration_s, max_duration_s, looks from studio.models
                              where active and provider <> 'mock' and kind in ('clip', 'motion') order by kind, credits_per_second desc`;
      return text(rows.map((m) => `${m.kind === "motion" ? "motion transfer" : "clip"}: ${m.id} (${m.label}) ${m.credits_per_second} credits/s, ` +
        `${m.min_duration_s}-${m.max_duration_s} s${m.looks ? `, ${m.looks.join("/")} only` : ""}`).join("\n"), { models: rows });
    }
    case "make_cut": {
      const pid = String(a.project_id || "");
      if (!UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const scene = await latestScene(uid, pid);
      const [p] = await asUser(uid, (tx) => tx`select aspect from studio.series where id = ${pid}`);
      const format = ["16x9", "9x16", "1x1", "4x5", "4x3", "3x4", "21x9"].includes(String(a.format)) ? String(a.format)
        : String(p?.aspect ?? "16:9").replace(":", "x");
      if (!await rateGate(uid, "make_cut", ["make_cut"], CUT_LIMIT))
        return text(`Limit reached: ${CUT_LIMIT} cuts per 10 minutes from chat. Wait a few minutes.`, undefined, true);
      // 2026-11-22: the scene's sound goes in too: the voiceovers and effects in the cut, and the score in the cut
      const [score] = a.music === false ? [] : await asUser(uid, (tx) => tx`select id from studio.audio_jobs where scene_id = ${scene}
                                                    and kind = 'music' and in_cut and status = 'done' order by created_at desc limit 1`);
      const opts = { fade: a.fade !== false, end_card: a.end_card !== false, voice: a.voiceover !== false, sfx: a.sound_effects !== false,
                     music_path: score ? `${uid}/audio/music/${score.id}.mp3` : null };
      const [r] = await asUser(uid, (tx) => tx`select studio.request_assembly(${scene}, ${format}, ${tx.json(opts)}) as id`);
      return text(`The cut is being made (${format}${opts.end_card ? ", with Made with anlim.ai on the last shot" : ""}); usually under a minute (longer with slowed shots). ` +
        "Get it with get_cut.", { cut_id: r.id });
    }
    case "get_cut": {
      const pid = String(a.project_id || "");
      if (!UUID.test(pid)) return text("project_id must be an id from list_projects.", undefined, true);
      const scene = await latestScene(uid, pid);
      const rows = await asUser(uid, (tx) => tx`select id, format, status, duration_s, error, output_path, preview_path, created_at
                                                    from studio.assemblies where scene_id = ${scene} order by created_at desc limit 3`);
      if (!rows.length) return text("No cut yet: make_cut.", undefined, true);
      const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
      const out = await Promise.all(rows.map(async (c) => ({ format: c.format, status: c.status, seconds: c.duration_s, error: c.error,
        url: c.status === "done" ? (paid ? await sign(c.output_path) : await sign(c.preview_path)) : null })));
      return text(out.map((c) => `${c.format} ${c.status}${c.seconds ? ` ${Number(c.seconds).toFixed(1)} s` : ""}` +
        `${c.url ? `: ${c.url}` : c.error ? `: ${c.error}` : ""}`).join("\n"), { cuts: out });
    }
    default:
      return text(`Unknown tool ${name}.`, undefined, true);
  }
}


// the creator's ElevenLabs key, from Supabase Vault (only the owner role and the worker may read it); never logged
async function xiKey(uid: string) {
  const [r] = await sql`select studio.connection_key(${uid}, 'elevenlabs') as k`;
  return (r?.k as string | null) ?? null;
}

// ---- v2 helpers: uploads, files, scenes, the spending gate
// Uploads from anlim.ai/upload land in <owner>/motion/ (the storage policy already allows images and videos there) as
// up-<time>-<random>[_d<centiseconds>].<ext>; the upload page measures a video's length and puts it in the name.
const UPLOAD_ID = /^up-[a-z0-9]{4,16}-[a-z0-9]{3,8}$/;
const rand = () => Math.random().toString(36).slice(2, 7);
const ext = (p: string) => (p.split(".").pop() || "png").toLowerCase();
type Upload = { id: string; path: string; kind: "image" | "video"; seconds: number | null; at: string };
async function uploads(uid: string, limit = 30): Promise<Upload[]> {
  const { data } = await admin.storage.from(BUCKET).list(`${uid}/motion`, { limit: 200, search: "up-", sortBy: { column: "created_at", order: "desc" } });
  return (data || []).filter((f) => f.name.startsWith("up-")).slice(0, limit).map((f) => {
    const m = f.name.match(/^(up-[a-z0-9]+-[a-z0-9]+)(?:_d(\d+))?\.([a-z0-9]+)$/);
    const e = m?.[3] ?? "";
    return { id: m?.[1] ?? f.name, path: `${uid}/motion/${f.name}`, kind: ["mp4", "mov", "webm"].includes(e) ? "video" : "image",
             seconds: m?.[2] ? Number(m[2]) / 100 : null, at: String(f.created_at ?? "").slice(0, 16).replace("T", " ") } as Upload;
  });
}
async function findUpload(uid: string, id: string) {
  if (!UPLOAD_ID.test(id)) return null;
  return (await uploads(uid, 200)).find((u) => u.id === id) ?? null;
}
async function copyStored(from: string, to: string) {
  const { error } = await admin.storage.from(BUCKET).copy(from, to);
  // the same upload used again (a second project, a retry): the copy from the first time is the same file
  if (error && !/already exists/i.test(error.message)) throw new Error(`copy failed: ${error.message}`);
  return to;
}
// the app's functions take images only from their own folders (studio.owned_file), so an upload is copied there
const copyUpload = (uid: string, u: Upload, folder: "characters" | "locations" | "stills") =>
  copyStored(u.path, `${uid}/${folder}/${u.id}.${ext(u.path) === "jpeg" ? "jpg" : ext(u.path)}`);
async function latestScene(uid: string, pid: string): Promise<string> {
  return asUser(uid, async (tx) => {
    const [p] = await tx`select id from studio.series where id = ${pid}`;
    if (!p) throw Object.assign(new Error("project not found"), { code: "P0001" });
    const [sc] = await tx`select id from studio.scenes where series_id = ${pid} order by ord desc limit 1`;
    if (sc) return sc.id as string;
    const [n] = await tx`select studio.create_scene(${pid}, 'Scene 1') as id`;
    return n.id as string;
  });
}
// paid accounts only, and at most SPEND_LIMIT of these per 10 minutes from chat (create has its own 5)
async function spendGate(uid: string, tool: string) {
  const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
  if (!paid) return text(`This comes with a paid anlim account. Buy credits or a plan at ${APP}, then try again.`, undefined, true);
  if (!await rateGate(uid, tool, SPEND_TOOLS, SPEND_LIMIT))
    return text(`Limit reached: ${SPEND_LIMIT} paid steps per 10 minutes from chat. Wait a few minutes, or use ${APP}.`, undefined, true);
  return null;
}
// Counts this account's calls to `tools` in the last 10 minutes and records this one, in one transaction locked per
// account, so parallel calls cannot all pass the count before any of them is recorded (review 2026-11-23). False = full.
async function rateGate(uid: string, tool: string, tools: string[], limit: number) {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"mcp:" + uid}))`;
    const [{ n }] = await tx`select count(*)::int as n from studio.mcp_calls where owner = ${uid} and tool = any(${tools}::text[])
                              and at > now() - interval '10 minutes'`;
    if (n >= limit) return false;
    await tx`insert into studio.mcp_calls(owner, tool) values (${uid}, ${tool})`;
    return true;
  });
}
const audioGate = async (uid: string, tool: string) => await rateGate(uid, tool, AUDIO_TOOLS, AUDIO_LIMIT) ? null
  : text(`Limit reached: ${AUDIO_LIMIT} voiceovers, sound effects and scores per 10 minutes from chat (they use your ElevenLabs credits). Wait a few minutes.`, undefined, true);

// The length of each kept shot in the cut, in seconds, exactly as the worker's assemble.js makes it: the clip's real
// length (or the shot's asked length for clips made before 2026-11-23), trims in whole frames with at least 1 s kept,
// then the speed. Used to shape the score's sections.
const FPS = 24;
function cutSeconds(r: Record<string, unknown>) {
  const frames = Math.round((Number(r.clip_s) || Number(r.duration_s) || 0) * FPS);
  const skip = Math.max(0, Math.round(Number(r.trim_start_s || 0) * FPS)), cut = Math.max(0, Math.round(Number(r.trim_end_s || 0) * FPS));
  const keep = Math.max(Math.min(FPS, frames), frames - skip - cut);
  const speed = Math.min(2, Math.max(0.5, Number(r.speed) || 1));
  return Math.max(1, Math.round(keep / speed)) / FPS;
}
// One section per shot; a shot under 3 s (ElevenLabs' shortest section) joins the section before it, or the one after it
// when it is first. Section ends are rounded on the running total, so rounding never adds up. The last section runs 1 s
// past the cut (the fade). Each section takes the mood of its longest shot.
type Sec = { label: string; seconds: number; styles: string };
function scoreSections(shots: Record<string, unknown>[], moods: string[]): Sec[] {
  const lens = shots.map(cutSeconds);
  lens[lens.length - 1] += 1;
  const groups: { idx: number[]; len: number }[] = [];
  let carry: { idx: number[]; len: number } | null = null;
  lens.forEach((len, i) => {
    let g = { idx: [i], len };
    if (carry) { g = { idx: [...carry.idx, i], len: carry.len + len }; carry = null; }
    if (g.len >= 3) groups.push(g);
    else if (groups.length) { groups[groups.length - 1].idx.push(...g.idx); groups[groups.length - 1].len += g.len; }
    else carry = g;
  });
  if (carry) groups.push({ ...carry, len: Math.max(3, carry.len) });      // the whole scene is under 3 s
  let end = 0, prev = 0;
  return groups.map((g) => {
    end += g.len;
    const r = Math.round(end * 10) / 10, seconds = Math.round((r - prev) * 10) / 10;
    prev = r;
    const main = g.idx.reduce((m, i) => (lens[i] > lens[m] ? i : m), g.idx[0]);
    return { label: `Shot ${String(shots[g.idx[0]].ord).padStart(2, "0")}`, seconds: Math.max(3, seconds), styles: moods[main] ?? "" };
  });
}

// ---- JSON-RPC
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function rpc(uid: string, m: Rpc) {
  switch (m.method) {
    case "initialize": {
      const want = String(m.params?.protocolVersion || "");
      return ok(m.id, { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "anlim", title: "anlim.ai", version: "2.5.0" },
        instructions: "anlim makes images and short video clips and keeps them in the creator's projects. Quick: create (an image or a " +
          "clip from words) then get_creation. Step by step, for a real person, a set or several shots: new_project (or list_projects), " +
          "get_upload_link so the creator uploads photos, add_character with an upload, add_location for the background, add_shot, " +
          "(update_character, update_shot, move_shot to change them), make_end_image when someone must appear or end somewhere exact, " +
          "make_start_image (new_setup places the characters), get_creation to look, animate, review_clip (keep), then make_cut and " +
          "get_cut (trim_clip to shorten a clip, set_clip_speed to slow it, in the cut; make_voiceover, make_sound_effect and " +
          "make_score add sound on the creator's ElevenLabs account). Steps that spend credits need a paid account. Clips take minutes: tell the creator and check again rather than " +
          "starting the same thing twice." });
    }
    case "ping": return ok(m.id, {});
    case "tools/list": return ok(m.id, { tools: TOOLS });
    case "tools/call": {
      const name = String(m.params?.name || "");
      if (!TOOLS.some((t) => t.name === name)) return err(m.id, -32602, `Unknown tool: ${name}`);
      try {
        return ok(m.id, await callTool(uid, name, (m.params?.arguments as Args) || {}));
      } catch (e) {
        // messages written for creators (studio.* raise exception, P0001: "you have N credits", ...) are passed on
        const msg = e instanceof Error ? e.message : String(e);
        if ((e as { code?: string })?.code === "P0001") return ok(m.id, text(msg.slice(0, 300), undefined, true));
        const ref = crypto.randomUUID().slice(0, 8);
        console.error(`studio-mcp ${name} ref ${ref}: ${msg}`);
        return ok(m.id, text(`Something went wrong (ref ${ref}). Try again; if it keeps happening, contact support with this reference.`, undefined, true));
      }
    }
    default:
      return err(m.id, -32601, `Method not found: ${m.method}`);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  // protected resource metadata (RFC 9728): where to sign in
  if (url.pathname.endsWith("/.well-known/oauth-protected-resource") || url.pathname.includes("/.well-known/oauth-protected-resource/")) {
    return json({ resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ["header"],
                  resource_name: "anlim.ai", resource_documentation: "https://anlim.ai/support" });
  }
  if (req.method !== "POST") return json({ error: "POST only (this server does not open an event stream)" }, 405, { Allow: "POST, OPTIONS" });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const challenge = (e?: string) => `Bearer resource_metadata="${METADATA_URL}"${e ? `, error="${e}"` : ""}`;
  if (!token) return json({ error: "sign in to anlim first" }, 401, { "WWW-Authenticate": challenge() });
  const { data: who, error } = await admin.auth.getUser(token);
  if (error || !who?.user) return json({ error: "invalid or expired token" }, 401, { "WWW-Authenticate": challenge("invalid_token") });

  let m: Rpc;
  try { m = await req.json(); } catch { return json(err(null, -32700, "Parse error"), 400); }
  if (Array.isArray(m)) return json(err(null, -32600, "Batches are not supported"), 400);
  if (m.id === undefined || m.id === null) return new Response(null, { status: 202, headers: cors });   // a notification
  return json(await rpc(who.user.id, m));
});

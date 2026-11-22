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
const SPEND_TOOLS = ["make_start_image", "animate", "motion_transfer", "add_location"];
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
      "4x5, 4x3, 3x4, 21x9 (default: the project's shape). end_card adds a 3 s 'Made with anlim.ai' card. Follow it with get_cut.",
    inputSchema: { type: "object", properties: {
      project_id: { type: "string" }, format: { type: "string", enum: ["16x9", "9x16", "1x1", "4x5", "4x3", "3x4", "21x9"] },
      end_card: { type: "boolean", default: true }, fade: { type: "boolean", default: true },
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
               sh.approved_generation_id, se.name as series_name, se.aspect,
               f.status as frame_status, f.composed_path, f.error as frame_error, f.then_render, f.render_error, f.check_result,
               g.id as gen_id, g.status as gen_status, g.output_path, g.preview_path, g.error as gen_error,
               q.verdict, q.raw -> 'reasons' as reasons
          from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
          left join lateral (select * from studio.frame_jobs where shot_id = sh.id and kind = 'start' order by created_at desc limit 1) f on true
          left join lateral (select * from studio.generations where shot_id = sh.id order by created_at desc limit 1) g on true
          left join lateral (select * from studio.qc_runs q where q.generation_id = g.id order by created_at desc limit 1) q on true
         where sh.id = ${id}`);
      if (!x) return text("Not found (or not yours).", undefined, true);
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
      return text([state, findings ? `The check (${x.verdict ?? "flag"}): ${findings}` : x.verdict === "PASS" ? "The check passed it." : null,
                   image ? `Image: ${image}` : null, video ? `Video${paid ? "" : " (watermarked: free account)"}: ${video}` : null,
                   `Project: ${x.series_name} (${x.aspect}). Open it at ${APP}`].filter(Boolean).join("\n"),
        { status: x.gen_status ?? x.frame_status ?? "starting", start_image_waits: waits, image_url: image, video_url: video,
          check: x.verdict ?? null, project: x.series_name, aspect: x.aspect });
    }
    case "create": {
      const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
      if (!paid) return text("Creating from chat comes with a paid anlim account. Buy credits or a plan at https://anlim.ai, then try again.", undefined, true);
      const [{ n }] = await sql`select count(*)::int as n from studio.mcp_calls where owner = ${uid} and tool = 'create'
                                  and at > now() - interval '10 minutes'`;   // CREATE_WINDOW_MIN
      if (n >= CREATE_LIMIT) return text(`Limit reached: ${CREATE_LIMIT} creates per ${CREATE_WINDOW_MIN} minutes from chat. Wait a few minutes, or use anlim.ai.`, undefined, true);
      const prompt = String(a.prompt || "").trim();
      const output = a.output === "image" ? "image" : "video";
      const look = a.look === "photoreal" ? "photoreal" : "cartoon";
      const seconds = Number(a.seconds) === 10 ? 10 : 5;
      const aspect = ASPECTS.includes(String(a.aspect)) ? String(a.aspect) : "16:9";
      const project = a.project_id ? String(a.project_id) : null;
      if (project && !UUID.test(project)) return text("project_id must be an id from list_projects.", undefined, true);
      await sql`insert into studio.mcp_calls(owner, tool) values (${uid}, 'create')`;   // counted even if it fails below
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
          if (!f.start_frame_path) await asUser(uid, async (tx) => {   // the plate is made from the shot's (approved) start image
            const [j] = await tx`select id from studio.frame_jobs where shot_id = ${sid} and kind = 'start' and status = 'ready' order by created_at desc limit 1`;
            if (j) await tx`select studio.decide_frame(${j.id}, 'approve')`;
          });
          plateShot = sid;
        } else plate = await copyStored(src, `${uid}/locations/plate-${Date.now()}-${rand()}.${ext(src)}`);
      }
      const locId = await asUser(uid, async (tx) => {
        const [r] = await tx`select studio.create_location(${pid}, ${String(a.name || "")}, ${a.description ? String(a.description) : null}) as id`;
        await tx`select studio.set_scene_location(${scene}, ${r.id})`;
        if (plate) await tx`select studio.set_location_plate(${r.id}, ${plate})`;
        if (plateShot) await tx`select studio.request_plate(${r.id}, ${plateShot})`;
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
    case "make_start_image": {
      const sid = String(a.shot_id || "");
      if (!UUID.test(sid)) return text("shot_id must be a shot id.", undefined, true);
      const mode = ["new_setup", "prompt", "continue", "reposition"].includes(String(a.mode)) ? String(a.mode) : "";
      if (!mode) return text("mode must be new_setup, prompt, continue or reposition.", undefined, true);
      const gate = await spendGate(uid, "make_start_image");
      if (gate) return gate;
      const [r] = await asUser(uid, (tx) => tx`select studio.request_start_frame(${sid}, ${mode}, ${a.instruction ? String(a.instruction) : null}, ${null}) as id`);
      return text(`The start image is being made (usually under a minute). Check it with get_creation (shot_id ${sid}).`, { job_id: r.id });
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
      const opts = { fade: a.fade !== false, end_card: a.end_card !== false };
      const [r] = await asUser(uid, (tx) => tx`select studio.request_assembly(${scene}, ${format}, ${tx.json(opts)}) as id`);
      return text(`The cut is being made (${format}${opts.end_card ? ", with the Made with anlim.ai card" : ""}); usually under a minute. ` +
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
  if (error) throw new Error(`copy failed: ${error.message}`);
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
  const [{ n }] = await sql`select count(*)::int as n from studio.mcp_calls where owner = ${uid} and tool = any(${SPEND_TOOLS}::text[])
                              and at > now() - interval '10 minutes'`;
  if (n >= SPEND_LIMIT) return text(`Limit reached: ${SPEND_LIMIT} paid steps per 10 minutes from chat. Wait a few minutes, or use ${APP}.`, undefined, true);
  await sql`insert into studio.mcp_calls(owner, tool) values (${uid}, ${tool})`;
  return null;
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
        serverInfo: { name: "anlim", title: "anlim.ai", version: "2.0.0" },
        instructions: "anlim makes images and short video clips and keeps them in the creator's projects. Quick: create (an image or a " +
          "clip from words) then get_creation. Step by step, for a real person, a set or several shots: new_project (or list_projects), " +
          "get_upload_link so the creator uploads photos, add_character with an upload, add_location for the background, add_shot, " +
          "make_start_image (new_setup places the characters), get_creation to look, animate, review_clip (keep), then make_cut and " +
          "get_cut. Steps that spend credits need a paid account. Clips take minutes: tell the creator and check again rather than " +
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

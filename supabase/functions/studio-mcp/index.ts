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
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const BUCKET = "studio";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const RESOURCE = Deno.env.get("MCP_RESOURCE_URL") || "https://mcp.anlim.ai/mcp";
const METADATA_URL = new URL("/.well-known/oauth-protected-resource", RESOURCE).toString();
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const CREATE_LIMIT = 5, CREATE_WINDOW_MIN = 10;
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
    description: "Status of an image or clip made with create (by shot id), with links to the image and the video once they are ready. Clips usually take 3 to 5 minutes; links last one hour.",
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
      if (!UUID.test(id)) return text("shot_id must be the id that create returned.", undefined, true);
      const [x] = await asUser(uid, (tx) => tx`
        select sh.action, sh.from_text, sh.start_frame_path, se.name as series_name, se.aspect,
               f.status as frame_status, f.composed_path, f.error as frame_error, f.then_render, f.render_error,
               g.status as gen_status, g.output_path, g.preview_path, g.error as gen_error
          from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id
          left join lateral (select * from studio.frame_jobs where shot_id = sh.id and kind = 'start' order by created_at desc limit 1) f on true
          left join lateral (select * from studio.generations where shot_id = sh.id order by created_at desc limit 1) g on true
         where sh.id = ${id}`);
      if (!x) return text("Not found (or not yours).", undefined, true);
      const [{ paid }] = await sql`select studio.has_paid(${uid}) as paid`;
      const image = x.frame_status === "ready" || x.frame_status === "approved" ? await sign(x.composed_path) : null;
      const delivered = ["checking", "review", "succeeded"].includes(x.gen_status);
      const video = delivered && x.output_path ? (paid ? await sign(x.output_path) : await sign(x.preview_path)) : null;
      const state = x.frame_status === "failed" ? `The image could not be made: ${x.frame_error ?? "unknown error"}. Nothing was charged for it.`
        : x.gen_status === "failed" ? `The clip did not finish (${x.gen_error ?? "unknown error"}).`
        : x.render_error ? `The image is ready; the clip did not start: ${x.render_error}`
        : x.gen_status === "queued" || x.gen_status === "running" ? "The clip is being made (usually 3 to 5 minutes). Check again shortly."
        : x.gen_status === "checking" ? "The clip is made and being checked; it can be watched now."
        : x.gen_status === "review" || x.gen_status === "succeeded" ? "The clip is ready."
        : image ? (x.then_render ? "The image is ready; the clip starts next." : "The image is ready.")
        : "The image is being drawn (usually under a minute). Check again shortly.";
      return text([state, image ? `Image: ${image}` : null, video ? `Video${paid ? "" : " (watermarked: free account)"}: ${video}` : null,
                   `Project: ${x.series_name} (${x.aspect}). Open it at https://anlim.ai`].filter(Boolean).join("\n"),
        { status: x.gen_status ?? x.frame_status ?? "starting", image_url: image, video_url: video, project: x.series_name, aspect: x.aspect });
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
        `shot_id ${q.shot_id}. Call get_creation with it to follow progress and get the links.`,
        { shot_id: q.shot_id, project_id: q.series_id, project: q.series_name, aspect: q.aspect, output, credits: cost });
    }
    default:
      return text(`Unknown tool ${name}.`, undefined, true);
  }
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
        serverInfo: { name: "anlim", title: "anlim.ai", version: "1.0.0" },
        instructions: "anlim makes images and short video clips from a description and keeps them in the creator's projects. " +
          "Use create to start one (it spends the creator's credits, paid accounts only), then get_creation with the shot_id to follow it. " +
          "Clips take a few minutes: tell the creator and check again rather than calling create twice." });
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

// Higgsfield developer API (motion transfer, 2026-11-20). @anlim
// Docs: https://docs.higgsfield.ai/docs/models/genjutsu/motion-transfer (read 2026-11-20).
//   POST https://api.higgsfield.ai/<endpoint>  Authorization: Key <id>:<secret>
//   body { video_url, image_urls[1..8], prompt, resolution "480p" | "720p" | "1080p" }
//   -> { request_id, status_url, cancel_url }; poll status_url until status "completed": { video: { url } }.
// The API answers statuses in lower case ("queued", "in_progress", "completed"); anything else is treated as failed.
// Billing: the source length rounded up to a whole second (open.higgsfield.ai model pages).
import { config } from "../config.js";

const BASE = "https://api.higgsfield.ai";
const hdr = () => ({ Authorization: `Key ${config.higgsfieldKey}`, "Content-Type": "application/json" });

async function call(url, opts = {}) {
  let r;
  try { r = await fetch(url, { ...opts, headers: hdr() }); }
  catch (e) {
    const c = e.cause || {};
    throw new Error(`higgsfield unreachable: ${c.code || c.name || ""} ${c.message || e.message}`.trim());
  }
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`higgsfield ${r.status}: ${text.slice(0, 300)}`);
    err.permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
    throw err;
  }
  return body;
}

export async function submit(endpoint, input) {
  if (!config.higgsfieldKey) throw Object.assign(new Error("set HIGGSFIELD_KEY (id:secret)"), { permanent: true });
  const j = await call(`${BASE}/${endpoint}`, { method: "POST", body: JSON.stringify(input) });
  if (!j.request_id || !j.status_url) throw new Error(`higgsfield: unexpected answer ${JSON.stringify(j).slice(0, 200)}`);
  return { requestId: j.request_id, statusUrl: j.status_url, responseUrl: j.status_url };
}

// -> { state: "pending" } | { state: "done", videoUrl } | { state: "failed", error }
export async function poll(gen) {
  const s = await call(gen.provider_status_url);
  const st = String(s.status || "").toLowerCase();
  if (["queued", "in_queue", "in_progress", "processing", "pending", "running"].includes(st)) return { state: "pending" };
  if (st !== "completed") return { state: "failed", error: `status ${st || "unknown"}: ${JSON.stringify(s).slice(0, 200)}` };
  const url = s.video?.url;
  return url ? { state: "done", videoUrl: url } : { state: "failed", error: `no video in result: ${JSON.stringify(s).slice(0, 200)}` };
}

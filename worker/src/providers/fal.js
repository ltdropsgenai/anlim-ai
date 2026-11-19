// fal queue API (docs: https://fal.ai/docs/model-endpoints/queue, read 2026-11-12).
// Submit returns request_id + status_url + response_url; status is IN_QUEUE / IN_PROGRESS / COMPLETED.
// Kling 4.0 image-to-video inputs (https://fal.ai/models/kling/v4/image-to-video): start_image_url, end_image_url,
// prompt, duration (3-30 s), resolution "720p" | "1080p". Price $0.157/s at 720p.
import { config } from "../config.js";

const hdr = () => ({ Authorization: `Key ${config.falKey}`, "Content-Type": "application/json" });

async function call(url, opts = {}) {
  let r;
  try { r = await fetch(url, { ...opts, headers: hdr() }); }
  catch (e) {
    // Node reports every network failure as "fetch failed"; the reason (DNS, refused, timeout, TLS) is in e.cause.
    const c = e.cause || {};
    throw new Error(`fal unreachable (${new URL(url).host}): ${c.code || c.name || ""} ${c.message || e.message}`.trim());
  }
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`fal ${r.status}: ${text.slice(0, 300)}`);
    err.permanent = r.status >= 400 && r.status < 500 && r.status !== 429;   // bad input: retrying will not help
    throw err;
  }
  return body;
}

export async function submit(endpoint, input) {
  if (!config.falKey) throw Object.assign(new Error("set FAL_KEY"), { permanent: true });
  const j = await call(`https://queue.fal.run/${endpoint}`, { method: "POST", body: JSON.stringify(input) });
  return { requestId: j.request_id, statusUrl: j.status_url, responseUrl: j.response_url };
}

// Image edits (end frames, Nano Banana 2 edit: result { images: [{ url }] }).
// -> { state: "pending" } | { state: "done", imageUrl } | { state: "failed", error }
export async function pollImage(job) {
  const s = await call(job.provider_status_url);
  if (s.status === "IN_QUEUE" || s.status === "IN_PROGRESS") return { state: "pending" };
  if (s.status !== "COMPLETED") return { state: "failed", error: `unexpected status ${s.status}` };
  try {
    const res = await call(job.provider_response_url);
    const url = res?.images?.[0]?.url;
    return url ? { state: "done", imageUrl: url } : { state: "failed", error: `no image in result: ${JSON.stringify(res).slice(0, 200)}` };
  } catch (e) {
    return { state: "failed", error: e.message };
  }
}

// -> { state: "pending" } | { state: "done", videoUrl } | { state: "failed", error }
export async function poll(gen) {
  const s = await call(gen.provider_status_url);
  if (s.status === "IN_QUEUE" || s.status === "IN_PROGRESS") return { state: "pending" };
  if (s.status !== "COMPLETED") return { state: "failed", error: `unexpected status ${s.status}` };
  try {
    const res = await call(gen.provider_response_url);
    const url = res?.video?.url;
    return url ? { state: "done", videoUrl: url } : { state: "failed", error: `no video in result: ${JSON.stringify(res).slice(0, 200)}` };
  } catch (e) {
    return { state: "failed", error: e.message };    // COMPLETED with an error body (e.g. content blocked)
  }
}

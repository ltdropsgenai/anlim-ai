// File storage, private bucket "studio" (paths start with the owner's id). Modes:
//   function (default): one-time links from the studio-storage Edge Function; no service_role key on this machine
//   supabase: direct Storage API with SUPABASE_SERVICE_ROLE_KEY;  local: a folder (tests)
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const base = () => `${config.supabaseUrl}/storage/v1`;

async function fn(op, objectPath, extra = {}) {
  const r = await fetch(`${config.supabaseUrl}/functions/v1/studio-storage`, {
    method: "POST", headers: { "x-worker-token": config.storageToken, "Content-Type": "application/json" },
    body: JSON.stringify({ op, path: objectPath, ...extra }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`studio-storage ${op} ${objectPath}: ${r.status} ${j.error || ""}`);
  return j.url;
}
const auth = () => ({ Authorization: `Bearer ${config.serviceKey}`, apikey: config.serviceKey });

export async function download(objectPath, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (config.storage === "local") return fs.copyFile(path.join(config.localStorageDir, objectPath), dest);
  const r = config.storage === "function" ? await fetch(await fn("sign_download", objectPath, { expires: 600 }))
    : await fetch(`${base()}/object/authenticated/${config.bucket}/${objectPath}`, { headers: auth() });
  if (!r.ok) throw new Error(`storage download ${objectPath}: ${r.status} ${await r.text()}`);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

export async function upload(src, objectPath, contentType = "video/mp4") {
  if (config.storage === "local") {
    const dest = path.join(config.localStorageDir, objectPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    return fs.copyFile(src, dest);
  }
  if (config.storage === "function") {
    const r = await fetch(await fn("sign_upload", objectPath), {
      method: "PUT", headers: { "Content-Type": contentType, "x-upsert": "true" }, body: await fs.readFile(src),
    });
    if (!r.ok) throw new Error(`storage upload ${objectPath}: ${r.status} ${await r.text()}`);
    return;
  }
  const r = await fetch(`${base()}/object/${config.bucket}/${objectPath}`, {
    method: "POST", headers: { ...auth(), "Content-Type": contentType, "x-upsert": "true" }, body: await fs.readFile(src),
  });
  if (!r.ok) throw new Error(`storage upload ${objectPath}: ${r.status} ${await r.text()}`);
}

// A short-lived URL the video provider can fetch the start frame from.
export async function signedUrl(objectPath, seconds = 3600) {
  if (config.storage === "local") return `file://${path.join(config.localStorageDir, objectPath)}`;
  if (config.storage === "function") return fn("sign_download", objectPath, { expires: seconds });
  const r = await fetch(`${base()}/object/sign/${config.bucket}/${objectPath}`, {
    method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: seconds }),
  });
  if (!r.ok) throw new Error(`storage sign ${objectPath}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return `${base()}${j.signedURL}`;
}

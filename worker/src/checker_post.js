// POST to the checker without Node fetch's 300 s headers timeout (undici). @anlim
// 2026-11-19 worker.js got this for clip checks (a check that waited in the checker's queue past 5 min came back as
// "fetch failed" and was retried from scratch). 2026-11-26 (Atud Clinton's end image, job dcedf786): frames.js still
// used fetch, and a busy cartoon group shot spent over 5 min matting every child in /compose, so each try died at
// 300 s with "fetch failed" and the creator waited 20+ minutes. Both now use this; 20 min cap.
import http from "node:http";
import { config } from "./config.js";

export function postChecker(route, body, timeoutMs = 20 * 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${config.checkerUrl}${route}`);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", timeout: timeoutMs,
      headers: { Authorization: `Bearer ${config.checkerToken}`, "Content-Type": "application/json", "Content-Length": data.length } },
      (res) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8"); let json; try { json = JSON.parse(text); } catch { json = null; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json }); }); });
    req.on("timeout", () => req.destroy(new Error(`checker timeout after ${Math.round(timeoutMs / 60000)} min`)));
    req.on("error", reject);
    req.end(data);
  });
}

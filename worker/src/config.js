// Worker settings, all from the environment. @anlim
import os from "node:os";
import path from "node:path";

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

export const config = {
  databaseUrl: need("DATABASE_URL"),                 // Supabase session pooler URI (Project Settings > Database)
  storage: process.env.STORAGE_MODE || "function",   // "function" (default), "supabase" or "local" (tests)
  supabaseUrl: process.env.SUPABASE_URL || "",
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",        // only for STORAGE_MODE=supabase
  storageToken: process.env.STORAGE_TOKEN || "",                    // x-worker-token for the studio-storage function
  localStorageDir: process.env.LOCAL_STORAGE_DIR || path.join(os.tmpdir(), "studio-storage"),
  bucket: process.env.STORAGE_BUCKET || "studio",
  falKey: process.env.FAL_KEY || "",
  higgsfieldKey: process.env.HIGGSFIELD_KEY || "",   // "id:secret" from open.higgsfield.ai (motion transfer)
  checkerUrl: process.env.CHECKER_URL || "http://127.0.0.1:8787",
  checkerToken: need("CHECKER_TOKEN"),
  checkerMaxUsd: Number(process.env.CHECKER_MAX_USD || "0.15"),   // per-clip checking budget (design doc)
  workDir: process.env.WORK_DIR || path.join(os.tmpdir(), "studio-work"),  // local clips + checker output
  workerId: process.env.WORKER_ID || `${os.hostname()}-${process.pid}`,
  batch: Number(process.env.WORKER_BATCH || "4"),
  checkerSlots: Number(process.env.CHECKER_MAX_JOBS || "2"),   // clip checks in flight at once (same env as the checker)
  idleMs: Number(process.env.WORKER_IDLE_MS || "5000"),
  pollMs: Number(process.env.PROVIDER_POLL_MS || "15000"),
  providerTimeoutMin: Number(process.env.PROVIDER_TIMEOUT_MIN || "20"),
  motionTimeoutMin: Number(process.env.MOTION_TIMEOUT_MIN || "60"),   // Genjutsu took 7.7-13 min for 12 s (2026-11-20 tests)
  maxStepTries: Number(process.env.MAX_STEP_TRIES || "5"),
  checkerMaxCrashes: Number(process.env.CHECKER_MAX_CRASHES || "2"),   // checks of one clip that may die with the machine
  endFrameGate: process.env.END_FRAME_GATE || "block",   // block | warn | off (end-frame drift check before submit)
};

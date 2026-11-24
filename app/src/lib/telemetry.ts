// Monitoring and analytics (2026-11-23, Londi chose "Built into Supabase"): page views and errors the app saw go to
// studio.app_events / studio.app_errors through studio-api, for the admin Insights page. Signed-in creators only; only
// the page's path is sent (never its query string), and the database caps how much one account can send. @anlim
import { Platform } from "react-native";
import { supabase } from "./supabase";

async function send(body: Record<string, unknown>) {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/studio-api`, {
      method: "POST", keepalive: true,
      headers: { Authorization: `Bearer ${token}`, apikey: process.env.EXPO_PUBLIC_SUPABASE_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch { /* monitoring never gets in the creator's way */ }
}

let lastRoute = "";
export function trackView(route: string) {
  // ids become ":id", so the Insights page counts "/cut/:id" as one page
  const r = (route || "/").split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
  if (r === lastRoute) return;
  lastRoute = r;
  void send({ op: "track", name: "view", route: r });
}

const seen = new Map<string, number>();
export function reportError(place: string, error: unknown) {
  const e = error instanceof Error ? error : new Error(String((error as { message?: string })?.message ?? error));
  const key = `${place}|${e.message}`;
  if (Date.now() - (seen.get(key) ?? 0) < 60_000) return;   // the same error over and over is sent once a minute
  seen.set(key, Date.now());
  void send({ op: "client_error", place: place.slice(0, 200), message: e.message.slice(0, 2000),
              detail: { stack: (e.stack || "").slice(0, 3000), platform: Platform.OS,
                        page: Platform.OS === "web" && typeof location !== "undefined" ? location.pathname : null } });
}

let installed = false;
export function installErrorHandlers() {
  if (installed || Platform.OS !== "web" || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => reportError("window", ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => reportError("promise", ev.reason));
}

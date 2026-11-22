// Where to go after signing in, when sign-in was asked for by the OAuth consent page (2026-11-21) or the AI-tool upload
// page (2026-11-22). Only those two pages are accepted, so this can never send a creator to another site. @anlim
import { Platform } from "react-native";

const KEY = "anlim.oauthReturn";
const OK = /^(\/oauth\/consent\?authorization_id=[A-Za-z0-9%_\-.]+|\/upload)$/;

export function setOauthReturn(path: string) {
  if (Platform.OS !== "web" || !OK.test(path)) return;
  try { window.sessionStorage.setItem(KEY, path); } catch { /* not kept: the creator starts the connection again */ }
}

export function takeOauthReturn(): string | null {
  if (Platform.OS !== "web") return null;
  try {
    const v = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    return v && OK.test(v) ? v : null;
  } catch { return null; }
}

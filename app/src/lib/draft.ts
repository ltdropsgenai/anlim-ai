// A prompt typed before signing up (2026-11-19, Londi: visitors try the prompt first and are asked to create an
// account only to see the result). Kept in this browser until the new account signs in; then the Home composer makes
// the shot and its first frame from it, paid from the new account's credits. Older than a day = dropped. @anlim
import { Platform } from "react-native";
import type { Aspect, Look, Output } from "./api";

export type Draft = { text: string; look: Look; len: number; output?: Output; aspect?: Aspect; at: number };
const KEY = "anlim.draft";
const DAY = 24 * 3600 * 1000;
let memory: Draft | null = null;     // native, or a browser where storage is blocked

export function saveDraft(d: Omit<Draft, "at">) {
  const v: Draft = { ...d, at: Date.now() };
  memory = v;
  if (Platform.OS === "web") { try { window.localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* memory only */ } }
}

export function peekDraft(): Draft | null {
  let v: Draft | null = memory;
  if (Platform.OS === "web") {
    try { const raw = window.localStorage.getItem(KEY); if (raw) v = JSON.parse(raw) as Draft; } catch { /* memory only */ }
  }
  if (!v || typeof v.text !== "string" || !v.text.trim() || Date.now() - (v.at || 0) > DAY) return null;
  return v;
}

export function clearDraft() {
  memory = null;
  if (Platform.OS === "web") { try { window.localStorage.removeItem(KEY); } catch { /* nothing to clear */ } }
}

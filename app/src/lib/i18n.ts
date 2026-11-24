// Languages (2026-11-24, Londi: English, Spanish and French, for the app and everything anlim makes). @anlim
//
// The English text is the key: t("Keep a clip for this shot first.") looks the sentence up in i18n/es.json or fr.json and
// falls back to the English. So a string can be translated wherever it is shown, including constants defined at module
// level (wrap them where they are rendered, not where they are defined: t() reads the language at call time).
// {name} in a string is filled from vars. Messages the server sends in English (errors, check reasons, notices) go
// through tMsg, which also matches catalog entries with {placeholders} against the message.
// Changing the language remounts the app (app/_layout.tsx keys the tree on it), so plain t() calls re-render.
import { Platform } from "react-native";
import es from "../i18n/es.json";
import fr from "../i18n/fr.json";

export type Lang = "en" | "es" | "fr";
export const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "English" }, { id: "es", label: "Español" }, { id: "fr", label: "Français" },
];
const DICTS: Record<Lang, Record<string, string> | null> = { en: null, es: es as Record<string, string>, fr: fr as Record<string, string> };
const KEY = "anlim.lang";

function isLang(x: unknown): x is Lang { return x === "en" || x === "es" || x === "fr"; }

// The device's language: the browser's list on the web, Intl elsewhere. Anything else is English.
function deviceLang(): Lang {
  const list: string[] = [];
  try {
    if (Platform.OS === "web" && typeof navigator !== "undefined") list.push(...(navigator.languages || []), navigator.language);
    list.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch { /* no Intl */ }
  for (const l of list) { const p = String(l || "").slice(0, 2).toLowerCase(); if (isLang(p)) return p; }
  return "en";
}
function stored(): Lang | null {
  try { if (Platform.OS === "web") { const v = localStorage.getItem(KEY); if (isLang(v)) return v; } } catch { /* private mode */ }
  return null;
}

let lang: Lang = stored() ?? deviceLang();
const listeners = new Set<(l: Lang) => void>();

export function getLang(): Lang { return lang; }
// The account's choice (from the server) or the creator's pick. remember=false: use it without saving it on this device.
export function setLang(l: Lang, remember = true) {
  if (!isLang(l)) return;
  if (remember) { try { if (Platform.OS === "web") localStorage.setItem(KEY, l); } catch { /* ignore */ } }
  if (l === lang) return;
  lang = l;
  listeners.forEach((f) => f(l));
}
export function onLang(f: (l: Lang) => void) { listeners.add(f); return () => { listeners.delete(f); }; }
// the language the device would pick (shown as the default in Account)
export function detectedLang(): Lang { return deviceLang(); }

const fill = (s: string, vars?: Record<string, string | number | null | undefined>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] != null ? String(vars[k]) : m)) : s;

// {why}, {error} and {evidence} hold the server's own English (a failure, the model tests' findings): shown translated
const SERVER_VARS = new Set(["why", "error", "evidence"]);
export function t(s: string, vars?: Record<string, string | number | null | undefined>): string {
  const d = DICTS[lang];
  if (d && vars) vars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, SERVER_VARS.has(k) && typeof v === "string" ? tMsg(v) : v]));
  return fill((d && d[s]) || s, vars);
}

// Server messages: exact match first, then the catalog's patterns ("Lip sync needs {n} credits; you have {m}.").
type Pat = { re: RegExp; keys: string[]; key: string };
const patterns: Partial<Record<Lang, Pat[]>> = {};
function patsFor(l: Lang): Pat[] {
  if (patterns[l]) return patterns[l]!;
  const d = DICTS[l] || {};
  const out: Pat[] = [];
  for (const key of Object.keys(d)) {
    if (!/\{\w+\}/.test(key)) continue;
    const keys: string[] = [];
    const src = key.split(/(\{\w+\})/).map((part) => {
      const m = part.match(/^\{(\w+)\}$/);
      if (m) { keys.push(m[1]); return "(.+?)"; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    out.push({ re: new RegExp(`^${src}$`, "s"), keys, key });
  }
  return (patterns[l] = out);
}
export function tMsg(msg: string | null | undefined): string {
  if (!msg) return "";
  const d = DICTS[lang];
  if (!d) return msg;
  if (d[msg]) return d[msg];
  for (const p of patsFor(lang)) {
    const m = msg.match(p.re);
    if (m) return fill(d[p.key], Object.fromEntries(p.keys.map((k, i) => [k, tMsg(m[i + 1])])));
  }
  return remote(msg);
}

// Messages written while anlim runs (check findings, cut notes, errors with numbers in them) are not in the catalog.
// They are asked of the server in batches (studio-api "translate", kept in studio.translations) and kept on this
// device; until one arrives the English shows, and the screen's next refresh shows the translation.
const REMOTE_KEY = "anlim.tr.";
let remoteCache: Record<string, string> | null = null;
let remoteLang: Lang | null = null;
const asked = new Map<string, number>();
const queue = new Set<string>();
let flushT: ReturnType<typeof setTimeout> | null = null;
let fetcher: ((texts: string[], lang: Lang) => Promise<Record<string, string>>) | null = null;
const listenersRemote = new Set<() => void>();
export function setTranslator(f: typeof fetcher) { fetcher = f; }
export function onTranslations(f: () => void) { listenersRemote.add(f); return () => { listenersRemote.delete(f); }; }
function cache(): Record<string, string> {
  if (remoteCache && remoteLang === lang) return remoteCache;
  remoteLang = lang; remoteCache = {};
  try { if (Platform.OS === "web") remoteCache = JSON.parse(localStorage.getItem(REMOTE_KEY + lang) || "{}") || {}; } catch { /* ignore */ }
  return remoteCache!;
}
function remote(msg: string): string {
  if (lang === "en" || msg.length > 2000 || !/[A-Za-z]{2,}/.test(msg)) return msg;
  const c = cache();
  if (c[msg]) return c[msg];
  const last = asked.get(msg) || 0;
  if (fetcher && Date.now() - last > 15000) {           // ask again later: the worker may still be translating it
    asked.set(msg, Date.now()); queue.add(msg);
    if (!flushT) flushT = setTimeout(flush, 400);
  }
  return msg;
}
async function flush() {
  flushT = null;
  const l = lang, texts = [...queue].slice(0, 50);
  texts.forEach((t) => queue.delete(t));
  if (queue.size) flushT = setTimeout(flush, 400);
  if (!texts.length || !fetcher || l === "en") return;
  try {
    const out = await fetcher(texts, l);
    if (l !== lang || !out || !Object.keys(out).length) return;
    const c = cache();
    Object.assign(c, out);
    const keys = Object.keys(c);
    if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1500)) delete c[k];
    try { if (Platform.OS === "web") localStorage.setItem(REMOTE_KEY + l, JSON.stringify(c)); } catch { /* full */ }
    listenersRemote.forEach((f) => f());
  } catch { /* signed out or offline: English stays */ }
}

// Dates and numbers in the creator's language.
export const locale = () => (lang === "es" ? "es" : lang === "fr" ? "fr-FR" : "en-US");
// The name used in screens (`t` is a common local variable name there).
export const tr = t;
// Plurals: trp(n, "{n} file", "{n} files"). French counts 0 and 1 as singular.
export function trp(n: number, one: string, many: string, vars?: Record<string, string | number | null | undefined>) {
  const single = lang === "fr" ? Math.abs(n) < 2 : n === 1;
  return t(single ? one : many, { n, ...vars });
}

// Module-level label tables are built once, in English. These wrap them so every read gives the creator's language:
// trMap({ active: "active" })[k] and Object.entries/values of it are translated; trDeep(list, ["title", "sub"]) does
// the same for the named fields of objects in arrays or records (FORMATS, nav items...). Keys and ids stay English.
export function trMap<T extends Record<string, string>>(m: T): T {
  return new Proxy(m, {
    get: (o, k) => { const v = (o as Record<string | symbol, unknown>)[k]; return typeof v === "string" ? t(v) : v; },
    getOwnPropertyDescriptor: (o, k) => {
      const d = Object.getOwnPropertyDescriptor(o, k);
      return d && typeof d.value === "string" ? { ...d, value: t(d.value) } : d;
    },
  });
}
export function trDeep<T extends object>(x: T, fields: string[]): T {
  const seen = new WeakMap<object, object>();
  const wrap = (v: unknown, field?: string | symbol): unknown => {
    if (typeof v === "string") return field && typeof field === "string" && fields.includes(field) ? t(v) : v;
    if (!v || typeof v !== "object") return v;
    if (seen.has(v)) return seen.get(v);
    const p = new Proxy(v, {
      get: (o, k) => {
        const val = Reflect.get(o, k);
        if (typeof val === "function") return Array.isArray(o) ? (val as Function).bind(p) : val;
        return wrap(val, Array.isArray(o) ? undefined : k);
      },
      getOwnPropertyDescriptor: (o, k) => {
        const d = Object.getOwnPropertyDescriptor(o, k);
        return d && "value" in d ? { ...d, value: wrap(d.value, Array.isArray(o) ? undefined : k) } : d;
      },
    });
    seen.set(v, p);
    return p;
  };
  return wrap(x) as T;
}

// A motion-transfer shot without a description is stored as "Motion transfer" (the worker reads it); shown translated.
export const shotText = (s: string | null | undefined) => (s === "Motion transfer" ? t("Motion transfer") : s ?? "");

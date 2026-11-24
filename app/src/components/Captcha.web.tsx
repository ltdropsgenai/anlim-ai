// Cloudflare Turnstile on sign-in, sign-up and password reset (2026-11-19; Londi 2026-11-18: CAPTCHA before launch).
// Off until EXPO_PUBLIC_TURNSTILE_SITE_KEY is set; Supabase Auth must have CAPTCHA protection on with the matching
// secret key (Dashboard > Authentication > Attack Protection), or it will reject every sign-in that sends a token. @anlim
import { useEffect, useRef } from "react";
import { tr } from "../lib/i18n";

declare global { interface Window { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void } } }
export const CAPTCHA_ON = !!process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  return new Promise((ok, fail) => {
    const id = "cf-turnstile-js";
    if (document.getElementById(id)) { const t = setInterval(() => { if (window.turnstile) { clearInterval(t); ok(); } }, 100); return; }
    const sc = document.createElement("script");
    sc.id = id; sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; sc.async = true;
    sc.onload = () => ok(); sc.onerror = () => fail(new Error(tr("The security check could not load. Check your connection.")));
    document.head.appendChild(sc);
  });
}

// Remount (change its key) after every attempt: a Turnstile token works once.
export function Captcha({ onToken }: { onToken: (t: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!CAPTCHA_ON) return;
    let wid: string | null = null, gone = false;
    loadScript().then(() => {
      if (gone || !box.current || !window.turnstile) return;
      wid = window.turnstile.render(box.current, {
        sitekey: process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY, theme: "dark",
        callback: (t: string) => onToken(t), "expired-callback": () => onToken(null), "error-callback": () => onToken(null),
      });
    }).catch(() => onToken(null));
    return () => { gone = true; if (wid && window.turnstile) window.turnstile.remove(wid); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!CAPTCHA_ON) return null;
  return <div ref={box} style={{ minHeight: 65 }} />;
}

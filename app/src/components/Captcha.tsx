// Native: no CAPTCHA widget yet (Turnstile needs a web view). Keep EXPO_PUBLIC_TURNSTILE_SITE_KEY unset for native
// builds until one is added, or Supabase will reject their sign-ins. @anlim
export const CAPTCHA_ON = false;
export function Captcha(_: { onToken: (t: string | null) => void }) { return null; }

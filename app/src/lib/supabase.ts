// Supabase client: sign-in, sign-up, password reset. Studio data goes through the studio-api function (lib/api.ts). @anlim
// On the web the client reads the session from links in Supabase's emails (confirm sign-up, reset password):
// they come back to the app with the tokens in the URL, and detectSessionInUrl picks them up.
import { Platform } from "react-native";
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_KEY!, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: Platform.OS === "web" },
});

// Where email links send the creator back to (web: this site; native: the dev web app until deep links exist).
export const appUrl = (path: string) =>
  (Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "http://localhost:8081") + path;

// Set while a password-reset sign-in is in progress, so the root layout sends the creator to /reset-password
// instead of the home screen (the reset link and the reset code both sign in first).
export const authFlags = { recovery: false };

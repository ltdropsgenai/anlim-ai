// What anlim does, in plain words: shared by Home (signed in) and the public landing page (2026-11-19). @anlim
import type { MarkName } from "../components/iconData";
import { trDeep } from "./i18n";

// 2026-11-20: each feature carries a MARK glyph (iconData.ts) instead of a nav icon in a square tile
export const FEATURES: { mark: MarkName; title: string; body: string }[] = trDeep([
  { mark: "continuity", title: "Your cast stays the same", body: "Give each character and place a card once. Every frame and clip uses the same faces, clothes and heights, shot after shot." },
  { mark: "frames", title: "Start and end frames from a sentence", body: "Say where everyone is. anlim draws the frame in your location and checks the room, the heights and the poses before you use it." },
  { mark: "route", title: "Auto picks the model", body: "Each kind of shot goes to the model that did best in our tests. Choose Best quality, Balanced or Lowest cost, and see why it picked." },
  { mark: "scan", title: "Every clip checked", body: "The anlim check looks at each clip frame by frame and tells you what it found. If a clip is unusable, request a refund and say why." },
  { mark: "ratios", title: "Finished scene cuts", body: "Join the clips you kept into one video in 16:9, 9:16 or 4:5, with fades, an end card, music (your track or a generated score), voiceover and sound effects." },
  { mark: "layers", title: "Everything in one place", body: "Clips, cuts, frames, characters, places and music, filed by type, series, look and genre." },
], ["title", "body"]);

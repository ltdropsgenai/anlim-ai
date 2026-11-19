// What anlim does, in plain words: shared by Home (signed in) and the public landing page (2026-11-19). @anlim
import type { IconName } from "../components/Icon";

export const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: "cast", title: "Your cast stays the same", body: "Give each character and place a card once. Every frame and clip uses the same faces, clothes and heights, shot after shot." },
  { icon: "image", title: "Start and end frames from a sentence", body: "Say where everyone is. anlim draws the frame in your location and checks the room, the heights and the poses before you use it." },
  { icon: "spark", title: "Auto picks the model", body: "Each kind of shot goes to the model that did best in our tests. Choose Best quality, Balanced or Lowest cost, and see why it picked." },
  { icon: "check", title: "Every clip checked", body: "The anlim check looks at each clip frame by frame and tells you what it found. A clip that fails costs nothing, and rejecting one it flagged gives the credits back." },
  { icon: "cut", title: "Finished scene cuts", body: "Join the clips you kept into one video in 16:9, 9:16 or 4:5, with fades, an end card, music (your track or a generated score), voiceover and sound effects." },
  { icon: "assets", title: "Everything in one place", body: "Clips, cuts, frames, characters, places and music, filed by type, series, look and genre." },
];


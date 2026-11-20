// Native: simple glyphs until an icon library is added (the web build uses Icon.web.tsx). @anlim
import { Text } from "react-native";
export type IconName = "studio" | "review" | "cast" | "credits" | "account" | "back" | "cut" | "home" | "workspace" | "assets"
  | "play" | "music" | "image" | "search" | "check" | "spark" | "arrow" | "fold" | "unfold";
const G: Record<IconName, string> = { studio: "▦", review: "✓", cast: "☺", credits: "◫", account: "◉", back: "‹", cut: "≡", home: "⌂", workspace: "▣", assets: "▦",
  play: "▶", music: "♪", image: "▨", search: "⌕", check: "✓", spark: "✦", arrow: "→", fold: "‹", unfold: "›" };
export function Icon({ name, size = 20, color = "#F4F4F5" }:
  { name: IconName; size?: number; color?: string; active?: boolean; weight?: number }) {
  return <Text style={{ fontSize: size, color, lineHeight: size + 2 }}>{G[name]}</Text>;
}

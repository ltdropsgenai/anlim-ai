// Stroke icons for the app frame (web: inline SVG). @anlim
import type { ReactElement } from "react";
export type IconName = "studio" | "review" | "cast" | "credits" | "account" | "back" | "cut" | "home" | "workspace" | "assets"
  | "play" | "music" | "image" | "search" | "check" | "spark" | "arrow";
const P: Record<IconName, ReactElement> = {
  studio: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M8 5v4M16 5v4" /></>,
  review: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.5 2.5L16 9.5" /></>,
  cast: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 19c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5" /><circle cx="17" cy="9" r="2.5" /><path d="M17 14c2.3 0 4 1.2 4.6 3.6" /></>,
  credits: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9 9.5c0-1.4 1.3-2.2 3-2.2s3 .8 3 2c0 2.9-6 1.5-6 4.6 0 1.3 1.3 2.1 3 2.1s3-.8 3-2.2" /></>,
  account: <><circle cx="12" cy="8.5" r="4" /><path d="M4 20c1.2-3.8 4.2-5.6 8-5.6s6.8 1.8 8 5.6" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  cut: <><path d="M4 7h16M4 12h10M4 17h13" /></>,
  home: <><path d="M3.5 11L12 4l8.5 7" /><path d="M6 9.5V20h12V9.5" /><path d="M10 20v-5h4v5" /></>,
  workspace: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M3 10h6" /><path d="M13.5 11l4 2.5-4 2.5z" /></>,
  assets: <><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></>,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  music: <><path d="M9 18V6l11-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5.5-5.5L6 19" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  check: <><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" /><path d="M8.5 12.2l2.5 2.5 4.8-5" /></>,
  spark: <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};
export function Icon({ name, size = 20, color = "currentColor" }: { name: IconName; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[name]}</svg>
  );
}

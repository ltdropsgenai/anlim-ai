// Stroke icons for the app frame (web: inline SVG). Nav glyphs redrawn 2026-11-20 on one 24 px grid, 1.6 stroke in the
// rail; credits is a ticket (the coin stack read as a database). @anlim
import type { ReactElement } from "react";
export type IconName = "studio" | "review" | "cast" | "credits" | "account" | "back" | "cut" | "home" | "workspace" | "assets"
  | "play" | "music" | "image" | "search" | "check" | "spark" | "arrow";
const P: Record<IconName, ReactElement> = {
  studio: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M8 5v4M16 5v4" /></>,
  review: <><path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5" /><path d="m8.6 12.2 2.4 2.4 4.6-5" /></>,
  cast: <><circle cx="9.5" cy="8.5" r="3.3" /><path d="M3.8 19.5c.6-3.3 2.9-5.2 5.7-5.2s5.1 1.9 5.7 5.2" /><path d="M15.6 5.6a3.1 3.1 0 0 1 0 5.8M17.6 14.6c1.5.7 2.4 2.4 2.7 4.9" /></>,
  credits: <><path d="M3.5 7.2c0-.9.7-1.7 1.7-1.7h13.6c.9 0 1.7.8 1.7 1.7v2.3a2.5 2.5 0 0 0 0 5v2.3c0 .9-.8 1.7-1.7 1.7H5.2c-1 0-1.7-.8-1.7-1.7v-2.3a2.5 2.5 0 0 0 0-5z" /><path d="M15 6v1.6M15 11.2v1.6M15 16.4V18" /></>,
  account: <><circle cx="12" cy="8.5" r="4" /><path d="M4 20c1.2-3.8 4.2-5.6 8-5.6s6.8 1.8 8 5.6" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  cut: <><path d="M4 7h16M4 12h10M4 17h13" /></>,
  home: <path d="M4 10.4 12 4l8 6.4V19a1 1 0 0 1-1 1h-4.2v-5.2h-5.6V20H5a1 1 0 0 1-1-1z" />,
  workspace: <><rect x="3.5" y="5" width="17" height="12" rx="1.6" /><path d="M3.5 20h17M7.5 20v-3M16.5 20v-3" /><path d="m10.4 8.6 4 2.4-4 2.4z" /></>,
  assets: <><rect x="7.5" y="3.5" width="13" height="13" rx="1.6" /><path d="M16.5 20.5H5a1.5 1.5 0 0 1-1.5-1.5V7.5" /><path d="m10 13.5 3-3.2 2.4 2.4 1.6-1.6 3.5 3.4" /></>,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  music: <><path d="M9 18V6l11-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5.5-5.5L6 19" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  check: <><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" /><path d="M8.5 12.2l2.5 2.5 4.8-5" /></>,
  spark: <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};
// The nav glyphs' solid part, drawn under the outline at low opacity when the item is the current page (2026-11-20)
const FILL: Partial<Record<IconName, ReactElement>> = {
  home: <path d="M4 10.4 12 4l8 6.4V19a1 1 0 0 1-1 1h-4.2v-5.2h-5.6V20H5a1 1 0 0 1-1-1z" />,
  workspace: <rect x="3.5" y="5" width="17" height="12" rx="1.6" />,
  assets: <rect x="7.5" y="3.5" width="13" height="13" rx="1.6" />,
  review: <rect x="4" y="4" width="16" height="16" rx="2" />,
  cast: <><circle cx="9.5" cy="8.5" r="3.3" /><path d="M3.8 19.5c.6-3.3 2.9-5.2 5.7-5.2s5.1 1.9 5.7 5.2z" /></>,
  credits: <path d="M3.5 7.2c0-.9.7-1.7 1.7-1.7h13.6c.9 0 1.7.8 1.7 1.7v2.3a2.5 2.5 0 0 0 0 5v2.3c0 .9-.8 1.7-1.7 1.7H5.2c-1 0-1.7-.8-1.7-1.7v-2.3a2.5 2.5 0 0 0 0-5z" />,
};
export function Icon({ name, size = 20, color = "currentColor", active = false, weight = 1.8 }:
  { name: IconName; size?: number; color?: string; active?: boolean; weight?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={weight}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", transition: "stroke 160ms ease" }}>
      {active && FILL[name] ? <g fill={color} fillOpacity={0.14} stroke="none">{FILL[name]}</g> : null}
      {P[name]}
    </svg>
  );
}

// Icons for the app frame (web: inline SVG); the navigation set is drawn duotone, see NAV below. @anlim
import type { ReactElement } from "react";
export type IconName = "studio" | "review" | "cast" | "credits" | "account" | "back" | "cut" | "home" | "workspace" | "assets"
  | "play" | "music" | "image" | "search" | "check" | "spark" | "arrow" | "fold" | "unfold";
const P: Partial<Record<IconName, ReactElement>> = {
  studio: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M8 5v4M16 5v4" /></>,
  account: <><circle cx="12" cy="8.5" r="4" /><path d="M4 20c1.2-3.8 4.2-5.6 8-5.6s6.8 1.8 8 5.6" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  cut: <><path d="M4 7h16M4 12h10M4 17h13" /></>,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  music: <><path d="M9 18V6l11-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5.5-5.5L6 19" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  check: <><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" /><path d="M8.5 12.2l2.5 2.5 4.8-5" /></>,
  spark: <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  // the sidebar's collapse / expand control: a panel with its edge, and a chevron pointing the way it will move
  fold: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M9 4.5v15M15.5 10l-2 2 2 2" /></>,
  unfold: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M9 4.5v15M13.5 10l2 2-2 2" /></>,
};
// Navigation glyphs (2026-11-20, Londi picked "icons2"): film-studio objects drawn duotone. A soft body (low-opacity
// fill), crisp strokes, and ONE accent part that turns tungsten orange on the current page: the logo's dot. Home is a
// clapperboard (start something), Workspace edit tracks with a playhead, Assets a contact sheet with one frame picked,
// Review a viewfinder with the tally light, Cast two busts with the lead in front, Credits a ticket stub.
const NAV: Partial<Record<IconName, { b: ReactElement | null; s: ReactElement; a: ReactElement }>> = {
  home: { b: <rect x="3" y="9.5" width="18" height="10.5" rx="2" />,
          s: <><rect x="3" y="9.5" width="18" height="10.5" rx="2" /><path d="M7.5 14.5h5" /></>,
          a: <path d="M3.6 8.2 3.2 6.5a1.5 1.5 0 0 1 1.1-1.8l12.6-3a1.5 1.5 0 0 1 1.8 1.1l.4 1.7z" stroke="none" /> },
  workspace: { b: null, s: <path d="M4 6.5h8M7 12h12M4 17.5h6" strokeWidth={3.2} />,
          a: <><path d="M15.5 3.5v17" fill="none" strokeWidth={1.8} /><path d="M13.6 3.2h3.8l-1.9 2.3z" stroke="none" /></> },
  assets: { b: <><rect x="3" y="4.5" width="8" height="6" rx="1.6" /><rect x="13" y="4.5" width="8" height="6" rx="1.6" /><rect x="3" y="13.5" width="8" height="6" rx="1.6" /></>,
          s: <><rect x="3" y="4.5" width="8" height="6" rx="1.6" /><rect x="13" y="4.5" width="8" height="6" rx="1.6" /><rect x="3" y="13.5" width="8" height="6" rx="1.6" /></>,
          a: <rect x="13" y="13.5" width="8" height="6" rx="1.6" stroke="none" /> },
  review: { b: <rect x="5" y="6.5" width="14" height="11" rx="2" />,
          s: <path d="M3 8V6a2 2 0 0 1 2-2h2.5M16.5 4H19a2 2 0 0 1 2 2v2M21 16v2a2 2 0 0 1-2 2h-2.5M7.5 20H5a2 2 0 0 1-2-2v-2" />,
          a: <circle cx="12" cy="12" r="2.6" stroke="none" /> },
  cast: { b: <><circle cx="15.5" cy="8" r="3" /><path d="M10.5 19c.4-3.2 2.4-5 5-5s4.6 1.8 5 5z" /></>,
          s: <><circle cx="15.5" cy="8" r="3" /><path d="M10.5 19c.4-3.2 2.4-5 5-5s4.6 1.8 5 5z" /></>,
          a: <><circle cx="8.5" cy="9" r="3.4" stroke="none" /><path d="M2.5 20.5c.5-3.8 2.9-6 6-6s5.5 2.2 6 6z" stroke="none" /></> },
  credits: { b: <path d="M3 7.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2V10a2 2 0 0 0 0 4v2.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V14a2 2 0 0 0 0-4z" />,
          s: <><path d="M3 7.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2V10a2 2 0 0 0 0 4v2.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V14a2 2 0 0 0 0-4z" /><path d="M15 6.5v1.5M15 11.25v1.5M15 16v1.5" /></>,
          a: <circle cx="9" cy="12" r="2.2" stroke="none" /> },
};
const ACCENT = "#FF7A1A";

export function Icon({ name, size = 20, color = "currentColor", active = false, weight = 1.8 }:
  { name: IconName; size?: number; color?: string; active?: boolean; weight?: number }) {
  const n = NAV[name];
  if (n) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        style={{ display: "block", overflow: "visible" }}>
        {n.b && <g fill={color} fillOpacity={active ? 0.16 : 0.09} stroke="none">{n.b}</g>}
        <g stroke={color} strokeWidth={weight} style={{ transition: "stroke 160ms ease" }}>{n.s}</g>
        <g fill={active ? ACCENT : color} stroke={active ? ACCENT : color} opacity={active ? 1 : 0.75}
          style={{ transition: "fill 200ms ease, stroke 200ms ease", filter: active ? "drop-shadow(0 0 3px rgba(255,122,26,0.7))" : "none" }}>{n.a}</g>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={weight}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block" }}>{P[name]}</svg>
  );
}

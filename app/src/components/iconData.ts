// Icon geometry, shared by the web (Icon.web.tsx: inline SVG) and native (Icon.tsx: react-native-svg) so both draw
// the same glyphs from one source (2026-11-20: native showed placeholder characters). Attribute names are the camelCase
// SVG props both renderers accept. @anlim
export type IconName = "studio" | "review" | "cast" | "credits" | "account" | "back" | "cut" | "home" | "workspace" | "assets"
  | "play" | "music" | "image" | "search" | "check" | "spark" | "arrow" | "fold" | "unfold";
export type Prim = { t: "path" | "rect" | "circle"; p: Record<string, string | number> };

// Plain line icons: stroke only.
export const LINE: Partial<Record<IconName, Prim[]>> = {
  studio: [{t: "rect", p: {"x": 3, "y": 5, "width": 18, "height": 14, "rx": 2}}, {t: "path", p: {"d": "M3 9h18M8 5v4M16 5v4"}}],
  account: [{t: "circle", p: {"cx": 12, "cy": 8.5, "r": 4}}, {t: "path", p: {"d": "M4 20c1.2-3.8 4.2-5.6 8-5.6s6.8 1.8 8 5.6"}}],
  back: [{t: "path", p: {"d": "M15 5l-7 7 7 7"}}],
  cut: [{t: "path", p: {"d": "M4 7h16M4 12h10M4 17h13"}}],
  play: [{t: "path", p: {"d": "M8 5.5v13l10.5-6.5z"}}],
  music: [{t: "path", p: {"d": "M9 18V6l11-2v12"}}, {t: "circle", p: {"cx": 6.5, "cy": 18, "r": 2.5}}, {t: "circle", p: {"cx": 17.5, "cy": 16, "r": 2.5}}],
  image: [{t: "rect", p: {"x": 3, "y": 5, "width": 18, "height": 14, "rx": 2}}, {t: "circle", p: {"cx": 9, "cy": 10, "r": 1.8}}, {t: "path", p: {"d": "M21 16l-5.5-5.5L6 19"}}],
  search: [{t: "circle", p: {"cx": 11, "cy": 11, "r": 6.5}}, {t: "path", p: {"d": "M16 16l4.5 4.5"}}],
  check: [{t: "path", p: {"d": "M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"}}, {t: "path", p: {"d": "M8.5 12.2l2.5 2.5 4.8-5"}}],
  spark: [{t: "path", p: {"d": "M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"}}],
  arrow: [{t: "path", p: {"d": "M5 12h14M13 6l6 6-6 6"}}],
  fold: [{t: "rect", p: {"x": 3, "y": 4.5, "width": 18, "height": 15, "rx": 2.5}}, {t: "path", p: {"d": "M9 4.5v15M15.5 10l-2 2 2 2"}}],
  unfold: [{t: "rect", p: {"x": 3, "y": 4.5, "width": 18, "height": 15, "rx": 2.5}}, {t: "path", p: {"d": "M9 4.5v15M13.5 10l2 2-2 2"}}],
};

// Navigation glyphs (Londi picked "icons2"): film-studio objects drawn duotone. b = soft body (low-opacity fill),
// s = crisp strokes, a = the ONE accent part that turns tungsten orange on the current page (the logo's dot).
// Home a clapperboard, Workspace edit tracks and a playhead, Assets a contact sheet, Review a viewfinder with the
// tally light, Cast two busts with the lead in front, Credits a ticket stub.
export const NAV: Partial<Record<IconName, { b: Prim[]; s: Prim[]; a: Prim[] }>> = {
  home: { b: [{t: "rect", p: {"x": 3, "y": 9.5, "width": 18, "height": 10.5, "rx": 2}}],
    s: [{t: "rect", p: {"x": 3, "y": 9.5, "width": 18, "height": 10.5, "rx": 2}}, {t: "path", p: {"d": "M7.5 14.5h5"}}],
    a: [{t: "path", p: {"d": "M3.6 8.2 3.2 6.5a1.5 1.5 0 0 1 1.1-1.8l12.6-3a1.5 1.5 0 0 1 1.8 1.1l.4 1.7z", "stroke": "none"}}] },
  workspace: { b: [],
    s: [{t: "path", p: {"d": "M4 6.5h8M7 12h12M4 17.5h6", "strokeWidth": 3.2}}],
    a: [{t: "path", p: {"d": "M15.5 3.5v17", "fill": "none", "strokeWidth": 1.8}}, {t: "path", p: {"d": "M13.6 3.2h3.8l-1.9 2.3z", "stroke": "none"}}] },
  assets: { b: [{t: "rect", p: {"x": 3, "y": 4.5, "width": 8, "height": 6, "rx": 1.6}}, {t: "rect", p: {"x": 13, "y": 4.5, "width": 8, "height": 6, "rx": 1.6}}, {t: "rect", p: {"x": 3, "y": 13.5, "width": 8, "height": 6, "rx": 1.6}}],
    s: [{t: "rect", p: {"x": 3, "y": 4.5, "width": 8, "height": 6, "rx": 1.6}}, {t: "rect", p: {"x": 13, "y": 4.5, "width": 8, "height": 6, "rx": 1.6}}, {t: "rect", p: {"x": 3, "y": 13.5, "width": 8, "height": 6, "rx": 1.6}}],
    a: [{t: "rect", p: {"x": 13, "y": 13.5, "width": 8, "height": 6, "rx": 1.6, "stroke": "none"}}] },
  review: { b: [{t: "rect", p: {"x": 5, "y": 6.5, "width": 14, "height": 11, "rx": 2}}],
    s: [{t: "path", p: {"d": "M3 8V6a2 2 0 0 1 2-2h2.5M16.5 4H19a2 2 0 0 1 2 2v2M21 16v2a2 2 0 0 1-2 2h-2.5M7.5 20H5a2 2 0 0 1-2-2v-2"}}],
    a: [{t: "circle", p: {"cx": 12, "cy": 12, "r": 2.6, "stroke": "none"}}] },
  cast: { b: [{t: "circle", p: {"cx": 15.5, "cy": 8, "r": 3}}, {t: "path", p: {"d": "M10.5 19c.4-3.2 2.4-5 5-5s4.6 1.8 5 5z"}}],
    s: [{t: "circle", p: {"cx": 15.5, "cy": 8, "r": 3}}, {t: "path", p: {"d": "M10.5 19c.4-3.2 2.4-5 5-5s4.6 1.8 5 5z"}}],
    a: [{t: "circle", p: {"cx": 8.5, "cy": 9, "r": 3.4, "stroke": "none"}}, {t: "path", p: {"d": "M2.5 20.5c.5-3.8 2.9-6 6-6s5.5 2.2 6 6z", "stroke": "none"}}] },
  credits: { b: [{t: "path", p: {"d": "M3 7.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2V10a2 2 0 0 0 0 4v2.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V14a2 2 0 0 0 0-4z"}}],
    s: [{t: "path", p: {"d": "M3 7.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2V10a2 2 0 0 0 0 4v2.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V14a2 2 0 0 0 0-4z"}}, {t: "path", p: {"d": "M15 6.5v1.5M15 11.25v1.5M15 16v1.5"}}],
    a: [{t: "circle", p: {"cx": 9, "cy": 12, "r": 2.2, "stroke": "none"}}] },
};
export const ACCENT = "#FF7A1A";

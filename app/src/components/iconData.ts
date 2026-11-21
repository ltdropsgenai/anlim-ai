// Icon geometry, shared by the web (Icon.web.tsx: inline SVG) and native (Icon.tsx: react-native-svg) so both draw
// the same glyphs from one source (2026-11-20: native showed placeholder characters). Attribute names are the camelCase
// SVG props both renderers accept. @anlim
export type IconName = "studio" | "review" | "cast" | "credits" | "account" | "back" | "cut" | "home" | "workspace" | "assets"
  | "play" | "music" | "image" | "search" | "check" | "spark" | "arrow" | "fold" | "unfold" | "motion";
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
  // Motion transfer (2026-11-20): the source clip behind, the recast frame in front, the recast character's head lit
  motion: { b: [{t: "rect", p: {"x": 3, "y": 4.5, "width": 12, "height": 9, "rx": 1.8}}],
    s: [{t: "rect", p: {"x": 3, "y": 4.5, "width": 12, "height": 9, "rx": 1.8}}, {t: "rect", p: {"x": 9, "y": 10.5, "width": 12, "height": 9, "rx": 1.8}},
        {t: "path", p: {"d": "M14 19.5v-1.6a2.2 2.2 0 0 1 4.4 0v1.6"}}],
    a: [{t: "circle", p: {"cx": 16.2, "cy": 14.6, "r": 1.7, "stroke": "none"}}] },
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

// Feature marks (2026-11-20, Londi picked the glass cards): bespoke glyphs on a 32 grid for the feature cards, in place
// of an orange icon in a square tile. b = soft body, s = metal strokes, a = the one tungsten part.
export type MarkName = "continuity" | "frames" | "route" | "scan" | "ratios" | "layers";
const dim = { opacity: 0.45 };
export const MARK: Record<MarkName, { b: Prim[]; s: Prim[]; a: Prim[] }> = {
  // the same character in three frames in a row
  continuity: { b: [{t: "rect", p: {x: 11.75, y: 8, width: 8.5, height: 16, rx: 1.6}}],
    s: [{t: "rect", p: {x: 2, y: 8, width: 8.5, height: 16, rx: 1.6, ...dim}}, {t: "rect", p: {x: 11.75, y: 8, width: 8.5, height: 16, rx: 1.6}},
        {t: "rect", p: {x: 21.5, y: 8, width: 8.5, height: 16, rx: 1.6, ...dim}},
        {t: "circle", p: {cx: 6.25, cy: 14, r: 1.9, ...dim}}, {t: "path", p: {d: "M3.6 21.2c.4-2 1.4-3 2.65-3s2.25 1 2.65 3", ...dim}},
        {t: "circle", p: {cx: 25.75, cy: 14, r: 1.9, ...dim}}, {t: "path", p: {d: "M23.1 21.2c.4-2 1.4-3 2.65-3s2.25 1 2.65 3", ...dim}},
        {t: "path", p: {d: "M13.35 21.2c.4-2 1.4-3 2.65-3s2.25 1 2.65 3"}}],
    a: [{t: "circle", p: {cx: 16, cy: 14, r: 2.1, stroke: "none"}}] },
  // a start frame, an end frame and the move between them
  frames: { b: [{t: "rect", p: {x: 3, y: 5, width: 15, height: 11, rx: 1.8}}],
    s: [{t: "rect", p: {x: 3, y: 5, width: 15, height: 11, rx: 1.8}}, {t: "rect", p: {x: 14, y: 16, width: 15, height: 11, rx: 1.8}},
        {t: "path", p: {d: "M3 12.5l4-3.5 3.5 3 2.5-2 5 4", opacity: 0.55}}],
    a: [{t: "path", p: {d: "M8.5 19.5c0 3 2.2 4.5 4.5 4.5", fill: "none", strokeDasharray: "1.2 1.8", strokeWidth: 1.4}},
        {t: "circle", p: {cx: 21.5, cy: 21.5, r: 1.8, stroke: "none"}}] },
  // one shot routed to the model that tested best
  route: { b: [],
    s: [{t: "circle", p: {cx: 5, cy: 16, r: 2.2}}, {t: "path", p: {d: "M7.2 16h4.3"}},
        {t: "path", p: {d: "M11.5 16c4 0 4-9 9-9h5.5", opacity: 0.42}}, {t: "path", p: {d: "M11.5 16c4 0 4 9 9 9h5.5", opacity: 0.42}},
        {t: "circle", p: {cx: 27.5, cy: 7, r: 1.5, opacity: 0.42}}, {t: "circle", p: {cx: 27.5, cy: 25, r: 1.5, opacity: 0.42}}],
    a: [{t: "path", p: {d: "M11.5 16h14.5", fill: "none", strokeWidth: 1.7}}, {t: "circle", p: {cx: 27.5, cy: 16, r: 2.4, stroke: "none"}}] },
  // a strip of frames, a scan head passing over it, a pass mark
  scan: { b: [{t: "rect", p: {x: 3, y: 7, width: 26, height: 18, rx: 2}}],
    s: [{t: "rect", p: {x: 3, y: 7, width: 26, height: 18, rx: 2}}, {t: "path", p: {d: "M3 11h26M3 21h26", opacity: 0.5}},
        {t: "path", p: {d: "M7 9h1M11 9h1M15 9h1M19 9h1M23 9h1M7 23h1M11 23h1M15 23h1M19 23h1M23 23h1", strokeWidth: 1.6, opacity: 0.55}},
        {t: "path", p: {d: "M8 16.2l2.2 2.2 4.2-4.4"}}],
    a: [{t: "path", p: {d: "M21 4.5v23", fill: "none", strokeWidth: 1.6}}, {t: "path", p: {d: "M19.3 4h3.4L21 6z", stroke: "none"}}] },
  // one cut in three shapes: 16:9, 9:16, 4:5
  ratios: { b: [{t: "rect", p: {x: 10.5, y: 4, width: 11, height: 24, rx: 1.8}}],
    s: [{t: "rect", p: {x: 2, y: 9.25, width: 28, height: 13.5, rx: 1.8}}, {t: "rect", p: {x: 10.5, y: 4, width: 11, height: 24, rx: 1.8, opacity: 0.55}},
        {t: "rect", p: {x: 8.6, y: 7.25, width: 14.8, height: 17.5, rx: 1.8, opacity: 0.35, strokeDasharray: "1.4 1.6"}}],
    a: [{t: "path", p: {d: "M14 13.2v5.6l4.6-2.8z", stroke: "none"}}] },
  // filed layers, the top one lit
  layers: { b: [{t: "path", p: {d: "M16 4.5l12 6-12 6-12-6z"}}],
    s: [{t: "path", p: {d: "M4 16l12 6 12-6", opacity: 0.7}}, {t: "path", p: {d: "M4 21.5l12 6 12-6", opacity: 0.42}}, {t: "path", p: {d: "M16 4.5l12 6-12 6-12-6z"}}],
    a: [{t: "path", p: {d: "M16 7.6l5.8 2.9-5.8 2.9-5.8-2.9z", stroke: "none"}}] },
};

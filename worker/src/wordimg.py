# Text with emojis and symbols, drawn as a picture (2026-11-25, Londi: in an episode "emojis are not rendered
# accurately. They appear as boxes"; then "even recent emoji packs" and "at any size"). ffmpeg's drawtext draws one font
# and no colour emoji, so any words, title or handle with a character their font lacks is drawn here and laid over the
# video by ffmpeg. Skia shapes the text (HarfBuzz: emoji sequences such as 👍🏽 and 👨‍👩‍👧 join up), falls back from the
# text font to Noto Color Emoji (the COLRv1 vector build, so emojis stay sharp at any size, with the newest Unicode
# emojis) and then to Noto Sans Symbols 2 (★ and similar). All three fonts are OFL. @anlim
#
# usage: python wordimg.py <in.json> <out.png>
#   in.json: {"text": "...", "size": px, "color": [r, g, b], "alpha": 0..1, "fonts": [text font, emoji, symbols, ...],
#             "shadow": {"dx": 2, "dy": 3, "alpha": 0.55}, "max_width": px (optional: the line is shrunk to fit),
#             "style": "flames" (optional: letters made of fire, written as a loop of frames)}
# Writes an RGBA PNG cropped to the drawing (shadow included).
import json
import sys

import skia

tl = skia.textlayout


def collection(paths):
    prov = tl.TypefaceFontProvider()
    families = []
    for p in paths:
        tf = skia.Typeface.MakeFromFile(p)
        if tf is None:
            continue
        prov.registerTypeface(tf)
        if tf.getFamilyName() not in families:
            families.append(tf.getFamilyName())
    fc = tl.FontCollection()
    fc.setDefaultFontManager(prov)
    return fc, families


def layout(fc, families, text, size, color, paint=None):
    st = tl.TextStyle()
    st.setFontSize(size)
    st.setFontFamilies(families)
    st.setForegroundPaint(paint or skia.Paint(AntiAlias=True, Color=skia.Color(*color)))
    ps = tl.ParagraphStyle()
    ps.setTextStyle(st)
    b = tl.ParagraphBuilder.make(ps, fc, skia.Unicode.ICU_Make())
    b.pushStyle(st)
    b.addText(text)
    p = b.Build()
    p.layout(1e6)
    return p


# "flames" (2026-11-25, Londi: "the words themselves will be actual flames ... the flames form the letters", "very
# legible still"): each letter is made of fire. Inside the letter's shape, burning texture that rises (stretched noise
# scrolling upward) from pale yellow at the bottom of the stroke to orange and red at the top; flame tongues lick up
# off the tops of the letters; the letters' edges flicker a little, never enough to lose the shape. A soft dark glow
# behind the letters keeps them readable over bright pictures. FLAME_FRAMES frames that loop without a seam (the noise
# scrolls up by exactly one tile per loop), written as out_00.png, out_01.png...
FLAME_FRAMES = 16


def _tile_noise(seed, gw, gh, w, h, ox, oy):
    """Smooth value noise on a grid that wraps (gw x gh cells), sampled over w x h pixels, offset by (ox, oy) cells."""
    import numpy as np
    grid = np.random.default_rng(seed).random((gh, gw))
    ys = (np.arange(h) / h * gh + oy) % gh
    xs = (np.arange(w) / w * gw + ox) % gw
    y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
    fy = ys - y0; fx = xs - x0
    fy = fy * fy * (3 - 2 * fy); fx = fx * fx * (3 - 2 * fx)
    y1 = (y0 + 1) % gh; x1 = (x0 + 1) % gw
    a = grid[np.ix_(y0, x0)]; b = grid[np.ix_(y0, x1)]; c = grid[np.ix_(y1, x0)]; d = grid[np.ix_(y1, x1)]
    top = a + (b - a) * fx[None, :]; bot = c + (d - c) * fx[None, :]
    return top + (bot - top) * fy[:, None]


def _blur(a, r):
    import numpy as np
    if r < 1:
        return a
    k = 2 * r + 1
    for axis in (0, 1):
        c = np.cumsum(np.pad(a, [(r + 1, r) if i == axis else (0, 0) for i in range(2)], mode="edge"), axis=axis)
        a = (np.take(c, range(k, c.shape[axis]), axis=axis) - np.take(c, range(0, c.shape[axis] - k), axis=axis)) / k
    return a


def flames(spec, fc, families, text, size, out):
    import numpy as np
    p = layout(fc, families, text, size, [255, 255, 255])
    lw, lh = int(p.LongestLine), int(p.Height)
    padx, top, bottom = int(size * 0.3), int(size * 0.75), int(size * 0.25)   # room for the tongues above
    w, h = lw + 2 * padx, lh + top + bottom
    surf = skia.Surface(w, h); cv = surf.getCanvas(); cv.clear(skia.ColorTRANSPARENT)
    layout(fc, families, text, size, None, skia.Paint(AntiAlias=True, Color=skia.ColorWHITE,
           Style=skia.Paint.kStrokeAndFill_Style, StrokeWidth=size * 0.03)).paint(cv, padx, top)
    m = surf.makeImageSnapshot().toarray()[:, :, 3].astype(np.float32) / 255.0    # the letters' shape
    H_, W_ = np.arange(h)[:, None], np.arange(w)[None, :]
    # where each pixel sits inside its stroke, bottom (1) to top (0), for the colour: hot at the base, red at the tips
    rows = np.where(m > 0.5, H_, h)
    ink_top, ink_bottom = top + lh * 0.12, top + lh * 0.80
    up = np.clip((H_ - ink_top) / max(1, ink_bottom - ink_top), 0, 1)          # 0 at the cap height, 1 at the baseline
    # tongues: the shape smeared upward and fading
    plume = np.zeros_like(m); rise = int(size * 0.75); step = max(1, rise // 30)
    for k in range(step, rise, step):
        shifted = np.zeros_like(m); shifted[: h - k] = m[k:]
        plume = np.maximum(plume, shifted * (1 - k / rise) ** 1.4)
    halo = _blur(m, max(2, int(size * 0.09)))
    stops = np.array([0.0, 0.18, 0.4, 0.62, 0.85, 1.0])
    cols = np.array([[0.30, 0.02, 0.0], [0.75, 0.06, 0.0], [1.0, 0.32, 0.0], [1.0, 0.62, 0.05], [1.0, 0.88, 0.35], [1.0, 0.98, 0.82]])
    gw, gh = max(6, w // max(6, int(size * 0.16))), 5
    for f in range(FLAME_FRAMES):
        t = f / FLAME_FRAMES
        sway = _tile_noise(11, max(3, gw // 3), gh, w, h, 0, t * gh) - 0.5                 # slow sideways sway
        lick = _tile_noise(23, gw, gh * 2, w, h, 0, t * gh * 2)                            # rising tongues and texture
        grain = _tile_noise(37, gw * 2, gh * 4, w, h, 0, t * gh * 4)                       # fine flicker
        # the letters' edges move a little (at most ~4% of the size), the tongues much more
        dx_core = np.rint(sway * size * 0.035).astype(int)
        core = m[H_, np.clip(W_ + dx_core, 0, w - 1)]
        dx_tip = (sway * size * 0.30 + (lick - 0.5) * size * 0.12).astype(int)
        tips = plume[H_, np.clip(W_ + dx_tip, 0, w - 1)] * (0.35 + 1.1 * lick)
        tips = np.clip(tips - 0.18, 0, 1) * 1.35
        # heat inside the letters: always hot (that is what keeps them readable), hotter low in the stroke, flickering
        inside = core * (0.66 + 0.28 * up + 0.16 * (grain - 0.5) + 0.12 * (lick - 0.5))
        heat = np.clip(np.maximum(inside, tips * (0.85 - 0.3 * (1 - up))), 0, 1)
        heat = _blur(heat, max(1, int(size * 0.012)))
        rgb = np.stack([np.interp(heat, stops, cols[:, i]) for i in range(3)], axis=-1)
        alpha = np.clip(heat * 2.2, 0, 1)
        fire = np.concatenate([rgb * alpha[..., None], alpha[..., None]], axis=-1)           # premultiplied
        dark = np.clip(halo * 0.7, 0, 0.6)[..., None]                                     # dark glow behind
        back = np.concatenate([np.zeros((h, w, 3)) + np.array([0.08, 0.01, 0.0]) * dark, dark], axis=-1)
        frame = fire + back * (1 - fire[..., 3:4])
        out8 = np.clip(frame * 255 + 0.5, 0, 255).astype(np.uint8)
        a8 = out8[..., 3:4].astype(np.float32)
        rgb8 = np.where(a8 > 0, np.clip(out8[..., :3] * 255.0 / np.maximum(a8, 1), 0, 255), 0).astype(np.uint8)
        img = skia.Image.fromarray(np.ascontiguousarray(np.concatenate([rgb8, out8[..., 3:4]], axis=-1)),
                                   colorType=skia.kRGBA_8888_ColorType, alphaType=skia.kUnpremul_AlphaType)
        img.save(out.replace(".png", f"_{f:02d}.png"), skia.kPNG)


def main(src, out):
    spec = json.load(open(src, encoding="utf-8"))
    text = spec["text"]
    size = max(6.0, float(spec["size"]))
    color = spec.get("color", [255, 241, 214])
    alpha = max(0.0, min(1.0, float(spec.get("alpha", 1))))
    sh = spec.get("shadow") or {"dx": 2, "dy": 3, "alpha": 0.55}
    fc, families = collection(spec["fonts"])
    p = layout(fc, families, text, size, color)
    mw = spec.get("max_width")
    if mw and p.LongestLine > mw:          # too wide for the picture: the same line, smaller
        size = max(6.0, size * mw / p.LongestLine)
        p = layout(fc, families, text, size, color)
    if spec.get("style") == "flames":
        flames(spec, fc, families, text, size, out)
        return
    pad = int(size * 0.25) + max(abs(int(sh["dx"])), abs(int(sh["dy"]))) + 4
    w, h = int(p.LongestLine) + 2 * pad, int(p.Height) + 2 * pad
    surface = skia.Surface(w, h)           # N32 premultiplied, transparent
    canvas = surface.getCanvas()
    canvas.clear(skia.ColorTRANSPARENT)
    layer = skia.Paint(Alphaf=alpha)
    if float(sh.get("alpha", 0)) > 0:
        layer.setImageFilter(skia.ImageFilters.DropShadow(float(sh["dx"]), float(sh["dy"]), 0, 0,
                                                          skia.Color4f(0, 0, 0, float(sh["alpha"])).toColor()))
    canvas.saveLayer(None, layer)
    p.paint(canvas, pad, pad)
    canvas.restore()
    img = surface.makeImageSnapshot()
    # crop to what was drawn (a few pixels of air), so ffmpeg places it by its real size
    arr = img.toarray()                    # h x w x 4, premultiplied BGRA or RGBA: only alpha (index 3) is read
    rows = (arr[:, :, 3] > 0).any(axis=1).nonzero()[0]
    cols = (arr[:, :, 3] > 0).any(axis=0).nonzero()[0]
    if len(rows) and len(cols):
        y0, y1 = max(0, rows[0] - 2), min(h, rows[-1] + 3)
        x0, x1 = max(0, cols[0] - 2), min(w, cols[-1] + 3)
        img = img.makeSubset(skia.IRect.MakeLTRB(int(x0), int(y0), int(x1), int(y1))) or img
    img.save(out, skia.kPNG)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

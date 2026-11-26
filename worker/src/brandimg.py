# Brand pictures for the cut, drawn with Skia at their exact pixel size (so ffmpeg never scales them). @anlim
#
# card (2026-11-25, Londi's end-card mockup): one card of the animated end card. A rounded rectangle `width` px wide,
#   2.25:1, corners 14% of its height, a soft drop shadow; the label (e.g. "Made with") centred on top in Space Grotesk
#   SemiBold with a cap height of 12% of the card's height; below it the app icon tile (rounded square #16151A, a 1 px
#   border in white at 12%, a white "a" and an orange dot) and "anlim.ai" in Space Grotesk Bold at 2.2x the label size,
#   the dot orange. The fill is chosen by the caller for the footage under the card. Colours: worker/assets/brand.json.
#   in.json: {"mode": "card", "width": px, "lead": "Made with", "fill": "#2C2B30", "fonts": {"semi": ttf, "bold": ttf},
#             "brand": {...}}  -> prints {"w", "h"} of the picture (card plus room for its shadow, card centred)
# logo (2026-11-25, Londi: a logo watermark on the whole cut): the creator's image at `width` pixels wide, its aspect
#   kept, high-quality resampling, corners rounded to 22% of the width when it is (nearly) square, at `opacity`.
#   in.json: {"mode": "logo", "src": image, "width": px, "opacity": 0..1}
#
# usage: python brandimg.py <in.json> <out.png>
import json
import sys

import numpy as np
import skia

tl = skia.textlayout


def rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def font_collection(path):
    prov = tl.TypefaceFontProvider()
    tf = skia.Typeface.MakeFromFile(path)
    if tf is None:
        raise SystemExit(f"cannot read font {path}")
    prov.registerTypeface(tf)
    fc = tl.FontCollection()
    fc.setDefaultFontManager(prov)
    return fc, tf.getFamilyName()


def paragraph(fc, family, runs, size):
    """One line of text in `size` px made of (text, [r, g, b]) runs."""
    ps = tl.ParagraphStyle()
    b = tl.ParagraphBuilder.make(ps, fc, skia.Unicode.ICU_Make())
    for text, col in runs:
        st = tl.TextStyle()
        st.setFontSize(size)
        st.setFontFamilies([family])
        st.setForegroundPaint(skia.Paint(AntiAlias=True, Color=skia.Color(*col)))
        b.pushStyle(st)
        b.addText(text)
        b.pop()
    p = b.Build()
    p.layout(1e6)
    return p


def cap_height(tf, size):
    f = skia.Font(tf, size)
    ch = f.getMetrics().fCapHeight
    return ch if ch and ch > 0 else size * 0.7


def card(spec, out):
    br = spec["brand"]
    fc_semi, fam_semi = font_collection(spec["fonts"]["semi"])
    fc_bold, fam_bold = font_collection(spec["fonts"]["bold"])
    tf_semi = skia.Typeface.MakeFromFile(spec["fonts"]["semi"])
    tf_bold = skia.Typeface.MakeFromFile(spec["fonts"]["bold"])
    cw = float(spec["width"])
    ch = cw / 2.25
    radius = ch * 0.14
    ink, dot = rgb(br["card_text"]), rgb(br["card_dot"])
    # the label's cap height is 12% of the card's height; the wordmark is 2.2x the label's size
    label_size = 0.12 * ch / (cap_height(tf_semi, 100) / 100)
    word_size = label_size * 2.2
    p_lead = paragraph(fc_semi, fam_semi, [(spec["lead"], ink)], label_size)
    p_word = paragraph(fc_bold, fam_bold, [("anlim", ink), (".", dot), ("ai", ink)], word_size)
    word_cap = cap_height(tf_bold, word_size)
    tile = word_cap * 1.32                      # the tile a little taller than the wordmark's capitals
    gap = word_size * 0.24
    row_w = tile + gap + p_word.LongestLine
    row_h = max(tile, p_word.Height)
    line_gap = ch * 0.05
    block_h = p_lead.Height + line_gap + row_h
    pad = int(round(ch * 0.22))                 # room for the shadow
    W, H = int(round(cw)) + 2 * pad, int(round(ch)) + 2 * pad
    surf = skia.Surface(W, H)
    cv = surf.getCanvas()
    cv.clear(skia.ColorTRANSPARENT)
    box = skia.RRect.MakeRectXY(skia.Rect.MakeXYWH(pad, pad, cw, ch), radius, radius)
    cv.save()
    cv.translate(0, ch * 0.035)
    cv.drawRRect(box, skia.Paint(AntiAlias=True, Color=skia.Color4f(0, 0, 0, 0.42).toColor(),
                                 MaskFilter=skia.MaskFilter.MakeBlur(skia.kNormal_BlurStyle, ch * 0.06)))
    cv.restore()
    cv.drawRRect(box, skia.Paint(AntiAlias=True, Color=skia.Color(*rgb(spec["fill"]))))
    top = pad + (ch - block_h) / 2
    p_lead.paint(cv, pad + (cw - p_lead.LongestLine) / 2, top)
    y = top + p_lead.Height + line_gap
    x = pad + (cw - row_w) / 2
    # the icon tile: rounded square, 1 px border in white at 12%, a white "a" and an orange dot
    ty = y + (row_h - tile) / 2
    tr_ = skia.RRect.MakeRectXY(skia.Rect.MakeXYWH(x, ty, tile, tile), tile * 0.22, tile * 0.22)
    cv.drawRRect(tr_, skia.Paint(AntiAlias=True, Color=skia.Color(*rgb(br["card_tile"]))))
    # the "a" and the dot: the app icon itself (worker/assets/watermark.png), drawn inside the tile, so it is the real mark
    if spec.get("icon"):
        img = skia.Image.open(spec["icon"])
        arr = img.toarray()[:, :, 3]
        xs = np.nonzero((arr > 40).any(axis=0))[0]
        end = xs[0]
        for xx in xs[1:]:
            if xx != end + 1:
                break
            end = xx
        ys = np.nonzero((arr[:, xs[0]:end + 1] > 40).any(axis=1))[0]
        icon = img.makeSubset(skia.IRect.MakeLTRB(int(xs[0]), int(ys[0]), int(end) + 1, int(ys[-1]) + 1))
        cv.save()
        cv.clipRRect(tr_, skia.ClipOp.kIntersect, True)
        cv.drawImageRect(icon.withDefaultMipmaps(), skia.Rect.MakeXYWH(x, ty, tile, tile),
                         skia.SamplingOptions(skia.FilterMode.kLinear, skia.MipmapMode.kLinear), skia.Paint(AntiAlias=True))
        cv.restore()
    cv.drawRRect(tr_, skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=1,
                                 Color=skia.Color4f(1, 1, 1, float(br["card_tile_border_alpha"])).toColor()))
    p_word.paint(cv, x + tile + gap, y + (row_h - p_word.Height) / 2)
    surf.makeImageSnapshot().save(out, skia.kPNG)
    print(json.dumps({"w": W, "h": H, "card_w": round(cw), "card_h": round(ch)}))


def logo(spec, out):
    img = skia.Image.open(spec["src"])
    if img is None:
        raise SystemExit("the logo could not be read")
    w = max(2, int(round(float(spec["width"]))))
    h = max(2, int(round(w * img.height() / img.width())))
    op = max(0.0, min(1.0, float(spec.get("opacity", 0.9))))
    surf = skia.Surface(w, h)
    cv = surf.getCanvas()
    cv.clear(skia.ColorTRANSPARENT)
    square = abs(img.width() / img.height() - 1) <= 0.05
    if square:                                                  # an app-icon shape: rounded corners, 22% of the width
        cv.clipRRect(skia.RRect.MakeRectXY(skia.Rect.MakeWH(w, h), 0.22 * w, 0.22 * w), skia.ClipOp.kIntersect, True)
    # downscaling a big logo: mipmaps + linear between levels keeps it sharp without shimmer; upscaling: cubic
    samp = skia.SamplingOptions(skia.FilterMode.kLinear, skia.MipmapMode.kLinear) if img.width() > w \
        else skia.SamplingOptions(skia.CubicResampler.Mitchell())
    src = img.withDefaultMipmaps() if img.width() > w else img
    cv.drawImageRect(src, skia.Rect.MakeWH(w, h), samp, skia.Paint(AntiAlias=True, Alphaf=op))
    surf.makeImageSnapshot().save(out, skia.kPNG)
    print(json.dumps({"w": w, "h": h, "rounded": square}))


if __name__ == "__main__":
    s = json.load(open(sys.argv[1], encoding="utf-8"))
    (card if s["mode"] == "card" else logo)(s, sys.argv[2])

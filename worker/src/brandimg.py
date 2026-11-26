# Brand pictures for the cut, drawn with Skia at their exact pixel size (so ffmpeg never scales them). @anlim
#
# credit (2026-11-25, Londi: the end card in the app's brand colours and font, readable over light and dark footage):
#   "Made with" over the anlim icon and "anlim.ai", on a rounded pill. Text in the theme's ink, the dot in its accent,
#   the pill #16161A at 80% with a soft shadow under it (worker/assets/brand.json, from app/src/lib/theme.ts). Space
#   Grotesk Bold, the app's display font. The picture is exactly `width` pixels wide.
#   in.json: {"mode": "credit", "width": px, "lead": "Made with", "font": ttf, "icon": watermark.png, "brand": {...}}
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


def icon_image(path):
    """The anlim icon: the first block of drawn columns at the left of the mark image (watermark.png)."""
    img = skia.Image.open(path)
    a = img.toarray()[:, :, 3]
    xs = np.nonzero((a > 40).any(axis=0))[0]
    end = xs[0]
    for x in xs[1:]:
        if x != end + 1:
            break
        end = x
    ys = np.nonzero((a[:, xs[0]:end + 1] > 40).any(axis=1))[0]
    return img.makeSubset(skia.IRect.MakeLTRB(int(xs[0]), int(ys[0]), int(end) + 1, int(ys[-1]) + 1))


def credit_layout(fc, family, lead, brand, S):
    """Sizes for wordmark size S: returns the pieces and the picture's width and height."""
    ink, acc = rgb(brand["ink"]), rgb(brand["accent"])
    p_lead = paragraph(fc, family, [(lead, ink)], S * 0.46)
    p_word = paragraph(fc, family, [("anlim", ink), (".", acc), ("ai", ink)], S)
    icon = S * 0.98                       # the icon about the wordmark's full height
    gap = S * 0.26                        # icon to wordmark
    row_w = icon + gap + p_word.LongestLine
    row_h = max(icon, p_word.Height)
    line_gap = S * 0.10
    pad_x, pad_y = S * 0.50, S * 0.34
    inner_w = max(row_w, p_lead.LongestLine)
    pill_w, pill_h = inner_w + 2 * pad_x, p_lead.Height + line_gap + row_h + 2 * pad_y
    shadow = S * 0.30                     # room around the pill for its soft shadow
    return dict(p_lead=p_lead, p_word=p_word, icon=icon, gap=gap, row_w=row_w, row_h=row_h, line_gap=line_gap,
                pad_y=pad_y, pill_w=pill_w, pill_h=pill_h, shadow=shadow, W=pill_w + 2 * shadow, H=pill_h + 2 * shadow)


def credit(spec, out):
    fc, family = font_collection(spec["font"])
    brand = spec["brand"]
    target = float(spec["width"])
    S = 100.0
    S *= target / credit_layout(fc, family, spec["lead"], brand, S)["W"]      # the size whose picture is `width` wide
    L = credit_layout(fc, family, spec["lead"], brand, S)
    w, h = int(round(target)), int(round(L["H"]))
    surf = skia.Surface(w, h)
    cv = surf.getCanvas()
    cv.clear(skia.ColorTRANSPARENT)
    ox = (w - L["W"]) / 2 + L["shadow"]
    oy = L["shadow"]
    pill = skia.RRect.MakeRectXY(skia.Rect.MakeXYWH(ox, oy, L["pill_w"], L["pill_h"]), S * 0.42, S * 0.42)
    # a soft shadow under the pill, so its edge reads over light footage too
    sh = skia.Paint(AntiAlias=True, Color=skia.Color4f(0, 0, 0, 0.45).toColor(),
                    MaskFilter=skia.MaskFilter.MakeBlur(skia.kNormal_BlurStyle, S * 0.10))
    cv.save()
    cv.translate(0, S * 0.05)
    cv.drawRRect(pill, sh)
    cv.restore()
    pr, pg, pb = rgb(brand["pill"])
    cv.drawRRect(pill, skia.Paint(AntiAlias=True, Color=skia.Color4f(pr / 255, pg / 255, pb / 255, float(brand["pill_alpha"])).toColor()))
    cx = ox + L["pill_w"] / 2
    y = oy + L["pad_y"]
    L["p_lead"].paint(cv, cx - L["p_lead"].LongestLine / 2, y)
    y += L["p_lead"].Height + L["line_gap"]
    x = cx - L["row_w"] / 2
    ic = icon_image(spec["icon"])
    iy = y + (L["row_h"] - L["icon"]) / 2
    cv.drawImageRect(ic, skia.Rect.MakeXYWH(x, iy, L["icon"], L["icon"]),
                     skia.SamplingOptions(skia.CubicResampler.Mitchell()), skia.Paint(AntiAlias=True))
    L["p_word"].paint(cv, x + L["icon"] + L["gap"], y + (L["row_h"] - L["p_word"].Height) / 2)
    surf.makeImageSnapshot().save(out, skia.kPNG)
    print(json.dumps({"w": w, "h": h}))


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
    (credit if s["mode"] == "credit" else logo)(s, sys.argv[2])

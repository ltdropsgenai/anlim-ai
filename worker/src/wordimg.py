# Text with emojis and symbols, drawn as a picture (2026-11-25, Londi: in an episode "emojis are not rendered
# accurately. They appear as boxes"; then "even recent emoji packs" and "at any size"). ffmpeg's drawtext draws one font
# and no colour emoji, so any words, title or handle with a character their font lacks is drawn here and laid over the
# video by ffmpeg. Skia shapes the text (HarfBuzz: emoji sequences such as 👍🏽 and 👨‍👩‍👧 join up), falls back from the
# text font to Noto Color Emoji (the COLRv1 vector build, so emojis stay sharp at any size, with the newest Unicode
# emojis) and then to Noto Sans Symbols 2 (★ and similar). All three fonts are OFL. @anlim
#
# usage: python wordimg.py <in.json> <out.png>
#   in.json: {"text": "...", "size": px, "color": [r, g, b], "alpha": 0..1, "fonts": [text font, emoji, symbols, ...],
#             "shadow": {"dx": 2, "dy": 3, "alpha": 0.55}, "max_width": px (optional: the line is shrunk to fit)}
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


def layout(fc, families, text, size, color):
    st = tl.TextStyle()
    st.setFontSize(size)
    st.setFontFamilies(families)
    st.setForegroundPaint(skia.Paint(AntiAlias=True, Color=skia.Color(*color)))
    ps = tl.ParagraphStyle()
    ps.setTextStyle(st)
    b = tl.ParagraphBuilder.make(ps, fc, skia.Unicode.ICU_Make())
    b.pushStyle(st)
    b.addText(text)
    p = b.Build()
    p.layout(1e6)
    return p


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

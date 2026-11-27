# Pictures for the shot effects (2026-11-27, Londi: "I want to build the same effects ... into anlim.ai", from a
# short-form VFX reference: phone mock-ups with a view count, comic stickers, a warped grid behind floating screens).
# Drawn with Pillow at the size they are used, so they stay sharp; ffmpeg lays them over the video (fx.js). @anlim
#
# usage: python fximg.py <in.json> <out.png>      in.json: {"mode": ..., ...}; prints {"w": .., "h": .., ...} as JSON
#   phone:  {"w": screen width px, "h": screen height px}  -> the phone body with a see-through screen; also writes
#           <out>_mask.png (white where the screen is: the clip shows through there) and reports the screen's place
#   badge:  {"text": "754K", "size": px, "font": ttf}        -> "▷ 754K" in white inside a red rounded box (the view count)
#   sticker:{"kind": pow|boom|wow|zap|arrow|circle|star, "text": optional, "size": px, "font": ttf, "color": [r,g,b]}
#   grid:   {"w": px, "h": px}                               -> a dark backdrop with a curved perspective grid
import json
import math
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 2   # drawn at twice the size and shrunk: smooth edges


def rr(draw, box, r, **kw):
    draw.rounded_rectangle(box, radius=r, **kw)


def phone(spec, out):
    sw, sh = int(spec["w"]), int(spec["h"])
    bez = max(6, round(sw * 0.035))                 # the black border around the screen
    rim = max(2, round(sw * 0.008))                 # the metal edge
    W, H = (sw + 2 * (bez + rim)) * SS, (sh + 2 * (bez + rim)) * SS
    rs = round(sw * 0.11) * SS                      # screen corner radius
    rb = rs + (bez + rim) * SS
    body = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(body)
    rr(d, (0, 0, W - 1, H - 1), rb, fill=(120, 122, 128, 255))                       # metal rim
    rr(d, (rim * SS, rim * SS, W - 1 - rim * SS, H - 1 - rim * SS), rb - rim * SS, fill=(12, 12, 14, 255))
    x0, y0 = (bez + rim) * SS, (bez + rim) * SS
    hole = Image.new("L", (W, H), 0)
    rr(ImageDraw.Draw(hole), (x0, y0, x0 + sw * SS - 1, y0 + sh * SS - 1), rs, fill=255)
    a = body.getchannel("A")
    a = Image.composite(Image.new("L", (W, H), 0), a, hole)
    body.putalpha(a)
    # the camera island at the top of the screen, over the picture
    iw, ih = round(sw * 0.30) * SS, round(sw * 0.085) * SS
    ix, iy = (W - iw) // 2, y0 + round(sw * 0.035) * SS
    rr(d, (ix, iy, ix + iw, iy + ih), ih // 2, fill=(0, 0, 0, 255))
    # side buttons
    bw = max(2, rim) * SS
    for (yy, hh) in ((0.18, 0.06), (0.27, 0.10), (0.39, 0.10)):
        rr(d, (0, int(H * yy), bw * 2, int(H * (yy + hh))), bw, fill=(95, 97, 103, 255))
    rr(d, (W - bw * 2, int(H * 0.27), W, int(H * 0.40)), bw, fill=(95, 97, 103, 255))
    body = body.resize((W // SS, H // SS), Image.LANCZOS)
    body.save(out)
    mask = hole.resize((W // SS, H // SS), Image.LANCZOS)
    # the mask of the screen alone, the size of the screen (the clip is scaled to it and given this alpha)
    sx, sy = bez + rim, bez + rim
    mask.crop((sx, sy, sx + sw, sy + sh)).save(out.replace(".png", "_mask.png"))
    return {"w": W // SS, "h": H // SS, "screen_x": sx, "screen_y": sy}


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def badge(spec, out):
    size = int(spec["size"])
    f = font(spec["font"], size * SS)
    text = str(spec["text"])[:12]
    tri = size * SS * 0.62                              # the play triangle, drawn (fonts may lack ▷)
    gap = size * SS * 0.30
    tw = f.getlength(text)
    pad = size * SS * 0.35
    lw = max(3, round(size * 0.10)) * SS
    W = int(tw + tri + gap + 2 * pad + 2 * lw)
    H = int(size * SS * 1.45 + 2 * lw)
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    rr(d, (lw // 2, lw // 2, W - 1 - lw // 2, H - 1 - lw // 2), H // 4, outline=(235, 38, 38, 255), width=lw, fill=(0, 0, 0, 70))
    cx, cy = lw + pad, H / 2
    d.polygon([(cx, cy - tri / 2), (cx, cy + tri / 2), (cx + tri * 0.87, cy)], outline=(255, 255, 255, 255), width=max(2, lw // 2))
    asc, desc = f.getmetrics()
    d.text((cx + tri + gap, cy - (asc + desc) / 2 + desc * 0.2), text, font=f, fill=(255, 255, 255, 255))
    im = im.resize((W // SS, H // SS), Image.LANCZOS)
    im.save(out)
    return {"w": im.width, "h": im.height}


def burst(n, r_out, r_in, cx, cy, rot=0.0):
    pts = []
    for k in range(n * 2):
        r = r_out if k % 2 == 0 else r_in
        # uneven spikes, like a comic burst (fixed pattern, so it is the same every time)
        r *= 1.0 + (0.18 if k % 4 == 0 else -0.06 if k % 4 == 2 else 0)
        a = rot + math.pi * k / n
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def sticker(spec, out):
    kind = spec["kind"]
    size = int(spec["size"]) * SS                       # the sticker's width
    col = tuple(spec.get("color") or [255, 214, 0]) + (255,)
    W = H = size
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lw = max(4, size // 40)
    if kind in ("pow", "boom", "wow", "zap"):
        text = (spec.get("text") or {"pow": "POW!", "boom": "BOOM!", "wow": "WOW!", "zap": "ZAP!"}[kind])[:10]
        cx = cy = size / 2
        d.polygon(burst(11, size * 0.49, size * 0.33, cx, cy, -0.2), fill=(20, 20, 20, 255))
        d.polygon(burst(11, size * 0.46, size * 0.30, cx, cy, -0.2), fill=(235, 38, 38, 255))
        d.polygon(burst(11, size * 0.36, size * 0.25, cx, cy, 0.1), fill=col)
        fs = int(size * 0.30)
        f = font(spec["font"], fs)
        while f.getlength(text) > size * 0.66 and fs > 10:
            fs = int(fs * 0.9); f = font(spec["font"], fs)
        tw = f.getlength(text)
        txt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        td = ImageDraw.Draw(txt)
        td.text(((W - tw) / 2, cy - fs * 0.62), text, font=f, fill=(235, 38, 38, 255), stroke_width=max(3, fs // 12), stroke_fill=(20, 20, 20, 255))
        im.alpha_composite(txt.rotate(-8, resample=Image.BICUBIC, center=(cx, cy)))
    elif kind == "arrow":
        # a hand-drawn style curved arrow pointing down-right
        pts = [(size * (0.15 + 0.6 * t), size * (0.2 + 0.55 * t * t)) for t in [i / 30 for i in range(31)]]
        d.line(pts, fill=(20, 20, 20, 255), width=lw * 3 + 6, joint="curve")
        d.line(pts, fill=col, width=lw * 3, joint="curve")
        ex, ey = pts[-1]
        ang = math.atan2(pts[-1][1] - pts[-4][1], pts[-1][0] - pts[-4][0])
        L = size * 0.16
        head = [(ex + L * 0.5 * math.cos(ang), ey + L * 0.5 * math.sin(ang)),
                (ex + L * math.cos(ang + 2.5), ey + L * math.sin(ang + 2.5)),
                (ex + L * math.cos(ang - 2.5), ey + L * math.sin(ang - 2.5))]
        d.polygon(head, fill=col, outline=(20, 20, 20, 255), width=3)
    elif kind == "circle":
        # a red hand-drawn ring around something (the reference circles view counts)
        c = tuple(spec.get("color") or [235, 38, 38]) + (255,)
        box = (lw * 2, lw * 2, W - lw * 2, H - lw * 2)
        d.ellipse(box, outline=c, width=lw * 2)
        d.arc((lw * 4, lw, W - lw, H - lw * 3), 200, 330, fill=c, width=lw * 2)
    elif kind == "star":
        cx = cy = size / 2
        pts = [(cx + (size * 0.47 if k % 2 == 0 else size * 0.2) * math.cos(-math.pi / 2 + math.pi * k / 5),
                cy + (size * 0.47 if k % 2 == 0 else size * 0.2) * math.sin(-math.pi / 2 + math.pi * k / 5)) for k in range(10)]
        d.polygon(pts, fill=col, outline=(20, 20, 20, 255), width=lw)
    else:
        raise SystemExit(f"unknown sticker {kind}")
    # a soft shadow so it reads on any picture
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sh.putalpha(im.getchannel("A").point(lambda v: v * 0.45).filter(ImageFilter.GaussianBlur(size / 60)))
    base = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    base.alpha_composite(sh, (int(size / 80), int(size / 50)))
    base.alpha_composite(im)
    base = base.resize((W // SS, H // SS), Image.LANCZOS)
    base.save(out)
    return {"w": base.width, "h": base.height}


def grid(spec, out):
    W, H = int(spec["w"]), int(spec["h"])
    im = Image.new("RGB", (W * SS, H * SS), (6, 6, 8))
    d = ImageDraw.Draw(im)
    w, h = W * SS, H * SS
    lw = max(1, round(min(W, H) / 400)) * SS
    col = (70, 70, 78)
    n = 14
    # lines that bow away from the centre, like the reference's warped grid
    for i in range(n + 1):
        u = i / n
        pts = []
        for j in range(61):
            v = j / 60
            x = u * w + (u - 0.5) * w * 0.35 * math.sin(math.pi * v)
            pts.append((x, v * h))
        d.line(pts, fill=col, width=lw)
    m = round(n * h / w)
    for i in range(m + 1):
        v = i / m
        pts = []
        for j in range(61):
            u = j / 60
            y = v * h + (v - 0.5) * h * 0.25 * math.sin(math.pi * u)
            pts.append((u * w, y))
        d.line(pts, fill=col, width=lw)
    # darker towards the edges
    vig = Image.new("L", (w, h), 0)
    ImageDraw.Draw(vig).ellipse((-w * 0.2, -h * 0.1, w * 1.2, h * 1.1), fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(min(w, h) / 6))
    im = Image.composite(im, Image.new("RGB", (w, h), (0, 0, 0)), vig)
    im = im.resize((W, H), Image.LANCZOS)
    im.save(out)
    return {"w": W, "h": H}


def round_mask(spec, out):
    """white rounded rectangle on black, the size of a picture-in-picture box (its corners are cut round)"""
    W, H = int(spec["w"]), int(spec["h"])
    im = Image.new("L", (W * SS, H * SS), 0)
    rr(ImageDraw.Draw(im), (0, 0, W * SS - 1, H * SS - 1), round(min(W, H) * float(spec.get("r", 0.08))) * SS, fill=255)
    im.resize((W, H), Image.LANCZOS).save(out)
    return {"w": W, "h": H}


def main():
    spec = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    fn = {"phone": phone, "badge": badge, "sticker": sticker, "grid": grid, "round": round_mask}[spec["mode"]]
    print(json.dumps(fn(spec, out)))


if __name__ == "__main__":
    main()

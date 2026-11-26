# Words over a shot as a picture, for words with emojis or symbols (2026-11-25, Londi: in an episode "emojis are not
# rendered accurately. They appear as boxes"). ffmpeg's drawtext draws one font and no colour emoji, so a word with a
# character Montserrat lacks is drawn here instead: Montserrat for letters, Noto Sans Symbols 2 for symbols (★),
# Noto Color Emoji for emojis, then placed and animated by ffmpeg like the drawn words. @anlim
#
# usage: python wordimg.py <in.json> <out.png>
#   in.json: {"size": px, "color": "#FFF1D6", "fonts": {"text": path, "symbols": path, "emoji": path},
#             "runs": [{"t": "Hi ", "f": "text"}, {"t": "😠", "f": "emoji"}, ...]}
# Writes an RGBA PNG: the words with the same soft shadow as drawtext's (black at 55%, 2 px right, 3 px down).
import json
import sys

from PIL import Image, ImageDraw, ImageFont

EMOJI_PX = 109          # Noto Color Emoji is a bitmap font with one size: 109 px


def main(src, out):
    spec = json.load(open(src, encoding="utf-8"))
    size = max(8, int(spec["size"]))
    color = spec.get("color", "#FFF1D6")
    fonts = spec["fonts"]
    text_font = ImageFont.truetype(fonts["text"], size)
    sym_font = ImageFont.truetype(fonts["symbols"], size) if fonts.get("symbols") else text_font
    emoji_font = ImageFont.truetype(fonts["emoji"], EMOJI_PX) if fonts.get("emoji") else None
    asc, desc = text_font.getmetrics()
    line_h = asc + desc
    em = round(size * 1.05)            # an emoji about as tall as the capitals plus a little

    pieces = []                         # (image RGBA, y offset from the top of the line)
    for run in spec["runs"]:
        t, f = run["t"], run.get("f", "text")
        if not t:
            continue
        if f == "emoji" and emoji_font is not None:
            # one emoji at its native size, cropped to its pixels, then scaled to the line
            g = Image.new("RGBA", (EMOJI_PX * 3, EMOJI_PX * 2), (0, 0, 0, 0))
            ImageDraw.Draw(g).text((EMOJI_PX // 2, EMOJI_PX // 4), t, font=emoji_font, embedded_color=True)
            box = g.getbbox()
            if not box:
                continue
            g = g.crop(box)
            k = em / max(g.height, 1)
            g = g.resize((max(1, round(g.width * k)), max(1, round(g.height * k))), Image.LANCZOS)
            gap = round(size * 0.06)
            padded = Image.new("RGBA", (g.width + 2 * gap, g.height), (0, 0, 0, 0))
            padded.paste(g, (gap, 0))
            pieces.append((padded, (line_h - g.height) // 2 - round(size * 0.04)))
        else:
            font = sym_font if f == "symbols" else text_font
            l, _, r, _ = font.getbbox(t)
            w = max(1, round(font.getlength(t)), r)
            img = Image.new("RGBA", (w + 2, line_h), (0, 0, 0, 0))
            ImageDraw.Draw(img).text((0, 0), t, font=font, fill=color)
            pieces.append((img, 0))

    if not pieces:
        Image.new("RGBA", (2, 2), (0, 0, 0, 0)).save(out)
        return
    pad = 4
    W = sum(p.width for p, _ in pieces) + 2 * pad + 3
    H = line_h + 2 * pad + 4
    word = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    x = pad
    for p, dy in pieces:
        word.alpha_composite(p, (x, max(0, pad + dy)))
        x += p.width
    # the drop shadow from the word's own shape
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    a = word.getchannel("A").point(lambda v: v * 55 // 100)
    shadow.paste((0, 0, 0, 255), (2, 3), a.crop((0, 0, W - 2, H - 3)))
    shadow.alpha_composite(word)
    box = shadow.getbbox() or (0, 0, W, H)
    shadow.crop(box).save(out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

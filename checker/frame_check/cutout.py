"""cutout.py - character reference images cut out of an approved still. Code only, no API. @anlim

Why: new-setup start stills draw each character from a reference image. The 2026-11-13 feasibility run used plain
crops of a still (ref_king.png, ref_layana.png): the room behind the character came along, and the image model can
copy that background or its furniture into the new setup. A cut-out on a plain white background carries only the
character.
How: people boxes from objects_check (YOLOX; cartoon children often come back as "teddy bear", merged as in
end_frame) -> each box is matted with the isnet-anime model (rembg) -> the blob(s) under the box's centre column are
kept -> pasted on white, cropped to the character with a margin. One cut-out per detected character, left to right.
With the location's empty-room PLATE (pass plate=): only pixels that differ from the plate are kept as well. Tested
2026-11-16: matting alone keeps the sofa, rug and floor behind a character on 3 of 4 Phase 0 stills (isnet-anime calls
cartoon furniture foreground); still-minus-plate removes them. The plate is used only when it fits the still (little
change outside the characters), which holds for stills the app composed onto that plate (new setup, reposition).
Each result says whether it is usable as a reference: the whole body inside the frame (not touching the edge), not
overlapping another character's box much, tall enough to show detail.

  python cutout.py STILL.png --out DIR [--plate PLATE.png]
  in code: cutout.cutouts(image_path, out_dir, plate=None) -> [{"index", "path", "box", "warnings": [...]}]
"""
import argparse, json, os, sys
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
import numpy as np
import cv2
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

VERSION = 2   # v2: plate difference
PLATE_THR = 28   # LAB distance, as end_frame
PLATE_FIT = 0.02  # a plate fits when under 2 % of the frame differs outside the characters
MARGIN = 0.06        # white space around the character, as a fraction of its height
MIN_H = 0.25         # a character shorter than this share of the frame height is too small to be a good reference


def _overlap(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix * iy / max(1, (a[2] - a[0]) * (a[3] - a[1]))


def plate_mask(bgr, plate, boxes):
    """(mask of pixels that differ from the plate, None) when the plate fits the still, else (None, reason)."""
    import end_frame as E
    from edit_check import align
    P = cv2.imread(plate) if isinstance(plate, str) else plate
    if P is None: return None, "plate not readable"
    if P.shape[:2] != bgr.shape[:2]: P = cv2.resize(P, (bgr.shape[1], bgr.shape[0]), interpolation=cv2.INTER_AREA)
    P, _ = align(bgr, P)
    h, w = bgr.shape[:2]
    m = (E._diff(bgr, P) > PLATE_THR).astype(np.uint8)
    o = max(3, w // 300) | 1
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((o, o), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((o * 3, o * 3), np.uint8))
    inside = np.zeros((h, w), np.uint8)
    for b in boxes: inside[b[1]:b[3], b[0]:b[2]] = 1
    outside = float((m & (1 - inside)).mean())
    if outside > PLATE_FIT: return None, f"the plate does not match this still ({100 * outside:.1f} % differs outside the characters)"
    return m, None


def cutouts(image, out_dir, plate=None, pad=0.08):
    import end_frame as E
    bgr = cv2.imread(image) if isinstance(image, str) else image
    if bgr is None: raise FileNotFoundError(image)
    h, w = bgr.shape[:2]
    people = E._merged_people(E._detector().detect(bgr))
    sess = E._matting()
    boxes = []
    for d in people:
        x, y, bw, bh = d["box"]
        boxes.append([max(0, int((x - pad * bw) * w)), max(0, int((y - pad * bh) * h)),
                      min(w, int((x + bw * (1 + pad)) * w)), min(h, int((y + bh * (1 + pad)) * h)), x, bw])
    boxes.sort(key=lambda b: (b[0] + b[2]) / 2)
    # 2026-11-16: a location can have a plate per camera framing; the first one that fits is used
    plates = [plate] if isinstance(plate, str) else [p for p in (plate or []) if p]
    pm, plate_why = None, "no plate for this location"
    for p_ in plates:
        pm, why_ = plate_mask(bgr, p_, boxes)
        if pm is not None: break
        plate_why = why_ if len(plates) == 1 else f"none of the location's {len(plates)} plates matches this still"
    os.makedirs(out_dir, exist_ok=True)
    out = []
    for i, (x0, y0, x1, y1, x, bw) in enumerate(boxes):
        warn = []
        if not sess:
            cm = np.ones((y1 - y0, x1 - x0), np.uint8); warn.append("no matting model: box cut, background included")
        else:
            # same matting as end_frame, including growing the crop over a head the detector's box cut off
            cm, (x0, y0, x1, y1) = E.matte_grown(bgr, x0, y0, x1, y1, int(x * w), int((x + bw) * w), sess)
        if pm is not None:
            pc = pm[y0:y1, x0:x1]
            both = cm & pc
            if both.sum() > 0.5 * cm.sum(): cm = both          # never let the plate erase most of the character
            else: warn.append("the plate removed most of this character: plate ignored for it")
        else:
            warn.append(f"background may come along: {plate_why}")
        n2, lab2, st2, _ = cv2.connectedComponentsWithStats(cm)
        if n2 > 2:                                              # drop specks left after the plate cut
            big = [k for k in range(1, n2) if st2[k, 4] > 0.01 * cm.sum()]
            cm = np.isin(lab2, big).astype(np.uint8)
        ys, xs = np.nonzero(cm)
        if not len(ys): continue
        mx0, mx1, my0, my1 = xs.min() + x0, xs.max() + x0, ys.min() + y0, ys.max() + y0
        if mx0 <= 2 or my0 <= 2 or mx1 >= w - 3 or my1 >= h - 3: warn.append("cut off by the frame edge: part of the body is missing")
        others = [b for j, b in enumerate(boxes) if j != i]
        if any(_overlap([x0, y0, x1, y1], b[:4]) > 0.25 for b in others):
            warn.append("overlaps another character: check that no part of them came along")
        if (my1 - my0) < MIN_H * h: warn.append("small in the frame: the reference will be low on detail")
        ch = my1 - my0; m = int(MARGIN * ch)
        cw_, chh = (mx1 - mx0) + 2 * m, ch + 2 * m
        canvas = np.full((chh, cw_, 3), 255, np.uint8)
        full = np.zeros((h, w), np.uint8); full[y0:y1, x0:x1] = cm
        sub = full[my0:my1 + 1, mx0:mx1 + 1].astype(bool)
        region = canvas[m:m + sub.shape[0], m:m + sub.shape[1]]
        region[sub] = bgr[my0:my1 + 1, mx0:mx1 + 1][sub]
        p = os.path.join(out_dir, f"cutout_{i + 1}.png"); cv2.imwrite(p, canvas)
        out.append({"index": i + 1, "path": p, "box": [round(mx0 / w, 3), round(my0 / h, 3), round(mx1 / w, 3), round(my1 / h, 3)],
                    "warnings": warn, "matting": bool(sess), "plate_used": pm is not None, "version": VERSION})
    json.dump(out, open(os.path.join(out_dir, "cutouts.json"), "w"), indent=1)
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("image"); ap.add_argument("--out", required=True); ap.add_argument("--plate")
    a = ap.parse_args()
    print(json.dumps(cutouts(a.image, a.out, plate=a.plate), indent=1))

if __name__ == "__main__":
    main()

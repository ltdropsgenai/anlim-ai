"""edit_check.py - did an image edit change only what it was meant to? @anlim

Compares BEFORE and AFTER. The AFTER image is first aligned to BEFORE (image models often
shift or rescale the whole picture slightly), then every area that changed is found. Changes
inside --region (the intended edit) are expected; changes outside it are flagged and boxed in
red on an overlay. Without --region it reports every change, to answer "what did this edit touch?".

  python edit_check.py BEFORE.png AFTER.png [--region x0,y0,x1,y1] [--out DIR] [--thr 28]
  (region in fractions of the image, e.g. 0.30,0.55,0.70,0.95)
"""
import argparse, os, shutil, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import write_viewer

def align(before, after):
    import cv2
    A = cv2.cvtColor(before, cv2.COLOR_BGR2GRAY); B = cv2.cvtColor(after, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(6000); k1, d1 = orb.detectAndCompute(A, None); k2, d2 = orb.detectAndCompute(B, None)
    if d1 is None or d2 is None: return after, None
    good = [m[0] for m in cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(d2, d1, k=2) if len(m) == 2 and m[0].distance < 0.75 * m[1].distance]
    if len(good) < 20: return after, None
    M, inl = cv2.estimateAffinePartial2D(np.float32([k2[m.queryIdx].pt for m in good]), np.float32([k1[m.trainIdx].pt for m in good]),
                                         method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if M is None: return after, None
    return cv2.warpAffine(after, M, (before.shape[1], before.shape[0]), borderMode=cv2.BORDER_REPLICATE), M

def main():
    import cv2
    ap = argparse.ArgumentParser(); ap.add_argument("before"); ap.add_argument("after")
    ap.add_argument("--region"); ap.add_argument("--out"); ap.add_argument("--thr", type=float, default=28)
    a = ap.parse_args()
    B0 = cv2.imread(a.before); A0 = cv2.imread(a.after)
    if A0.shape[:2] != B0.shape[:2]: A0 = cv2.resize(A0, (B0.shape[1], B0.shape[0]))
    A, M = align(B0, A0)
    h, w = B0.shape[:2]
    lab_b = cv2.cvtColor(cv2.GaussianBlur(B0, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    lab_a = cv2.cvtColor(cv2.GaussianBlur(A, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    diff = np.sqrt(((lab_b - lab_a) ** 2).sum(-1))
    ch = (diff > a.thr).astype(np.uint8)
    k = max(3, w // 300) | 1
    ch = cv2.morphologyEx(ch, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    ch = cv2.dilate(ch, np.ones((k * 3, k * 3), np.uint8))
    reg = None
    if a.region:
        x0, y0, x1, y1 = [float(v) for v in a.region.split(",")]; reg = (int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(ch)
    minarea = (w * h) * 0.0004
    inside, outside = [], []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if area < minarea: continue
        box = [int(x), int(y), int(x + bw), int(y + bh)]
        if reg:
            ix = max(0, min(box[2], reg[2]) - max(box[0], reg[0])); iy = max(0, min(box[3], reg[3]) - max(box[1], reg[1]))
            frac_in = ix * iy / max(1, bw * bh)
            (inside if frac_in > 0.6 else outside).append({"box": box, "area_pct": round(100 * area / (w * h), 2)})
        else:
            outside.append({"box": box, "area_pct": round(100 * area / (w * h), 2)})
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.after)), "edit_check_" + os.path.splitext(os.path.basename(a.after))[0])
    os.makedirs(out, exist_ok=True)
    ov = A.copy(); t = max(2, w // 400)
    if reg: cv2.rectangle(ov, reg[:2], reg[2:], (0, 200, 0), t)
    for c in outside: cv2.rectangle(ov, tuple(c["box"][:2]), tuple(c["box"][2:]), (0, 0, 255), t)
    for c in inside: cv2.rectangle(ov, tuple(c["box"][:2]), tuple(c["box"][2:]), (255, 160, 0), t)
    cv2.imwrite(os.path.join(out, "overlay.jpg"), ov, [cv2.IMWRITE_JPEG_QUALITY, 92])
    heat = cv2.applyColorMap(np.clip(diff * 3, 0, 255).astype(np.uint8), cv2.COLORMAP_JET)
    cv2.imwrite(os.path.join(out, "change_map.jpg"), cv2.addWeighted(A, 0.45, heat, 0.55, 0))
    shutil.copy(a.before, os.path.join(out, "before" + os.path.splitext(a.before)[1]))
    shutil.copy(a.after, os.path.join(out, "after" + os.path.splitext(a.after)[1]))
    shift = None
    if M is not None: shift = {"scale": round(float(np.hypot(M[0, 0], M[1, 0])), 4), "dx_px": round(float(M[0, 2]), 1), "dy_px": round(float(M[1, 2]), 1)}
    why = []
    if M is None:
        why.append("ALIGNMENT FAILED: compared without aligning; if the edit moved or rescaled the picture, every edge shows as changed")
    if shift and (abs(shift["scale"] - 1) > 0.01 or abs(shift["dx_px"]) > 3 or abs(shift["dy_px"]) > 3):
        why.append(f"whole image moved: scale {shift['scale']}, shift ({shift['dx_px']}, {shift['dy_px']}) px (aligned before comparing)")
    if reg:
        if outside: why.append(f"{len(outside)} changed areas OUTSIDE the intended region ({sum(c['area_pct'] for c in outside):.1f}% of image)")
        if not inside: why.append("nothing changed inside the intended region")
    elif outside: why.append(f"{len(outside)} changed areas ({sum(c['area_pct'] for c in outside):.1f}% of image)")
    frames = [{"i": 0, "key": "edit", "label": os.path.basename(a.after), "t": None, "why": why or ["only the intended region changed"],
               "out": "overlay.jpg", "refs": [{"label": "before", "src": os.path.basename(os.path.join(out, "before" + os.path.splitext(a.before)[1]))},
                                              {"label": "after (as delivered)", "src": "after" + os.path.splitext(a.after)[1]},
                                              {"label": "change map (red = changed most)", "src": "change_map.jpg"}],
               "edit": {"inside": inside, "outside": outside, "alignment": shift}}]
    write_viewer({"kind": "edit", "clip": os.path.basename(a.after), "frames": frames}, out)
    print(f"{os.path.basename(a.before)} -> {os.path.basename(a.after)}")
    for x in (why or ["only the intended region changed"]): print("  " + x)
    for c in outside[:12]: print(f"   outside: box {c['box']} ({c['area_pct']}%)")
    print(f"  review: {os.path.join(out, 'review.html')}  (green = intended region, red = unexpected change)")

if __name__ == "__main__":
    main()

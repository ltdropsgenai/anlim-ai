"""objects_check.py - who and what is in the shot, sampled through the clip. @anlim

Catches things that appear or multiply from nowhere: people on an empty bench (M_Ap_Rete_Mwen P020),
10-12 people on an empty ridge (P053), a second copy of the actor (P018), an extra figure in shop
glass (P016_alt), groceries piling up (P042), props that vanish.

  python objects_check.py CLIP --people 1 [--allow "backpack,handbag"] [--fps 2] [--conf 0.45]
  in code: objects_check.analyze(clip, people=1, track=["backpack"], ...)

What it reports:
- PEOPLE: the most people seen in a sample vs the shot's head count (--people), sustained 2+ samples.
- APPEARS: an object class (COCO list: person, backpack, handbag, cup, bottle, cell phone, book,
  bench, car...) absent in the first sample that shows up later and stays 2+ samples, and was not in
  --allow (things the shot says enter). Also a class whose count goes up (one cup becomes three).
- VANISHES (for --track classes): present at the start, then gone for 2+ samples.
Directions about where in the frame come as fractions of the frame.

Model: YOLOX-S from OpenCV Zoo (models/object_detection_yolox_2022nov.onnx, Apache-2.0), COCO classes.
LIMITS: it counts what a COCO detector recognises. People in reflections, posters, photos and screens
count as people (P016_alt's figure in glass is a real case of that, which is useful, but so is a
framed photo, which is not); small or blurred figures are missed; cartoon detection is tested
separately (README).
"""
import argparse, json, os, subprocess, sys
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")   # hide OpenCV 5 "Targets are not supported" notices
import numpy as np
import cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import probe

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "object_detection_yolox_2022nov.onnx")
COCO = ["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light", "fire hydrant",
        "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
        "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
        "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
        "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut",
        "cake", "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
        "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors",
        "teddy bear", "hair drier", "toothbrush"]

class Detector:
    """YOLOX-S, pre/post-processing as in the OpenCV Zoo demo (letterbox to 640, RGB, no normalisation)."""
    def __init__(self, conf=0.45, nms=0.5):
        if not os.path.exists(MODEL):
            sys.exit(f"model missing: {MODEL} (github.com/opencv/opencv_zoo, models/object_detection_yolox)")
        self.net = cv2.dnn.readNet(MODEL); self.conf = conf; self.nms = nms
        g, s = [], []
        for st in (8, 16, 32):
            n = 640 // st; xv, yv = np.meshgrid(np.arange(n), np.arange(n))
            g.append(np.stack((xv, yv), 2).reshape(1, -1, 2)); s.append(np.full((1, n * n, 1), st))
        self.grids = np.concatenate(g, 1); self.strides = np.concatenate(s, 1)
    def detect(self, bgr):
        h, w = bgr.shape[:2]; r = min(640 / h, 640 / w)
        pad = np.ones((640, 640, 3), np.float32) * 114
        pad[: int(h * r), : int(w * r)] = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (int(w * r), int(h * r))).astype(np.float32)
        self.net.setInput(np.transpose(pad, (2, 0, 1))[None])
        d = self.net.forward(self.net.getUnconnectedOutLayersNames())[0][0].copy()
        d[:, :2] = (d[:, :2] + self.grids[0]) * self.strides[0]; d[:, 2:4] = np.exp(d[:, 2:4]) * self.strides[0]
        xywh = np.stack([d[:, 0] - d[:, 2] / 2, d[:, 1] - d[:, 3] / 2, d[:, 2], d[:, 3]], 1)
        sc = d[:, 4:5] * d[:, 5:]; best = sc.max(1); cls = sc.argmax(1)
        keep = cv2.dnn.NMSBoxesBatched(xywh.tolist(), best.tolist(), cls.tolist(), self.conf, self.nms)
        out = []
        for i in np.array(keep).flatten():
            x, y, bw, bh = xywh[i] / r
            out.append({"cls": COCO[int(cls[i])], "score": round(float(best[i]), 3),
                        "box": [round(float(x / w), 3), round(float(y / h), 3), round(float(bw / w), 3), round(float(bh / h), 3)]})
        return out

def samples(clip, fps):
    w, h, _, dur = probe(clip)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", clip, "-vf", f"fps={fps}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         capture_output=True, check=True).stdout
    for i in range(len(raw) // (w * h * 3)):
        yield round(i / fps, 2), np.frombuffer(raw, np.uint8, w * h * 3, i * w * h * 3).reshape(h, w, 3)

def runs(flags, n=2):
    """indexes where a True run of length >= n starts"""
    out, r = [], 0
    for i, f in enumerate(flags):
        r = r + 1 if f else 0
        if r == n: out.append(i - n + 1)
    return out

def cartoon_people(dets, thr=0.30):
    """Chibi / big-head cartoon children are detected as "teddy bear" as often as "person". Count both
    as people, one count per body (class-agnostic NMS), at 0.30. Calibrated 2026-11-10 on 16 kids frames
    counted by eye (0-4 characters): 13/16 exact, never more people than there were; the 3 misses were
    undercounts (children behind a kitchen island, two children seated close at a table)."""
    p = [d for d in dets if d["cls"] in ("person", "teddy bear") and d["score"] >= thr]
    rest = [d for d in dets if d["cls"] not in ("person", "teddy bear")]
    if p:
        keep = cv2.dnn.NMSBoxes([d["box"] for d in p], [d["score"] for d in p], thr, 0.5)
        p = [dict(p[i], cls="person") for i in np.array(keep).flatten()]
        # NMS keeps a head-and-torso box that sits inside the same child's full-body box (IoU under 0.5):
        # 2026-11-12, app clip S2 at 3.5 s: King as "teddy bear" [0.44,0.10,0.21,0.56] inside his "person" box
        # [0.43,0.17,0.25,0.82], IoU 0.47, 87% contained -> 3 people counted, a FAIL with 2 children on screen.
        # A box at least 80% inside a larger one is the same body. Under-counting only FLAGs; over-counting FAILs.
        def inside(a, b):
            ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])); iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
            return ix * iy / (a[2] * a[3] + 1e-9)
        p.sort(key=lambda d: -d["box"][2] * d["box"][3])
        kept = []
        for d in p:
            if all(inside(d["box"], k["box"]) < 0.8 for k in kept): kept.append(d)
        p = kept
    return p + rest

def _inside(box, r):
    cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
    return r[0] <= cx <= r[2] and r[1] <= cy <= r[3]

def region_people(D, im, r, conf=0.35, tile=None):
    """People seen INSIDE a region (glass, mirror, screen): the region is cut into square tiles with 25%
    overlap, so a small reflected figure is enlarged before detection (the whole-frame pass missed the
    P016_alt and P021 reflections). Only figures whose box lies within the region count: someone walking
    in front of the glass has feet below it."""
    H, W = im.shape[:2]; x0, y0, x1, y1 = int(r[0] * W), int(r[1] * H), int(r[2] * W), int(r[3] * H)
    # tile = region height by default; smaller tiles (240 px) were tested on P016_alt: 3x slower, found nothing more
    side = max(32, min(tile or (y1 - y0), y1 - y0, x1 - x0)); step = max(1, int(side * 0.75)); found = []
    def starts(a, b):
        v = list(range(a, max(a + 1, b - side + 1), step)) or [a]
        if v[-1] + side < b: v.append(max(a, b - side))
        return v
    for ya in starts(y0, y1):
        for xa in starts(x0, x1):
            t_ = im[ya:min(H, ya + side), xa:min(W, xa + side)]
            if t_.size == 0: continue
            for d in D.detect(t_):
                if d["cls"] != "person" or d["score"] < conf: continue
                bx, by, bw, bh = d["box"]; th, tw = t_.shape[:2]
                g = [(xa + bx * tw) / W, (ya + by * th) / H, bw * tw / W, bh * th / H]
                if g[1] + g[3] <= r[3] + 0.02 and g[1] >= r[1] - 0.02:
                    found.append({"box": [round(v, 3) for v in g], "score": d["score"]})
    if found:
        keep = cv2.dnn.NMSBoxes([f["box"] for f in found], [f["score"] for f in found], conf, 0.4)
        found = [found[i] for i in np.array(keep).flatten()]
    return found

def analyze(clip, people=None, allow=(), track=(), fps=2.0, conf=0.45, min_size=0.0, style="photo", regions=(), log=print):
    """style "cartoon" counts chibi characters (see cartoon_people).
    regions: [{"box": [x0, y0, x1, y1] (fractions), "kind": "photo" | "glass", "expect": 0, "name": "shop window"}]
      photo: people inside are NOT counted in the head count (framed photos, posters, screens)
      glass: people inside are not counted in the head count either, but are searched for with
             enlarged tiles and flagged when more than "expect" (a reflection nobody asked for).
             Boxes are fixed in the frame: for locked shots."""
    log = log or (lambda *x: None)
    D = Detector(min(conf, 0.30) if style == "cartoon" else conf); rows = []
    for t, im in samples(clip, fps):
        dets = D.detect(im)
        if style == "cartoon": dets = cartoon_people(dets)
        dets = [d for d in dets if d["box"][3] >= min_size and (d["cls"] == "person" or d["score"] >= conf)]
        inreg = {}
        for i, rg in enumerate(regions):
            nm = rg.get("name") or f"{rg.get('kind', 'region')} {i + 1}"
            hold = [d for d in dets if d["cls"] == "person" and _inside(d["box"], rg["box"])
                    and d["box"][1] + d["box"][3] <= rg["box"][3] + 0.02]
            dets = [d for d in dets if d not in hold]
            if rg.get("kind") == "glass":
                # drop tile detections that are the real people in front of the glass (the region crop
                # cuts them off at its edge, so their partial box would otherwise fit inside it)
                front = [d["box"] for d in dets if d["cls"] == "person"]
                def over(a, b):
                    ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])); iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
                    return ix * iy / (a[2] * a[3] + 1e-9)
                inreg[nm] = len([g for g in region_people(D, im, rg["box"]) if all(over(g["box"], f) < 0.3 for f in front)])
            else:
                inreg[nm] = len(hold)
        rows.append({"t": t, "dets": dets, "in_regions": inreg})
    counts = [{} for _ in rows]
    for c, r in zip(counts, rows):
        for d in r["dets"]: c[d["cls"]] = c.get(d["cls"], 0) + 1
    problems, look = [], []
    if not rows: return {"clip": clip, "problems": ["no frames read"], "samples": []}
    np_ = [c.get("person", 0) for c in counts]
    if people is not None:
        for i in runs([n > people for n in np_]):
            problems.append(f"PEOPLE: {np_[i]} people at {rows[i]['t']:.1f} s, the shot calls for {people}")
        if people > 0:
            for i in runs([n < people for n in np_], 3):
                look.append(f"fewer people than the shot calls for from {rows[i]['t']:.1f} s ({np_[i]} of {people}) - turned away or out of frame?")
    for i, rg in enumerate(regions):
        nm = rg.get("name") or f"{rg.get('kind', 'region')} {i + 1}"
        series = [r["in_regions"].get(nm, 0) for r in rows]
        if rg.get("kind") == "glass":
            # without "expect", the approved start frame sets the count (a reflection already in it was approved)
            lim = rg["expect"] if "expect" in rg else series[0]
            for j in runs([n > lim for n in series]):
                problems.append(f"REFLECTION: {series[j]} figure(s) in the {nm} at {rows[j]['t']:.1f} s ({lim} expected"
                                + ("" if "expect" in rg else ", as in the first frame") + ")")
        elif any(series):
            look.append(f"{max(series)} people inside the {nm} (not counted in the head count)")
    first = counts[0]; allow = set(allow)
    WORN = {"tie", "handbag", "backpack", "umbrella", "suitcase"}      # come in with extra people
    extra_people = any(p.startswith("PEOPLE") for p in problems)
    for cls in sorted({k for c in counts for k in c}):
        if cls in allow or (cls == "person" and people is not None): continue
        series = [c.get(cls, 0) for c in counts]
        base = series[0]
        long_, short_ = runs([n > base for n in series], 3), runs([n > base for n in series], 2)
        if not short_: continue
        i = (long_ or short_)[0]                                   # report each class once, at its first run
        what = "appears" if base == 0 else f"goes from {base} to {series[i]}"
        msg = f"{cls} {what} at {rows[i]['t']:.1f} s (detector's class name; not in the first frame, not in the allowed list)"
        if extra_people and cls in WORN: look.append(msg + " - probably on the extra people")
        elif long_: look.append("APPEARS: " + msg)    # a note, not a failure: on 55 judged clips (2026-11-10) the
                                                     # detector's "a chair/train/book appeared" failed 6 good clips
        else: look.append(msg + " - only 2 samples, may be detector flicker")
    for cls in track:
        series = [c.get(cls, 0) for c in counts]
        if series[0] == 0: look.append(f"{cls} is not seen in the first frame (spec says it is there - check the start frame)")
        else:
            for i in runs([n == 0 for n in series]):           # presence, not count: counts flicker
                problems.append(f"VANISHES: {cls} not seen from {rows[i]['t']:.1f} s (in the first frame)")
    rep = {"clip": clip, "people_spec": people, "max_people": max(np_), "people_per_sample": np_,
           "first_frame": first, "problems": problems, "look_at": look, "samples": rows}
    log(f"{os.path.basename(clip)}: people per sample {np_}; first frame {first}")
    log("PROBLEMS:" if problems else "nothing appears, multiplies or vanishes by this check")
    for p in problems[:15]: log("  - " + p)
    for p in look[:6]: log("  look: " + p)
    return rep

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip"); ap.add_argument("--people", type=int); ap.add_argument("--allow", default="")
    ap.add_argument("--track", default=""); ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument("--conf", type=float, default=0.45); ap.add_argument("--style", default="photo", choices=["photo", "cartoon"])
    ap.add_argument("--regions", help='JSON list, e.g. [{"box":[0.2,0,0.68,0.75],"kind":"photo"}]')
    ap.add_argument("--json")
    a = ap.parse_args()
    rep = analyze(a.clip, a.people, [x for x in a.allow.split(",") if x], [x for x in a.track.split(",") if x], a.fps, a.conf, style=a.style,
                  regions=json.loads(a.regions) if a.regions else ())
    if a.json: json.dump(rep, open(a.json, "w"), indent=1)

if __name__ == "__main__":
    main()

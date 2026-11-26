"""end_frame.py - end frames that change only the characters. @anlim

An end frame is usually made by editing the approved start still ("same room, she is now at the shelf").
Image models redraw the whole picture when they do that, and things that should not move do: on
2026-11-12 (Phase 0 S3) three end-frame edits in a row squeezed the shelf toys to the right to make
room for Layana. The video model then slid the toys across the shelf during the clip (Londi's catch).

Two tools:

  check   start vs end, everywhere outside the characters (in either frame). Anything that changed there
          is "drift": a prop moved, furniture redrawn, the room rescaled. PASS when nothing did, FLAG with
          boxes otherwise. Free (no API), run it before paying for a render.
  compose builds an end frame that cannot drift: the room comes pixel-for-pixel from the start still; only
          the characters (and the places they left, which the edit had to repaint) come from the edit.

  python end_frame.py check   START.png END.png   [--out DIR]
  python end_frame.py compose START.png EDITED.png OUT.png [--out DIR]
  in code: end_frame.check(start, end) -> dict;  end_frame.compose(start, edited, out_path) -> dict

Character masks: people boxes from objects_check (YOLOX, cartoon_people), then each box is cut out with the
rembg "isnet-anime" matting model (pip install "rembg[cpu]"; the model, 176 MB, downloads on first use).
Without rembg the masks fall back to the padded boxes: the check then cannot see drift inside a
character's box, and compose copies whole boxes from the edit (so props inside a box can still drift).

Tested 2026-11-12 on Phase 0 S3 (see regress unit.end_frame and the case list in README): the three
drifted end frames FLAG on the shelf, the hand-fixed one PASSes, compose(start, drifted) PASSes.
LIMITS: one room, locked camera. A deliberate camera change between start and end (push-in, new angle)
is reported as drift everywhere; a prop the shot MEANS to move (she picks up the truck) is reported too:
pass it in allow=[x0,y0,x1,y1 fractions].
"""
import argparse, json, os, sys, threading
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
import numpy as np
import cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import objects_check as oc
from edit_check import align

VERSION = 1
THR = 28            # LAB distance after a 5x5 blur, the same as edit_check
MIN_AREA = 0.0015   # of the frame; a drift smaller than this is line wobble from the re-draw
_det = None
_sess = {}

# What counts as a character, and which matting model cuts them out (2026-11-16, Londi: "Cartoon, photoreal (animals,
# people, objects). That's the rule"). Until then only "person" / "teddy bear" boxes were characters and isnet-anime
# (trained on anime) cut every one out. Set per request with subjects(look, cast) by the checker service, which runs
# one end_frame request at a time (_EF_LOCK), so a module-level setting is safe there.
ANIMALS = ("bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe")
MATTING = {"cartoon": "isnet-anime", "photoreal": "isnet-general-use"}
_CFG_LOCK = __import__("threading").RLock()
_CFG = {"classes": ("person", "teddy bear"), "look": "cartoon", "unfindable": ()}


def subject_classes(look="cartoon", cast=None):
    """Detector classes for a cast [{"kind": person|animal|object, "what": "golden retriever"}]. People -> person;
    animals -> every COCO animal (a cartoon dog is often called a cat or a bear); objects -> the COCO class named in
    "what", if any (a "red toy dump truck" -> truck). In cartoon, "teddy bear" also counts: the detector calls chibi
    children and toy-like animals that. With no cast: people, as before."""
    cast = cast or [{"kind": "person"}]
    cl = set()
    for c in cast:
        k = (c.get("kind") or "person").lower()
        if k == "person": cl.add("person")
        elif k == "animal": cl.update(ANIMALS)
        else:
            w = " " + (c.get("what") or c.get("name") or "").lower().replace("-", " ") + " "
            cl.update(x for x in oc.COCO if f" {x} " in w or f" {x}s " in w)
    if look == "cartoon" and cl: cl.add("teddy bear")
    return tuple(sorted(cl))


def unfindable(cast=None):
    """Cast members the detector has no class for (an object such as a "robot vacuum"): compose cannot outline them,
    so it cannot keep the room around them pixel-for-pixel either."""
    out = []
    for c in cast or []:
        if (c.get("kind") or "person").lower() == "object" and not subject_classes("photoreal", [c]):
            out.append(c.get("name") or c.get("what") or "an object")
    return tuple(out)


class subjects:
    """with subjects(look, cast): ... - char_mask, compose, check, reposition_fit and cutout use this cast's classes
    and the look's matting model."""
    def __init__(self, look="cartoon", cast=None):
        self.new = {"classes": subject_classes(look, cast) if cast else ("person", "teddy bear"),
                    "look": look if look in MATTING else "cartoon", "unfindable": unfindable(cast)}
    def __enter__(self):
        _CFG_LOCK.acquire()      # one cast at a time: the checker service also checks clips on parallel threads
        self.old = dict(_CFG); _CFG.update(self.new); return self
    def __exit__(self, *a):
        _CFG.clear(); _CFG.update(self.old); _CFG_LOCK.release()


def _detector():
    global _det
    if _det is None: _det = oc.Detector(conf=0.25)
    return _det


def _matting():
    name = MATTING[_CFG["look"]]
    if name not in _sess:
        try:
            _sess[name] = _lean_session(name)     # isnet-general-use (photoreal) downloads on first use, like isnet-anime
        except Exception:
            _sess[name] = False
    return _sess[name]


def _lean_session(name):
    """rembg session with onnxruntime's CPU memory arena and memory pattern OFF.
    2026-11-20: the Fly checker (2 GB) was OOM-killed every ~9 minutes. Measured on room_drift's end_frame.check (two
    1344x752 cartoon stills, rembg 2.0.69 + onnxruntime 1.23.2, the versions in the Dockerfile): process peak 2,112 MB
    with the defaults (the arena keeps every 1024x1024 activation buffer), 1,449 MB with both off; same drift boxes,
    same time (16 s). Built through sessions_class because rembg 2.0.69's new_session takes no session options."""
    import onnxruntime as ort
    from rembg.sessions import sessions_class
    o = ort.SessionOptions(); o.enable_cpu_mem_arena = False; o.enable_mem_pattern = False
    if "OMP_NUM_THREADS" in os.environ:
        o.inter_op_num_threads = o.intra_op_num_threads = int(os.environ["OMP_NUM_THREADS"])
    cls = next((c for c in sessions_class if c.name() == name), None)
    if cls is None:
        from rembg import new_session
        return new_session(name)
    return cls(name, o)


def _merged_people(dets, thr=0.25):
    """Person and "teddy bear" boxes (cartoon children, see objects_check.cartoon_people), merged into one box per
    body. Counting keeps the best-scoring box, but for a mask that can be a torso-and-legs box without the head:
    2026-11-12, composed S3 end frame: Layana as "person" 0.58 from the neck down, and as "teddy bear" 0.51 head to
    feet; NMS kept the first and the check flagged her head as drift. Here boxes that overlap by more than half of
    the smaller one are joined into their union."""
    bs = [list(d["box"]) for d in dets if d["cls"] in _CFG["classes"] and d["score"] >= thr]
    def ov(a, b):
        ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])); iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
        return ix * iy / (min(a[2] * a[3], b[2] * b[3]) + 1e-9)
    merged = True
    while merged:
        merged = False
        for i in range(len(bs)):
            for j in range(i + 1, len(bs)):
                if ov(bs[i], bs[j]) > 0.5:
                    a, b = bs[i], bs[j]
                    x0, y0 = min(a[0], b[0]), min(a[1], b[1]); x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
                    bs[i] = [x0, y0, x1 - x0, y1 - y0]; del bs[j]; merged = True; break
            if merged: break
    return [{"cls": "person", "box": b} for b in bs]


def _matte(bgr, x0, y0, x1, y1, cx0, cx1, sess):
    """isnet-anime mask of one crop, keeping the blob(s) that touch the body's centre columns (the matting model also
    picks up nearby furniture)."""
    from rembg import remove
    from PIL import Image
    crop = Image.fromarray(cv2.cvtColor(bgr[y0:y1, x0:x1], cv2.COLOR_BGR2RGB))
    cm = (np.array(remove(crop, session=sess, only_mask=True)) > 100).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(cm)
    if n > 1:
        a, b = cx0 - x0, cx1 - x0
        keep = [i for i in range(1, n) if st[i, 4] > 0.02 * cm.size and
                min(st[i, 0] + st[i, 2], b) - max(st[i, 0], a) > 0.3 * st[i, 2]]
        cm = np.isin(lab, keep).astype(np.uint8) if keep else cm
    return cm


GROW = 2   # times a crop is enlarged when the character runs off its top or upper sides


def matte_grown(bgr, x0, y0, x1, y1, cx0, cx1, sess):
    """_matte, and while the mask runs into the crop's top (or its sides in the upper 40 %: hair, bows, caps) the crop
    is enlarged that way and matted again (GROW times at most). Returns (mask, (x0, y0, x1, y1)). Used by char_mask and
    cutout.cutouts (2026-11-16: the detector's box for a seated Layana started at her mouth)."""
    h, w = bgr.shape[:2]
    cm = _matte(bgr, x0, y0, x1, y1, cx0, cx1, sess)
    for _ in range(GROW):
        ch, cw = cm.shape; edge = max(2, ch // 100); up = int(0.4 * ch)
        top = y0 > 0 and cm[:edge].sum() > 0.03 * cw * edge
        left = x0 > 0 and cm[:up, :edge].sum() > 0.03 * up * edge
        right = x1 < w and cm[:up, -edge:].sum() > 0.03 * up * edge
        if not (top or left or right): break
        gy, gx = int(0.35 * (y1 - y0)), int(0.25 * (x1 - x0))
        if top: y0 = max(0, y0 - gy)
        if left: x0 = max(0, x0 - gx)
        if right: x1 = min(w, x1 + gx)
        cm = _matte(bgr, x0, y0, x1, y1, cx0, cx1, sess)
    return cm, (x0, y0, x1, y1)


_MASK_CACHE = {}          # 2026-11-26: char_mask results by image content (see char_mask)
_MASK_CACHE_MAX = 8
_MASK_LOCK = threading.Lock()


def char_mask(bgr, pad=0.08):
    """_char_mask, remembered by the image's content and the request's look and cast classes.
    2026-11-26 (Atud Clinton's end image, job dcedf786, a cartoon park with 6 children): one compose matted the same
    images again and again (the start still in compose and in each check() pass, the composed frame in check() and in
    the repair pass): up to 11 char_mask calls for about 5 different images, each ~12 s of full CPU at 1.7 s per child
    on the Fly shared-cpu-2x, which drained the machine's CPU burst and slowed it 16 times (Fly shared-CPU baseline).
    Identical pixels give the identical mask, so a repeat is a lookup. Callers get copies (they may draw on them)."""
    import hashlib
    key = (hashlib.blake2b(np.ascontiguousarray(bgr).tobytes(), digest_size=16).hexdigest(), bgr.shape, pad,
           _CFG["look"], tuple(_CFG["classes"]))
    with _MASK_LOCK:
        hit = _MASK_CACHE.get(key)
    if hit is None:
        hit = _char_mask(bgr, pad)
        with _MASK_LOCK:
            _MASK_CACHE[key] = hit
            while len(_MASK_CACHE) > _MASK_CACHE_MAX: _MASK_CACHE.pop(next(iter(_MASK_CACHE)))
    m, boxes, matted = hit
    return m.copy(), [list(b) for b in boxes], matted


def _char_mask(bgr, pad=0.08):
    """uint8 mask (255 = a character) and the people boxes (pixels). One cut-out per detected person.
    2026-11-16 (reposition live test, job f5f11c3d): the detector's box for a seated Layana started at her mouth, the
    mask stopped at the box edge, and compose pasted the wall over her hair and bows. When the mask runs into the top
    of the crop, or its sides in the upper 40 % (hair, bows, caps), the crop is enlarged that way and matted again.
    Not downwards or lower sides: there it is usually the sofa or the floor touching the body."""
    h, w = bgr.shape[:2]
    people = _merged_people(_detector().detect(bgr))
    m = np.zeros((h, w), np.uint8)
    boxes = []
    sess = _matting()
    for d in people:
        x, y, bw, bh = d["box"]
        x0 = max(0, int((x - pad * bw) * w)); y0 = max(0, int((y - pad * bh) * h))
        x1 = min(w, int((x + bw * (1 + pad)) * w)); y1 = min(h, int((y + bh * (1 + pad)) * h))
        if not sess:
            boxes.append([x0, y0, x1, y1]); m[y0:y1, x0:x1] = 255
            continue
        cm, (x0, y0, x1, y1) = matte_grown(bgr, x0, y0, x1, y1, int(x * w), int((x + bw) * w), sess)
        boxes.append([x0, y0, x1, y1])
        m[y0:y1, x0:x1] = np.maximum(m[y0:y1, x0:x1], cm * 255)
    return m, boxes, bool(sess)


def _diff(a, b):
    la = cv2.cvtColor(cv2.GaussianBlur(a, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    lb = cv2.cvtColor(cv2.GaussianBlur(b, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    return np.sqrt(((la - lb) ** 2).sum(-1))


def _read(p, like=None):
    im = cv2.imread(p) if isinstance(p, str) else p
    if im is None: raise FileNotFoundError(p)
    if like is not None and im.shape[:2] != like.shape[:2]:
        im = cv2.resize(im, (like.shape[1], like.shape[0]), interpolation=cv2.INTER_AREA)
    return im


def check(start, end, out_dir=None, allow=None, thr=THR, min_area=MIN_AREA, known=None):
    S = _read(start); E0 = _read(end, S)
    E, M = align(S, E0)
    h, w = S.shape[:2]
    ms, _, matted = char_mask(S); me, _, _ = char_mask(E)
    k = max(5, w // 120) | 1
    chars = cv2.dilate(np.maximum(ms, me), np.ones((k, k), np.uint8))   # outlines and shadows next to a body
    # Where a character STOOD at the start, the start still has no empty room to compare with: the floor under King's
    # old shoes and their shadow flagged after he sat down (2026-11-13 bake-off S4). Same margin as compose.
    kg = max(15, w // 50) | 1
    chars = np.maximum(chars, cv2.dilate(ms, np.ones((kg, kg), np.uint8)))
    # KNOWN (compose): where compose pasted characters on purpose. The detector can miss a character in the composed
    # frame that it found in the edit (2026-11-16 live, job 0a3a685e: Layana); without this the repair pass "restored"
    # the empty sofa over her and she vanished.
    if known is not None:
        chars = np.maximum(chars, cv2.dilate(known, np.ones((k, k), np.uint8)))
    d = _diff(S, E)
    ch = ((d > thr) & (chars == 0)).astype(np.uint8)
    o = max(3, w // 300) | 1
    ch = cv2.morphologyEx(ch, cv2.MORPH_OPEN, np.ones((o, o), np.uint8))
    ch = cv2.dilate(ch, np.ones((o * 3, o * 3), np.uint8))
    if allow:
        ax0, ay0, ax1, ay1 = allow; ch[int(ay0 * h):int(ay1 * h), int(ax0 * w):int(ax1 * w)] = 0
    n, _, st, _ = cv2.connectedComponentsWithStats(ch)
    drift = []
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        if area < min_area * w * h: continue
        drift.append({"box": [round(x / w, 3), round(y / h, 3), round((x + bw) / w, 3), round((y + bh) / h, 3)],
                      "area_pct": round(100 * area / (w * h), 2)})
    drift.sort(key=lambda r: -r["area_pct"])
    shift = None
    if M is not None:
        shift = {"dx_px": round(float(M[0, 2]), 1), "dy_px": round(float(M[1, 2]), 1),
                 "scale": round(float(np.hypot(M[0, 0], M[1, 0])), 4)}
    res = {"verdict": "FLAG" if drift else "PASS", "drift": drift, "align": shift, "matting": matted,
           "version": VERSION,
           "why": ("things outside the characters changed between the start and end frame; the video will move them "
                   "during the clip" if drift else "only the characters changed")}
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        ov = E.copy()
        ov[chars > 0] = (0.5 * ov[chars > 0] + 0.5 * np.array([255, 160, 0])).astype(np.uint8)  # characters: blue tint
        for r in drift:
            x0, y0, x1, y1 = [int(v * s) for v, s in zip(r["box"], (w, h, w, h))]
            cv2.rectangle(ov, (x0, y0), (x1, y1), (0, 0, 255), 3)
        cv2.imwrite(os.path.join(out_dir, "end_frame_check.png"), np.hstack([S, ov]))
        json.dump(res, open(os.path.join(out_dir, "end_frame_check.json"), "w"), indent=1)
    return res


REVEAL_EDIT_MIN = 0.01   # a vacated area pasted from the edit with a character is listed from 1 % of the frame
REVEAL_FLAG = 0.25       # FLAG when the image model's repaint makes up 25 % of the frame or more (an ordinary
                         # reposition where one character walks away repaints 10-12 %; the close-up job ed5bee77 44 %)
MISSED_MIN = 0.02           # compose: a part of an edit character this large (of the frame) not found again is protected
UNEXPLAINED_MIN = 0.005    # new setup: a difference from the empty room this large (of the frame), outside the characters found
FURNITURE_DIFF = 18       # new setup: LAB distance counted as changed in the band around the characters
FURNITURE_BAND = 0.03     # ...and the share of that band above which the furniture moved (see compose)
CLOSEUP_COVER = 0.35     # reposition_fit: characters cover this much of the still -> the room behind them is unknown


PHOTO_ROOM_PCT = 3.0   # photoreal: colour share, kept for information only (see photo_room_diff)
PHOTO_ROOM_CORR = 0.90  # photoreal room check: the room's edge structure must correlate this well with the plate


def photo_room_diff(S, E, chars_mask):
    """Photoreal: how much of the ROOM (outside the characters) differs between the plate S and the edit E, compared
    coarsely: both blurred (sigma 4), colour-corrected to each other (median offset over the room), shrunk to 96 px
    wide, LAB distance > 20 counted. 2026-11-17, Kijan living room: Nano Banana 2 1.8 % and 0.9 % (room unchanged),
    GPT Image 2.6 8.1 % and Seedream 5 Lite 6.0 % (re-lit / re-drawn). Boxes: the changed cells, merged."""
    h, w = S.shape[:2]
    k = max(15, w // 50) | 1
    m = cv2.dilate(chars_mask, np.ones((k, k), np.uint8)) > 0
    room = ~m
    off = np.median(S[room].astype(np.int16) - E[room].astype(np.int16), axis=0) if room.any() else np.zeros(3)
    En = np.clip(E.astype(np.int16) + off, 0, 255).astype(np.uint8)
    W = 96; H = max(1, round(W * h / w))
    a = cv2.resize(cv2.GaussianBlur(S, (0, 0), 4), (W, H), interpolation=cv2.INTER_AREA)
    b = cv2.resize(cv2.GaussianBlur(En, (0, 0), 4), (W, H), interpolation=cv2.INTER_AREA)
    rm = cv2.resize(room.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST) > 0
    d = np.sqrt(((cv2.cvtColor(a, cv2.COLOR_BGR2LAB).astype(np.float32)
                  - cv2.cvtColor(b, cv2.COLOR_BGR2LAB).astype(np.float32)) ** 2).sum(-1))
    ch = ((d > 20) & rm).astype(np.uint8)
    pct = 100.0 * ch[rm].mean() if rm.any() else 0.0
    boxes = []
    n, _, st, _ = cv2.connectedComponentsWithStats(cv2.dilate(ch, np.ones((3, 3), np.uint8)))
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        if area < 4: continue
        boxes.append({"box": [round(x / W, 3), round(y / H, 3), round((x + bw) / W, 3), round((y + bh) / H, 3)],
                      "area_pct": round(100 * area / (W * H), 2)})
    boxes.sort(key=lambda r: -r["area_pct"])
    # 2026-11-17 bake-off (20 pictures of the Kijan living room): colour alone mixes "re-lit" with "moved" - GPT Image
    # 2.6 kept every wall, window and sofa where it was but re-lit the room (colour 4.7-10 %), while two pictures that
    # really moved or zoomed the room scored 9.5-18.7 %. The room's EDGE STRUCTURE separates them: correlation of
    # blurred edge maps (192 px) over the room - GPT 2.6 0.955-0.973, Nano Banana 2 0.907-0.946 when the room held,
    # 0.708-0.779 when it was rearranged or zoomed. Below PHOTO_ROOM_CORR the room counts as changed.
    def edges(img):
        g = cv2.cvtColor(cv2.GaussianBlur(img, (0, 0), 3), cv2.COLOR_BGR2GRAY).astype(np.float32)
        mg = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
        mg = cv2.resize(mg, (192, max(1, round(192 * h / w))), interpolation=cv2.INTER_AREA)
        return mg / (np.percentile(mg, 95) + 1e-6)
    ea, eb = edges(S), edges(E)
    rr = cv2.resize(room.astype(np.uint8), (ea.shape[1], ea.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    if rr.sum() > 50:
        xa, xb = ea[rr] - ea[rr].mean(), eb[rr] - eb[rr].mean()
        corr = float((xa * xb).sum() / (np.sqrt((xa * xa).sum() * (xb * xb).sum()) + 1e-9))
    else:
        corr = 1.0
    return {"changed_pct": round(float(pct), 2), "structure": round(corr, 3), "offset": [int(v) for v in off], "boxes": boxes[:12]}


def reposition_fit(start, plates=None):
    """Before paying for a reposition edit: how much of START the characters cover, and whether a location plate fits
    it. A close-up with no fitting plate means the image model must invent the room behind the characters
    (2026-11-16, job ed5bee77)."""
    S = _read(start)
    ms, bs, _ = char_mask(S)
    cover = float((ms > 0).mean())
    _, fit, plate_path = pick_plate(S, plates, cv2.dilate(ms, np.ones((25, 25), np.uint8))) if plates else (None, None, None)
    ok = cover < CLOSEUP_COVER or plate_path is not None
    return {"verdict": "PASS" if ok else "FLAG", "cover": round(cover, 3), "people": len(bs),
            "plate_fit": None if fit is None else round(fit, 4), "plate_path": plate_path, "drift": [],
            "why": None if ok else (f"the characters cover {cover:.0%} of this still and no empty-room plate of the "
                                    "location fits its framing, so the room behind them would be invented")}


PLATE_FIT = 0.02   # a plate fits a still when under 2 % of the room (outside every character) differs


def plate_fit(S, plate, mask):
    """The location's empty-room plate aligned to still S, and the share of S's room (mask == 0) that differs from it."""
    P0 = _read(plate, S)
    P, _ = align(S, P0)
    room = mask == 0
    return P, float(((_diff(S, P) > THR) & room).sum()) / max(1, int(room.sum()))


def pick_plate(S, plates, mask):
    """The first plate that fits still S (plates: the location's latest framing first), else None. Returns
    (aligned plate or None, fit of the chosen or best plate, path or None)."""
    best = None
    for p in ([plates] if isinstance(plates, str) else [x for x in (plates or []) if x]):
        try: P, fit = plate_fit(S, p, mask)
        except Exception: continue
        if fit <= PLATE_FIT: return P, fit, p
        best = fit if best is None else min(best, fit)
    return None, best, None


def compose(start, edited, out_path, out_dir=None, feather=2.0, plate=None, expect=None):
    """Room from START, characters from EDITED. Where a character stood in START but not in EDITED, the room behind
    them is not in START: it comes from the location's empty-room PLATE (a path, or a list: one per camera framing,
    the first that fits is used) when one fits, otherwise from
    EDITED's repaint, and those areas are listed in "revealed" so a person looks at them.
    2026-11-16 (reposition live test, job f5f11c3d): with only the edit's repaint, the image model put a blue block on
    the shelf where Layana had stood, and the check passed it (the start still had Layana there, nothing to compare).
    2026-11-16 (live test, job ed5bee77, close-up at a table -> both on the sofa): the characters covered half of the
    start still, no plate fitted that framing, and the vacated area touched the new characters, so it was taken from
    the edit silently - the edit had redrawn the room (table gone, sofa moved, chairs added) and the check said
    "unchanged". Areas taken from the edit that way are now listed in "revealed" too, and a large total FLAGs. The
    detector also found 1 of the 2 characters in the edit, so Layana was pasted only where the vacated area reached:
    the wall showed through her face. EXPECT (the number of characters in the shot) FLAGs when fewer are found."""
    S = _read(start); E0 = _read(edited, S)
    E, _ = align(S, E0)
    ms, bs, matted = char_mask(S); me, be, _ = char_mask(E)
    P, fit, plate_path = pick_plate(S, plate, cv2.dilate(np.maximum(ms, me), np.ones((25, 25), np.uint8)))
    revealed = []
    # The edit comes back a shade lighter or warmer overall; measured on the room (outside every character) and
    # removed, so pasted areas do not show as lighter patches (2026-11-12: a faint halo around King's head).
    room = (cv2.dilate(np.maximum(ms, me), np.ones((25, 25), np.uint8)) == 0)
    off = np.median(S[room].astype(np.int16) - E[room].astype(np.int16), axis=0)
    E = np.clip(E.astype(np.int16) + off, 0, 255).astype(np.uint8)
    # Where a character stood at the START, the edit's repaint is used with a wide margin: a tight mask leaves the
    # start character's outline and shadow behind as a ghost (2026-11-12, S3: faint Layana outline on the wall).
    # The edit's colours there differ slightly from the start still, so a plain paste shows a lighter patch on the
    # wall and a smudge on the floor: that area (the room the character left) is Poisson-blended into the start
    # still (cv2.seamlessClone), which matches its colours to the surroundings. Characters are pasted as drawn.
    k = max(5, S.shape[1] // 200) | 1
    kg = max(15, S.shape[1] // 50) | 1
    chars_end = cv2.dilate(me, np.ones((k, k), np.uint8))
    vacated = cv2.dilate(ms, np.ones((kg, kg), np.uint8))
    vacated[chars_end > 0] = 0
    # A vacated area that touches a character's new outline (he shifted a little: King's head at S3) is pasted
    # straight from the edit with the character: Poisson blending there pulls the old head's colours into the gap
    # (2026-11-12: a brown smudge beside King's head). Only areas a character fully left are Poisson-blended.
    base = S.copy()
    near = cv2.dilate(chars_end, np.ones((5, 5), np.uint8)) > 0
    n, lab, st, cen = cv2.connectedComponentsWithStats((vacated > 0).astype(np.uint8))
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        if area < 50: continue
        part = np.where(lab == i, 255, 0).astype(np.uint8)
        if (near & (part > 0)).any():
            chars_end = np.maximum(chars_end, part)
            # the room in this part is the edit's repaint, unchecked: list it when it is more than a sliver and, with
            # a fitting plate, when the repaint differs from the plate there
            big = area >= REVEAL_EDIT_MIN * S.shape[0] * S.shape[1]
            if big and P is not None:
                big = float((_diff(E, P)[part > 0] > THR).mean()) > 0.10
            if big:
                hh, ww = S.shape[:2]
                revealed.append({"box": [round(x / ww, 3), round(y / hh, 3), round((x + bw) / ww, 3), round((y + bh) / hh, 3)],
                                 "area_pct": round(100 * area / (ww * hh), 2), "source": "edit"})
            continue
        # seamlessClone needs the mask inside the frame with a 1 px margin
        part[:1, :] = 0; part[-1:, :] = 0; part[:, :1] = 0; part[:, -1:] = 0
        ys, xs = np.nonzero(part)
        if not len(xs): continue
        cx = (xs.min() + xs.max() + 1) // 2; cy = (ys.min() + ys.max() + 1) // 2
        base = cv2.seamlessClone(P if P is not None else E, base, part, (int(cx), int(cy)), cv2.NORMAL_CLONE)
        if area >= MIN_AREA * S.shape[0] * S.shape[1]:
            hh, ww = S.shape[:2]
            revealed.append({"box": [round(x / ww, 3), round(y / hh, 3), round((x + bw) / ww, 3), round((y + bh) / hh, 3)],
                             "area_pct": round(100 * area / (ww * hh), 2), "source": "plate" if P is not None else "edit"})
    # New setup (the start is the empty-room plate, nobody in it): the image model often moves or resizes the furniture
    # a character sits or leans on. Pasting the characters onto the plate's furniture then leaves them hovering in front
    # of a sofa that is somewhere else (2026-11-16 live, job 4954a1b8: both seated, the plate's sofa larger and higher
    # than the edit's; the check said "unchanged"). Measured in a band around the characters (LAB diff > 18): 5.1 %
    # differs there vs 1.3 % for a standing new setup that composed cleanly (job 8dcf8b15) - two cases only, so the
    # 3 % line is a first guess. Above it the whole frame is the edit as drawn, and it is FLAGged for a person to compare
    # the room with the location. Not for repositions (people in the start): there moved props are restored from it.
    furniture_moved = False
    unexplained = []
    if _CFG["unfindable"]:
        # the checker cannot outline these cast members, so pasting "characters only" would drop or freeze them
        chars_end = np.full(chars_end.shape, 255, np.uint8)
    photo_room = None
    if not bs and _CFG["look"] == "photoreal":
        # Photoreal new setup (2026-11-17 live, Kijan living room): image models re-render every surface of a photo (rug
        # weave, shutters, grain), so a pixel comparison with the plate marks the whole room as changed although nothing
        # moved (Nano Banana 2 after alignment: 0.9 % of a 96-px colour-corrected picture differs by > 20; the pixel check
        # had drawn 9 red boxes). Photoreal compares the room coarsely instead, and keeps the image model's picture as
        # drawn: its people sit on the furniture with their own shadows and contact, which a cut-and-paste loses.
        photo_room = photo_room_diff(S, E, me)
        chars_end = np.full(chars_end.shape, 255, np.uint8)
    elif not bs:
        band = (cv2.dilate(me, np.ones((kg * 3, kg * 3), np.uint8)) > 0) & (cv2.dilate(me, np.ones((kg, kg), np.uint8)) == 0)
        furniture_moved = bool(band.any()) and float((_diff(S, E)[band] > FURNITURE_DIFF).mean()) > FURNITURE_BAND
        # 2026-11-16 live (job 0a3a685e): the detector found King but not Layana, so only King was pasted onto the plate
        # and Layana vanished except one leg. With an empty room as the start, everything the edit added shows as a
        # difference from it: large differences outside the characters found are a missed character or a room change.
        # Either way the plate composite cannot be trusted, so the edit is used as drawn and those areas are FLAGged.
        hh, ww = S.shape[:2]
        dd = (_diff(S, E) > THR).astype(np.uint8)
        dd[cv2.dilate(me, np.ones((kg, kg), np.uint8)) > 0] = 0
        dd = cv2.morphologyEx(dd, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        dd = cv2.morphologyEx(dd, cv2.MORPH_CLOSE, np.ones((kg, kg), np.uint8))
        n_, _, st_, _ = cv2.connectedComponentsWithStats(dd)
        for i in range(1, n_):
            x, y, bw, bh, area = st_[i]
            if area >= UNEXPLAINED_MIN * hh * ww:
                unexplained.append({"box": [round(x / ww, 3), round(y / hh, 3), round((x + bw) / ww, 3), round((y + bh) / hh, 3)],
                                    "area_pct": round(100 * area / (ww * hh), 2)})
        if furniture_moved or unexplained:
            chars_end = np.full(chars_end.shape, 255, np.uint8)
    as_drawn = bool(_CFG["unfindable"]) or furniture_moved or bool(unexplained) or photo_room is not None
    take = cv2.GaussianBlur(chars_end.astype(np.float32) / 255, (0, 0), feather)[..., None]
    out = (E.astype(np.float32) * take + base.astype(np.float32) * (1 - take)).round().astype(np.uint8)
    # Characters found in the edit but not in the composed frame (the detector is not stable on cartoon children):
    # protected from the repair pass and the check, which would otherwise treat them as room drift and paint the room
    # back over them (2026-11-16 live, job 0a3a685e: the detector called Layana a teddy bear in the edit and missed her
    # in the composed frame). Only character-sized parts (MISSED_MIN): a small prop the matting took along with a
    # character is still repaired (S3_end_watch).
    mo0, _, _ = char_mask(out)
    left = ((me > 0) & (cv2.dilate(mo0, np.ones((k, k), np.uint8)) == 0)).astype(np.uint8)
    missed = np.zeros(me.shape, np.uint8)
    nm, labm, stm, _ = cv2.connectedComponentsWithStats(left)
    for i in range(1, nm):
        if stm[i, 4] >= MISSED_MIN * me.size:      # a character-sized part; small props stay repairable
            missed[labm == i] = 255
    # Repair pass: the matting can take a prop that touches a character as part of her (2026-11-12, S3_end_watch:
    # the ring stacker and a block beside Layana's arm came from the edit, still moved). What the check then finds
    # outside the characters of the composed frame is restored from the start still, and it is checked again.
    for _ in range(2):
        res = check(S, out, known=missed)
        if res["verdict"] == "PASS": break
        h, w = S.shape[:2]
        mo, _, _ = char_mask(out)
        fix = np.zeros((h, w), np.uint8)
        for d in res["drift"]:
            x0, y0, x1, y1 = [int(v * s) for v, s in zip(d["box"], (w, h, w, h))]
            fix[y0:y1, x0:x1] = 255
        fix[cv2.dilate(mo, np.ones((3, 3), np.uint8)) > 0] = 0
        fix[missed > 0] = 0
        # never copy start-still pixels where a character stood in the START frame: a drift box that overlaps it
        # pasted King's old shoes back onto the floor (2026-11-13, bake-off S4 GPT Image 2.6 and Seedream)
        fix[cv2.dilate(ms, np.ones((kg, kg), np.uint8)) > 0] = 0
        if as_drawn: break                         # the whole frame is the edit (above)
        a = cv2.GaussianBlur(fix.astype(np.float32) / 255, (0, 0), 1.5)[..., None]
        out = (S.astype(np.float32) * a + out.astype(np.float32) * (1 - a)).round().astype(np.uint8)
    cv2.imwrite(out_path, out)
    res = check(S, out, out_dir, known=missed)
    res["composed"] = out_path
    res["matting"] = matted
    res["revealed"] = revealed
    res["plate_fit"] = None if fit is None else round(fit, 4)
    res["plate_used"] = P is not None
    res["plate_path"] = plate_path
    res["people"] = {"start": len(bs), "end": len(be), "expect": expect}
    redrawn = sum(r["area_pct"] for r in revealed if r["source"] == "edit")
    res["furniture_moved"] = furniture_moved
    if photo_room is not None:
        res["room_diff"] = photo_room
        res["drift"] = photo_room["boxes"]
        moved = photo_room["structure"] < PHOTO_ROOM_CORR
        res["verdict"] = "FLAG" if moved else "PASS"
        if not moved: res["drift"] = []          # re-lit or re-textured, not moved: nothing to box
        # 2026-11-17, Kijan shot 5: GPT kept the camera exactly (scale 1.000, shift < 3 px) and slid the coffee table to
        # make room for two people in front of the fireplace. Say which of the two it is, from the alignment.
        al = res.get("align") or {}
        same_cam = (abs(al.get("scale", 1) - 1) < 0.01 and abs(al.get("dx_px", 0)) < 0.01 * S.shape[1]
                    and abs(al.get("dy_px", 0)) < 0.01 * S.shape[0])
        what = ("the camera matches the location, but furniture or objects were moved" if same_cam
                else "the image model moved or reframed the camera")
        res["why"] = (f"{what} (the room's layout matches the location only {100 * photo_room['structure']:.0f}%; "
                      "red boxes show where the picture differs most): compare it with the location"
                      if moved else "the room's layout matches the location")
        if res["verdict"] == "PASS" and expect and len(be) < expect:
            res["verdict"] = "FLAG"
            res["why"] = f"found {len(be)} of the {expect} characters in the new frame: look closely"
    elif _CFG["unfindable"]:
        res["verdict"] = "FLAG"
        res["why"] = (f"the checker cannot outline {', '.join(_CFG['unfindable'])}, so the picture is used as the image model "
                      "drew it and the room was not compared: check the room and every character yourself")
    elif unexplained:
        res["verdict"] = "FLAG"
        res["drift"] = sorted(unexplained, key=lambda r: -r["area_pct"])
        res["why"] = ("parts of the picture (red boxes) differ from the location's empty room but are not a character the "
                      "check found: a character may have been missed, or the image model changed the room. The picture is "
                      "used as the image model drew it; check the room and every character")
    elif furniture_moved:
        res["verdict"] = "FLAG"
        res["why"] = ("the image model moved the furniture next to the characters, so the room is used as it drew it: "
                      "compare it with the location (sofa, shelf, window) before using it")
    elif expect and len(be) < expect:
        res["verdict"] = "FLAG"
        res["why"] = (f"found {len(be)} of the {expect} characters in the new frame: a character may be cut off or "
                      "patched with the room; look closely")
    elif redrawn >= 100 * REVEAL_FLAG:
        res["verdict"] = "FLAG"
        res["why"] = (f"{redrawn:.0f}% of the picture was redrawn by the image model where the characters used to be "
                      "(dashed boxes): check the room still matches")
    if out_dir:
        json.dump(res, open(os.path.join(out_dir, "end_frame_check.json"), "w"), indent=1)
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check"); c.add_argument("start"); c.add_argument("end"); c.add_argument("--out")
    c.add_argument("--allow", help="x0,y0,x1,y1 fractions: a region the shot means to change")
    p = sub.add_parser("compose"); p.add_argument("start"); p.add_argument("edited"); p.add_argument("out_png"); p.add_argument("--out"); p.add_argument("--plate")
    a = ap.parse_args()
    if a.cmd == "check":
        allow = [float(v) for v in a.allow.split(",")] if a.allow else None
        r = check(a.start, a.end, a.out, allow)
    else:
        r = compose(a.start, a.edited, a.out_png, a.out, plate=a.plate)
    if not r["matting"]:
        print("note: rembg not installed; using character boxes (pip install \"rembg[cpu]\")", file=sys.stderr)
    print(json.dumps(r, indent=1))
    sys.exit(0 if r["verdict"] == "PASS" else 1)


if __name__ == "__main__":
    main()

"""face_id.py - is it still the same person? Face-identity scores against reference pictures. @anlim

From the music videos (Si_M_Te cqa.py, M_Ap_Rete_Mwen QC gate A): score every sampled frame's faces
against each character's reference and flag drops, so a face that morphs, or a cut to a different
person, is caught by numbers and not only by eye.

  python face_id.py TARGET --ref C01=C01_master.png [--ref C04=stranger.png ...] [--fps 2] [--thr 0.363]
                     [--out DIR]
  TARGET is a video or a folder of stills. Each --ref picture should show one face clearly; several
  pictures of one person can be given as --ref C01=a.png --ref C01=b.png (best score is used).

Models (in models/, OpenCV Zoo, Apache-2.0): YuNet face detector and SFace face recognizer.
Score = cosine similarity; 0.363 is OpenCV's suggested "same person" threshold for SFace.

LIMITS - read before trusting it:
- Built and tested on photoreal faces. On cartoon faces the detector may find nothing or the scores
  may not mean "same character" (see the test results in README). Do not use it to pass cartoons.
- A low score can also come from a turned head, motion blur, a small face or a hand over the face;
  the tool lists the times for a person to look at - it does not decide on its own.
"""
import argparse, glob, json, os, subprocess, sys
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")   # hide OpenCV 5 "Targets are not supported" notices
import numpy as np
import cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import probe

MD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
DET = os.path.join(MD, "face_detection_yunet_2023mar.onnx"); REC = os.path.join(MD, "face_recognition_sface_2021dec.onnx")

class Faces:
    def __init__(self, min_score=0.7):
        if not (os.path.exists(DET) and os.path.exists(REC)):
            sys.exit(f"models missing in {MD}: face_detection_yunet_2023mar.onnx and face_recognition_sface_2021dec.onnx "
                     "(github.com/opencv/opencv_zoo, models/face_detection_yunet and models/face_recognition_sface)")
        self.det = cv2.FaceDetectorYN.create(DET, "", (320, 320), min_score, 0.3, 5000)
        self.rec = cv2.FaceRecognizerSF.create(REC, "")
    def find(self, img):
        h, w = img.shape[:2]; s = min(1.0, 1280 / max(h, w))
        im = cv2.resize(img, (int(w * s), int(h * s))) if s < 1 else img
        self.det.setInputSize((im.shape[1], im.shape[0]))
        _, f = self.det.detect(im)
        out = []
        for row in (f if f is not None else []):
            crop = self.rec.alignCrop(im, row); e = self.rec.feature(crop).flatten()
            e = e / (np.linalg.norm(e) + 1e-9)
            x, y, bw, bh = row[:4] / s
            # eye spacing / face-box width: about 0.25-0.45 for faces seen from the front to three-quarter,
            # under 0.2 for profiles and heads seen from behind, whose scores are not reliable
            # (tested 2026-11-10: rear-profile shots of the right man scored 0.14-0.25, as low as a wrong man)
            turned = float(np.linalg.norm(row[6:8] - row[4:6]) / (row[2] + 1e-6)) < 0.2
            # detector confidence: real faces scored 0.90-0.93 on the SuperCool clips; a back of the head (P013)
            # and a tiny background face scored 0.71-0.75. Below 0.85 = not scored, listed with the turned faces.
            turned = turned or float(row[14]) < 0.85
            out.append({"box": [float(x / w), float(y / h), float(bw / w), float(bh / h)], "det": float(row[14]), "emb": e, "turned": turned})
        return out

def samples(target, fps):
    if os.path.isdir(target):
        for p in sorted(glob.glob(os.path.join(target, "*"))):
            if p.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                im = cv2.imread(p)
                if im is not None: yield os.path.basename(p), None, im
        return
    w, h, _, dur = probe(target)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", target, "-vf", f"fps={fps}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    for i in range(n):
        yield f"t{i / fps:.2f}", i / fps, np.frombuffer(raw, np.uint8, w * h * 3, i * w * h * 3).reshape(h, w, 3)

def analyze(target, refs_in, fps=2.0, thr=0.363, min_face=0.04, det_thr=0.7, out=None, log=print, fail_thr=0.25):
    """Library entry point (for the app). refs_in: {"C01": ["a.png", ...], ...}. Returns the report dict:
    "look_at" (faces to check), "usable" False when the model cannot tell the references apart, "error" if a
    reference has no face. `log` gets the human-readable lines (None = silent)."""
    log = log or (lambda *x: None)
    a = argparse.Namespace(target=target, fps=fps, thr=thr, min_face=min_face, det_thr=det_thr, out=out)
    F = Faces(a.det_thr); refs = {}; usable = True
    for name, paths in refs_in.items():
        for path in ([paths] if isinstance(paths, str) else paths):
            im = cv2.imread(path)
            if im is None: return {"target": target, "error": f"cannot read {path}", "look_at": [], "usable": False}
            fs = sorted(F.find(im), key=lambda f: -f["box"][2] * f["box"][3])
            if not fs: return {"target": target, "error": f"no face found in reference {path}", "look_at": [], "usable": False}
            refs.setdefault(name, []).append(fs[0]["emb"])
    names = list(refs)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            x = max(float(np.dot(e1, e2)) for e1 in refs[names[i]] for e2 in refs[names[j]])
            if x > 0.5:
                usable = False
                log(f"WARNING: references {names[i]} and {names[j]} score {x:.2f} against each other - the face model "
                      "does not tell them apart, so its scores mean nothing here (cartoon faces do this: tested 2026-11-10, "
                      "two different cartoon children scored 0.66-0.74, the same child 0.73). Do not use this check for them.")
    rows = []
    for key, t, im in samples(a.target, a.fps):
        fs = [f for f in F.find(im) if f["box"][2] >= a.min_face]
        faces = []
        for f in fs:
            sc = {n: float(max(np.dot(f["emb"], e) for e in es)) for n, es in refs.items()}
            best = max(sc, key=sc.get)
            faces.append({"box": [round(v, 3) for v in f["box"]], "best": best, "score": round(sc[best], 3), "turned": f["turned"],
                          "scores": {n: round(v, 3) for n, v in sc.items()}})
        rows.append({"key": key, "t": t, "faces": faces})
    # report
    problems = []; weak = []; counts = [len(r["faces"]) for r in rows]
    log(f"{len(rows)} samples; faces per sample: min {min(counts) if counts else 0}, max {max(counts) if counts else 0}")
    for n in refs:
        sc = [(r["key"], max((f["scores"][n] for f in r["faces"] if not f["turned"]), default=None)) for r in rows]
        have = [s for _, s in sc if s is not None]
        if not have:
            log(f"  {n}: no face in any sample"); continue
        low = [k for k, s in sc if s is not None and s < a.thr]
        log(f"  {n}: best-face score median {np.median(have):.3f}, min {min(have):.3f}; below {a.thr}: {len(low)} of {len(have)} samples with a face")
    # every face that matches no reference
    for r in rows:
        for f in r["faces"]:
            # Below fail_thr = a different person (the real cases on the judged clips scored 0.10-0.15).
            # Between fail_thr and thr = a weak match, a note: the right man scored 0.33-0.35 on two good clips.
            if f["score"] < fail_thr and not f["turned"]:
                problems.append(f"{r['key']}: a face at x={f['box'][0]:.2f} matches no reference (best {f['best']} {f['score']:.3f})")
            elif f["score"] < a.thr and not f["turned"]:
                weak.append(f"{r['key']}: weak match at x={f['box'][0]:.2f} (best {f['best']} {f['score']:.3f}) - look")
    # sudden change: the main face's best score falls by a lot between neighbouring samples
    prev = None
    for r in rows:
        front = [f for f in r["faces"] if not f["turned"]]
        if front:
            m = max(front, key=lambda f: f["box"][2])
            if prev and prev["best"] == m["best"] and prev["score"] - m["score"] > 0.25 and m["score"] < fail_thr:
                problems.append(f"{r['key']}: the main face's match to {m['best']} drops {prev['score']:.2f} -> {m['score']:.2f} (morph, cut or turn - look)")
            if prev and prev["best"] != m["best"] and min(prev["score"], m["score"]) >= a.thr:
                problems.append(f"{r['key']}: the main face changes from {prev['best']} to {m['best']}")
            prev = m
    turned = [r["key"] for r in rows if any(f["turned"] for f in r["faces"])]
    if turned: log(f"  turned-away or unclear faces (profile, from behind, low detector confidence) not scored at: {', '.join(turned[:12])}{' ...' if len(turned) > 12 else ''} - check those by eye")
    changes = [rows[i]["key"] for i in range(1, len(rows)) if counts[i] != counts[i - 1]]
    log("LOOK AT:" if problems else "no identity problems found by this check")
    for p in problems[:30]: log("  - " + p)
    if len(problems) > 30: log(f"  ... {len(problems) - 30} more in the report")
    if changes: log(f"  face count changes at: {', '.join(changes[:20])}{' ...' if len(changes) > 20 else ''}")
    rep = {"target": a.target, "refs": {n: len(e) for n, e in refs.items()}, "thr": a.thr, "usable": usable,
           "samples": rows, "look_at": problems, "weak": weak, "turned_away": turned, "face_count_changes": changes}
    if a.out:
        os.makedirs(a.out, exist_ok=True)
        json.dump(rep, open(os.path.join(a.out, "face_id.json"), "w"), indent=1)
        log(f"report: {os.path.join(a.out, 'face_id.json')}")
    return rep

# ---------------------------------------------------------------------------------------------------------------
# identity(): does each person keep the face of the APPROVED START FRAME through the clip? (2026-11-17)
# Why: in the app's wide photoreal shots (people full-body, faces 30-50 px in a 1296-1344 px clip) analyze() found no
# face at all - the detector misses faces that small and min_face (4 % of the width) drops them - so face drift went
# unreported (Kijan route test: Londi rejected 4 MiniMax H3 clips for "faces changing, blurry"; the check said nothing).
# Here frames are enlarged to 3840 px before detection, and each person is compared with their own face in the
# approved start frame (same render, same light) rather than only the character card.
# Calibration, Kijan living room 2026-11-17 (12 clips, Londi's labels), per-person median score vs the start frame,
# lowest person per clip (identity(), 2 fps): MiniMax rejects 0.258 / 0.335 / 0.339 / 0.388; Kling approvals 0.402-0.591; one approved MiniMax
# hug 0.353. IDENTITY_THR 0.40 sits in that gap; it is THIN (0.388 vs 0.402).
# SuperCool 55 (photoreal music video, Londi's labels), same code: 21 clips had a face to score; FLAG on 5 of 34 pass
# (P009 0.39, P011 0.37, P026, P027, P043), 1 of 9 minor, 2 of 12 fail (P016_alt, P018 - P018's notes include "a second
# copy of him appears"). So: a FLAG for a person to look at, never a FAIL; most SuperCool fails were not about faces.
IDENTITY_THR = 0.40
IDENTITY_MIN_SEEN = 3          # fewer scored samples than this = "not checked" for that person, said out loud

def _find_big(F, img, up_to=3840):
    h, w = img.shape[:2]; k = up_to / max(h, w)
    im = cv2.resize(img, (int(w * k), int(h * k)), interpolation=cv2.INTER_CUBIC if k > 1 else cv2.INTER_AREA)
    F.det.setInputSize((im.shape[1], im.shape[0])); _, f = F.det.detect(im); out = []
    for row in (f if f is not None else []):
        e = F.rec.feature(F.rec.alignCrop(im, row)).flatten(); e = e / (np.linalg.norm(e) + 1e-9)
        frontal = float(np.linalg.norm(row[6:8] - row[4:6]) / (row[2] + 1e-6)) >= 0.2 and float(row[14]) >= 0.85
        out.append({"x": float(row[0] / im.shape[1]), "w_px": float(row[2] / k), "det": float(row[14]), "frontal": frontal, "emb": e})
    return out

def _assign(faces, refs):
    """Greedy one-face-per-person: the highest (face, person) score first. refs: {name: emb}."""
    pairs = sorted(((float(f["emb"] @ e), i, n) for i, f in enumerate(faces) for n, e in refs.items()), reverse=True)
    used_f, used_n, out = set(), set(), {}
    for sc, i, n in pairs:
        if i in used_f or n in used_n: continue
        used_f.add(i); used_n.add(n); out[n] = (faces[i], sc)
    return out

def identity(clip, refs_in, start_frame=None, fps=2.0, thr=IDENTITY_THR, log=None):
    """{"people": {name: {"median", "min", "seen", "samples", "against"}}, "drift": [msgs], "unchecked": [msgs], "error"?}"""
    log = log or (lambda *x: None)
    F = Faces(0.7); card = {}
    for name, paths in refs_in.items():
        for path in ([paths] if isinstance(paths, str) else paths):
            im = cv2.imread(path)
            fs = sorted(_find_big(F, im, 1280), key=lambda f: -f["w_px"]) if im is not None else []
            if fs: card[name] = fs[0]["emb"]; break
    if not card: return {"error": "no face found in any reference", "people": {}, "drift": [], "unchecked": []}
    if len(card) > 1 and max(float(card[a] @ card[b]) for a in card for b in card if a < b) > 0.5:
        return {"error": "the face model cannot tell these references apart (cartoon?)", "people": {}, "drift": [], "unchecked": []}
    base = dict(card); against = {n: "card" for n in card}
    sf = cv2.imread(start_frame) if start_frame else None
    if sf is not None:
        for n, (f, sc) in _assign([f for f in _find_big(F, sf) if f["frontal"]], card).items():
            if sc >= 0.3: base[n] = f["emb"]; against[n] = "start frame"     # below 0.3 the start face is not clearly them
    # Scored only against the start frame: against the card alone, good SuperCool clips scored -0.00 to 0.18
    # (stylised grade, card drawn differently), i.e. noise. No clear start face = "not checked", said out loud.
    scores = {n: [] for n in card}; samples = 0
    for key, t, im in samples_iter(clip, fps):
        samples += 1
        for n, (f, sc) in _assign([f for f in _find_big(F, im) if f["frontal"]], base).items():
            if against[n] == "start frame": scores[n].append(sc)
    rep = {"people": {}, "drift": [], "unchecked": [], "thr": thr}
    for n, v in scores.items():
        p = {"seen": len(v), "samples": samples, "against": against[n]}
        if len(v) >= IDENTITY_MIN_SEEN:
            p["median"] = round(float(np.median(v)), 3); p["min"] = round(float(min(v)), 3)
            if p["median"] < thr:
                rep["drift"].append(f"{n}'s face no longer matches the {against[n]} - changed or blurred (match {p['median']:.2f}, below {thr}): look at their face")
        elif against[n] != "start frame":
            rep["unchecked"].append(f"{n}'s face is not clear in the approved start frame: identity not checked")
        else:
            rep["unchecked"].append(f"{n}'s face was too small, turned away or hidden in {samples - len(v)} of {samples} samples: identity not checked")
        rep["people"][n] = p
    log(f"identity: {rep['people']}")
    return rep

def samples_iter(target, fps):
    yield from samples(target, fps)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target"); ap.add_argument("--ref", action="append", required=True)
    ap.add_argument("--fps", type=float, default=2); ap.add_argument("--thr", type=float, default=0.363)
    ap.add_argument("--min-face", type=float, default=0.04, help="ignore faces narrower than this fraction of the frame")
    ap.add_argument("--det-thr", type=float, default=0.7, help="face detector confidence (0.5 finds more drawn faces)")
    ap.add_argument("--out")
    a = ap.parse_args(); refs = {}
    for r in a.ref:
        n, pth = r.split("=", 1); refs.setdefault(n, []).append(pth)
    rep = analyze(a.target, refs, a.fps, a.thr, a.min_face, a.det_thr, a.out)
    if rep.get("error"): sys.exit(rep["error"])

if __name__ == "__main__":
    main()

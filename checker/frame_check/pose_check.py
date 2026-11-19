"""pose_check.py - body keypoints for EVERY person in a frame (top-down: find each person, then pose
each one on its own crop). @anlim

Why top-down: the earlier single-person test (2026-11-10) picked one person per frame, gave one
person's limbs to another in contact shots, and invented a body on a legs-only frame. Here each person
box from the YOLOX detector (objects_check.py) gets its own pose, so a limb can only belong to the
person whose box it is in.

  python pose_check.py IMAGE_OR_CLIP [--out DIR] [--fps 2]
  in code: pose_check.poses(bgr_image) -> [{"box", "score", "kp": {name: [x, y, visibility]}, ...}]

Per person it derives (fractions of the image):
  height_px  nose -> midpoint of the ankles (when both are visible), the automatic counterpart of the
             head-top clicks in measure.py (nose, not hair top: compare like with like)
  shoulder_w shoulder to shoulder; build = shoulder_w / height_px
  facing     "camera" when both eyes and both shoulders are visible and the nose sits between the
             shoulders; "away" when neither eye is visible; "side" otherwise
Model: OpenCV Zoo pose_estimation_mediapipe_2023mar.onnx (BlazePose, Apache-2.0), run without its own
person detector or rotation: people lying down or upside down are not handled.
"""
import argparse, json, os, subprocess, sys
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")   # hide OpenCV 5 "Targets are not supported" notices
import numpy as np
import cv2
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import objects_check

NAMES = ["nose", "l_eye_in", "l_eye", "l_eye_out", "r_eye_in", "r_eye", "r_eye_out", "l_ear", "r_ear", "mouth_l", "mouth_r",
         "l_shoulder", "r_shoulder", "l_elbow", "r_elbow", "l_wrist", "r_wrist", "l_pinky", "r_pinky", "l_index", "r_index",
         "l_thumb", "r_thumb", "l_hip", "r_hip", "l_knee", "r_knee", "l_ankle", "r_ankle", "l_heel", "r_heel", "l_foot", "r_foot"]
EDGES = [("l_shoulder", "r_shoulder"), ("l_shoulder", "l_elbow"), ("l_elbow", "l_wrist"), ("r_shoulder", "r_elbow"),
         ("r_elbow", "r_wrist"), ("l_shoulder", "l_hip"), ("r_shoulder", "r_hip"), ("l_hip", "r_hip"), ("l_hip", "l_knee"),
         ("l_knee", "l_ankle"), ("r_hip", "r_knee"), ("r_knee", "r_ankle"), ("nose", "l_eye"), ("nose", "r_eye")]
MODEL = os.path.join(HERE, "models", "pose_estimation_mediapipe_2023mar.onnx")
_net = None; _det = None
VIS = 0.5

def _pose_crop(img, box):
    global _net
    if _net is None: _net = cv2.dnn.readNet(MODEL)
    H, W = img.shape[:2]; x, y, w, h = box[0] * W, box[1] * H, box[2] * W, box[3] * H
    side = max(w, h) * 1.25; cx, cy = x + w / 2, y + h / 2; x0, y0 = int(cx - side / 2), int(cy - side / 2); s = int(side)
    big = cv2.copyMakeBorder(img, s, s, s, s, cv2.BORDER_CONSTANT, value=0)   # pad so any crop fits
    crop = big[y0 + s: y0 + 2 * s, x0 + s: x0 + 2 * s]
    blob = cv2.cvtColor(cv2.resize(crop, (256, 256), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    _net.setInput(blob[None]); out = _net.forward(_net.getUnconnectedOutLayersNames())
    lm, conf = out[0], out[1]
    lm = lm[0].reshape(-1, 5)[:33].copy(); lm[:, 3:] = 1 / (1 + np.exp(-lm[:, 3:]))
    kp = {}
    for n, r in zip(NAMES, lm):
        kp[n] = [round(float((x0 + r[0] * s / 256) / W), 4), round(float((y0 + r[1] * s / 256) / H), 4), round(float(min(r[3], r[4])), 3)]
    return kp, float(np.asarray(conf).flatten()[0])

def derive(kp, W, H):
    v = lambda n: kp[n][2] >= VIS
    P = lambda n: np.array([kp[n][0] * W, kp[n][1] * H])
    d = {}
    if v("nose") and v("l_ankle") and v("r_ankle"): d["height_px"] = round(float(np.linalg.norm(P("nose") - (P("l_ankle") + P("r_ankle")) / 2)), 1)
    if v("l_shoulder") and v("r_shoulder"):
        d["shoulder_w"] = round(float(np.linalg.norm(P("l_shoulder") - P("r_shoulder"))), 1)
        if "height_px" in d: d["build"] = round(d["shoulder_w"] / d["height_px"], 3)
    # head direction from the nose between the ears: centred = facing the camera. The first version
    # (eyes + shoulders visible) called a woman turned three-quarters to the man beside her "camera".
    if v("l_ear") and v("r_ear") and v("nose"):
        ex = sorted([kp["l_ear"][0], kp["r_ear"][0]]); span = ex[1] - ex[0]
        off = (kp["nose"][0] - (ex[0] + ex[1]) / 2) / (span + 1e-6)
        d["head_turn"] = round(float(off), 2)            # 0 = straight at the camera, +-0.5 = at an ear
        d["facing"] = "camera" if abs(off) < 0.15 else "side"
    elif not (v("l_eye") or v("r_eye")): d["facing"] = "away"
    else: d["facing"] = "side"
    return d

def poses(bgr, min_conf=0.5):
    global _det
    if _det is None: _det = objects_check.Detector(0.4)
    H, W = bgr.shape[:2]; out = []
    for d in _det.detect(bgr):
        if d["cls"] != "person": continue
        kp, c = _pose_crop(bgr, d["box"])
        if c < min_conf: continue
        out.append({"box": d["box"], "score": d["score"], "pose_conf": round(c, 3), "kp": kp, **derive(kp, W, H)})
    return sorted(out, key=lambda p: p["box"][0])

def draw(bgr, ps):
    im = bgr.copy(); H, W = im.shape[:2]; t = max(2, W // 400)
    cols = [(80, 80, 255), (255, 180, 60), (60, 220, 255), (120, 220, 120), (220, 120, 220), (0, 160, 255)]
    for i, p in enumerate(ps):
        c = cols[i % len(cols)]; k = p["kp"]
        x, y, w, h = p["box"]; cv2.rectangle(im, (int(x * W), int(y * H)), (int((x + w) * W), int((y + h) * H)), c, 1)
        for a, b in EDGES:
            if k[a][2] >= VIS and k[b][2] >= VIS:
                cv2.line(im, (int(k[a][0] * W), int(k[a][1] * H)), (int(k[b][0] * W), int(k[b][1] * H)), c, t)
        lab = f"P{i + 1} {p.get('facing', '')} h={p.get('height_px', '-')}"
        cv2.putText(im, lab, (int(x * W), max(20, int(y * H) - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5 * t, c, t)
    return im

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("src"); ap.add_argument("--out"); ap.add_argument("--fps", type=float, default=2)
    a = ap.parse_args(); out = a.out or os.path.splitext(a.src)[0] + "_pose"; os.makedirs(out, exist_ok=True)
    if a.src.lower().endswith((".png", ".jpg", ".jpeg")):
        items = [("img", cv2.imread(a.src))]
    else:
        items = [(f"t{t:.2f}", im) for t, im in objects_check.samples(a.src, a.fps)]
    res = []
    for key, im in items:
        ps = poses(im); res.append({"key": key, "people": [{k: v for k, v in p.items() if k != "kp"} for p in ps]})
        cv2.imwrite(os.path.join(out, f"{key}_pose.jpg"), draw(im, ps), [cv2.IMWRITE_JPEG_QUALITY, 90])
        print(key, [(p.get("facing"), p.get("height_px"), p.get("build")) for p in ps])
    json.dump(res, open(os.path.join(out, "pose.json"), "w"), indent=1)

if __name__ == "__main__":
    main()

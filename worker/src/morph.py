#!/usr/bin/env python3
"""Morph one still into another (2026-11-27, Londi: "can we build a morph effect?" - approach 1, built in the worker).

Made for "real you -> cartoon you" (or back): the two pictures show the same person in the same pose and framing (the second
one is a redraw of the first in the other look). The morph has two layers:
  1. Face warp: MediaPipe face landmarks on both pictures; the frame is cut into triangles between the points (plus fixed
     points around the border) and every triangle moves step by step from its place in A to its place in B, while A and B
     are both warped to that in-between shape.
  2. Reveal: B shows through A along a soft, noisy wave that sweeps across the frame, with a light glow on the wave's edge.
If a face is not found in either picture the warp is skipped and only the reveal runs (printed as "warp": false).

usage: morph.py A.png B.png out.mp4 [--seconds 1.2] [--hold 0.4] [--fps 30] [--dir lr|rl|tb|bt|center] [--glow 0.6] [--seed 7]
       morph.py A.mp4 B.mp4 out.mp4 --video [--fps 24] ...
prints {"frames", "warp", "points", "w", "h"} as JSON. Output: H.264 yuv420p, even size, no audio. @anlim

--video (2026-11-27, the cut's "morph" transition, worker assemble.js joinPart): A and B are two clips of the same
length (the end of one shot running past the change, and the start of the next with its first frame held before it).
Frame i of the output morphs A's frame i into B's frame i, the morph running from 0 to 1 over the whole length, so the
people keep moving while they change. The face points are found once, on the frames at the middle (the change itself).
"""
import argparse, json, os, subprocess, sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_CANDIDATES = [os.path.join(HERE, "..", "..", "checker", "frame_check", "models", "face_landmarker.task"),
                    "/app/checker/frame_check/models/face_landmarker.task"]


YUNET_CANDIDATES = [os.path.join(HERE, "..", "..", "checker", "frame_check", "models", "face_detection_yunet_2023mar.onnx"),
                    "/app/checker/frame_check/models/face_detection_yunet_2023mar.onnx"]


def _landmarks(img_rgb):
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mpt
        from mediapipe.tasks.python import vision
    except Exception:
        return None
    model = next((p for p in MODEL_CANDIDATES if os.path.exists(p)), None)
    if not model:
        return None
    opts = vision.FaceLandmarkerOptions(base_options=mpt.BaseOptions(model_asset_path=model), num_faces=1,
                                        min_face_detection_confidence=0.3, min_face_presence_confidence=0.3)
    with vision.FaceLandmarker.create_from_options(opts) as det:
        res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(img_rgb)))
    if not res.face_landmarks:
        return None
    h, w = img_rgb.shape[:2]
    return np.array([[p.x * w, p.y * h] for p in res.face_landmarks[0]], np.float32)


def face_points(img_rgb):
    """478 face landmarks in pixels, or None. A face that is small in the frame (a person standing in a room) is missed
    by the landmarker on the whole picture, so the face is first found with YuNet, cropped with a margin, enlarged to
    512 px and the landmarks are mapped back."""
    p = _landmarks(img_rgb)
    if p is not None:
        return p
    yn = next((m for m in YUNET_CANDIDATES if os.path.exists(m)), None)
    if not yn:
        return None
    h, w = img_rgb.shape[:2]
    det = cv2.FaceDetectorYN.create(yn, "", (w, h), 0.5)
    _, faces = det.detect(cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR))
    if faces is None or not len(faces):
        return None
    x, y, fw, fh = max(faces[:, :4].tolist(), key=lambda f: f[2] * f[3])
    cx, cy, side = x + fw / 2, y + fh / 2, max(fw, fh) * 2.0
    x0, y0 = int(max(cx - side / 2, 0)), int(max(cy - side / 2, 0))
    x1, y1 = int(min(cx + side / 2, w)), int(min(cy + side / 2, h))
    crop = img_rgb[y0:y1, x0:x1]
    s = 512.0 / max(crop.shape[:2])
    big = cv2.resize(crop, (int(crop.shape[1] * s), int(crop.shape[0] * s)), interpolation=cv2.INTER_CUBIC)
    q = _landmarks(big)
    if q is None:
        return None
    return q / s + np.float32([x0, y0])


def border_points(w, h, n=6):
    xs = np.linspace(0, w - 1, n)
    ys = np.linspace(0, h - 1, n * 2)
    pts = [(x, 0) for x in xs] + [(x, h - 1) for x in xs] + [(0, y) for y in ys[1:-1]] + [(w - 1, y) for y in ys[1:-1]]
    return np.array(pts, np.float32)


def triangles(pts, w, h):
    sub = cv2.Subdiv2D((0, 0, w, h))
    for p in pts:
        sub.insert((float(min(max(p[0], 0), w - 1)), float(min(max(p[1], 0), h - 1))))
    idx = {}
    for i, p in enumerate(pts):
        idx[(round(float(min(max(p[0], 0), w - 1)), 1), round(float(min(max(p[1], 0), h - 1)), 1))] = i
    tris = []
    for t in sub.getTriangleList():
        v = [(round(float(t[0]), 1), round(float(t[1]), 1)), (round(float(t[2]), 1), round(float(t[3]), 1)),
             (round(float(t[4]), 1), round(float(t[5]), 1))]
        if all(k in idx for k in v):
            tris.append([idx[k] for k in v])
    return tris


def warp(img, src, dst, tris):
    out = np.zeros_like(img)
    h, w = img.shape[:2]
    for a, b, c in tris:
        s = np.float32([src[a], src[b], src[c]])
        d = np.float32([dst[a], dst[b], dst[c]])
        x, y, bw, bh = cv2.boundingRect(d)
        x0, y0 = max(x, 0), max(y, 0)
        x1, y1 = min(x + bw, w), min(y + bh, h)
        if x1 <= x0 or y1 <= y0:
            continue
        m = cv2.getAffineTransform(s, d - np.float32([x0, y0]))
        patch = cv2.warpAffine(img, m, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
        mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillConvexPoly(mask, np.int32(np.round(d - np.float32([x0, y0]))), 255, cv2.LINE_AA)
        mk = (mask.astype(np.float32) / 255.0)[..., None]
        region = out[y0:y1, x0:x1].astype(np.float32)
        out[y0:y1, x0:x1] = (region * (1 - mk) + patch.astype(np.float32) * mk).astype(np.uint8)
    return out


def reveal_field(w, h, direction, seed):
    """0..1 field: the order in which pixels turn (low first). A sweep plus soft noise so the edge is organic."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    if direction == "rl":
        base = 1 - xx / w
    elif direction == "tb":
        base = yy / h
    elif direction == "bt":
        base = 1 - yy / h
    elif direction == "center":
        base = np.hypot(xx - w / 2, yy - h / 2) / np.hypot(w / 2, h / 2)
    else:
        base = xx / w
    noise = np.zeros((h, w), np.float32)
    for scale, amp in ((8, 0.5), (24, 0.3), (64, 0.2)):
        small = rng.random((max(2, h // (h // scale + 1)), max(2, w // (w // scale + 1)))).astype(np.float32)
        noise += cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC) * amp
    noise = (noise - noise.min()) / (noise.max() - noise.min() + 1e-6)
    f = base * 0.75 + noise * 0.25
    return (f - f.min()) / (f.max() - f.min() + 1e-6)


def ease(t):
    return t * t * (3 - 2 * t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a"); ap.add_argument("b"); ap.add_argument("out")
    ap.add_argument("--seconds", type=float, default=1.2)
    ap.add_argument("--hold", type=float, default=0.4)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--dir", default="lr", choices=["lr", "rl", "tb", "bt", "center"])
    ap.add_argument("--glow", type=float, default=0.4)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--no-warp", action="store_true")
    ap.add_argument("--video", action="store_true")
    a = ap.parse_args()
    if a.video:
        return main_video(a)

    A = cv2.imread(a.a, cv2.IMREAD_COLOR)
    B = cv2.imread(a.b, cv2.IMREAD_COLOR)
    if A is None or B is None:
        sys.exit("cannot read the two pictures")
    h, w = A.shape[:2]
    w2, h2 = w - w % 2, h - h % 2
    A = A[:h2, :w2]
    B = cv2.resize(B, (w2, h2), interpolation=cv2.INTER_AREA)
    w, h = w2, h2

    pa = pb = None
    if not a.no_warp:
        pa = face_points(cv2.cvtColor(A, cv2.COLOR_BGR2RGB))
        pb = face_points(cv2.cvtColor(B, cv2.COLOR_BGR2RGB))
    use_warp = pa is not None and pb is not None
    if use_warp:
        keep = np.arange(0, 468, 6)  # a spread of the 468 mesh points (the iris points are left out)
        pa, pb = pa[keep], pb[keep]
        border = border_points(w, h)
        pa = np.vstack([pa, border]); pb = np.vstack([pb, border])
        tris = triangles((pa + pb) / 2, w, h)

    field = reveal_field(w, h, a.dir, a.seed)
    soft = 0.3
    n_morph = max(2, int(round(a.seconds * a.fps)))
    n_hold = int(round(a.hold * a.fps))

    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(a.fps),
                           "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", a.out],
                          stdin=subprocess.PIPE)
    frames = 0
    for _ in range(n_hold):
        ff.stdin.write(A.tobytes()); frames += 1
    for i in range(n_morph):
        t = i / (n_morph - 1)
        tw = ease(t)
        if use_warp:
            mid = pa * (1 - tw) + pb * tw
            wa = warp(A, pa, mid, tris)
            wb = warp(B, pb, mid, tris)
        else:
            wa, wb = A, B
        # the wave front moves from before the frame to past it
        front = -soft + t * (1 + 2 * soft)
        m = ease(np.clip((front - field) / soft + 0.5, 0, 1))
        if use_warp:
            # the face changes gradually over the whole morph (the warp is what the eye follows), not with the wave
            fm = np.zeros((h, w), np.float32)
            cv2.fillConvexPoly(fm, np.int32(cv2.convexHull(mid[:-len(border)])), 1.0, cv2.LINE_AA)
            k = int(max(w, h) * 0.03) | 1
            fm = cv2.GaussianBlur(fm, (k, k), 0)
            m = m * (1 - fm) + tw * fm
        m = m[..., None]
        img = wa.astype(np.float32) * (1 - m) + wb.astype(np.float32) * m
        if a.glow > 0:
            edge = (4 * m * (1 - m)) ** 2
            img = img + edge * 255 * a.glow
        frame = np.clip(img, 0, 255).astype(np.uint8)
        ff.stdin.write(frame.tobytes()); frames += 1
    for _ in range(n_hold):
        ff.stdin.write(B.tobytes()); frames += 1
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ffmpeg failed")
    print(json.dumps({"frames": frames, "warp": bool(use_warp), "points": int(len(pa)) if use_warp else 0, "w": w, "h": h}))


def read_frames(path, limit=600):
    cap = cv2.VideoCapture(path)
    out = []
    while len(out) < limit:
        ok, f = cap.read()
        if not ok:
            break
        out.append(f)
    cap.release()
    return out


def main_video(a):
    FA, FB = read_frames(a.a), read_frames(a.b)
    n = min(len(FA), len(FB))
    if n < 2:
        sys.exit("the two clips need at least 2 frames each")
    h, w = FA[0].shape[:2]
    w, h = w - w % 2, h - h % 2
    FA = [f[:h, :w] for f in FA[:n]]
    FB = [cv2.resize(f, (w, h), interpolation=cv2.INTER_AREA) for f in FB[:n]]
    mid = n // 2
    pa = pb = None
    if not a.no_warp:
        pa = face_points(cv2.cvtColor(FA[max(0, mid - 1)], cv2.COLOR_BGR2RGB))
        pb = face_points(cv2.cvtColor(FB[mid], cv2.COLOR_BGR2RGB))
    use_warp = pa is not None and pb is not None
    why = None if use_warp else "no face on both sides"
    if use_warp:
        # two shots of different framing (a big profile into a small face across the room) tear the whole picture when
        # warped into each other (tested 2026-11-27): the warp only runs when the faces are of a like size and place
        ca, cb = pa[:468].mean(0), pb[:468].mean(0)
        sa, sb = np.ptp(pa[:468], 0).max(), np.ptp(pb[:468], 0).max()
        if np.hypot(*(ca - cb)) > 0.2 * max(w, h) or max(sa, sb) > 1.6 * max(1.0, min(sa, sb)):
            use_warp, why = False, "the faces are of a different size or place"
    if use_warp:
        keep = np.arange(0, 468, 6)
        pa, pb = pa[keep], pb[keep]
        border = border_points(w, h)
        pa = np.vstack([pa, border]); pb = np.vstack([pb, border])
        tris = triangles((pa + pb) / 2, w, h)
    field = reveal_field(w, h, a.dir, a.seed)
    soft = 0.3
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(a.fps),
                           "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", a.out],
                          stdin=subprocess.PIPE)
    for i in range(n):
        t = i / (n - 1)
        tw = ease(t)
        A, B = FA[i], FB[i]
        if use_warp:
            midp = pa * (1 - tw) + pb * tw
            wa = warp(A, pa, midp, tris)
            wb = warp(B, pb, midp, tris)
        else:
            wa, wb = A, B
        front = -soft + t * (1 + 2 * soft)
        m = ease(np.clip((front - field) / soft + 0.5, 0, 1))
        if use_warp:
            fm = np.zeros((h, w), np.float32)
            cv2.fillConvexPoly(fm, np.int32(cv2.convexHull(midp[:-len(border)])), 1.0, cv2.LINE_AA)
            k = int(max(w, h) * 0.03) | 1
            fm = cv2.GaussianBlur(fm, (k, k), 0)
            m = m * (1 - fm) + tw * fm
        m = m[..., None]
        img = wa.astype(np.float32) * (1 - m) + wb.astype(np.float32) * m
        if a.glow > 0:
            img = img + ((4 * m * (1 - m)) ** 2) * 255 * a.glow
        ff.stdin.write(np.clip(img, 0, 255).astype(np.uint8).tobytes())
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ffmpeg failed")
    print(json.dumps({"frames": n, "warp": bool(use_warp), "why": why, "points": int(len(pa)) if use_warp else 0, "w": w, "h": h}))


if __name__ == "__main__":
    main()

"""crowd_still.py - is a crowd shot's background frozen? @anlim

Why (2026-11-24 crowd tests, Londi): 2 of 3 crowd clips came out with the crowd frozen like a painted backdrop. The
frame review passed the frozen classroom: no rule looks at time. This measures it. The camera move is estimated
from tracked points and cancelled; then each of 24 regions (4 x 6) is compared with the first frame, and the
largest change it ever reaches is kept. A crowd that lives moves away from its first frame; a frozen one does not.

Measured only when the camera is still (under STILL_PX after alignment): a tracking camera cannot be aligned over
a whole clip (both market clips: 369-505 px), so the result says "not measured" and the action check (which
describes what the crowd does) is the only judge.
Calibration, 2026-11-24, two still-camera classroom clips only (a first guess, not a benchmark):
  frozen class  : 96% of regions under 3 (only the teacher's regions moved) -> FLAG
  living class  : 38% under 3 (students lean, turn, gesture)                -> no flag
  stadium round 2 (camera 1.5 px): 25% under 3                              -> no flag

  python crowd_still.py CLIP.mp4
  in code: crowd_still.analyze(clip) -> {"measured", "camera_px", "still_share", "frozen", "why"}
"""
import sys

STEP_S, MAX_S, GRID = 0.25, 6.0, (4, 6)
STILL_PX = 3.0          # camera move (px at 640 wide, incl. zoom) under which the clip can be measured
CHANGE = 3.0            # a region whose change from the first frame never reaches this stayed as it was
FROZEN_SHARE = 0.75     # this share of regions unchanged = a frozen background

def analyze(clip):
    import cv2, numpy as np
    cap = cv2.VideoCapture(clip); fps = cap.get(cv2.CAP_PROP_FPS) or 24; step = max(1, round(fps * STEP_S))
    frames, i = [], 0
    while True:
        ok, f = cap.read()
        if not ok or i / fps > MAX_S: break
        if i % step == 0:
            g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY); h, w = g.shape
            frames.append(cv2.GaussianBlur(cv2.resize(g, (640, int(h * 640 / w))), (3, 3), 0))
        i += 1
    cap.release()
    if len(frames) < 4: return {"measured": False, "why": "too few frames to measure"}
    ref = frames[0]; p0 = cv2.goodFeaturesToTrack(ref, 400, 0.01, 8)
    if p0 is None or len(p0) < 12: return {"measured": False, "why": "too little detail to track the camera"}
    out, move = [], 0.0
    for b in frames[1:]:
        p1, st, _ = cv2.calcOpticalFlowPyrLK(ref, b, p0, None); ok = st.ravel() == 1
        M = None
        if ok.sum() >= 12: M, _ = cv2.estimateAffinePartial2D(p0[ok], p1[ok], method=cv2.RANSAC, ransacReprojThreshold=2.0)
        if M is None: return {"measured": False, "why": "the camera move could not be tracked"}
        move = max(move, float(np.hypot(M[0, 2], M[1, 2])) + abs(float(np.hypot(M[0, 0], M[1, 0])) - 1) * 640)
        if move > STILL_PX:
            return {"measured": False, "camera_px": round(move, 1), "why": "the camera moves, so the background cannot be compared over the clip"}
        wa = cv2.warpAffine(ref, M, (ref.shape[1], ref.shape[0]), borderMode=cv2.BORDER_REPLICATE)
        d = cv2.absdiff(wa, b).astype(np.float32)[20:-20, 20:-20]; H, W = d.shape
        out.append([[float(d[r * H // GRID[0]:(r + 1) * H // GRID[0], c * W // GRID[1]:(c + 1) * W // GRID[1]].mean())
                     for c in range(GRID[1])] for r in range(GRID[0])])
    cells = np.array(out).max(axis=0)
    share = float((cells < CHANGE).mean()); n = int((cells < CHANGE).sum())
    frozen = share >= FROZEN_SHARE
    return {"measured": True, "camera_px": round(move, 1), "still_share": round(share, 2), "frozen": frozen,
            "regions": cells.round(1).tolist(),
            "why": (f"CROWD STILL: {n} of {cells.size} parts of the picture never change from the first frame; "
                    "the crowd may be frozen like a painted backdrop") if frozen else None}

if __name__ == "__main__":
    for c in sys.argv[1:]:
        r = analyze(c); r.pop("regions", None); print(c, r)

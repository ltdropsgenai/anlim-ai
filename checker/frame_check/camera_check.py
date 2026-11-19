"""camera_check.py - does the camera do what the shot spec says? @anlim

From the music-video QC gate D (Camera): the move must match the spec (locked, push-in, pan...),
fixed objects stay rigid, no surprise zoom or drift in a "locked" shot.

  python camera_check.py CLIP.mp4 [--expect locked|push-in|pull-out|pan-left|pan-right|tilt-up|tilt-down|any]
                         [--fps 6] [--start S] [--end S]
  --expect can join moves with + (push-in+pan-left).

How: samples frames, matches background corners (from the frame's outer band first, where the
set usually is, falling back to the whole frame when the band has too little detail) between neighbouring samples (ORB + RANSAC,
which ignores points that move on their own, like a walking character) and chains the result
into the camera's zoom, sideways/vertical travel and roll from the first frame. Directions are
the CAMERA's: the picture content moving left means the camera pans right.

Limits: a character filling most of the frame can be read as camera motion; a big change between
samples (a cut, a whip pan) breaks the chain and is reported. Steps where few points agree are
listed: in a locked shot that means the background itself changed (warping walls, a redrawn room)
or the view is hidden - look at those times.
"""
import argparse, json, math, os, subprocess, sys
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")   # hide OpenCV 5 "Targets are not supported" notices
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import probe

W = 640

def frames(p, fps, start, end):
    w, h, _, dur = probe(p); hh = int(round(h * W / w / 2)) * 2
    args = ["ffmpeg", "-v", "error"]
    if start: args += ["-ss", str(start)]
    args += ["-i", p]
    if end: args += ["-t", str(end - (start or 0))]
    args += ["-vf", f"fps={fps},scale={W}:{hh}", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = subprocess.run(args, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, hh, W), hh

def band(shape):
    """Outer band of the frame (left/right quarters and top fifth): where the set usually is when a
    character fills the centre. Tested 2026-11-10: on a kids clip with a still room and a girl tilting
    her head in the centre, whole-frame matching read the head tilt as a 2.5 degree camera roll."""
    h, w = shape; m = np.zeros((h, w), np.uint8)
    m[:, : w // 4] = 255; m[:, -w // 4:] = 255; m[: h // 5, :] = 255
    return m

def step(a, b, orb, bf, mask=None):
    import cv2
    ka, da = orb.detectAndCompute(a, mask); kb, db = orb.detectAndCompute(b, mask)
    if da is None or db is None or len(ka) < 20 or len(kb) < 20: return None, 0.0, 0
    m = bf.match(da, db)
    if len(m) < 20: return None, 0.0, len(m)
    pa = np.float32([ka[x.queryIdx].pt for x in m]); pb = np.float32([kb[x.trainIdx].pt for x in m])
    M, inl = cv2.estimateAffinePartial2D(pa, pb, method=cv2.RANSAC, ransacReprojThreshold=2.0, maxIters=4000)
    if M is None: return None, 0.0, len(m)
    # if "nothing moved" explains (almost) as many points as the best move, the set did not move:
    # the extra move came from something that moves on its own (curtain, walking person)
    still = int((np.linalg.norm(pa - pb, axis=1) < 2.0).sum())
    if still >= max(30, 0.5 * inl.sum()): M = np.float64([[1, 0, 0], [0, 1, 0]])
    step.inliers = int(max(inl.sum(), still))
    return np.vstack([M, [0, 0, 1]]), float(inl.mean()), len(m)

def end_of(path):
    """Where the camera ends up: per axis, the median of the last 5 samples, so one or two odd samples at the very
    end cannot decide the clip - the same "lasts 3+ samples" rule the excursion check below uses. (2026-11-14,
    MiniMax walk_e98b3141: on Londi's PC the last sample at 5.00 s alone read zoom x0.930 / travel 0.518 and failed a
    still shot as "pull-out, pan-left"; the cloud VM decoded that frame normally and read locked.)"""
    tail = path[-5:]
    return (tail[-1][0],) + tuple(float(np.median([x[k] for x in tail])) for k in (1, 2, 3, 4))

def classify(scale, dx, dy, rot, tol):
    moves = []
    if scale > 1 + tol["scale"]: moves.append("push-in")
    if scale < 1 - tol["scale"]: moves.append("pull-out")
    if dx < -tol["shift"]: moves.append("pan-right")      # content moves left -> camera moved right
    if dx > tol["shift"]: moves.append("pan-left")
    if dy < -tol["shift"]: moves.append("tilt-down")
    if dy > tol["shift"]: moves.append("tilt-up")
    if abs(rot) > tol["rot"]: moves.append("roll")
    return moves or ["locked"]

def analyze(clip, expect="any", fps=6.0, start=None, end=None, scale_tol=0.02, shift_tol=0.02, log=print):
    """Library entry point (for the app): returns the report dict; `log` gets the human-readable lines
    (pass log=None for silence). report["problems"] empty = the camera matched the spec."""
    import cv2
    log = log or (lambda *x: None)
    a = argparse.Namespace(clip=clip, expect=expect, fps=fps, start=start, end=end, scale_tol=scale_tol, shift_tol=shift_tol)
    fr, hh = frames(a.clip, a.fps, a.start, a.end)
    global BAND
    BAND = band(fr.shape[1:])
    orb = cv2.ORB_create(2000); bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    tol = {"scale": a.scale_tol, "shift": a.shift_tol, "rot": 1.0}
    segs = []; cur = {"t0": a.start or 0.0, "C": np.eye(3), "path": [], "weak": []}
    t0 = a.start or 0.0
    for i in range(1, len(fr)):
        t = t0 + i / a.fps
        M, ratio, nm = step(fr[i - 1], fr[i], orb, bf, BAND)        # set at the edges first
        if M is None or step.inliers < 30:
            M2, r2, n2 = step(fr[i - 1], fr[i], orb, bf)                 # fall back to the whole frame
            if M2 is not None and (M is None or r2 * min(n2, 400) > ratio * min(nm, 400)): M, ratio, nm = M2, r2, n2
        if M is None or ratio < 0.15:
            cur["t1"] = t - 1 / a.fps; segs.append(cur)
            cur = {"t0": t, "i0": i, "C": np.eye(3), "path": [], "weak": [], "after_break": f"chain broken at {t:.2f} s ({nm} matches, {ratio:.0%} agree): cut, whip or redrawn frame"}
            continue
        cur["C"] = M @ cur["C"]
        # direct match against the segment's first frame when it holds: no drift from chaining
        i0 = cur.setdefault("i0", i - 1)
        D, rd, nd = step(fr[i0], fr[i], orb, bf, BAND)
        if D is None or step.inliers < 30: D, rd, nd = step(fr[i0], fr[i], orb, bf)
        if D is not None and step.inliers >= 30: cur["C"] = D
        if ratio < 0.4: cur["weak"].append(f"{t:.2f} s ({ratio:.0%} of points agree)")
        C = cur["C"]; s = math.hypot(C[0, 0], C[1, 0]); r = math.degrees(math.atan2(C[1, 0], C[0, 0]))
        # where the frame centre went, as a fraction of the frame width, net of zoom
        c = np.array([W / 2, hh / 2, 1.0]); p = C @ c
        cur["path"].append((round(t, 2), round(s, 4), round((p[0] - W / 2) / W, 4), round((p[1] - hh / 2) / W, 4), round(r, 2)))
    cur["t1"] = t0 + (len(fr) - 1) / a.fps; segs.append(cur)
    want = set(a.expect.split("+")); report = {"clip": a.clip, "expect": a.expect, "segments": [], "problems": []}
    for sg in segs:
        if not sg["path"]: continue
        t, s, dx, dy, r = end_of(sg["path"])
        mx_s = max(abs(x[1] - 1) for x in sg["path"]); mx_x = max(abs(x[2]) for x in sg["path"]); mx_y = max(abs(x[3]) for x in sg["path"])
        moves = classify(s, dx, dy, r, tol)
        # A move that goes out and comes back by the last frame (a drift, or P049's tilt down to the
        # shoes and back) is not in the end-to-end numbers: look at each axis's largest excursion.
        # It counts only when it lasts 3+ samples (0.5 s at 6 fps): one or two odd samples are usually a
        # large subject passing close to the lens (tested on a walking man in a still room, 2026-11-10).
        brief = []
        for ax, lim, names in ((1, tol["scale"], ("push-in", "pull-out")), (2, tol["shift"], ("pan-left", "pan-right")),
                               (3, tol["shift"], ("tilt-up", "tilt-down"))):
            vals = [x[ax] - (1 if ax == 1 else 0) for x in sg["path"]]
            out = [abs(v) > lim for v in vals]; run = best = 0
            for o in out: run = run + 1 if o else 0; best = max(best, run)
            pk = max(vals, key=abs); name = names[0] if pk > 0 else names[1]
            # 2026-11-17: also a move when 4+ samples are over the limit even if no 3 are in a row. Phase 0 S5_r2_klingS
            # (a bad clip): push-in peak 0.031, 7 samples over 0.02 in a row on the Linux VM (ffmpeg 4.4) but split
            # into 8 non-consecutive samples on Londi's PC (ffmpeg 8.1, a different scaler) -> FLAG on one, PASS on the
            # other. On the 119 locked benchmark clips (VM) no clip that passes today has 4+ such samples, so this only
            # catches a real move broken up by noise; a passer-by near the lens gives 1-2.
            if (best >= 3 or sum(out) >= 4) and name not in moves:
                moves = [m for m in moves if m != "locked"] + [f"{name} and back (peak {abs(pk):.3f} at {sg['path'][vals.index(pk)][0]:.2f} s)"]
            elif 0 < best < 3:
                brief += [x[0] for x, o in zip(sg["path"], out) if o]
        if brief:
            sg["weak"].append("brief jump at " + ", ".join(f"{t:.2f}" for t in sorted(set(brief))) + " s (a large subject near the lens? look)")
        seg = {"from": round(sg["t0"], 2), "to": round(sg["t1"], 2), "moves": moves, "end_zoom": s, "end_shift_x": dx,
               "end_shift_y": dy, "end_roll_deg": r, "max_zoom_change": round(mx_s, 4), "max_shift_x": round(mx_x, 4),
               "max_shift_y": round(mx_y, 4), "weak_steps": sg["weak"], "path_t_zoom_x_y_roll": sg["path"]}
        if sg.get("after_break"): seg["note"] = sg["after_break"]
        report["segments"].append(seg)
        log(f"{seg['from']:.2f}-{seg['to']:.2f} s: {', '.join(moves)}  (zoom x{s:.3f}, travel {dx:+.3f} / {dy:+.3f} of frame width, roll {r:+.1f} deg;"
              f" max zoom change {mx_s:.3f}, max travel {mx_x:.3f} / {mx_y:.3f})")
        if sg.get("after_break"): log("   " + sg["after_break"])
        if "any" not in want:
            got = {m.split(" (")[0] for m in moves}
            if "roll" not in want: got -= {"roll"}
            if got != want:
                report["problems"].append(f"{seg['from']:.2f}-{seg['to']:.2f} s: camera {', '.join(moves)}, spec {a.expect}")
            if "roll" in moves and "roll" not in want:
                report["problems"].append(f"{seg['from']:.2f}-{seg['to']:.2f} s: horizon rolls {r:+.1f} deg")
        if sg["weak"]:
            report.setdefault("look_at", []).extend(sg["weak"])
    if len(report["segments"]) > 1: report["problems"].append(f"{len(report['segments'])} segments: the chain broke (see notes) - a cut inside a single shot?")
    log("PROBLEMS:" if report["problems"] else ("matches spec" if "any" not in want else "no spec given (--expect)"))
    for p in report["problems"]: log("  - " + p)
    if report.get("look_at"):
        log("LOOK AT (few background points agree: a big moving subject, or a warping / redrawn background):")
        for p in report["look_at"][:10]: log("  - " + p)
    return report

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip"); ap.add_argument("--expect", default="any"); ap.add_argument("--fps", type=float, default=6)
    ap.add_argument("--start", type=float); ap.add_argument("--end", type=float)
    ap.add_argument("--scale-tol", type=float, default=0.02); ap.add_argument("--shift-tol", type=float, default=0.02)
    ap.add_argument("--json")
    a = ap.parse_args()
    report = analyze(a.clip, a.expect, a.fps, a.start, a.end, a.scale_tol, a.shift_tol)
    if a.json: json.dump(report, open(a.json, "w"), indent=1)

if __name__ == "__main__":
    main()

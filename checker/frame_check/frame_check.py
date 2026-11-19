"""frame_check.py - full-size frame review for generated video. @anlim

Code checks every frame (small copies, fast). Frames that need review are exported at FULL
native resolution, one image each (never tiled), and review.html shows them one at a time,
beside the source frame and/or set plate when given. ai_review.py adds AI verdicts.

  python frame_check.py OUTPUT.mp4 [--source SRC.mp4] [--plate PLATE.png] [--roles roles.json]
                        [--floor-fps 6] [--pad 2] [--out DIR] [--max-export 600]
"""
import argparse, json, os, subprocess, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import probe, extract, plate_compare, write_viewer, locate_role, validate_roles

AW = 320          # analysis width for the code passes
STILL_THR = 0.10

def motion_beats(F, cuts, top=20):
    """Frames in the fastest `top` % of frame-to-frame change (cuts excluded), +-1 frame. Generation defects
    in action (a kick drawn as a hand, a fist merged into a shirt, a third hand) last 2-8 frames and sit in
    the fastest motion, where a 4-frame sweep can step over them. EP18 2026-11-10: top 20% covered 36-43% of
    each fight clip and held every frame of the b2 third hand (3/3), the shotD kick blob (5/5) and 5/6 of the
    b1 v4 foot-in-shirt frames. Tried first: two characters' clothing colours close together - did not
    separate defect frames (the third hand came while they were apart; in kicks one colour is hidden)."""
    G = F.astype(np.float32).mean(-1); n = len(G)
    d1 = np.array([0.0] + [np.abs(G[i] - G[i - 1]).mean() for i in range(1, n)])
    d1[[c for c in cuts if c < n]] = 0
    nz = d1[d1 > 0]
    if not len(nz): return set()
    hot = set(np.where(d1 >= np.percentile(nz, 100 - top))[0].tolist())
    return {j for i in hot for j in (i - 1, i, i + 1) if 0 <= j < n}  # mean frame-to-frame change below this for 2 s = a still image

def small_frames(p, w, h):
    ah = int(round(AW * h / w)); ah += ah % 2
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-vf", f"scale={AW}:{ah}",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    n = len(raw) // (AW * ah * 3)
    return np.frombuffer(raw[:n * AW * ah * 3], np.uint8).reshape(n, ah, AW, 3)

def analyse(F, roles):
    n = len(F); G = F.astype(np.float32).mean(-1); flags = {i: [] for i in range(n)}
    d1 = np.array([0.0] + [np.abs(G[i] - G[i - 1]).mean() for i in range(1, n)])
    med = float(np.median(d1[1:])) + 1e-6
    # cut = a big change that PERSISTS (3 frames later still nearer the new shot than any of the 3 before)
    cuts = set()
    for i in range(1, n - 3):
        if d1[i] > max(2.5 * med, 8.0):
            to_new = np.abs(G[i + 3] - G[i]).mean()
            to_old = min(np.abs(G[i + 3] - G[j]).mean() for j in range(max(0, i - 3), i))
            if to_new < 0.6 * to_old: cuts.add(i)
    for i in sorted(cuts): flags[i].append(f"cut (change {d1[i]:.1f})")
    # 1- and 2-frame outliers: differ from both neighbours while the neighbours match
    for k in (1, 2):
        for i in range(1, n - k):
            a, b = G[i - 1], G[i + k]
            out = min(np.abs(G[j] - a).mean() for j in range(i, i + k))
            back = min(np.abs(G[j] - b).mean() for j in range(i, i + k))
            score = min(out, back) / (np.abs(a - b).mean() + 1.0)
            if score > 2.5 and min(out, back) > 6:
                for j in range(i, i + k): flags[j].append(f"{k}-frame outlier (x{score:.1f})")
    # still-image shots: 2 s or more where the picture does not change at all. Tested on the Keycard v4
    # verdicts: whole-frame motion does NOT separate "the action never happens" from good shots (two
    # rejected clips moved more than three approved ones), so only a literal still is flagged here;
    # "the named action happens" is rule 15 for the AI/human review.
    bounds = [0] + sorted(cuts) + [n]
    for s0, s1 in zip(bounds[:-1], bounds[1:]):
        seg = d1[s0 + 1:s1]
        if len(seg) >= 48 and float(np.mean(seg)) < STILL_THR:
            flags[s0].append(f"still image: frames {s0}-{s1 - 1} do not change (mean change {float(np.mean(seg)):.2f})")
    # dark corners vs the clip's own corners
    h, w = G.shape[1:]; cy, cx = h // 4, w // 4
    corner = np.array([np.concatenate([g[:cy, :cx].ravel(), g[:cy, -cx:].ravel(), g[-cy:, :cx].ravel(),
                                       g[-cy:, -cx:].ravel()]).mean() for g in G])
    cm = float(np.median(corner))
    for i in range(n):
        if corner[i] < 0.55 * cm and corner[i] < 60: flags[i].append(f"dark corners ({corner[i]:.0f} vs clip {cm:.0f})")
    # roles
    if roles:
        track = {}
        ambiguous = {}
        for r in roles:
            pts = []
            for f in F:
                loc = locate_role(f, r, min_area=0.01)
                if isinstance(loc, str):
                    pts.append(None)
                    if loc == "colour not unique": ambiguous[r["name"]] = ambiguous.get(r["name"], 0) + 1
                else: pts.append(loc)
            track[r["name"]] = pts
        for name, cnt in ambiguous.items():
            if cnt > 0.2 * n: flags[0].append(f"roles: {name}'s colour is not unique in {cnt} of {n} frames; swap checks skip those frames")
        names = list(track)
        for name in names:                       # jumps far and comes back within 6 frames, same shot
            P = track[name]
            for i in range(1, n):
                if P[i] is None or P[i - 1] is None or i in cuts: continue
                if abs(P[i][0] - P[i - 1][0]) + abs(P[i][1] - P[i - 1][1]) < 0.25: continue
                for j in range(i + 1, min(n, i + 7)):
                    if j in cuts: break
                    if P[j] is not None and abs(P[j][0] - P[i - 1][0]) + abs(P[j][1] - P[i - 1][1]) < 0.12:
                        for q in range(i, j): flags[q].append(f"{name} jumps and returns (frames {i}-{j - 1})")
                        break
        if len(names) >= 2:                      # order of two characters flips against the shot
            A, B = track[names[0]], track[names[1]]
            for axis, label in ((0, "left/right"), (1, "above/below")):
                sign = [None if (A[i] is None or B[i] is None) else (1 if A[i][axis] < B[i][axis] else -1) for i in range(n)]
                for i in range(n):
                    if sign[i] is None: continue
                    lo = max([c for c in cuts if c <= i], default=0); hi = min([c for c in cuts if c > i], default=n)
                    win = [s for s in sign[max(lo, i - 12):min(hi, i + 13)] if s is not None]
                    if len(win) >= 4 and np.sign(sum(win)) != 0 and sign[i] != np.sign(sum(win)) and abs(sum(win)) >= 0.5 * len(win):
                        flags[i].append(f"role order flip {label}: {names[0]} vs {names[1]}")
    return flags, sorted(cuts)

def plate_pass(path, n, fps, cuts, plate, step):
    """Room scale vs the set plate on every `step`-th frame (full-res decode of those frames only),
    flags frames off-plate and shots whose room grows or shrinks."""
    import cv2
    cap = cv2.VideoCapture(path); res = {}; i = 0
    while True:
        ok, fr = cap.read()
        if not ok: break
        if i % step == 0: res[i] = plate_compare(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB), plate)
        i += 1
    cap.release()
    flags = {}
    bounds = [0] + list(cuts) + [n]
    for a, b in zip(bounds[:-1], bounds[1:]):
        shot = [(i, res[i]["scale_room"]) for i in sorted(res) if a <= i < b and res[i].get("ok")]
        for i in sorted(res):
            keep = [w for w in res[i]["why"] if "partly hidden" not in w]   # people move in front of fixtures all the time
            if a <= i < b and keep: flags.setdefault(i, []).extend("plate: " + w for w in keep)
        if len(shot) >= 2:
            s = [v for _, v in shot]
            if max(s) - min(s) > 0.06:
                lo_i = shot[int(np.argmin(s))][0]; hi_i = shot[int(np.argmax(s))][0]
                for i in (lo_i, hi_i):
                    flags.setdefault(i, []).append(f"plate: room scale changes within shot ({min(s):.2f} to {max(s):.2f})")
    return flags, res

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("output"); ap.add_argument("--source"); ap.add_argument("--plate"); ap.add_argument("--roles")
    ap.add_argument("--floor-fps", type=float, default=6.0); ap.add_argument("--pad", type=int, default=2)
    ap.add_argument("--out"); ap.add_argument("--max-export", type=int, default=600)
    ap.add_argument("--previous", help="previous version of this clip (re-render check)")
    ap.add_argument("--window", help="seconds the re-render was meant to change, e.g. 4.0-5.5")
    ap.add_argument("--dense-motion", type=float, default=0, help="also export EVERY frame of the fastest N%% of motion (e.g. 20 for fights)")
    a = ap.parse_args()
    w, h, fps, dur = probe(a.output)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.output)), "frame_check",
                                os.path.splitext(os.path.basename(a.output))[0])
    os.makedirs(out, exist_ok=True)
    roles = json.load(open(a.roles)) if a.roles else None
    role_msgs = []
    if roles and a.plate: roles, role_msgs = validate_roles(roles, a.plate)
    F = small_frames(a.output, w, h); n = len(F)
    flags, cuts = analyse(F, roles)
    flags[0].extend(role_msgs)
    if a.previous:
        P = small_frames(a.previous, w, h); win = None
        if a.window:
            t0, t1 = [float(x) for x in a.window.split("-")]; win = (int(t0 * fps), int(t1 * fps))
        m = min(len(P), n)
        if len(P) != n: flags[0].append(f"re-render: frame count {n} vs previous {len(P)}; compared the first {m}")
        Gp = P.astype(np.float32).mean(-1); Gn = F.astype(np.float32).mean(-1)
        dv = np.array([np.abs(Gp[i] - Gn[i]).mean() for i in range(m)])
        noise = float(np.median(dv)) if win is None else float(np.median([dv[i] for i in range(m) if not (win[0] <= i <= win[1])] or [0]))
        thr = max(4.0, 3 * noise)
        changed = [i for i in range(m) if not (win and win[0] <= i <= win[1]) and dv[i] > thr]
        outside_total = sum(1 for i in range(m) if not (win and win[0] <= i <= win[1]))
        if noise > 6.0 or (outside_total and len(changed) > 0.5 * outside_total):
            flags[0].append(f"re-render: the WHOLE clip was regenerated (typical difference outside the window {noise:.1f}, "
                            f"a splice is under 1), so frame-by-frame comparison cannot isolate errors: rely on the swap/identity "
                            f"checks and review every frame")
        else:
            for i in changed:
                flags[i].append(f"re-render: changed vs previous version outside the fixed window (diff {dv[i]:.1f}, noise {noise:.1f})")
    if a.dense_motion:
        for i in sorted(motion_beats(F, cuts, a.dense_motion)): flags[i].append("fast motion (every frame reviewed)")
    step = max(1, int(round(fps / a.floor_fps)))
    plate_res = {}
    if a.plate:
        pf, plate_res = plate_pass(a.output, n, fps, cuts, a.plate, step)
        for i, v in pf.items(): flags[i].extend(v)
    pick = {}
    for i, why in flags.items():
        if why:
            for j in range(max(0, i - a.pad), min(n, i + a.pad + 1)): pick.setdefault(j, set())
            pick[i].update(why)
    for i in range(0, n, step):
        pick.setdefault(i, set())
        if not flags[i]: pick[i].add("sweep")
    idx = sorted(pick)[:a.max_export]
    outp = extract(a.output, idx, out, "out")
    prevp = {}
    if a.previous:
        prevp = extract(a.previous, idx, out, "prev")
    srcp = {}
    if a.source:
        sw, sh, sfps, sdur = probe(a.source)
        last = int(sdur * sfps) - 1
        smap = extract(a.source, sorted(set(min(int(round(i / fps * sfps)), last) for i in idx)), out, "src")
        srcp = {i: smap.get(min(int(round(i / fps * sfps)), last)) for i in idx}
    plate_name = None
    if a.plate:
        import shutil; plate_name = "plate_" + os.path.basename(a.plate); shutil.copy(a.plate, os.path.join(out, plate_name))
    frames = []
    for i in idx:
        if not outp.get(i): continue
        refs = []
        if srcp.get(i): refs.append({"label": "source", "src": srcp[i]})
        if prevp.get(i): refs.append({"label": "previous version", "src": prevp[i]})
        if plate_name: refs.append({"label": "set plate", "src": plate_name})
        frames.append({"i": i, "key": f"f{i}", "t": i / fps, "why": sorted(pick[i]) or ["neighbour of flagged frame"],
                       "out": outp[i], "refs": refs, "plate": plate_res.get(i)})
    man = {"kind": "video", "clip": os.path.basename(a.output), "fps": fps, "size": [w, h], "frames_total": n,
           "cuts": cuts, "floor_fps": a.floor_fps, "frames": frames, "flagged_by_code": [i for i in range(n) if flags[i]]}
    write_viewer(man, out)
    print(f"{man['clip']}: {n} frames at {fps:g} fps, {w}x{h}")
    print(f"  cuts: {len(cuts)}  flagged by code: {len(man['flagged_by_code'])}  exported full size: {len(frames)}")
    for i in man["flagged_by_code"][:40]: print(f"   f{i:05d} {i / fps:6.3f}s  {' | '.join(flags[i])}")
    print(f"  review: {os.path.join(out, 'review.html')}")

if __name__ == "__main__":
    main()

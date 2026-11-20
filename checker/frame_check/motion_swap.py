"""motion_swap.py - did a motion-transfer render keep who is who? @anlim

2026-11-20 (anlim.ai motion transfer, Genjutsu / Genjutsu Light): the model maps the people of the source clip to the
creator's characters again at every camera cut, and sometimes gets it wrong for a shot (EP11 rooftop test: the 9-10 s
close-up came back with the other fighter in two of four runs; the app's first live run also swapped the opening flip).
role_source.py catches this for Name That Fight, but it needs each character's colour range written by hand
(roles.json). The app has no such file, so this check learns both sides from the clips themselves:

 1. People are found in the render and in the source (YOLOX; cartoon bodies counted as in objects_check).
 2. Each person is described by the colours of their clothes (torso hue/sat/value histogram, role_source.desc).
 3. The render's people are clustered into two characters, the source's into two actors.
 4. Which actor plays which character is the mapping MOST shots agree with (one vote per shot, as role_source).
 5. Every sampled frame is then judged: two people -> their left/right order against the source; one person
    (a close-up) -> is the character on screen the one the source's actor maps to? Disagreeing runs are swaps.

Never a FAIL (2026-11-20 policy: the checker only flags). FLAG with times when swapped runs are found and the mapping is
clear; NOT SURE when the vote is close; NOT CHECKED when either side does not hold two people who look different.
Two-person clips only for now (the common case); three or more people: NOT CHECKED.

  python motion_swap.py RENDER.mp4 SOURCE.mp4 [--step 2] [--json out.json]
"""
import argparse, json, os, sys
import numpy as np
import cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from objects_check import Detector
from role_source import frames_rgb, people, desc, bh
from sync_check import find_cuts

MIN_SPLIT = 0.25     # Bhattacharyya distance between the two cluster centres; below this the two look alike
MARGIN = 0.08        # a single person is judged only when one centre is clearly nearer than the other

def _cluster(D):
    X = np.float32(D)
    _, lab, cen = cv2.kmeans(X, 2, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 1e-4), 5, cv2.KMEANS_PP_CENTERS)
    return cen

def _who(d, cen):
    """(cluster, sure) for one descriptor."""
    a, b = bh(d, cen[0]), bh(d, cen[1])
    return (0 if a < b else 1), abs(a - b) >= MARGIN

def analyze(render, source, step=2, log=print, min_run=3):
    log = log or (lambda *a: None)
    R, rf = frames_rgb(render); S, sf = frames_rgb(source)
    det = Detector(conf=0.3)
    cuts = sorted(set(find_cuts(R.astype(np.float32).mean(-1))))
    shot_of = lambda i: sum(1 for c in cuts if c <= i)
    rows = []
    for i in range(0, len(R), step):
        j = min(int(round(i / rf * sf)), len(S) - 1)
        if i / rf > len(S) / sf + 0.5: break                 # render longer than its source (rounded-up length)
        rp = sorted(people(det, R[i], cartoon=True), key=lambda d: -d["box"][2] * d["box"][3])[:3]
        sp = sorted(people(det, S[j], cartoon=True), key=lambda d: -d["box"][2] * d["box"][3])[:3]
        rows.append({"i": i, "t": round(i / rf, 3), "shot": shot_of(i),
                     "r": [(d["box"], desc(R[i], d["box"])) for d in rp], "s": [(d["box"], desc(S[j], d["box"])) for d in sp]})
    two_r = [p for r in rows if len(r["r"]) == 2 for p in r["r"]]
    two_s = [p for r in rows if len(r["s"]) == 2 for p in r["s"]]
    res = {"render": os.path.basename(render), "source": os.path.basename(source), "cuts": len(cuts),
           "frames": len(rows), "issues": [], "verdict": "NOT CHECKED"}
    if sum(1 for r in rows if len(r["r"]) >= 3) > len(rows) / 3 or sum(1 for r in rows if len(r["s"]) >= 3) > len(rows) / 3:
        res["why"] = "more than two people in much of the clip; this check handles two"; log(f"motion swap: {res['why']}"); return res
    if len(two_r) < 8 or len(two_s) < 8:
        res["why"] = "too few frames with two people on both sides"; log(f"motion swap: {res['why']}"); return res
    rc, sc = _cluster([d for _, d in two_r]), _cluster([d for _, d in two_s])
    if bh(rc[0], rc[1]) < MIN_SPLIT or bh(sc[0], sc[1]) < MIN_SPLIT:
        res["why"] = "the two people look too alike to tell apart by their clothes"; log(f"motion swap: {res['why']}"); return res

    # per frame: does source actor 0 sit where render character 0 sits? (True/False, or None when it cannot be told)
    def same(r):
        if len(r["r"]) == 2 and len(r["s"]) == 2:
            (rb0, rd0), (rb1, rd1) = sorted(r["r"], key=lambda p: p[0][0] + p[0][2] / 2)
            (sb0, sd0), (sb1, sd1) = sorted(r["s"], key=lambda p: p[0][0] + p[0][2] / 2)
            if abs((rb0[0] + rb0[2] / 2) - (rb1[0] + rb1[2] / 2)) < 0.10 or abs((sb0[0] + sb0[2] / 2) - (sb1[0] + sb1[2] / 2)) < 0.10:
                return None
            kr0, ok1 = _who(rd0, rc); kr1, ok2 = _who(rd1, rc); ks0, ok3 = _who(sd0, sc); ks1, ok4 = _who(sd1, sc)
            if kr0 == kr1 or ks0 == ks1 or not (ok1 or ok2) or not (ok3 or ok4): return None
            return (ks0 == 0) == (kr0 == 0)                      # left person: actor 0 <-> character 0 ?
        if len(r["r"]) == 1 and len(r["s"]) == 1:
            kr, ok1 = _who(r["r"][0][1], rc); ks, ok2 = _who(r["s"][0][1], sc)
            if not (ok1 and ok2): return None
            return kr == ks
        return None
    for r in rows: r["same"] = same(r)
    per_shot = {}
    for r in rows:
        if r["same"] is not None: per_shot.setdefault(r["shot"], []).append(r["same"])
    sv = [sum(v) > len(v) / 2 for v in per_shot.values() if sum(v) != len(v) / 2]
    if len(sv) < 2:
        res["why"] = "too few shots where who is who can be told"; log(f"motion swap: {res['why']}"); return res
    maj = sum(sv) >= len(sv) / 2; agree = max(sum(sv), len(sv) - sum(sv)) / len(sv)
    for r in rows: r["swapped"] = None if r["same"] is None else (r["same"] != maj)
    # runs of swapped frames inside one shot (unknown frames neither break nor extend a run)
    runs, cur = [], []
    for r in rows:
        if r["swapped"] is None: continue
        if r["swapped"] and (not cur or cur[-1]["shot"] == r["shot"]): cur.append(r); continue
        if cur: runs.append(cur)
        cur = [r] if r["swapped"] else []
    if cur: runs.append(cur)
    for run in [x for x in runs if len(x) >= min_run]:
        res["issues"].append({"kind": "swap", "from_s": run[0]["t"], "to_s": round(run[-1]["t"] + step / rf, 3),
                              "text": f"who is who swapped against your clip at {run[0]['t']:.1f}-{run[-1]['t'] + step / rf:.1f} s"})
    known = sum(1 for r in rows if r["swapped"] is not None); sw = sum(1 for r in rows if r["swapped"])
    res.update({"frames_judged": known, "frames_swapped": sw, "shots_voting": len(sv), "agree": round(agree, 2),
                "rows": [{"t": r["t"], "shot": r["shot"], "r": len(r["r"]), "s": len(r["s"]), "swapped": r["swapped"]} for r in rows]})
    res["verdict"] = ("FLAG" if agree >= 0.6 else "NOT SURE") if res["issues"] else "PASS"
    log(f"motion swap {res['render']}: {known} of {len(rows)} sampled frames judged, {sw} swapped, mapping agreed by "
        f"{agree:.0%} of {len(sv)} shots -> {res['verdict']}")
    for x in res["issues"]: log("  " + x["text"])
    return res

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("render"); ap.add_argument("source")
    ap.add_argument("--step", type=int, default=2); ap.add_argument("--json")
    a = ap.parse_args()
    res = analyze(a.render, a.source, a.step)
    if a.json: json.dump(res, open(a.json, "w", encoding="utf-8"), indent=1)

if __name__ == "__main__":
    main()

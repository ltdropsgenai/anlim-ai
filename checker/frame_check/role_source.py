"""role_source.py - compare a motion-transfer render with its driving (source) video, frame by frame. @anlim

Two failures from EP18 (2026-11-10) that the in-clip checks cannot see:
 1. ROLE SWAP AGAINST THE SOURCE. The model maps characters by POSITION at each cut, so after a cut the
    hero can perform the other fighter's moves for the whole shot (b3 v2 f29-f59, b1 v3 f96-f105, kd_g v1).
    frame_check's role-order check only sees a flip INSIDE a shot; a shot that is swapped from its first
    frame to its last looks consistent. Here the order of the two characters in the render is compared
    with the order of the two actors in the source at the same moment.
 2. EXTRA CHARACTER. The render shows a person where the source shows fewer (g v3 f280-f288: the boxer
    added where the source shows only Ip Man).

Source actors are found with the YOLOX person detector (live action) and told apart by the colours of their
clothes: every source person from frames with two people is clustered into two actors. Which actor plays which
character is the mapping that MOST compared frames agree with; the frames that disagree are the swaps. (First
version learned the mapping from the first comparable frame - EP18 b3 v2's first two-person frame, f32, was
inside the swapped shot, so it reported the correct shots as swapped. The majority assumes the render is right
more often than wrong; when the vote is close the check reports NOT SURE instead of a verdict.)

  python role_source.py RENDER.mp4 SOURCE.mp4 --roles roles.json [--step 2] [--json out.json]
"""
import argparse, json, os, subprocess, sys
import numpy as np
import cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import locate_role
from objects_check import Detector, cartoon_people
from sync_check import find_cuts

AW = 320

def frames_rgb(p, w=AW):
    pr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate",
                         "-of", "json", p], capture_output=True, text=True).stdout
    st = json.loads(pr)["streams"][0]; a, b = st["r_frame_rate"].split("/"); fps = float(a) / float(b)
    h = int(round(w * st["height"] / st["width"])); h += h % 2
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    return np.frombuffer(raw[:n * w * h * 3], np.uint8).reshape(n, h, w, 3), fps

def people(det, rgb, cartoon, min_area=0.01, conf=0.5):
    d = det.detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    d = cartoon_people(d) if cartoon else [x for x in d if x["cls"] == "person" and x["score"] >= conf]
    return [x for x in d if x["cls"] == "person" and x["box"][2] * x["box"][3] >= min_area]

def desc(rgb, box):
    """Clothes colour of a detected person: hue/sat histogram of the middle of the box (torso)."""
    h, w = rgb.shape[:2]; x, y, bw, bh = box
    x0, x1 = int((x + 0.2 * bw) * w), int((x + 0.8 * bw) * w); y0, y1 = int((y + 0.25 * bh) * h), int((y + 0.75 * bh) * h)
    patch = rgb[max(0, y0):max(y0 + 1, y1), max(0, x0):max(x0 + 1, x1)]
    hsv = cv2.cvtColor(np.ascontiguousarray(patch), cv2.COLOR_RGB2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 3, 3], [0, 180, 0, 256, 0, 256]).ravel()
    return hist / (hist.sum() + 1e-6)

def bh(a, b): return float(cv2.compareHist(a.astype(np.float32), b.astype(np.float32), cv2.HISTCMP_BHATTACHARYYA))

def analyze(render, source, roles, step=2, start=0.0, log=print, min_run=3):
    log = log or (lambda *a: None)
    if not roles or len(roles) < 2:
        return {"verdict": "NOT CHECKED", "why": "roles.json needs two characters", "rows": [], "issues": [], "mapping": {}}
    R, rf = frames_rgb(render); S, sf = frames_rgb(source)
    det = Detector(conf=0.3); cuts = set(find_cuts(R.astype(np.float32).mean(-1)))
    A, B = roles[0], roles[1]
    rows, cand = [], []
    for i in range(0, len(R), step):
        j = int(round((i / rf + start) * sf))
        if j >= len(S): break
        la, lb = locate_role(R[i], A, min_area=0.01), locate_role(R[i], B, min_area=0.01)
        sp = sorted(people(det, S[j], cartoon=False, conf=0.3), key=lambda d: -d["box"][2] * d["box"][3])
        rp = people(det, R[i], cartoon=True)
        row = {"i": i, "t": round(i / rf, 3), "src_people": len(sp), "render_people": len(rp), "order": None}
        if len(sp) >= 2 and not isinstance(la, str) and not isinstance(lb, str):
            s1, s2 = sp[0], sp[1]; c1 = s1["box"][0] + s1["box"][2] / 2; c2 = s2["box"][0] + s2["box"][2] / 2
            if abs(c1 - c2) > 0.12 and abs(la[0] - lb[0]) > 0.12:
                cand.append((len(rows), desc(S[j], s1["box"]), desc(S[j], s2["box"]), c1 < c2, la[0] < lb[0]))
        rows.append(row)
    tmpl = {}
    if len(cand) >= 4:
        X = np.float32([d for c in cand for d in (c[1], c[2])])
        _, lab, cen = cv2.kmeans(X, 2, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 1e-4), 5, cv2.KMEANS_PP_CENTERS)
        if bh(cen[0], cen[1]) < 0.25:
            log("  roles vs source: the two source actors' clothes look alike; swap check off")
            cand = []
        votes = []
        for c in cand:
            k1 = int(np.argmin([bh(c[1], cen[0]), bh(c[1], cen[1])])); k2 = int(np.argmin([bh(c[2], cen[0]), bh(c[2], cen[1])]))
            if k1 == k2: votes.append(None); continue
            x_left = c[3] if k1 == 0 else not c[3]          # is actor 0 left of actor 1 in the source?
            votes.append(x_left == c[4])                     # True: actor 0 is on character A's side
        # one vote per SHOT (a swapped shot gives many frames; EP18 b3 v2: 4 swapped frames of 10 but 1 shot of 3)
        bounds = sorted(cuts); shot_of = lambda i: sum(1 for c in bounds if c <= i)
        per_shot = {}
        for c, v in zip(cand, votes):
            if v is not None: per_shot.setdefault(shot_of(rows[c[0]]["i"]), []).append(v)
        sv = [sum(v) > len(v) / 2 for v in per_shot.values() if sum(v) != len(v) / 2]
        if sv:
            maj = sum(sv) >= len(sv) / 2; share = max(sum(sv), len(sv) - sum(sv)) / len(sv)
            tmpl = {"actor0_is": A["name"] if maj else B["name"], "agree": round(share, 2), "shots": len(sv)}
            for c, v in zip(cand, votes):
                if v is not None: rows[c[0]]["order"] = "same" if v == maj else "swapped"
    issues = []
    def runs(pred, need=min_run):
        out, cur = [], []
        for r in rows:
            if pred(r) is None: continue          # unknown frames neither break nor extend a run
            if pred(r):
                if cur and any(c in cuts for c in range(cur[-1]["i"] + 1, r["i"] + 1)): out.append(cur); cur = []
                cur.append(r)
            else:
                if cur: out.append(cur); cur = []
        if cur: out.append(cur)
        return [c for c in out if len(c) >= need]
    for run in runs(lambda r: None if r["order"] is None else r["order"] == "swapped"):
        issues.append({"kind": "role_swap", "from_frame": run[0]["i"], "to_frame": run[-1]["i"] + step - 1,
                       "text": f"roles swapped against the source f{run[0]['i']}-f{run[-1]['i'] + step - 1} "
                               f"({run[0]['t']:.2f}-{run[-1]['t']:.2f} s): {A['name']} is where the source's other actor is"})
    # Extra person: only where the source detector sees at least one person (live-action close-ups and motion
    # blur give 0, and the approved EP18 b3 over-the-shoulder shot then read as "render 3, source 0").
    # NOTE ONLY, never a verdict: it caught g v3 f280-f287 (the boxer added where the source shows only Ip Man),
    # but approved b1 and b3 renders got as many hits (cartoon over-count in fight close-ups). Rule 23 SOURCE
    # MATCH in the AI review is what judges an added person; these frames are just pointed at.
    for run in runs(lambda r: r["src_people"] >= 1 and r["render_people"] > r["src_people"], need=2):
        issues.append({"kind": "note_extra_person", "from_frame": run[0]["i"], "to_frame": run[-1]["i"] + step - 1,
                       "text": f"look at: maybe more people than the source f{run[0]['i']}-f{run[-1]['i'] + step - 1} "
                               f"({run[0]['t']:.2f}-{run[-1]['t']:.2f} s): render {max(r['render_people'] for r in run)}, "
                               f"source {min(r['src_people'] for r in run)}"})
    known = sum(1 for r in rows if r["order"]); sw = sum(1 for r in rows if r["order"] == "swapped")
    sure = tmpl.get("agree", 0) >= 0.6 and tmpl.get("shots", 0) >= 3
    res = {"render": os.path.basename(render), "source": os.path.basename(source), "mapping": tmpl,
           "frames_compared": known, "frames_swapped": sw, "issues": issues, "rows": rows,
           "verdict": ("FAIL" if sure else "NOT SURE") if any(x["kind"] == "role_swap" for x in issues) else "PASS"}
    log(f"roles vs source {res['render']}: order compared on {known} of {len(rows)} sampled frames, {sw} swapped "
        f"(mapping agreed by {tmpl.get('agree', 0):.0%} of {tmpl.get('shots', 0)} shots) -> {res['verdict']}")
    for x in issues: log("  " + x["text"])
    return res

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("render"); ap.add_argument("source"); ap.add_argument("--roles", required=True)
    ap.add_argument("--step", type=int, default=2); ap.add_argument("--start", type=float, default=0.0); ap.add_argument("--json")
    a = ap.parse_args()
    res = analyze(a.render, a.source, json.load(open(a.roles)), a.step, a.start)
    if a.json: json.dump(res, open(a.json, "w", encoding="utf-8"), indent=1)

if __name__ == "__main__":
    main()

"""room_drift.py - did the room's props move during a walking clip? Code only, no API. @anlim

Why: Londi's MiniMax labels (2026-11-14): 4 of 9 bad walking clips had the toys on the shelf shifting while Layana
walked past ("toys on the shelf behind her shifted position when she came to a stop"). The frame review flags PROPS and
SET LAYOUT on good clips about as often as on bad ones, so it never named this.
How: the clip's first and last frames go through end_frame.check (characters cut out with YOLOX + the isnet-anime
matting model; everything else compared after alignment). Kept: changes of 0.5 % of the frame or more that do not
touch the frame edge. Dropped: edge changes (a window's animated view, a slight reframe) and smaller ones (a foot's
shadow, line wobble, a strip of sofa beside a moving head). The raw boxes are cached, so new thresholds need no re-run.
Measured 2026-11-16 on the 13 MiniMax walking clips (benchmark eval_minimax_2026-11-13; the SAME clips the thresholds
were chosen on, so optimistic): the 4 clips Londi noted for shifting toys all DRIFT; 2 more DRIFT where the toys did
move but his note named another defect (walk_1e3161ee, walk_e98b3141, checked by eye); 0 of 4 good clips. Handling and
talking shots false-alarm (a handed prop moves on purpose; Kling redraws small details), so it runs on WALKING actions
with a locked camera only.
2026-11-16 (auto-pass work): now on EVERY locked-camera clip, so the frame review's unconfirmed flags can stop
holding good clips back. Measured on all 84 labelled Phase 0 + MiniMax clips (same clips the thresholds were picked
on, so optimistic): non-walking actions need 1.0 % of the frame (sofa that grows or scoots: S4_r1/r2/r3_gemini caught;
1 of 25 good non-walking clips false-alarms, S1_r3_gemini at 1.11 %); the edge margin went 0.01 -> 0.02 (the window's
moving trees at x 0.013-0.015 false-alarmed 3 good talking clips). Walking results unchanged (6 of 9 bad, 0 of 4 good).
Verdict effect: FLAG with the boxes (a person looks), never FAIL.

  python room_drift.py CLIP.mp4 --out DIR
  python room_drift.py --bench CASES.json        (labelled cases: shot, label, clip, why; prints DRIFT / OK per clip)
  in code: room_drift.analyze(clip, out_dir) -> dict;  room_drift.apply(verdict, rd) -> (verdict, reason, flags)
"""
import argparse, json, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

VERSION = 2   # v2: raw boxes cached, thresholds applied on read
MIN_AREA_PCT = 0.5     # of the frame, walking (0.3 let a 0.43 % strip of sofa back beside King's moving head through)
MIN_AREA_OTHER = 1.0   # of the frame, any other action (handed props, small redraws: 0.5 false-alarmed 4 of 25 good)
EDGE = 0.02            # a change box this close to the frame edge is the window / a reframe, not a prop
# Same words as studio.shot_kind's "walking" and the worker's WALKING (keep in step).
# Any action where feet move on the floor (the walk guard, pipeline.py / batch_eval.py, 2026-11-16): the two moon-walking
# Phase 0 clips were "Layana takes one step toward King" - a single step slides as badly as a walk.
FEET_MOVE = re.compile(r"\b(walks?|walking|runs?|running|steps?|stepping|stepped|cross(es|ing)?|goes to|go to|goes over|"
                       r"moves? (to|toward|towards|over|across|back|closer)|comes? (to|over|toward|towards)|approach(es|ing)?|"
                       r"dances?|dancing|skips?|hops?|jumps?|chases?|crawls?|paces?|wanders?|strolls?|trots?|gallops?)\b", re.I)
WALKING = re.compile(r"\b(walks?|walking|runs?|running|cross(es|ing)?|goes to|go to|moves? to|dances?|dancing|skips?|"
                     r"hops?|chases?|crawls?)\b", re.I)


def locked(camera):
    """Same test as the worker's isLocked: no camera text, or one that says locked / static."""
    return not camera or bool(re.search(r"lock|static", camera, re.I))


def keep(drift, min_area_pct=MIN_AREA_PCT, edge=EDGE):
    """Prop changes worth a look: big enough and not touching the frame edge."""
    out = []
    for r in drift:
        x0, y0, x1, y1 = r["box"]
        if r["area_pct"] < min_area_pct: continue
        if x0 <= edge or y0 <= edge or x1 >= 1 - edge or y1 >= 1 - edge: continue
        out.append({"box": [float(v) for v in r["box"]], "area_pct": float(r["area_pct"])})
    return out


def _frame(clip, path, last=False):
    args = ["ffmpeg", "-v", "error", "-y"] + (["-sseof", "-0.1"] if last else []) + ["-i", clip, "-frames:v", "1", path]
    subprocess.run(args, check=True, capture_output=True)


def analyze(clip, out_dir, force=False, log=None, walking=True):
    log = log or (lambda *a: None)
    d = os.path.join(out_dir, "room_drift"); os.makedirs(d, exist_ok=True)
    cache = os.path.join(d, "room_drift.json")
    if os.path.exists(cache) and not force:
        r = json.load(open(cache, encoding="utf-8"))
        if r.get("version") == VERSION: return _decide(r, walking)
    import end_frame as E
    from fc_common import probe
    a, b = os.path.join(d, "first.png"), os.path.join(d, "last.png")
    _frame(clip, a); _frame(clip, b, last=True)
    raw = E.check(a, b, out_dir=d)
    try: dur = float(probe(clip)[3])
    except Exception: dur = None
    r = {"raw": [{"box": [float(v) for v in x["box"]], "area_pct": float(x["area_pct"])} for x in raw["drift"]],
         "matting": raw["matting"], "end_t": dur, "version": VERSION}
    json.dump(r, open(cache, "w", encoding="utf-8"), indent=1)
    r = _decide(r, walking); log(f"room drift: {r['verdict']} {r['drift']}")
    return r


def _decide(r, walking=True):
    kept = keep(r.get("raw", []), MIN_AREA_PCT if walking else MIN_AREA_OTHER)
    return dict(r, verdict="DRIFT" if kept else "OK", drift=kept,
                why=("things in the room (not the characters) are in a different place at the end than at the start"
                     if kept else "the room's props end where they started"))


def apply(verdict, rd):
    """DRIFT -> at least FLAG, with a timeline mark at the end of the clip. FAIL and NOT REVIEWED stay."""
    if rd.get("verdict") != "DRIFT" or verdict.startswith(("FAIL", "NOT REVIEWED")):
        return verdict, "", []
    boxes = "; ".join(f"box {r['box']} ({r['area_pct']}% of the frame)" for r in rd["drift"][:3])
    why = f"room props moved between the first and last frame: {boxes}"[:300]
    flags = [{"t_s": rd.get("end_t"), "frame": "rd0", "verdict": "FAIL", "rules": ["PROPS MOVED"],
              "note": "compare the shelf / props with the first frame: " + boxes[:250]}]
    return ("FLAG" if verdict == "PASS" else verdict), why, flags


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("clip", nargs="?"); ap.add_argument("--out")
    ap.add_argument("--bench"); ap.add_argument("--force", action="store_true"); a = ap.parse_args()
    if a.bench:
        cases = json.load(open(a.bench, encoding="utf-8"))["cases"]; root = os.path.dirname(os.path.abspath(a.bench))
        for c in cases:
            act = (c.get("spec") or {}).get("action", "")
            if not WALKING.search(act) or not locked((c.get("spec") or {}).get("camera")): continue
            clip = c["clip"]
            if not os.path.exists(clip):            # cases written on Windows, read in the cloud session
                clip = os.path.join(os.path.dirname(os.path.dirname(HERE)), *clip.split("vid_projects\\", 1)[-1].split("\\"))
            r = analyze(clip, os.path.join(root, c["shot"]), force=a.force)
            print(f"{c['shot']:16s} {c['label']:8s} {r['verdict']:5s} {r['drift']}  | {c.get('why', '')[:70]}")
        return
    r = analyze(a.clip, a.out or os.path.dirname(os.path.abspath(a.clip)), force=a.force, log=print)
    print(json.dumps(r, indent=1))

if __name__ == "__main__":
    main()

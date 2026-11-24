"""shot_qc.py - one call per generated shot: runs every code check the shot spec allows and maps the
results onto the QC gates. This is the entry point the app calls after each render. @anlim

  python shot_qc.py SPEC.json            (or, in code: shot_qc.run(spec_dict))

Shot spec (only "clip" and "out" are required; every other key switches a check on):
{
  "shot_id": "P013", "clip": "...P013.mp4", "out": "...\\qa\\P013",
  "action": "He packs his things into a box at his desk.",   # given to the AI reviewer, with "cast",
  "cast": {"C01": "the man, grey blazer, black backpack"},    # "wardrobe", "props", "blocking", "notes"
  "render_id": "sc_8f2a", "paid_retries": 1,
  "start_frame": "...\\finals\\P013_final.jpg",   # the approved still the clip must start on
  "min_duration": 6.2,                             # the edit slot (dur_s); the clip must not be shorter
  "size": "1344x768", "fps": 24,
  "camera": "locked",                              # camera_check --expect
  "faces": {"C01": ["...\\C01_master.png"]},       # face_id (photoreal casts only)
  "style": "photo",                                # or "cartoon" (chibi characters counted as people)
  "regions": [{"box": [0.0, 0.25, 1.0, 0.75], "kind": "glass", "expect": 0, "name": "shop window"}],
  "people": 1, "allow_objects": ["handbag"], "track_objects": ["backpack"],   # objects_check
  "driving": {"video": "...frag.mp4", "start": 0.0, "roles": "...roles.json"},   # motion transfer: sync_check
                                                   # (cut timing vs the source) + role_source (swap vs source)
  "use": [4.0, 12.0],                              # seconds of the render the edit uses; issues outside -> flags
  "frame_check": {"roles": "...roles.json", "plate": "...plate.png", "source": null,
                  "previous": null, "window": null},  # full-size export + every-frame checks + viewer
  "ai_review": {"only": "flagged", "max_usd": 0.50,
                "skip_if_code_fail": true, "stop_after_fails": 3}
                                                   # models: ai_review.DEFAULTS (Haiku 5.5 thinking off reviews frames,
                                                   # Sonnet 5.5 second opinion + action check, 2026-11-12). "model" alone
                                                   # pins all three (e.g. "claude-opus-5-5"); "verify_model",
                                                   # "action_model", "thinking" override one each
                                                   # needs frame_check; runs only with ANTHROPIC_API_KEY set
                                                   # AND the estimate under max_usd, else it only packs the task
}
RULE: code checks can FAIL a gate or leave it open; they never PASS one. A gate passes only through
the full-size review (ai_review.py record, which reads shot_qc.json and merges these results).
Writes OUT/shot_qc.json.
"""
import json, os, re, subprocess, sys
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")   # hide OpenCV 5 "Targets are not supported" notices
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from fc_common import probe

GATES = {"A": "Character", "B": "Set", "C": "Anatomy", "D": "Camera", "E": "Motion", "F": "Editorial", "G": "Technical"}

def first_frame(clip, w=640):
    import cv2
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", clip, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                         capture_output=True, check=True).stdout
    im = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    return cv2.resize(im, (w, int(im.shape[0] * w / im.shape[1])))

def start_frame_check(clip, still):
    """Does the clip start on the approved still? (SuperCool batch: 'each clip starts on its finals
    still'; P018 failed 'doesn't start on the still'.) Aligns frame 0 to the still (the edit may
    scale/crop) and returns the share of 16 px blocks that differ."""
    import cv2
    a = first_frame(clip); b = cv2.imread(still)
    if b is None: return {"error": f"cannot read {still}"}
    b = cv2.resize(b, (a.shape[1], int(b.shape[0] * a.shape[1] / b.shape[1])))
    ga, gb = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(3000); ka, da = orb.detectAndCompute(ga, None); kb, db = orb.detectAndCompute(gb, None)
    aligned = False; reframe = None
    if da is not None and db is not None:
        m = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(db, da)
        if len(m) >= 30:
            pb = np.float32([kb[x.queryIdx].pt for x in m]); pa = np.float32([ka[x.trainIdx].pt for x in m])
            M, inl = cv2.estimateAffinePartial2D(pb, pa, method=cv2.RANSAC, ransacReprojThreshold=3.0)
            if M is not None and inl.sum() >= 20:
                gb = cv2.warpAffine(gb, M, (ga.shape[1], ga.shape[0])); aligned = True
                sc = float(np.hypot(M[0, 0], M[1, 0]))
                # where the still's centre lands, as a fraction of the frame width
                cx, cy = ga.shape[1] / 2, ga.shape[0] / 2
                px = M @ np.array([cx, cy, 1.0])
                reframe = {"scale": round(sc, 3), "shift_x": round(float(px[0] - cx) / ga.shape[1], 3),
                           "shift_y": round(float(px[1] - cy) / ga.shape[1], 3)}
    h = min(ga.shape[0], gb.shape[0]) // 16 * 16; w = ga.shape[1] // 16 * 16
    # blur and match brightness/contrast first: the generator and the encoder shift tone and grain,
    # which is not a different picture
    fa = cv2.GaussianBlur(ga[:h, :w], (0, 0), 2).astype(np.float32); fb = cv2.GaussianBlur(gb[:h, :w], (0, 0), 2).astype(np.float32)
    fb = (fb - fb.mean()) / (fb.std() + 1e-6) * fa.std() + fa.mean()
    d = np.abs(fa - fb).reshape(h // 16, 16, w // 16, 16).mean((1, 3))
    return {"aligned": aligned, "reframe": reframe, "blocks_differ_pct": round(float((d > 20).mean()) * 100, 2), "mean_diff": round(float(d.mean()), 2)}

def gate_of_flag(w):
    """frame_check's code flags -> gate, or None for markers that are not defects (a cut, a contact beat
    exported for close review, a neighbour frame) and "flag" for ones a person should look at. Until
    2026-11-10 every marker became gate evidence, so a clip with an ordinary cut failed gate G."""
    w = w.lower()
    if w.startswith(("cut (", "fast motion", "neighbour")) or w == "sweep": return None
    if "outlier" in w or "dark corners" in w or "jumps and returns" in w: return "flag"
    if "swap" in w or "order" in w or "colour" in w or "role" in w: return "A"
    if "plate" in w or "room" in w or "fixture" in w or "structure" in w: return "B"
    if "still" in w or "frozen" in w: return "E"
    if "outside the window" in w or "regenerated" in w: return "G"
    return "G"      # cuts, 1-2 frame outliers, dark corners

ROOT = os.path.dirname(os.path.dirname(HERE))      # the vid_projects folder this tool sits in

def localize(p):
    """A path written on another machine (C:\\vid_projects\\... or /sessions/.../mnt/vid_projects/...)
    is re-based onto this machine's vid_projects folder when it does not exist as written."""
    if not isinstance(p, str) or os.path.exists(p): return p
    q = p.replace("\\", "/"); key = "/vid_projects/"
    i = q.lower().find(key)
    if i < 0: return p
    return os.path.join(ROOT, *[x for x in q[i + len(key):].split("/") if x])

def _walk(x):
    if isinstance(x, dict): return {k: _walk(v) for k, v in x.items()}
    if isinstance(x, list): return [_walk(v) for v in x]
    return localize(x) if isinstance(x, str) and ("/" in x or "\\" in x) else x

def check_deps():
    """Fail early, with the install command, instead of half-way through a shot."""
    import shutil
    missing = []
    for mod, pkg in (("cv2", "opencv-python"), ("numpy", "numpy"), ("PIL", "pillow")):
        try: __import__(mod)
        except ImportError: missing.append(pkg)
    if missing: raise RuntimeError(f"missing Python packages: {', '.join(missing)} - install with: "
                                   f"{sys.executable} -m pip install {' '.join(missing)}")
    for exe in ("ffmpeg", "ffprobe"):
        if not shutil.which(exe): raise RuntimeError(f"{exe} not found on PATH")

def start_people(spec):
    """People the detector counts on the approved start still (regions excluded), or None when not checkable."""
    spec = _walk(spec)
    if not (spec.get("start_frame") and os.path.exists(spec["start_frame"])): return None
    import cv2, objects_check
    D = objects_check.Detector(0.30 if spec.get("style") == "cartoon" else 0.45)
    dets = D.detect(cv2.imread(spec["start_frame"]))
    if spec.get("style") == "cartoon": dets = objects_check.cartoon_people(dets)
    return sum(1 for d in dets if d["cls"] == "person" and not any(objects_check._inside(d["box"], r["box"]) for r in spec.get("regions", [])))

def spec_vs_start(spec):
    """(ok, message): does the spec's head count match the approved start frame? Checked before any
    paid review. On 2026-11-10 a spec that said 5 people and "the man with a box" (an old shot-list line)
    made the AI fail HEAD COUNT and PROPS on every frame of P018, whose approved start frame shows 4 and no box."""
    spec = _walk(spec)
    if not (spec.get("start_frame") and spec.get("people") is not None and os.path.exists(spec["start_frame"])):
        return True, ""
    import cv2, objects_check
    D = objects_check.Detector(0.30 if spec.get("style") == "cartoon" else 0.45)
    dets = D.detect(cv2.imread(spec["start_frame"]))
    if spec.get("style") == "cartoon": dets = objects_check.cartoon_people(dets)
    n0 = sum(1 for d in dets if d["cls"] == "person" and not any(objects_check._inside(d["box"], r["box"]) for r in spec.get("regions", [])))
    if n0 != spec["people"]:
        return False, (f"SPEC CHECK: the spec says {spec['people']} people but the approved start frame shows {n0} "
                       "(detector count) - fix the spec, or confirm it, before a paid review")
    return True, f"spec check: start frame shows {n0} people, as the spec says"

def run(spec, log=print):
    log = log or (lambda *x: None)
    check_deps()
    spec = _walk(spec)
    clip = spec["clip"]; out = spec["out"]
    if not os.path.exists(clip): raise FileNotFoundError(f"clip not found: {clip}")
    os.makedirs(out, exist_ok=True)
    json.dump(spec, open(os.path.join(out, "shot_spec.json"), "w", encoding="utf-8"), indent=1)   # read by ai_review
    code = {g: [] for g in GATES}; ran = []; notes = []; flags = []    # flags: minor, a person should look
    use = spec.get("use")        # [t0, t1] seconds of this render the edit actually uses (EP18: b1 used 4.0-12.0 s)
    def in_use(t0, t1):
        """Does [t0, t1] overlap the part of the clip the edit uses? Problems outside it are reported as flags,
        not failures: EP18 b1 v3's swap at 2.3-3.8 s was outside the 4.0-12.0 s the episode used."""
        return not use or (t1 >= use[0] and t0 <= use[1])
    w, h, fps, dur = probe(clip)
    ran.append("probe")
    if spec.get("size") and f"{w}x{h}" != spec["size"].lower(): code["G"].append(f"size {w}x{h}, spec {spec['size']}")
    if spec.get("fps") and abs(fps - spec["fps"]) > 0.01: code["G"].append(f"frame rate {fps:.3f}, spec {spec['fps']}")
    if spec.get("min_duration") and dur + 1 / fps < spec["min_duration"]:
        code["G"].append(f"clip {dur:.2f} s is shorter than its edit slot {spec['min_duration']:.2f} s")
    start_ok = False                      # True when frame 0 is confirmed to be the approved still
    if spec.get("start_frame"):
        r = start_frame_check(clip, spec["start_frame"]); ran.append("start_frame")
        rf = r.get("reframe")
        moved = bool(rf) and (abs(rf["scale"] - 1) > 0.03 or abs(rf["shift_x"]) > 0.03 or abs(rf["shift_y"]) > 0.03)
        # 2026-11-20 (held-out test): Seedance 2.0 starts every clip on a centred crop of the still (scale x1.067,
        # shift 0.003): its own aspect handling, nothing in the picture changes and Londi passed those clips. A small
        # centred crop (up to x1.10, centre within 1% of the width) is a note, not a gate B failure. Off-centre or
        # larger re-framings still fail (Phase 0 Seedance 2.5 started x1.5).
        crop = moved and 1.0 <= rf["scale"] <= REFRAME_CROP_MAX and abs(rf["shift_x"]) <= 0.01 and abs(rf["shift_y"]) <= 0.01
        start_ok = not r.get("error") and r.get("blocks_differ_pct", 100) <= START_LIMIT and (not moved or crop)
        if r.get("error"): notes.append("start frame: " + r["error"])
        elif crop and r.get("blocks_differ_pct", 100) <= START_LIMIT:
            notes.append(f"start frame: the model starts on a centred crop of the approved still (x{rf['scale']}); "
                         "the picture is the same, its edges are trimmed")
        elif moved:
            code["B"].append(f"starts on a re-framed version of the approved still (scale x{r['reframe']['scale']}, shift "
                             f"{r['reframe']['shift_x']:+.3f} / {r['reframe']['shift_y']:+.3f} of the width)")
        elif r["blocks_differ_pct"] > START_LIMIT:
            code["B"].append(f"does not start on the approved still: {r['blocks_differ_pct']}% of the frame differs"
                             + ("" if r["aligned"] else " (could not align)"))
        elif r["blocks_differ_pct"] > START_NOTE:
            notes.append(f"start frame: {r['blocks_differ_pct']}% of the frame differs from the approved still (fail above {START_LIMIT}%) - look")
        log(f"start frame vs approved still: {r}")
    if spec.get("camera"):
        import camera_check
        r = camera_check.analyze(clip, spec["camera"], log=None); ran.append("camera")
        # Severity: you accepted a 3.2% drift (P009) and called a 4.8% push-in minor (P013); the failed shots
        # moved 6.6% (P020) to 24% (P018). Under 5% (and under 2 degrees of roll) is a FLAG, not a FAIL.
        if r["problems"]:
            segs = r.get("segments", []); mags = []
            for s0 in segs:                       # size of each move the check reported (not of noise on other axes)
                for mv in s0.get("moves", []):
                    m_ = re.search(r"peak ([0-9.]+)", mv)
                    if m_: mags.append(float(m_.group(1)))
                    elif mv in ("push-in", "pull-out"): mags.append(abs(s0.get("end_zoom", 1) - 1))
                    elif mv in ("pan-left", "pan-right"): mags.append(abs(s0.get("end_shift_x", 0)))
                    elif mv in ("tilt-up", "tilt-down"): mags.append(abs(s0.get("end_shift_y", 0)))
            mag = max(mags or [0])
            roll = max([abs(s0.get("end_roll_deg", 0)) for s0 in segs] or [0])
            if mag >= CAM_FAIL or roll >= 2.0 or len(segs) > 1: code["D"] += r["problems"]
            else: flags += [f"minor camera move ({mag:.1%}): {x}" for x in r["problems"]]
        notes += [f"camera, look at {x}" for x in r.get("look_at", [])[:6]]
        log(f"camera: {'; '.join(s0['moves'][0] if len(s0['moves']) == 1 else ', '.join(s0['moves']) for s0 in r['segments'])}")
    if spec.get("faces"):
        import face_id
        r = face_id.analyze(clip, spec["faces"], log=None); ran.append("faces")
        if r.get("error"): notes.append("faces: " + r["error"])
        elif not r["usable"]: notes.append("faces: the model cannot tell these references apart (cartoon?); identity left to review")
        else:
            # A FLAG, not a FAIL: on the 55-clip benchmark the face check failed 5 clips; only 2 were real (P020,
            # P029), and both also failed the camera check. Others: a memory-look grade (P011), a near-threshold
            # match (P001), faces in a photo (P038).
            flags += [f"face: {x}" for x in r["look_at"]]
            notes += [f"face: {x}" for x in r.get("weak", [])[:6]]
            if r.get("turned_away"): notes.append(f"faces turned away (not scored) at {', '.join(r['turned_away'][:8])}")
        log(f"faces: {len(r.get('look_at', []))} to look at")
        # 2026-11-17: analyze() is blind in wide shots (faces 30-50 px) - identity() enlarges the frames and compares
        # each person with their own face in the approved start frame. Photoreal only (cartoon faces are not
        # separable by this model). A FLAG for review, never a FAIL. Calibration in face_id.py.
        if spec.get("start_frame") and spec.get("style", "photo") != "cartoon" and os.path.exists(spec["start_frame"]):
            ri = face_id.identity(clip, spec["faces"], spec["start_frame"]); ran.append("identity")
            if ri.get("error"): notes.append("identity: " + ri["error"])
            flags += [f"FACE: {x}" for x in ri.get("drift", [])]
            notes += [f"identity: {x}" for x in ri.get("unchecked", [])]
            log(f"identity: {ri.get('people')}")
    # 2026-11-24: a crowd shot's background frozen like a backdrop (crowd_still.py; still camera only). A flag for a
    # person, never a failure: calibrated on two classroom clips.
    crowd_moves = None                 # handed to the action check: a measurement outranks "frozen" seen in small frames
    if spec.get("crowd"):
        try:
            import crowd_still
            cs = crowd_still.analyze(clip); ran.append("crowd_still")
            if cs.get("measured") and not cs.get("frozen"):
                crowd_moves = (f"{round((1 - cs['still_share']) * 100)}% of the picture keeps changing over the clip (still camera, "
                               "measured on every part of the full-size frames), so a crowd in it is most likely moving; rain or "
                               "the main subject can add to this number")
            if cs.get("frozen"): flags.append(cs["why"])
            elif not cs.get("measured"): notes.append(f"crowd still: not measured ({cs.get('why')})")
            log(f"crowd still: {({k: v for k, v in cs.items() if k != 'regions'})}")
        except Exception as e:
            notes.append(f"crowd still failed: {type(e).__name__}: {str(e)[:150]}")
    if spec.get("people") is not None or spec.get("track_objects"):
        import objects_check
        r = objects_check.analyze(clip, spec.get("people"), spec.get("allow_objects", []), spec.get("track_objects", []),
                                  style=spec.get("style", "photo"), regions=spec.get("regions", []), log=None)
        ran.append("objects")
        # Extra people already in the APPROVED start still are a spec question, not a generation defect: the
        # still was approved, so either the spec's head count is wrong (extras, a photo) or the detector
        # miscounts. 2026-11-10: the last two false fails of the benchmark (P010 - a photo with two people -
        # and P027) were "2 people at 0.0 s, the shot calls for 1". People who appear DURING the shot (more
        # than the still shows) still fail: P020, P053.
        n_start = start_people(spec) if spec.get("people") is not None else None
        # The clip's own frame 0 counts as the approved start when the start check confirmed it IS the still:
        # the detector can disagree between the still and the video frame (P010: the people in a held photo
        # score 0.47 on the clip, under 0.45 on the 2688 px still).
        pps = r.get("people_per_sample") or []
        if n_start is not None and start_ok and pps: n_start = max(n_start, int(pps[0]))
        for pr in r["problems"]:
            m_ = re.match(r"PEOPLE: (\d+) people at", pr)
            if m_ and n_start is not None and n_start > spec["people"] and int(m_.group(1)) <= n_start:
                flags.append(f"SPEC CHECK: {pr} - the approved start already shows {n_start} (detector count; a photo or poster counts too); confirm the spec's head count")
                continue
            code["A" if pr.startswith(("PEOPLE", "REFLECTION")) else "E"].append(pr)
        notes += [f"objects: {x}" for x in r.get("look_at", [])[:6]]
        log(f"objects: people per sample {r.get('people_per_sample')}")
    if spec.get("driving"):
        # Motion transfer: compare with the driving video (EP18 lessons, 2026-11-10)
        dv = spec["driving"]; src = dv["video"]; st = float(dv.get("start", 0))
        import sync_check
        r = sync_check.analyze(clip, src, start=st, log=None); ran.append("sync")
        for x in r["issues"]:
            t0 = x.get("t", 0)
            if x["kind"] == "drift":
                (code["F"] if in_use(t0, 1e9) else flags).append("SYNC: " + x["text"])
            elif x["kind"] == "cut_off": flags.append("SYNC: " + x["text"])
            else: notes.append("sync: " + x["text"])
        if dv.get("roles"):
            import role_source
            r = role_source.analyze(clip, src, json.load(open(dv["roles"])), step=int(dv.get("step", 4)), start=st, log=None)
            ran.append("roles_vs_source")
            rfps = probe(clip)[2]
            for x in r["issues"]:
                if x["kind"] == "role_swap":
                    t0, t1 = x["from_frame"] / rfps, x["to_frame"] / rfps
                    if r["verdict"] == "FAIL" and in_use(t0, t1): code["A"].append("ROLE SWAP vs source: " + x["text"])
                    else: flags.append("role swap vs source (" + r["verdict"] + ("" if in_use(t0, t1) else ", outside the used window") + "): " + x["text"])
                else: notes.append("roles vs source: " + x["text"])
    if spec.get("frame_check") is not None:
        fc = spec["frame_check"] or {}
        cmd = [sys.executable, os.path.join(HERE, "frame_check.py"), clip, "--out", out]
        for k in ("roles", "plate", "source", "previous", "window"):
            if fc.get(k): cmd += [f"--{k}", str(fc[k])]
        dm = fc.get("dense_motion", 20 if spec.get("driving") else 0)      # fights / motion transfer: on by default
        if dm: cmd += ["--dense-motion", str(dm)]
        p = subprocess.run(cmd, capture_output=True, text=True); ran.append("frame_check")
        if p.returncode: notes.append("frame_check failed: " + p.stderr.strip()[-300:])
        else:
            man = json.load(open(os.path.join(out, "manifest.json")))
            for f in man["frames"]:
                for wv in f.get("why", []):
                    g = gate_of_flag(wv)
                    if g is None: continue
                    line = f"{f['key']} ({f.get('t', 0):.2f} s): {wv}"
                    if g == "flag" or not in_use(f.get("t", 0), f.get("t", 0)): flags.append(line + ("" if in_use(f.get("t", 0), f.get("t", 0)) else " [outside the used window]"))
                    else: code[g].append(line)
    # The spec must agree with the approved start frame before any paid review: on 2026-11-10 a spec that
    # said 5 people and "the man with a box" (an old shot-list line) made the AI fail HEAD COUNT and PROPS
    # on every frame of P018, whose approved start frame shows 4 people and no box.
    spec_ok, msg = spec_vs_start(spec)
    if not spec_ok: notes.append(msg)
    elif msg: log(msg)
    ai = spec.get("ai_review")
    if ai is not None and not spec_ok and not ai.get("force"):
        notes.append("ai_review: NOT RUN - the spec does not match the approved start frame (set \"force\": true to run anyway)")
        ai = None
    # A shot the cheap code checks already failed goes back for re-generation; the paid review would only
    # confirm it (P018, 2026-11-10: code failed B, D, G; the review then failed all 45 frames for $0.71-1.39).
    if ai is not None and any(code.values()) and ai.get("skip_if_code_fail", True):
        notes.append("ai_review: NOT RUN - the code checks already failed this shot (set \"skip_if_code_fail\": false to review anyway)")
        ai = None
    if ai is not None:
        import argparse as _ap, ai_review
        if not os.path.exists(os.path.join(out, "manifest.json")):
            notes.append("ai_review: needs \"frame_check\" in the spec (no exported frames)")
        else:
            only = ai.get("only", "flagged"); price = float(ai.get("price_per_m", 4.0)); cap = float(ai.get("max_usd", 0.5))
            m_rev = ai.get("model", ai_review.DEFAULTS["review_model"])
            m_ver = ai.get("verify_model", ai.get("model", ai_review.DEFAULTS["verify_model"]))
            m_act = ai.get("action_model", ai.get("model", ai_review.DEFAULTS["action_model"]))
            think = ai.get("thinking", ai_review.DEFAULT_THINKING.get(m_rev))
            ai_review.cmd_pack(_ap.Namespace(dir=out, rules=ai.get("rules"), only=only)); ran.append("ai_pack")
            n, tok, usd = ai_review.estimate(out, only, price, m_rev, ai.get("rules"))
            if not os.environ.get("ANTHROPIC_API_KEY"):
                notes.append(f"ai_review: packed {n} frames (about ${usd:.2f}); not run - ANTHROPIC_API_KEY not set")
            elif usd > cap:
                notes.append(f"ai_review: packed {n} frames; not run - estimate ${usd:.2f} is over the ${cap:.2f} cap")
            else:
                ai_review.cmd_api(_ap.Namespace(dir=out, rules=ai.get("rules"), only=only, model=m_rev, thinking=think,
                                                price=price, yes=True, stop_after=int(ai.get("stop_after_fails", 3)),
                                                verdicts=None, force=False)); ran.append(f"ai_api {m_rev} (${usd:.2f} est.)")
            v_, kept, dropped, vusd = ai_review.verify_fail(out, m_ver, log=log)
            if v_ == "FAIL": code["E"] += [f"AI review (second opinion confirmed): {k}" for k in kept]
            elif v_ == "FLAG": flags += [f"AI review: {x}" for x in dropped][:6]
            if vusd: ran.append(f"ai_verify (${vusd:.2f})")
            # Clip-level action check (blind description, then comparison with the action text). On by default with
            # the AI review; "action_check": false in the ai_review block turns it off. 2026-11-11 benchmark: caught
            # P030 (reversed hand-off) that no frame rule saw, 0 good clips failed.
            if ai.get("action_check", True) and spec.get("action") and os.environ.get("ANTHROPIC_API_KEY"):
                import action_check
                act = re.sub(r"\s*\(wording from the shot manifest, unedited\)\s*$", "", spec["action"])
                try:
                    ar = action_check.analyze(clip, act, out, m_act, use=spec.get("use"), log=log, measured=crowd_moves)
                    ran.append(f"action_check (${ar.get('usd', 0):.2f})")
                    newv, why_ = action_check.apply("PASS", ar)
                    if newv.startswith("FAIL"): code["E"].append(why_)
                    elif why_: flags.append(why_)
                except Exception as e:
                    notes.append(f"action_check failed: {type(e).__name__}: {str(e)[:150]}")
            ran.append("ai_verify")
    res = {"shot_id": spec.get("shot_id"), "clip": clip, "render_id": spec.get("render_id"),
           "paid_retries": spec.get("paid_retries"), "checks_run": ran, "notes": notes,
           "code_gates": {f"QC-{g} {GATES[g]}": ("FAIL" if code[g] else "no code flags") for g in GATES},
           "evidence": {f"QC-{g}": code[g] for g in GATES if code[g]},
           "flags": flags,
           "verdict": "FAIL" if any(code.values()) else ("FLAG" if flags else "NEEDS REVIEW")}
    json.dump(res, open(os.path.join(out, "shot_qc.json"), "w"), indent=1)
    log(f"{spec.get('shot_id') or clip}: {res['verdict']}  (checks: {', '.join(ran)})")
    for g, ev in res["evidence"].items():
        for e in sorted(ev, key=lambda e: e.startswith("face:"))[:5]: log(f"  {g}: {e}")
        if len(ev) > 5: log(f"  {g}: ... {len(ev) - 5} more in shot_qc.json")
    for fl in flags[:5]: log(f"  FLAG: {fl}")
    for n in notes[:8]: log(f"  note: {n}")
    return res

# % of 16 px blocks that differ after aligning, blurring and matching tone. On 20 SuperCool clips
# (2026-11-10) frame 0 vs its approved still: 0-2.5% for clips that start on it, 4.6% for P049 and P053
# (not checked by eye). A small missing prop is under 1% of the frame, so this catches a different
# picture, not a detail; details stay with the full-size review.
CAM_FAIL = 0.05
START_LIMIT = 8.0    # was 5.0: two good clips (P026 5.45%, P054 5.11%) failed on it in the 55-clip benchmark
START_NOTE = 4.0
REFRAME_CROP_MAX = 1.10   # centred crop a model may apply to the start still (Seedance 2.0: x1.067) - a note, not a FAIL

if __name__ == "__main__":
    run(json.load(open(sys.argv[1], encoding="utf-8")))

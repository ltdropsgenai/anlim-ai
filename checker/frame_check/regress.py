"""regress.py - re-run every labelled case after a change to the QC tools, and show what got better or worse. @anlim

Why: the checks interact. On 2026-11-10 the second opinion fixed three false fails and quietly turned a real
defect (P002, tangled fingers) into a FLAG; it was only noticed because the whole benchmark was re-run by hand.
This runs all of it in one command, never calls the paid API, and never changes the saved test data.

  python regress.py                 quick: unit tests + EP18 sync and fast-motion cases (about 2-3 min)
  python regress.py --full          + EP18 role-vs-source cases and the 55-clip SuperCool rescore (about 15 min)
  python regress.py --full --accept make this run's benchmark verdicts the new baseline (after you checked them)
  python regress.py --only sync     run the cases whose id contains "sync"

Cases live in regress_cases.json (paths relative to the vid_projects folder, so the same file works on the PC
and in the cloud session). A case whose files are missing is SKIPPED, never passed.
Results: _tests/regress/report_<time>.txt and last.json. Exit code 1 when anything FAILED or ERRORED.

Status per case: PASS (as expected) | FAIL (not as expected: a regression or a broken check) | SKIP | ERROR.
Benchmark: every clip's verdict is compared with the accepted baseline and ranked against the human label
(good clip: PASS > FLAG > FAIL; bad clip: FAIL > FLAG > PASS), so a change reads as BETTER or WORSE per clip.
The benchmark case FAILS when any clip got worse or a bad clip passed.
"""
import argparse, csv, io, json, os, shutil, subprocess, sys, tempfile, time, traceback
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))                 # ...\vid_projects
CASES = os.path.join(HERE, "regress_cases.json")
BASE = os.path.join(HERE, "regress_baseline.json")
OUTD = os.path.join(HERE, "_tests", "regress")

def P(rel): return os.path.join(ROOT, *rel.replace("\\", "/").split("/"))

class Skip(Exception): pass

def need(*paths):
    miss = [p for p in paths if not os.path.exists(p)]
    if miss: raise Skip("missing: " + ", ".join(os.path.relpath(m, ROOT) for m in miss[:3]))

def no_api():
    """Make any paid call impossible inside this process."""
    os.environ.pop("ANTHROPIC_API_KEY", None)
    import urllib.request
    def refuse(*a, **k): raise RuntimeError("regress.py: an API call was attempted")
    urllib.request.urlopen = refuse

# ---------------------------------------------------------------- unit tests (no video, instant)
def u_first_json(c):
    import ai_review as A
    got = [A.first_json('x {"a": 1}\n{"b": 2} tail'), A.first_json('{"decision": "REJECTED", "why": "a {b} c"}')]
    want = [{"a": 1}, {"decision": "REJECTED", "why": "a {b} c"}]
    return got == want, got, want

def u_keep_rule(c):
    import ai_review as A
    table = {"UUU": True, "RRR": False, "CRC": True, "UUR": False, "CR": False, "UR": False, "RR": False, "CC": True, "UU": True}
    m = {"C": "CONFIRMED", "R": "REJECTED", "U": "UNCERTAIN"}
    got = {k: A.keep_rule([m[x] for x in k]) for k in table}
    return got == table, got, table

def u_clip_verdict(c):
    import ai_review as A
    man = {"frames": [{"key": f"f{i}"} for i in (0, 4, 8, 12, 16, 20, 24, 28, 32, 36)]}
    F = lambda *r: {"checks": {x: "FAIL" for x in r}}
    P = {"checks": {"ANATOMY": "PASS", "EVERY CREATURE": "PASS", "HEAD COUNT": "PASS"}}
    cases = {
        "two consecutive -> FAIL":          ({"f0": F("ANATOMY"), "f4": F("ANATOMY")}, None, "FAIL"),
        "single frame -> FLAG":             ({"f4": F("ANATOMY")}, None, "FLAG"),
        "not consecutive -> FLAG":          ({"f0": F("ANATOMY"), "f8": F("ANATOMY")}, None, "FLAG"),
        "minor rule never fails":           ({"f0": F("MOUTHS"), "f4": F("MOUTHS")}, None, "FLAG"),
        "code camera decides camera":       ({"f0": F("CAMERA"), "f4": F("CAMERA")}, True, "PASS"),
        "camera consequences ignored":      ({"f0": F("CAMERA", "SET LAYOUT"), "f4": F("CAMERA", "SET LAYOUT")}, True, "PASS"),
        "AI camera without code camera":    ({"f0": F("CAMERA"), "f4": F("CAMERA")}, None, "FAIL"),
        "nothing failed -> PASS":           ({"f0": {"checks": {"ANATOMY": "PASS"}}}, None, "PASS"),
        "set text only flags":              ({"f0": F("TEXT"), "f4": F("TEXT")}, None, "FLAG"),
        "text forbidden by spec fails":     ({"f0": F("TEXT"), "f4": F("TEXT")}, "NO_TEXT", "FAIL"),
        # sweep after an early stop: f20..f36 reviewed with gaps (path test clip 15, creatures in f120/f136/f156)
        "sweep: 3 in a row reviewed -> FAIL": ({"f0": P, "f20": F("EVERY CREATURE"), "f28": F("EVERY CREATURE"), "f36": F("EVERY CREATURE")}, None, "FAIL"),
        "sweep: 2 in a row reviewed -> FLAG": ({"f0": P, "f20": F("EVERY CREATURE"), "f28": F("EVERY CREATURE")}, None, "FLAG"),
        "sweep: reviewed pass between -> FLAG": ({"f12": F("HEAD COUNT"), "f20": F("HEAD COUNT"), "f24": P, "f32": F("HEAD COUNT")}, None, "FLAG"),
        "sweep: minor rule still only flags": ({"f20": F("MOUTHS"), "f28": F("MOUTHS"), "f36": F("MOUTHS")}, None, "FLAG"),
    }
    got = {k: (A.clip_verdict(man, v, None, True) if cam == "NO_TEXT" else A.clip_verdict(man, v, cam))[0] for k, (v, cam, _) in cases.items()}
    got["sweep 8 of 20"] = [x for x in A.sweep_pick(list(range(20)), 8)]
    got["sweep 3 of 3"] = A.sweep_pick([5, 6, 7], 8)
    want = {k: w for k, (_, _, w) in cases.items()}
    want["sweep 8 of 20"] = [0, 3, 5, 8, 11, 14, 16, 19]; want["sweep 3 of 3"] = [5, 6, 7]
    return got == want, got, want

def u_gate_of_flag(c):
    import shot_qc as S
    table = {"cut (change 56.2)": None, "fast motion (every frame reviewed)": None, "neighbour of flagged frame": None,
             "sweep": None, "1-frame outlier (x3.1)": "flag", "dark corners (40 vs clip 90)": "flag",
             "ipman jumps and returns (frames 104-107)": "flag", "role order flip left/right: a vs b": "A",
             "plate: room scale changes within shot (0.9 to 1.0)": "B", "still image: frames 0-60 do not change (mean change 0.01)": "E",
             "re-render: changed vs previous version outside the fixed window (diff 9.0, noise 1.0)": "G"}
    got = {k: S.gate_of_flag(k) for k in table}
    return got == table, got, table

def u_sync_classify(c):
    import sync_check as Y
    m = lambda *offs: [{"offset": o, "render_frame": 10 * (i + 1)} for i, o in enumerate(offs)]
    cases = {
        "b1 rejected: -2 x4":           (m(0.2, -2, -2, -2.2, -2), 1, 0),
        "b3 rejected: -1.2 -1.2 -1.8":  (m(0.6, 0.2, 0, -1.2, -1.2, -1.8, -0.4), 1, 0),
        "approved: within +-0.8":       (m(0.6, 0.2, 0, -0.2, -0.2, -0.8, 0.6), 0, 0),
        "noise: +1.6 then -1.4":        (m(1.6, -1.4, 0.2, 0.2), 0, 0),
        "two cuts 2+ off = drift":      (m(0, -2.5, -3), 1, 0),
        "lone tail cut 8 off = single": (m(0.2, -0.2, -8.2), 0, 1),
    }
    got = {k: [len(x) for x in Y.classify(p)] for k, (p, _, _) in cases.items()}
    want = {k: [r, s] for k, (_, r, s) in cases.items()}
    return got == want, got, want

def u_verify_missing_frames(c):
    """A failing rule whose frames are gone from disk (or can't be asked offline) stays FAIL, unverified (bug S2)."""
    import ai_review as A
    d = tempfile.mkdtemp(prefix="regress_")
    try:
        man = {"kind": "video", "clip": "x.mp4", "fps": 24, "frames": [{"key": k, "i": i, "t": i / 24, "out": f"out_{k}.png", "why": ["sweep"]}
                                                                      for i, k in ((0, "f0"), (4, "f4"))]}
        json.dump(man, open(os.path.join(d, "manifest.json"), "w"))
        with open(os.path.join(d, "verdicts.jsonl"), "w") as fh:
            for k in ("f0", "f4"): fh.write(json.dumps({"key": k, "verdict": "FAIL", "checks": {"ANATOMY": "FAIL"}, "issues": []}) + "\n")
        v, kept, dropped, usd = A.verify_fail(d, log=None)
        got = {"verdict": v, "kept": len(kept), "usd": usd}
        want = {"verdict": "FAIL", "kept": 1, "usd": 0.0}
        return got == want, got, want
    finally:
        shutil.rmtree(d, ignore_errors=True)

def u_verify_flag_reasons(c):
    """A clip the AI review only FLAGs returns its reasons (bug S1: shot_qc showed FLAG with no reason)."""
    import ai_review as A
    d = tempfile.mkdtemp(prefix="regress_")
    try:
        man = {"kind": "video", "clip": "x.mp4", "fps": 24, "frames": [{"key": "f0", "i": 0, "t": 0, "out": "o.png", "why": ["sweep"]}]}
        json.dump(man, open(os.path.join(d, "manifest.json"), "w"))
        open(os.path.join(d, "verdicts.jsonl"), "w").write(json.dumps({"key": "f0", "checks": {"ANATOMY": "FAIL"}}) + "\n")
        v, kept, dropped, usd = A.verify_fail(d, log=None)
        return (v == "FLAG" and len(dropped) == 1), {"verdict": v, "reasons": dropped}, {"verdict": "FLAG", "reasons": "1 line"}
    finally:
        shutil.rmtree(d, ignore_errors=True)

def u_repair_plan(c):
    """Decision rules from how EP18 was repaired (render log 2026-11-10), on synthetic cuts."""
    import repair_plan as R
    cuts = [40, 99, 105, 208, 266]
    D = lambda a, b, **k: dict({"from": a, "to": b}, **k)
    def acts(dd, use=None, n=289): return [x["action"] for x in R.plan(dd, n, 24.0, cuts, use)["actions"]]
    got = {
        "outside use -> ignore":        acts([D(60, 91, kind="role_swap")], use=[4.0, 12.0]),
        "third hand 3 fr -> edit":      acts([D(181, 183, rule="ANATOMY", note="third hand at her belt", box=[.45, .55, .55, .7])]),
        "pouch 4 fr -> edit":           acts([D(63, 66, rule="WARDROBE", note="pouch at his hip")]),
        "big box -> rerender":          acts([D(63, 66, rule="WARDROBE", note="jacket", box=[0, 0, .6, .6])]),
        "kick as hand -> rerender":     acts([D(100, 103, rule="ANATOMY", note="kick end drawn as a hand")]),
        "two close -> one rerender":    acts([D(208, 223, rule="ANATOMY", note="hand drawn as a shoe"), D(233, 259, kind="role_swap")]),
        "most of clip -> full":         acts([D(10, 90, kind="role_swap"), D(120, 250, rule="IDENTITY")]),
        "tail, no use -> trim":         acts([D(280, 288, rule="SOURCE MATCH")]),
        "sync -> retime":               acts([D(103, 288, kind="sync")]),
    }
    want = {"outside use -> ignore": ["ignore"], "third hand 3 fr -> edit": ["pixel_edit"], "pouch 4 fr -> edit": ["pixel_edit"],
            "big box -> rerender": ["rerender"], "kick as hand -> rerender": ["rerender"], "two close -> one rerender": ["rerender"],
            "most of clip -> full": ["full_rerender"], "tail, no use -> trim": ["trim"], "sync -> retime": ["retime"]}
    pl = R.plan([D(100, 103, rule="ANATOMY", note="kick")], 289, 24.0, cuts)["actions"][0]
    got["in/out on cuts"] = [pl["replace"], pl["in_point"], pl["out_point"]]; want["in/out on cuts"] = [[99, 104], "cut", "cut"]
    return got == want, got, want

def u_verify_errors(c):
    """A second-opinion reply with no JSON is retried once; if it still has none it is an ERROR left out of the vote,
    never an UNCERTAIN (Phase 0 2026-11-11: "check failed: substring not found" counted as U kept a rule failed).
    Mocked API, no spend."""
    import ai_review as A
    d = tempfile.mkdtemp(prefix="regress_vf_")
    replies = {"f0": ["I cannot judge this frame.", '{"decision": "REJECTED", "why": "occlusion"}'],   # retry rescues it
               "f4": ["no json", "still no json"],                                                     # ERROR, not counted
               "f8": ['{"decision": "REJECTED", "why": "motion blur"}']}
    asked = []
    def fake(model, key, system, content, max_tokens=2000):
        txt = json.dumps(content); k = next(x for x in replies if f"ZQ_{x}_ZQ" in txt)
        asked.append((k, max_tokens)); return replies[k].pop(0), {}
    old, oldk = A._call, os.environ.get("ANTHROPIC_API_KEY")
    A._call = fake; os.environ["ANTHROPIC_API_KEY"] = "test"
    try:
        keys = [("f0", 0), ("f4", 4), ("f8", 8)]
        man = {"kind": "video", "clip": "x.mp4", "fps": 24, "frames": [{"key": k, "i": i, "t": i / 24, "out": f"out_{k}.png", "why": ["sweep"]}
                                                                      for k, i in keys]}
        json.dump(man, open(os.path.join(d, "manifest.json"), "w"))
        with open(os.path.join(d, "verdicts.jsonl"), "w") as fh:
            for k, _ in keys:
                subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x36", "-frames:v", "1",
                                os.path.join(d, f"out_{k}.png")], check=True)
                fh.write(json.dumps({"key": k, "verdict": "FAIL", "checks": {"ANATOMY": "FAIL"},
                                     "issues": [{"rule": "ANATOMY", "note": f"ZQ_{k}_ZQ melted hand"}]}) + "\n")
        v, kept, dropped, usd = A.verify_fail(d, log=None, force=True)
        line = (kept + dropped)[0]
        got = {"verdict": v, "dropped": len(dropped), "f4 is ERROR": "f4 ERROR (not counted)" in line,
               "no UNCERTAIN": "UNCERTAIN" not in line, "retry budget": [t for k, t in asked if k == "f0"]}
        want = {"verdict": "FLAG", "dropped": 1, "f4 is ERROR": True, "no UNCERTAIN": True, "retry budget": [600, 1200]}
        return got == want, got, want
    finally:
        A._call = old
        if oldk is None: os.environ.pop("ANTHROPIC_API_KEY", None)
        else: os.environ["ANTHROPIC_API_KEY"] = oldk
        shutil.rmtree(d, ignore_errors=True)

def u_request_options(c):
    """Reviewer cost controls map to the documented Messages API fields (effort -> output_config.effort,
    thinking -> thinking.type); nothing is sent when neither is set, so the model's defaults apply."""
    import ai_review as A
    got = [A.request_options(), A.request_options("low"), A.request_options(None, "between_tools"), A.request_options("high", "disabled")]
    want = [{}, {"output_config": {"effort": "low"}}, {"thinking": {"type": "between_tools"}},
            {"output_config": {"effort": "high"}, "thinking": {"type": "disabled"}}]
    return got == want, got, want

def u_default_models(c):
    """The checker's default models (chosen 2026-11-12, exp_review.py): Haiku 5.5 reviews frames with thinking off;
    Sonnet 5.5 gives second opinions and checks the action. A change here must be re-benchmarked first."""
    import ai_review as A
    got = (A.DEFAULTS, A.DEFAULT_THINKING.get(A.DEFAULTS["review_model"]), A.DEFAULT_THINKING.get("claude-sonnet-5-5"))
    want = ({"review_model": "claude-haiku-5-5", "verify_model": "claude-sonnet-5-5", "action_model": "claude-sonnet-5-5"}, "disabled", None)
    return got == want, got, want

def u_foot_slide_apply(c):
    """foot_slide_check.apply (2026-11-17): SLIDE flags; only OK with high confidence lifts the walk guard; FAIL stays."""
    import foot_slide_check as FS
    ev = {"verdict": "SLIDE", "confidence": "high", "events": [{"from_t": 1.0, "to_t": 1.5, "what": "left foot glides"}]}
    got = {"slide on pass": FS.apply("PASS", ev, True)[0], "slide on walk flag": FS.apply("FLAG (walk)", ev, True)[0],
           "ok high lifts": FS.apply("FLAG (walk)", {"verdict": "OK", "confidence": "high"}, True)[0],
           "ok medium holds": FS.apply("FLAG (walk)", {"verdict": "OK", "confidence": "medium"}, True)[0],
           "ok high, other flag": FS.apply("FLAG", {"verdict": "OK", "confidence": "high"}, True)[0],
           "unsure holds": FS.apply("FLAG (walk)", {"verdict": "UNSURE", "confidence": "low"}, True)[0],
           "fail stays": FS.apply("FAIL (AI)", ev, True)[0]}
    want = {"slide on pass": "FLAG", "slide on walk flag": "FLAG", "ok high lifts": "PASS", "ok medium holds": "FLAG (walk)",
            "ok high, other flag": "FLAG", "unsure holds": "FLAG (walk)", "fail stays": "FAIL (AI)"}
    return got == want, got, want

def u_pipeline_flow(c):
    """pipeline.check_clip (the app's checker service) maps results the way batch_eval scores them, and passes the
    default models through. Every step mocked, no spend: code FAIL stops; over-budget is NOT_REVIEWED; an AI FAIL the
    second opinion keeps is FAIL; one it drops stays a FLAG when a severe rule remains (WARDROBE); a single unconfirmed
    ANATOMY frame is a note, PASS (photoreal since 2026-11-17, as cartoon); a high-confidence action FAIL turns PASS into FAIL."""
    import types, pipeline, ai_review as A, shot_qc
    d = tempfile.mkdtemp(prefix="regress_pl_")
    man = {"frames": [{"key": f"f{i}", "t": i / 24, "out": f"f{i}.png"} for i in (0, 4, 8)]}
    json.dump(man, open(os.path.join(d, "manifest.json"), "w"))
    calls = {}
    def run_case(code="NEEDS REVIEW", est=0.05, ver=None, cv="PASS", keep=True, action=None):
        saved = (shot_qc.run, A.estimate, A.cmd_api, A.cmd_apply, A.clip_verdict, A.verify_fail, A.code_camera_ok, A.spec_text_forbidden)
        shot_qc.run = lambda spec, log=None: {"verdict": code, "evidence": {"QC-C": ["hand"]} if code == "FAIL" else {}, "notes": [], "flags": []}
        A.estimate = lambda *a, **k: (3, 1000, est)
        def api(ns): calls["review"] = (ns.model, ns.thinking); return 0.02
        A.cmd_api = api
        A.cmd_apply = lambda ns: ver or {}
        A.clip_verdict = lambda *a: (cv, ["ANATOMY: 2 frame(s)"] if cv == "FAIL" else [], ["ANATOMY: 1 frame(s)"] if cv == "FLAG" else [])
        def vf(out, model, log=None): calls["verify"] = model; return ("FAIL", ["kept"], [], 0.01) if keep else ("FLAG", [], ["WARDROBE: 1 frame(s) f4"], 0.01)
        A.verify_fail = vf; A.code_camera_ok = lambda d: None; A.spec_text_forbidden = lambda d: False
        ac = sys.modules.get("action_check")
        if action is not None:
            fake = types.ModuleType("action_check")
            def an(clip, act, out, model, use=None, log=None): calls["action"] = model; return dict(action, usd=0.02)
            fake.analyze = an
            fake.apply = lambda v, ar: ("FAIL (action)", "action: wrong") if ar["verdict"] == "FAIL" and ar.get("confidence") == "high" and not v.startswith("FAIL") else (v, "")
            sys.modules["action_check"] = fake
        try:
            spec = {"clip": "x.mp4", "out": d, "action": "hands over the truck" if action is not None else ""}
            return pipeline.check_clip(spec)["verdict"]
        finally:
            (shot_qc.run, A.estimate, A.cmd_api, A.cmd_apply, A.clip_verdict, A.verify_fail, A.code_camera_ok, A.spec_text_forbidden) = saved
            if ac is not None: sys.modules["action_check"] = ac
            else: sys.modules.pop("action_check", None)
    got = {"code FAIL": run_case(code="FAIL"), "over budget": run_case(est=0.50), "AI FAIL kept": run_case(cv="FAIL"),
           "AI FAIL dropped": run_case(cv="FAIL", keep=False), "single frame": run_case(cv="FLAG"), "clean": run_case(),
           "action FAIL high": run_case(action={"verdict": "FAIL", "confidence": "high"}), "models": dict(calls)}
    want = {"code FAIL": "FAIL", "over budget": "NOT_REVIEWED", "AI FAIL kept": "FAIL", "AI FAIL dropped": "FLAG",
            "single frame": "PASS", "clean": "PASS", "action FAIL high": "FAIL",
            "models": {"review": ("claude-haiku-5-5", "disabled"), "verify": "claude-sonnet-5-5", "action": "claude-sonnet-5-5"}}
    return got == want, got, want

def u_cartoon_people_nested(c):
    """One cartoon child seen twice - a head-and-torso "teddy bear" box inside his full-body "person" box - counts
    as one person (app clip S2 at 3.5 s, 2026-11-12: IoU 0.47 passed NMS, 3 people counted, false FAIL). Two
    children standing side by side, boxes touching, still count as two."""
    import objects_check as O
    king = [{"cls": "person", "score": 0.36, "box": [0.43, 0.17, 0.25, 0.82]},
            {"cls": "teddy bear", "score": 0.37, "box": [0.44, 0.10, 0.21, 0.56]}]
    layana = {"cls": "person", "score": 0.66, "box": [0.10, 0.17, 0.26, 0.78]}
    pair = [{"cls": "person", "score": 0.8, "box": [0.20, 0.20, 0.22, 0.70]}, {"cls": "person", "score": 0.8, "box": [0.40, 0.20, 0.22, 0.70]}]
    n = lambda d: sum(1 for x in O.cartoon_people(d) if x["cls"] == "person")
    got = {"S2 at 3.5 s": n(king + [layana]), "side by side": n(pair)}
    want = {"S2 at 3.5 s": 2, "side by side": 2}
    return got == want, got, want

def u_pipeline_passthrough(c):
    """pipeline.check_clip runs the furniture check when the start frame shows furniture OR the action moves someone,
    turns a clean PASS into FLAG on THROUGH/CONTACT with a timeline mark, and leaves a FAIL alone (no spend).
    Every API step mocked."""
    import pipeline, ai_review as A, shot_qc, passthrough_check as PT
    d = tempfile.mkdtemp(prefix="regress_pt_")
    json.dump({"frames": [{"key": "f0", "t": 0.0, "out": "f0.png"}]}, open(os.path.join(d, "manifest.json"), "w"))
    asked = []
    def run_case(cv="PASS", pt="THROUGH", furn=("dining table",), action="Layana walks to the shelf"):
        saved = (shot_qc.run, A.estimate, A.cmd_api, A.cmd_apply, A.clip_verdict, A.verify_fail, A.code_camera_ok,
                 A.spec_text_forbidden, PT.furniture_in, PT.analyze, sys.modules.get("action_check"))
        shot_qc.run = lambda spec, log=None: {"verdict": "NEEDS REVIEW", "evidence": {}, "notes": [], "flags": []}
        A.estimate = lambda *a, **k: (1, 100, 0.01); A.cmd_api = lambda ns: 0.01; A.cmd_apply = lambda ns: {}
        A.clip_verdict = lambda *a: (cv, ["X: 2 frame(s)"] if cv == "FAIL" else [], [])
        A.verify_fail = lambda out, model, log=None: ("FAIL", ["kept"], [], 0.0)
        A.code_camera_ok = lambda d: None; A.spec_text_forbidden = lambda d: False
        PT.furniture_in = lambda *a, **k: list(furn)
        def an(clip, out, model, start=None, ask_always=False, log=None):
            asked.append(model); return {"verdict": pt, "confidence": "medium", "usd": 0.02,
                                         "events": [{"from_t": 1.5, "to_t": 2.75, "what": "feet between the table legs"}]}
        PT.analyze = an
        import types; fake = types.ModuleType("action_check")
        fake.analyze = lambda *a, **k: {"verdict": "PASS", "usd": 0.0}; fake.apply = lambda v, ar: (v, "")
        sys.modules["action_check"] = fake
        try:
            r = pipeline.check_clip({"clip": "x.mp4", "out": d, "action": action, "start_frame": "s.png", "walk_guard": False})
            return r["verdict"], len([f for f in r["frame_flags"] if f["frame"].startswith("pt")]), r.get("passthrough_usd", 0)
        finally:
            (shot_qc.run, A.estimate, A.cmd_api, A.cmd_apply, A.clip_verdict, A.verify_fail, A.code_camera_ok,
             A.spec_text_forbidden, PT.furniture_in, PT.analyze, ac) = saved
            if ac is not None: sys.modules["action_check"] = ac
            else: sys.modules.pop("action_check", None)
    n0 = len(asked)
    got = {"through on a clean clip": run_case(), "ok": run_case(pt="OK"),
           "no furniture, but he sits down": run_case(furn=(), action="King steps back and sits on the sofa"),
           "no furniture, no movement": run_case(furn=(), action="Layana talks to King")}
    before_fail = len(asked); got["already FAIL"] = run_case(cv="FAIL"); got["asked on FAIL"] = len(asked) - before_fail
    got["model"] = asked[0] if asked else None
    want = {"through on a clean clip": ("FLAG", 1, 0.02), "ok": ("PASS", 0, 0.02),
            "no furniture, but he sits down": ("FLAG", 1, 0.02), "no furniture, no movement": ("PASS", 0, 0),
            "already FAIL": ("FAIL", 0, 0), "asked on FAIL": 0, "model": "claude-sonnet-5-5"}
    return got == want, got, want

def u_action_blind(c):
    """The call that SEES the frames must not contain the action text (P030: the frame review, shown the action,
    repeated "handing the folder back" for a clip where he takes it). Mocked API, no spend."""
    import action_check as AC, ai_review as A
    calls = []
    def fake(model, key, system, content, max_tokens=2000):
        calls.append(json.dumps(content)); return (json.dumps({"people": "a man and a woman", "sequence": ["t=0: x"], "ends_with": "y", "camera": "locked"})
                                                  if len(calls) == 1 else json.dumps({"verdict": "FAIL", "differs": "reversed", "confidence": "high"})), {}
    old, oldk = A._call, os.environ.get("ANTHROPIC_API_KEY")
    A._call = fake; os.environ["ANTHROPIC_API_KEY"] = "test"
    d = tempfile.mkdtemp(prefix="regress_ac_")
    try:
        clip = os.path.join(d, "c.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=2", "-pix_fmt", "yuv420p", clip], check=True)
        secret = "HANDS THE FOLDER BACK zq7"
        r = AC.analyze(clip, secret, d, force=True, log=None)
        got = {"blind call has action": secret in calls[0], "compare call has action": secret in calls[1],
               "blind call has images": '"image"' in calls[0], "verdict": r["verdict"], "calls": len(calls)}
        want = {"blind call has action": False, "compare call has action": True, "blind call has images": True, "verdict": "FAIL", "calls": 2}
        return got == want, got, want
    finally:
        A._call = old
        if oldk is None: os.environ.pop("ANTHROPIC_API_KEY", None)
        else: os.environ["ANTHROPIC_API_KEY"] = oldk
        shutil.rmtree(d, ignore_errors=True)

def u_action_apply(c):
    """How an action check changes the clip verdict (policy measured 2026-11-11)."""
    import action_check as AC
    R = lambda v, conf="high": {"verdict": v, "confidence": conf, "differs": "x"}
    cases = {"PASS + FAIL high": ("PASS", R("FAIL")), "PASS + FAIL medium": ("PASS", R("FAIL", "medium")),
             "PASS + FLAG": ("PASS", R("FLAG", "medium")), "FLAG + FAIL high": ("FLAG", R("FAIL")),
             "FAIL (AI) + PASS": ("FAIL (AI)", R("PASS")), "FAIL (code) + FAIL high": ("FAIL (code)", R("FAIL")),
             "spec check + FAIL high": ("NOT REVIEWED (spec check)", R("FAIL")), "PASS + NOT CHECKED": ("PASS", {"verdict": "NOT CHECKED"}),
             "PASS + ERROR": ("PASS", {"verdict": "ERROR"})}
    want = {"PASS + FAIL high": "FAIL (action)", "PASS + FAIL medium": "FLAG", "PASS + FLAG": "FLAG", "FLAG + FAIL high": "FAIL (action)",
            "FAIL (AI) + PASS": "FAIL (AI)", "FAIL (code) + FAIL high": "FAIL (code)", "spec check + FAIL high": "NOT REVIEWED (spec check)",
            "PASS + NOT CHECKED": "PASS", "PASS + ERROR": "PASS"}
    got = {k: AC.apply(v, ar)[0] for k, (v, ar) in cases.items()}
    return got == want, got, want

def u_camera_end_spike(c):
    """One or two odd samples at the very end must not decide the camera move (MiniMax walk_e98b3141 on the PC,
    2026-11-14: last sample read zoom x0.930 / travel 0.518 and failed a still shot). A real move still counts."""
    import camera_check as C
    still = [(i / 6, 1.0, 0.0, 0.0, 0.0) for i in range(30)]
    tol = {"scale": 0.02, "shift": 0.02, "rot": 1.0}
    cls = lambda path: C.classify(*C.end_of(path)[1:], tol)
    got = {"one odd last sample": cls(still + [(5.0, 0.93, 0.518, -0.016, -0.2)]),
           "two odd last samples": cls(still + [(4.83, 0.93, 0.5, 0.0, 0.0), (5.0, 0.93, 0.518, 0.0, 0.0)]),
           "real pull-out": cls([(i / 6, 1 - 0.01 * i, 0.0, 0.0, 0.0) for i in range(31)]),
           "real pan from 3.3 s": cls(still[:20] + [(i / 6, 1.0, 0.01 * (i - 19), 0.0, 0.0) for i in range(20, 31)])}
    want = {"one odd last sample": ["locked"], "two odd last samples": ["locked"], "real pull-out": ["pull-out"],
            "real pan from 3.3 s": ["pan-left"]}
    return got == want, got, want

def u_room_drift(c):
    """room_drift keeps prop changes of 0.5 %+ that do not touch the frame edge, runs in the pipeline on every
    locked-camera cartoon clip (not photoreal, not a moving camera), turns PASS into FLAG on DRIFT and leaves FAIL
    alone. No video, no API."""
    import pipeline, ai_review as A, shot_qc, room_drift as RD, passthrough_check as PT
    shelf = {"box": [0.76, 0.405, 0.92, 0.546], "area_pct": 1.65}
    got = {"keep: shelf": RD.keep([shelf]) == [shelf],
           "keep: window at the edge": RD.keep([{"box": [0.0, 0.05, 0.16, 0.54], "area_pct": 5.0}]) == [],
           "keep: sofa strip 0.43 %": RD.keep([{"box": [0.35, 0.40, 0.49, 0.46], "area_pct": 0.43}]) == []}
    d = tempfile.mkdtemp(prefix="regress_rd_")
    json.dump({"frames": [{"key": "f0", "t": 0.0, "out": "f0.png"}]}, open(os.path.join(d, "manifest.json"), "w"))
    calls = []
    def run_case(cv="PASS", rd="DRIFT", action="Layana walks to the shelf", camera="locked", style="cartoon"):
        saved = (shot_qc.run, A.estimate, A.cmd_api, A.cmd_apply, A.clip_verdict, A.verify_fail, A.code_camera_ok,
                 A.spec_text_forbidden, RD.analyze, sys.modules.get("action_check"))
        shot_qc.run = lambda spec, log=None: {"verdict": "NEEDS REVIEW", "evidence": {}, "notes": [], "flags": []}
        A.estimate = lambda *a, **k: (1, 100, 0.01); A.cmd_api = lambda ns: 0.01; A.cmd_apply = lambda ns: {}
        A.clip_verdict = lambda *a: (cv, ["X: 2 frame(s)"] if cv == "FAIL" else [], [])
        A.verify_fail = lambda out, model, log=None: ("FAIL", ["kept"], [], 0.0)
        A.code_camera_ok = lambda d: None; A.spec_text_forbidden = lambda d: False
        def an(clip, out, force=False, log=None, walking=True):
            calls.append(walking); return {"verdict": rd, "drift": [shelf] if rd == "DRIFT" else [], "end_t": 7.2}
        RD.analyze = an
        import types; fake = types.ModuleType("action_check")
        fake.analyze = lambda *a, **k: {"verdict": "PASS", "usd": 0.0}; fake.apply = lambda v, ar: (v, "")
        sys.modules["action_check"] = fake
        try:
            r = pipeline.check_clip({"clip": "x.mp4", "out": d, "action": action, "camera": camera, "passthrough": False, "walk_guard": False,
                                     "style": style, "height_check": False})
            return r["verdict"], len([f for f in r["frame_flags"] if f["frame"].startswith("rd")])
        finally:
            (shot_qc.run, A.estimate, A.cmd_api, A.cmd_apply, A.clip_verdict, A.verify_fail, A.code_camera_ok,
             A.spec_text_forbidden, RD.analyze, ac) = saved
            if ac is not None: sys.modules["action_check"] = ac
            else: sys.modules.pop("action_check", None)
    got["drift on a clean walk"] = run_case(); got["no drift"] = run_case(rd="OK")
    # 2026-11-16: every locked-camera cartoon clip is asked (walking=False -> the 1.0 % threshold); photoreal never
    n = len(calls); got["talking shot"] = run_case(action="Layana talks to King"); got["asked: talking (walking flag)"] = calls[n:]
    n = len(calls); got["photoreal walk"] = run_case(style="photo"); got["asked: photoreal"] = len(calls) - n
    n = len(calls); got["panning camera"] = run_case(camera="pan-right"); got["asked: pan"] = len(calls) - n
    n = len(calls); got["already FAIL"] = run_case(cv="FAIL"); got["asked: FAIL"] = len(calls) - n
    want = {"keep: shelf": True, "keep: window at the edge": True, "keep: sofa strip 0.43 %": True,
            "drift on a clean walk": ("FLAG", 1), "no drift": ("PASS", 0), "talking shot": ("FLAG", 1),
            "asked: talking (walking flag)": [False], "photoreal walk": ("PASS", 0), "asked: photoreal": 0,
            "panning camera": ("PASS", 0), "asked: pan": 0, "already FAIL": ("FAIL", 0), "asked: FAIL": 0}
    return got == want, got, want

def t_room_drift(c):
    """Real clips through room_drift.analyze (YOLOX + isnet-anime matting; no API)."""
    import room_drift as RD
    clip = P(c["clip"]); need(clip)
    r = RD.analyze(clip, tempfile.mkdtemp(prefix="regress_rdclip_"), force=True)
    return r["verdict"] == c["want"], {"verdict": r["verdict"], "drift": r["drift"]}, c["want"]

def t_cutout(c):
    """Characters cut out of a still (YOLOX + isnet-anime matting, plus still-minus-plate when given). No API."""
    import cutout as CU
    img = P(c["image"]); need(img)
    plate = P(c["plate"]) if c.get("plate") else None
    if plate: need(plate)
    res = CU.cutouts(img, tempfile.mkdtemp(prefix="regress_cut_"), plate=plate)
    got = {"count": len(res), "plate_used": [r["plate_used"] for r in res], "warnings": [r["warnings"] for r in res]}
    return got == c["want"], got, c["want"]

def t_height(c):
    """Height check on labelled stills, measurement only (ai=False, no API): standing pairs measured, the rest NOT CHECKED."""
    import height_check as HC
    bench = P(c["bench"]); need(bench)
    got = {}
    for k in json.load(open(bench, encoding="utf-8"))["cases"]:
        if k["id"] not in c["want"]: continue
        cast = [dict(x, ref=P(x["ref"]) if x.get("ref") else None) for x in k["cast"]]
        r = HC.check(P(k["still"]), cast, plate=P(k["plate"]) if k.get("plate") else None,
                     out_dir=tempfile.mkdtemp(prefix="regress_height_"), ai=False, log=lambda *a: None)
        got[k["id"]] = r["verdict"]
    return got == c["want"], got, c["want"]

def u_height_apply(c):
    """height_check.apply: WRONG turns PASS into FLAG with a HEIGHTS mark at the last frame; FLAG stays FLAG with the
    reason; OK / UNSURE / NOT CHECKED change nothing; FAIL and NOT REVIEWED stay. No video, no API."""
    import height_check as HC
    w = {"verdict": "WRONG", "problems": ["King vs Layana: same height"], "end_t": 7.0}
    v, why, fl = HC.apply("PASS", w)
    got = {"PASS+WRONG": v, "why": why.startswith("heights wrong at the end of the clip: King vs Layana"),
           "mark": [(f["t_s"], f["rules"]) for f in fl], "FLAG+WRONG": HC.apply("FLAG", w)[0],
           "PASS+OK": HC.apply("PASS", {"verdict": "OK"})[0], "PASS+UNSURE": HC.apply("PASS", {"verdict": "UNSURE"})[0],
           "PASS+NOT CHECKED": HC.apply("PASS", {"verdict": "NOT CHECKED"})[0], "FAIL (AI)+WRONG": HC.apply("FAIL (AI)", w)[0],
           "NOT REVIEWED+WRONG": HC.apply("NOT REVIEWED", w)[0]}
    want = {"PASS+WRONG": "FLAG", "why": True, "mark": [(7.0, ["HEIGHTS"])], "FLAG+WRONG": "FLAG", "PASS+OK": "PASS",
            "PASS+UNSURE": "PASS", "PASS+NOT CHECKED": "PASS", "FAIL (AI)+WRONG": "FAIL (AI)", "NOT REVIEWED+WRONG": "NOT REVIEWED"}
    return got == want, got, want

def u_ai_part(c):
    """ai_review.ai_part (2026-11-16 auto-pass): on cartoon, unconfirmed frame flags are notes (PASS) unless a severe rule
    repeats (SEVERE_FLAG); a confirmed FAIL stays FAIL; photoreal (2026-11-17) the same, plus IMAGE QUALITY on 3+ frames."""
    import ai_review as A
    got = {"cartoon minor+single": A.ai_part("FLAG", ["MOUTHS: 3 frame(s) f1, f2, f3", "ANATOMY: 1 frame(s) f4 (not consecutive)"], "cartoon"),
           "cartoon rejected": A.ai_part("FLAG", ["ANATOMY: f36 REJECTED: normal hand"], "cartoon"),
           "cartoon identity x2": A.ai_part("FLAG", ["IDENTITY: 2 frame(s) f72, f96 (not consecutive)"], "cartoon"),
           "cartoon head count x1": A.ai_part("FLAG", ["HEAD COUNT: 1 frame(s) f52 (not consecutive)"], "cartoon"),
           "cartoon reflection x1": A.ai_part("FLAG", ["REFLECTIONS AND SHADOWS: 1 frame(s) f112 (not consecutive)"], "cartoon"),
           "cartoon FAIL": A.ai_part("FAIL", [], "cartoon"), "photo flag": A.ai_part("FLAG", ["MOUTHS: 1 frame(s) f1"], "photo"),
           "photo pass": A.ai_part("PASS", [], None),
           "photo P049": A.ai_part("FLAG", ["ANATOMY: 2 frame(s) f44, f60 (not consecutive)", "IMAGE QUALITY: 3 frame(s) f44, f60, f76", "SET LAYOUT: 1 frame(s) f76 (not consecutive)"], "photo"),
           "photo wardrobe x1": A.ai_part("FLAG", ["WARDROBE: 1 frame(s) f36 (not consecutive)"], "photo"),
           "cartoon image quality x3": A.ai_part("FLAG", ["IMAGE QUALITY: 3 frame(s) f1, f2, f3"], "cartoon")}
    want = {"cartoon minor+single": "PASS", "cartoon rejected": "PASS", "cartoon identity x2": "FLAG", "cartoon head count x1": "PASS",
            "cartoon reflection x1": "FLAG", "cartoon FAIL": "FAIL", "photo flag": "PASS", "photo pass": "PASS",
            "photo P049": "FLAG", "photo wardrobe x1": "FLAG", "cartoon image quality x3": "PASS"}
    return got == want, got, want

def u_walk_guard(c):
    """room_drift.FEET_MOVE (2026-11-16 walk guard): actions where feet move are never auto-passed; the two moon-walking
    Phase 0 clips were "takes one step toward"."""
    import room_drift as RD
    acts = {"one step": "Layana takes one step toward King and hands him the truck", "steps back": "King turns, steps back and sits down",
            "dog trots": "Rex trots to Ana", "talking": "Layana talks to King", "blocks": "King slowly places the blue block",
            "waving": "Layana and King wave at the camera"}
    got = {k: bool(RD.FEET_MOVE.search(v)) for k, v in acts.items()}
    want = {"one step": True, "steps back": True, "dog trots": True, "talking": False, "blocks": False, "waving": False}
    return got == want, got, want

def u_subject_classes(c):
    """end_frame.subject_classes / unfindable (2026-11-16: people, animals and objects, cartoon and photoreal)."""
    import end_frame as EF
    got = {"cartoon kids": EF.subject_classes("cartoon", [{"kind": "person"}]),
           "photo person": EF.subject_classes("photoreal", [{"kind": "person"}]),
           "dog + truck": EF.subject_classes("photoreal", [{"kind": "animal", "what": "golden retriever"}, {"kind": "object", "what": "red toy dump truck"}]),
           "robot vacuum": EF.subject_classes("photoreal", [{"kind": "object", "what": "robot vacuum"}]),
           "unfindable": EF.unfindable([{"name": "Vac", "kind": "object", "what": "robot vacuum"}, {"name": "Cup", "kind": "object", "what": "a cup"}])}
    want = {"cartoon kids": ("person", "teddy bear"), "photo person": ("person",),
            "dog + truck": ("bear", "bird", "cat", "cow", "dog", "elephant", "giraffe", "horse", "sheep", "truck", "zebra"),
            "robot vacuum": (), "unfindable": ("Vac",)}
    return got == want, got, want

UNITS = {"unit.walk_guard": u_walk_guard, "unit.foot_slide_apply": u_foot_slide_apply, "unit.subject_classes": u_subject_classes, "unit.ai_part": u_ai_part, "unit.height_apply": u_height_apply, "unit.action_apply": u_action_apply, "unit.action_blind": u_action_blind, "unit.repair_plan": u_repair_plan, "unit.first_json": u_first_json, "unit.keep_rule": u_keep_rule, "unit.clip_verdict": u_clip_verdict,
         "unit.gate_of_flag": u_gate_of_flag, "unit.sync_classify": u_sync_classify,
         "unit.verify_missing_frames": u_verify_missing_frames, "unit.verify_flag_reasons": u_verify_flag_reasons,
         "unit.verify_errors": u_verify_errors, "unit.request_options": u_request_options,
         "unit.default_models": u_default_models,
         "unit.pipeline_flow": u_pipeline_flow,
         "unit.cartoon_people_nested": u_cartoon_people_nested, "unit.camera_end_spike": u_camera_end_spike, "unit.room_drift": u_room_drift,
         "unit.pipeline_passthrough": u_pipeline_passthrough}

# ---------------------------------------------------------------- data cases
def t_verify_saved(c):
    """Second opinion from the SAVED decisions only: verdicts as accepted, and the saved files untouched."""
    import ai_review as A, hashlib
    d0 = P(c["dir"]); need(d0)
    got, changed = {}, []
    for shot in c["want"]:
        d = os.path.join(d0, shot); need(os.path.join(d, "ai_verify.json"))
        h = hashlib.md5(open(os.path.join(d, "ai_verify.json"), "rb").read()).hexdigest()
        got[shot] = A.verify_fail(d, log=None)[0]
        if hashlib.md5(open(os.path.join(d, "ai_verify.json"), "rb").read()).hexdigest() != h: changed.append(shot)
    if changed: got["FILES CHANGED"] = changed
    return got == c["want"], got, c["want"]

def t_sync(c):
    import sync_check as Y
    r, s = P(c["render"]), P(c["source"]); need(r, s)
    res = Y.analyze(r, s, log=None)
    drift = [i["text"] for i in res["issues"] if i["kind"] == "drift"]
    ok = res["verdict"] in (c["want"] if isinstance(c["want"], list) else [c["want"]])
    if ok and c.get("drift_from") is not None:          # the drift must start where the notes say (+-3 frames)
        ok = any(abs(i["from_frame"] - c["drift_from"]) <= 3 for i in res["issues"] if i["kind"] == "drift")
    return ok, {"verdict": res["verdict"], "drift": drift}, {"verdict": c["want"], "drift_from": c.get("drift_from")}

def t_dense(c):
    import frame_check as F
    from fc_common import probe
    clip = P(c["clip"]); need(clip)
    w, h, fps, _ = probe(clip); X = F.small_frames(clip, w, h); _, cuts = F.analyse(X, None)
    hot = F.motion_beats(X, cuts, c.get("top", 20))
    hit = [f for f in c["defect_frames"] if f in hot]
    cover = len(hot) / len(X)
    ok = len(hit) >= c.get("min_hit", len(c["defect_frames"])) and cover <= c.get("max_cover", 0.5)
    return ok, {"hit": f"{len(hit)}/{len(c['defect_frames'])}", "coverage": round(cover, 2)}, \
        {"hit_at_least": c.get("min_hit", len(c["defect_frames"])), "coverage_at_most": c.get("max_cover", 0.5)}

def t_roles(c):
    import role_source as RS
    r, s, ro = P(c["render"]), P(c["source"]), P(c["roles"]); need(r, s, ro)
    res = RS.analyze(r, s, json.load(open(ro)), step=c.get("step", 4), log=None)
    sw = [(i["from_frame"], i["to_frame"]) for i in res["issues"] if i["kind"] == "role_swap"]
    ok = res["verdict"] == c["want"]
    if ok and c.get("swap_within"):                     # a reported swap must overlap the known one
        a, b = c["swap_within"]; ok = any(x0 <= b and x1 >= a for x0, x1 in sw)
    return ok, {"verdict": res["verdict"], "swaps": sw}, {"verdict": c["want"], "swap_within": c.get("swap_within")}

RANK = {"pass": {"PASS": 2, "FLAG": 1, "FAIL": 0}, "fail": {"FAIL": 2, "FLAG": 1, "PASS": 0}, "minor": {"PASS": 2, "FLAG": 2, "FAIL": 0}}

def kind(p):
    """FAIL / FLAG / PASS / UNKNOWN. "NOT REVIEWED (spec check)" stops for a person, so it ranks as FLAG.
    "NOT REVIEWED (offline)" means a paid review would decide it: UNKNOWN. (2026-11-10: the first version
    ranked both as OTHER, so two bad clips, P030 and P038, went from FAIL to NOT REVIEWED and the case still passed.)"""
    if p.startswith("FAIL"): return "FAIL"
    if p == "FLAG" or "spec check" in p: return "FLAG"
    if p == "PASS": return "PASS"
    return "UNKNOWN"

def t_benchmark(c, accept=False):
    b = c["args"]
    if "cases" in b: need(P(b["cases"]), P(b["out"]))
    else: need(*(P(b[k]) for k in ("clips", "manifest", "stills", "bible", "out")))
    out = P(b["out"]); tag = "_regress"
    for f in (f"results{tag}.csv", f"summary{tag}.txt"):
        if os.path.exists(os.path.join(out, f)): os.remove(os.path.join(out, f))
    env = dict(os.environ); env.pop("ANTHROPIC_API_KEY", None)
    cmd = [sys.executable, os.path.join(HERE, "batch_eval.py"), "--rescore", "--offline", "--action-check", "--tag", tag,
           "--out", out, "--max-usd", "0"]
    cmd += ["--cases", P(b["cases"])] if "cases" in b else \
           ["--clips", P(b["clips"]), "--manifest", P(b["manifest"]), "--stills", P(b["stills"]), "--bible", P(b["bible"])]
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if p.returncode: raise RuntimeError("batch_eval failed: " + (p.stderr or p.stdout)[-600:])
    rows = list(csv.DictReader(open(os.path.join(out, f"results{tag}.csv"), encoding="utf-8")))
    now = {r["shot"]: r["pipeline"] for r in rows}; lab = {r["shot"]: r["label"] for r in rows}
    bkey = "benchmark" if c["id"] == "benchmark.supercool_55" else "benchmark:" + c["id"]
    base = json.load(open(BASE)).get(bkey, {}) if os.path.exists(BASE) else {}
    better, worse, other, unknown = [], [], [], []
    for s, v in now.items():
        if s not in base: other.append(f"{s}: new ({v})"); continue
        if v == base[s]: continue
        a, z = RANK.get(lab[s], {}).get(kind(base[s])), RANK.get(lab[s], {}).get(kind(v))
        line = f"{s} ({lab[s]}): {base[s]} -> {v}"
        if kind(v) == "UNKNOWN":                 # only a paid review can say; a bad clip we used to catch is a regression
            (worse if lab[s] == "fail" and kind(base[s]) in ("FAIL", "FLAG") else unknown).append(line + " (needs a paid review to know)")
        elif a is None or z is None or a == z: other.append(line)
        elif z > a: better.append(line)
        else: worse.append(line)
    m = {"good_failed": sum(1 for s in now if lab[s] == "pass" and kind(now[s]) == "FAIL"),
         "good_passed": sum(1 for s in now if lab[s] == "pass" and now[s] == "PASS"),
         "bad_caught": sum(1 for s in now if lab[s] == "fail" and kind(now[s]) in ("FAIL", "FLAG")),
         "bad_unknown": sum(1 for s in now if lab[s] == "fail" and kind(now[s]) == "UNKNOWN"),
         "bad_failed": sum(1 for s in now if lab[s] == "fail" and kind(now[s]) == "FAIL"),
         "bad_passed": sum(1 for s in now if lab[s] == "fail" and now[s] == "PASS"),
         "clips": len(now)}
    if accept:
        bj = json.load(open(BASE)) if os.path.exists(BASE) else {}
        bj[bkey] = now; bj[bkey + "_metrics"] = m; bj["accepted"] = time.strftime("%Y-%m-%d %H:%M")
        json.dump(bj, open(BASE, "w", encoding="utf-8"), indent=1)
    ok = not worse and m["bad_passed"] == 0
    return ok, {"metrics": m, "better": better, "worse": worse, "unknown": unknown, "changed_same_rank": other}, \
        {"no clip worse than baseline": True, "bad_passed": 0}

def t_shot_qc(c):
    """End to end through shot_qc.run: the spec keys, gate mapping and the "use" window together."""
    import shot_qc as S
    spec = json.loads(json.dumps(c["spec"]))
    def fix(v): return P(v) if isinstance(v, str) and ("/" in v or "\\" in v) else v
    spec = {k: ({kk: fix(vv) for kk, vv in v.items()} if isinstance(v, dict) else fix(v)) for k, v in spec.items()}
    need(spec["clip"])
    spec["out"] = tempfile.mkdtemp(prefix="regress_sq_")
    try:
        r = S.run(spec, log=None)
        text = json.dumps({"evidence": r["evidence"], "flags": r["flags"]})
        miss = [x for x in c.get("contains", []) if x not in text]
        return r["verdict"] == c["want"] and not miss, {"verdict": r["verdict"], "missing_text": miss, "evidence": r["evidence"], "flags": r["flags"][:4]}, \
            {"verdict": c["want"], "contains": c.get("contains", [])}
    finally:
        shutil.rmtree(spec["out"], ignore_errors=True)

def t_repair_build(c):
    """Rebuild a real EP18 splice from its parts; it must match the splice Londi approved and pass sync."""
    import repair_plan as R, frame_check as F
    from fc_common import probe
    import numpy as np
    r, pa, src, ref = P(c["render"]), P(c["patch"]), P(c["source"]), P(c["approved"]); need(r, pa, src, ref)
    out = os.path.join(tempfile.mkdtemp(prefix="regress_rb_"), "rebuilt.mp4")
    try:
        res = R.build(r, pa, tuple(c["replace"]), c.get("patch_from", 0), out, src, log=None)
        w, h, _, _ = probe(ref); A = F.small_frames(out, w, h).astype(float); B = F.small_frames(ref, w, h).astype(float)
        d = [float(np.abs(A[i] - B[i]).mean()) for i in range(min(len(A), len(B)))]
        got = {"frames": [len(A), len(B)], "max_diff": round(max(d), 2), "sync": res["sync"], "hold": res["hold"]}
        ok = len(A) == len(B) and max(d) <= c.get("max_diff", 3.0) and res["sync"] in ("PASS", "FLAG")
        return ok, got, {"same frame count": True, "max_diff_at_most": c.get("max_diff", 3.0), "sync": "PASS or FLAG"}
    finally:
        shutil.rmtree(os.path.dirname(out), ignore_errors=True)

def t_repair_edit(c):
    """Pixel edits land on their box only: nothing outside changes, no other frame changes."""
    import repair_plan as R, frame_check as F, cv2
    import numpy as np
    clip = P(c["clip"]); need(clip)
    tmp = tempfile.mkdtemp(prefix="regress_re_")
    try:
        w, h, fps, _ = R.probe(clip); img = os.path.join(tmp, "edit.png"); cv2.imwrite(img, np.full((h, w, 3), (255, 0, 255), np.uint8))
        out = os.path.join(tmp, "out.mp4")
        res = R.apply_edits(clip, [{"frame": f, "image": img, "box": c["box"]} for f in c["frames"]], out)
        A = F.small_frames(clip, w, h).astype(float); B = F.small_frames(out, w, h).astype(float)
        d = [float(np.abs(A[i] - B[i]).mean()) for i in range(min(len(A), len(B)))]
        changed = [i for i, x in enumerate(d) if x > 3]
        got = {"outside_untouched": res["outside_untouched"], "changed_frames": changed, "frames": [len(A), len(B)]}
        return res["outside_untouched"] and changed == c["frames"] and len(A) == len(B), got, \
            {"outside_untouched": True, "changed_frames": c["frames"]}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def t_end_frame(c):
    """end_frame.py on real Phase 0 S3 frames: each drifted end frame FLAGs with a drift box on the shelf, compose()
    of each PASSes its own check, and the start still against itself PASSes."""
    try:
        import rembg  # noqa: F401
    except ImportError:
        raise Skip('rembg not installed (pip install "rembg[cpu]")')
    import end_frame as EF
    start = P(c["start"]); drifted = [P(p) for p in c["drifted"]]
    need(start, *drifted)
    sx0, sy0, sx1, sy1 = c["shelf"]
    on_shelf = lambda r: any(d["box"][0] < sx1 and d["box"][2] > sx0 and d["box"][1] < sy1 and d["box"][3] > sy0 for d in r["drift"])
    got, want = {}, {}
    tmp = tempfile.mkdtemp(prefix="ef_")
    for p in drifted:
        n = os.path.basename(p)
        r = EF.check(start, p); got[f"check {n}"] = [r["verdict"], on_shelf(r)]; want[f"check {n}"] = ["FLAG", True]
        r = EF.compose(start, p, os.path.join(tmp, n)); got[f"compose {n}"] = r["verdict"]; want[f"compose {n}"] = "PASS"
    got["start vs itself"] = EF.check(start, start)["verdict"]; want["start vs itself"] = "PASS"
    shutil.rmtree(tmp, ignore_errors=True)
    return got == want, got, want

def t_compose(c):
    """end_frame.compose on stills where it failed live (2026-11-16): "revealed" - the room a character left comes
    from a fitting plate (an invented block there is gone) or is listed as drawn by the edit; "head" - a seated
    character whose detector box starts at the mouth keeps her hair (the crop grows when the mask runs into its top)."""
    try:
        import rembg  # noqa: F401
    except ImportError:
        raise Skip('rembg not installed (pip install "rembg[cpu]")')
    import end_frame as EF, cv2, numpy as np
    start, edited = P(c["start"]), P(c["edited"])
    plate = [P(x) for x in c["plates"]] if c.get("plates") else (P(c["plate"]) if c.get("plate") else None)
    need(start, edited, *([plate] if isinstance(plate, str) else (plate or [])))
    out = os.path.join(tempfile.mkdtemp(prefix="compose_"), "out.png")
    with EF.subjects(c.get("look", "cartoon"), c.get("subjects")):
        r = EF.compose(start, edited, out, plate=plate, expect=c.get("expect"))
    O = cv2.imread(out); h, w = O.shape[:2]
    x0, y0, x1, y1 = c["region"]; sl = (slice(int(y0 * h), int(y1 * h)), slice(int(x0 * w), int(x1 * w)))
    ref = cv2.imread(P(c["region_like"])); ref = cv2.resize(ref, (w, h)) if ref.shape[:2] != (h, w) else ref
    diff = float(np.abs(O[sl].astype(int) - ref[sl].astype(int)).mean())
    ok = diff < c["max_diff"] if "max_diff" in c else diff > c["min_diff"]   # min_diff: the region must differ from region_like
    got = {"verdict": r["verdict"], "sources": sorted({x["source"] for x in r["revealed"]}), "region matches": ok}
    return got == c["want"], dict(got, region_diff=round(diff, 1)), c["want"]

def t_reposition_fit(c):
    """end_frame.reposition_fit before paying for a reposition edit: a close-up with no fitting plate FLAGs (2026-11-16,
    job ed5bee77), a wide still or one with a fitting plate PASSes."""
    try:
        import rembg  # noqa: F401
    except ImportError:
        raise Skip('rembg not installed (pip install "rembg[cpu]")')
    import end_frame as EF
    start = P(c["start"]); plates = [P(x) for x in c.get("plates", [])]
    need(start, *plates)
    r = EF.reposition_fit(start, plates or None)
    return r["verdict"] == c["want"], {"verdict": r["verdict"], "cover": r["cover"], "plate_fit": r["plate_fit"]}, c["want"]


RUN = {"reposition_fit": t_reposition_fit, "compose": t_compose, "height": t_height, "cutout": t_cutout, "room_drift": t_room_drift, "end_frame": t_end_frame, "repair_build": t_repair_build, "repair_edit": t_repair_edit, "shot_qc": t_shot_qc, "verify_saved": t_verify_saved, "sync": t_sync, "dense": t_dense, "roles": t_roles, "benchmark": t_benchmark}

# ---------------------------------------------------------------- runner
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--full", action="store_true"); ap.add_argument("--accept", action="store_true")
    ap.add_argument("--only", default=""); a = ap.parse_args()
    no_api()
    cases = json.load(open(CASES, encoding="utf-8"))["cases"]
    todo = [(cid, None) for cid in UNITS] + [(c["id"], c) for c in cases if a.full or not c.get("slow")]
    if a.only: todo = [t for t in todo if a.only in t[0]]
    os.makedirs(OUTD, exist_ok=True); res = []; t_all = time.time()
    for cid, c in todo:
        t0 = time.time()
        try:
            if c is None: ok, got, want = UNITS[cid](c)
            elif c["type"] == "benchmark": ok, got, want = t_benchmark(c, accept=a.accept)
            else: ok, got, want = RUN[c["type"]](c)
            st = "PASS" if ok else "FAIL"
        except Skip as e: st, got, want = "SKIP", str(e), None
        except Exception as e: st, got, want = "ERROR", f"{type(e).__name__}: {e}", traceback.format_exc()[-800:]
        res.append({"id": cid, "status": st, "got": got, "want": want, "why": (c or {}).get("why", ""), "secs": round(time.time() - t0, 1)})
        print(f"{st:5s} {cid}  ({res[-1]['secs']} s)")
        if st in ("FAIL", "ERROR"):
            print(f"      got:  {json.dumps(got, default=str)[:900]}")
            print(f"      want: {json.dumps(want, default=str)[:600]}")
        elif c is not None and c.get("type") == "benchmark":
            print(f"      {json.dumps(got['metrics'])}")
            for k in ("better", "worse", "unknown"):
                for line in got[k]: print(f"      {k.upper()}: {line}")
    n = {s: sum(1 for r in res if r["status"] == s) for s in ("PASS", "FAIL", "ERROR", "SKIP")}
    summary = f"{n['PASS']} passed, {n['FAIL']} failed, {n['ERROR']} errors, {n['SKIP']} skipped in {time.time() - t_all:.0f} s" \
              f" ({'full' if a.full else 'quick'}{', baseline accepted' if a.accept and a.full else ''})"
    print("\n" + summary)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    json.dump({"when": stamp, "summary": summary, "results": res}, open(os.path.join(OUTD, "last.json"), "w", encoding="utf-8"), indent=1, default=str)
    with open(os.path.join(OUTD, f"report_{stamp}.txt"), "w", encoding="utf-8") as fh:
        fh.write(summary + "\n\n")
        for r in res: fh.write(f"{r['status']:5s} {r['id']}  {r['why']}\n      got:  {json.dumps(r['got'], default=str)}\n")
    sys.exit(1 if n["FAIL"] or n["ERROR"] else 0)

if __name__ == "__main__":
    main()

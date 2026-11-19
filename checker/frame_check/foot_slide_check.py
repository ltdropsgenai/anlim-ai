"""foot_slide_check.py - do walking characters really step, or do their feet slide (moon-walk, skate, glide)? @anlim

Why: Londi, 2026-11-16: "moonwalk clips are unacceptable" (Phase 0 S1_r1_gemini, S1_r2_gemini: "She is moon-walking";
MiniMax walk_061a6169: "she also slide to her right"). Since then every clip whose action moves the feet is held
for review by the walk guard (pipeline.py), which also holds every good walk (4 of 8 good Kijan clips).
Code first (2026-11-17): body keypoints (pose_check, BlazePose) and the speed of the planted foot against the hips.
It did not work on cartoon children: the planted-foot speed of a good walk (S1_r3_gemini 1.14 of the hip speed) was
higher than a moon-walk's (0.27-0.62) - keypoint jitter on drawn feet is larger than the slide. So it is an AI
question, like passthrough_check: the whole clip as time-stamped frame strips (8 per second), asking it to follow each
planted foot against the floor's own marks (rug pattern, floorboards, tiles).

  python foot_slide_check.py CLIP --out QA_DIR            (one clip; cached in QA_DIR)
  python foot_slide_check.py --bench foot_slide_cases.json (labelled clips: caught / false alarms / $)

Status: MEASURING (2026-11-17). In the clip verdict only when FOOT_SLIDE_GATE=on (pipeline.py): then a high-confidence
OK lets a walking clip pass instead of the walk guard's FLAG, and SLIDE flags it. Off until the bench says how far to
trust it.
"""
import argparse, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import passthrough_check as PT

VERSION = 1
SYSTEM = """You check a generated video clip (cartoon or photoreal) for ONE defect: feet that SLIDE instead of stepping.
You get the clip as frames in time order, 8 per second, with the time printed on each frame.

How real walking looks: one foot is planted - it stays on the SAME spot of the floor (judge it against the floor's own
marks: rug pattern, floorboards, tiles, shadows, the furniture's legs) - while the other foot swings forward; then they
swap. The body travels only as the feet take steps, about one step length per step. A planted foot may roll heel to
toe or pivot on the spot, but it does not travel along the floor.
Defects (report SLIDE):
- a planted foot glides along the floor while the body moves (skating, sliding sideways or backwards);
- MOON-WALK: the legs make stepping motions but the body travels the wrong way or much farther or shorter than the
  steps, or the body travels with no steps at all (gliding, drifting, being "carried");
- the feet hover above the floor while the character travels.
NOT a defect: a planted foot pivoting or rolling on the spot; small steps; standing still; turning on the spot;
camera movement (the whole room moves with it); motion blur on a moving foot; a foot hidden behind furniture for a
moment.
Follow every character who moves across the floor, frame by frame, before deciding. Answer with ONE JSON object:
{"movers": [{"character": "<short description>", "steps": "<one or two sentences: each step with times, and whether the planted foot stayed on its spot>"}],
 "verdict": "SLIDE|OK|UNSURE",
 "confidence": "high|medium|low",
 "events": [{"character": "...", "from_t": 0.0, "to_t": 0.0, "what": "<at most 25 words: which foot, how far it slid, against what floor mark>"}]}
SLIDE = a defect above; OK = every move is made of real steps; UNSURE = the feet are too small, hidden or blurred to tell."""


def apply(verdict, fs, walking):
    """Clip verdict after the foot check -> (verdict, reason, timeline flags). SLIDE -> FLAG (never FAIL yet: 3 labelled
    examples). A walking clip the walk guard would hold passes only on OK with high confidence."""
    v = fs.get("verdict")
    if verdict.startswith(("FAIL", "NOT REVIEWED")): return verdict, "", []
    if v == "SLIDE":
        ev = fs.get("events") or []
        what = "; ".join(f"{e.get('from_t')}-{e.get('to_t')} s {e.get('what', '')}" for e in ev[:2]) or fs.get("why", "")
        flags = [{"t_s": float(e.get("from_t") or 0), "frame": f"fs{i}", "verdict": "FAIL", "rules": ["FEET SLIDE"],
                  "note": f"{e.get('from_t')}-{e.get('to_t')} s: {e.get('what', '')}"[:300]} for i, e in enumerate(ev[:4])]
        return ("FLAG" if verdict in ("PASS", "FLAG (walk)") else verdict), f"feet slide ({fs.get('confidence', '?')}): {what}"[:300], flags
    if walking and verdict == "FLAG (walk)" and v == "OK" and fs.get("confidence") == "high":
        return "PASS", "feet checked: real steps (high confidence)", []
    return verdict, "", []


def sheets(clip, out_dir, fps=8.0, cols=4, rows=3, width=512):
    sub = os.path.join(out_dir, "foot_slide"); os.makedirs(sub, exist_ok=True)    # own folder: passthrough's strips keep their names
    return PT.sheets(clip, sub, fps=fps, cols=cols, rows=rows, width=width)


def analyze(clip, out_dir, model="claude-sonnet-5-5", force=False, log=print):
    """Cached in OUT/foot_slide_check.json. Returns {"verdict": SLIDE|OK|UNSURE|NOT CHECKED|ERROR, ...}."""
    log = log or (lambda *a: None)
    import ai_review as A
    os.makedirs(out_dir, exist_ok=True); cp = os.path.join(out_dir, "foot_slide_check.json")
    if os.path.exists(cp) and not force:
        s = json.load(open(cp, encoding="utf-8"))
        if s.get("version") == VERSION and s.get("model") == model: return dict(s, cached=True)
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key: return {"verdict": "NOT CHECKED", "why": "ANTHROPIC_API_KEY not set", "usd": 0.0}
    sh = sheets(clip, out_dir)
    content = [{"type": "text", "text": f"{len(sh)} image(s) follow, in time order."}]
    for p, ts in sh:
        content += [{"type": "text", "text": f"Frames {ts[0]:.2f}-{ts[-1]:.2f} s, left to right, top to bottom:"}, A.img_block(p)[0]]
    pi, pw, pr, po = A.PRICES.get(model, (2.0, 2.5, 0.1, 10.0)); usd = 0.0; ans = None
    for mt in (3000, 6000):
        try:
            txt, u = A._call(model, key, SYSTEM, content, mt)
            usd += (int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6
            ans = A.first_json(txt)
            if ans and ans.get("verdict") in ("SLIDE", "OK", "UNSURE"): break
        except Exception as e:
            ans = {"verdict": "ERROR", "why": f"{type(e).__name__}: {str(e)[:150]}"}
    if not ans or ans.get("verdict") not in ("SLIDE", "OK", "UNSURE", "ERROR"):
        ans = {"verdict": "ERROR", "why": "no readable answer"}
    r = dict(ans, usd=round(usd, 4), version=VERSION, model=model, sheets=[p for p, _ in sh])
    json.dump(r, open(cp, "w", encoding="utf-8"), indent=1)
    log(f"foot slide: {r['verdict']} ({r.get('confidence', '')}) ${usd:.3f}")
    return r


def bench(cases_path, model, force=False, max_usd=3.0):
    cases = json.load(open(cases_path, encoding="utf-8"))
    out_root = os.path.join(HERE, "_tests", "foot_slide_v%d" % VERSION); rows, spent = [], 0.0
    import shot_qc
    for c in cases["cases"]:
        clip = shot_qc.localize(c["clip"])
        if not os.path.exists(clip): print(f"  missing: {clip}"); continue
        if spent > max_usd: print(f"stopped: ${spent:.2f} spent (max {max_usd})"); break
        r = analyze(clip, os.path.join(out_root, c["id"]), model, force=force, log=None)
        spent += 0 if r.get("cached") else r.get("usd", 0)
        hit = r["verdict"] == "SLIDE"; ok = hit == (c["expect"] == "slide")
        rows.append((c, r, hit, ok))
        ev = "; ".join(f"{e.get('from_t')}-{e.get('to_t')} s {e.get('what', '')}" for e in r.get("events", [])[:2])
        print(f"{'ok ' if ok else 'XX '} {c['id']:<26} expect {c['expect']:<11} got {r['verdict']:<7} {r.get('confidence', ''):<6} "
              f"${r.get('usd', 0):.3f}{' (cached)' if r.get('cached') else ''}  {ev[:100]}", flush=True)
    pos = [x for x in rows if x[0]["expect"] == "slide"]; neg = [x for x in rows if x[0]["expect"] != "slide"]
    lift = [x for x in neg if x[1]["verdict"] == "OK" and x[1].get("confidence") == "high"]
    print(f"\nslides caught: {sum(x[2] for x in pos)} of {len(pos)}   false alarms: {sum(x[2] for x in neg)} of {len(neg)}"
          f"   good walks it would let pass (OK, high): {len(lift)} of {len(neg)}"
          f"   errors: {sum(1 for x in rows if x[1]['verdict'] == 'ERROR')}   spent this run: ${spent:.2f}"
          f"   per clip: ${(sum(x[1].get('usd', 0) for x in rows) / max(1, len(rows))):.3f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip", nargs="?"); ap.add_argument("--out")
    ap.add_argument("--model", default="claude-sonnet-5-5"); ap.add_argument("--force", action="store_true")
    ap.add_argument("--bench"); ap.add_argument("--max-usd", type=float, default=3.0)
    ap.add_argument("--sheets-only", action="store_true", help="write the frame strips, no API")
    a = ap.parse_args()
    if a.bench: return bench(a.bench, a.model, a.force, a.max_usd)
    if not a.clip or not a.out: ap.error("CLIP and --out are required (or --bench CASES.json)")
    if a.sheets_only:
        os.makedirs(a.out, exist_ok=True)
        for p, ts in sheets(a.clip, a.out): print(p, f"{ts[0]:.2f}-{ts[-1]:.2f} s")
        return
    print(json.dumps(analyze(a.clip, a.out, a.model, a.force), indent=1))


if __name__ == "__main__":
    main()

"""action_check.py - does the clip PERFORM its shot's action, in the right order and direction? @anlim

Why: the frame review judges single frames. A reversed action looks fine frame by frame: SuperCool P030
(2026-10-22) "he hands the folder back" came out as he TAKES the folder; the frame review (with the action text
in front of it) never saw it and repeated "handing the folder back" in its own notes. Rules 17 (the action
happens) and 19 (it matches the line) are clip-level questions.

Two calls, so the action text cannot steer what the model sees:
  1. BLIND: N frames in time order (default 8, with their times), no action text -> a plain description of
     what happens: who is in it, who moves what, from whom to whom, in which order, how it ends.
  2. COMPARE (text only): that description vs the shot's action -> PASS / FLAG / FAIL with the part that differs.
     FAIL = the named action does not happen, is reversed, or a different action happens instead.
     FLAG = it happens but weakly, partly, or with an extra unrequested move.
Result cached in OUT/action_check.json (reused unless force); no API key -> NOT CHECKED (or the cached result).

  python action_check.py CLIP.mp4 --action "he hands the folder back, a small nod" [--out DIR] [--frames 8]
  in code: action_check.analyze(clip, action, out_dir, model="claude-sonnet-5-5", n=8, use=None)
"""
import argparse, json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

BLIND = """You see frames from ONE short video clip, in time order, each labelled with its time. You are not told
what the clip is meant to show. Describe only what you can see happen, as a sequence:
who is in it (by appearance), what each person does with their hands, body and any object, in which ORDER,
in which DIRECTION (who gives to whom, who takes from whom, who enters or leaves, toward or away from camera),
and how it ends. Say "not visible" rather than guessing. Note any camera move.
Answer with ONE JSON object: {"people": "...", "sequence": ["t=..: ...", ...], "ends_with": "...", "camera": "..."}"""

COMPARE_VERSION = 2
COMPARE = """You compare a blind description of a generated video clip with the action the shot was written for.
The description was made WITHOUT knowing the action, so trust it over assumptions.
The clip STARTS on a still image that a person already approved. Whatever the first frame (t=0) shows - who is
there, what they hold or do not hold, whether a laptop is already open, whether he is already standing, seated,
walking or at the railing - was approved and is NOT a failure, even when the action text describes a set-up or a
prop that the first frame does not show. Judge only what happens FROM t=0 ON: does the motion that follows go the
way the action says, in that direction? A set-up already completed or skipped at t=0 is at most a FLAG note, never
a FAIL. (Benchmark 2026-11-10: "no box", "already open at t=0", "already seated" failed three approved clips.)
Verdict:
- FAIL: what happens after t=0 contradicts the action: it happens in reverse (takes instead of gives, sits
  instead of stands, leaves instead of enters), or a clearly different action happens instead of it.
- FLAG: the action happens but barely reads, only partly, too late, or with an extra move the shot did not ask for.
- PASS: the described events match the action, in order and direction. Small details the description could not
  see (a nod, a look) are not failures - say they are unconfirmed.
Ignore camera moves (checked elsewhere) unless the action itself is a camera move.
Answer with ONE JSON object: {"verdict": "PASS|FLAG|FAIL", "matches": "...", "differs": "...", "confidence": "high|medium|low"}"""

def _json_call(A, model, key, system, content, max_tokens):
    """One call that must return a JSON object; one retry with a larger budget when the reply is cut off or
    malformed (Keycard 2026-11-11: two replies ended mid-string at 600 tokens -> JSONDecodeError)."""
    last = None; usd_u = []
    for mt in (max_tokens, max_tokens * 2):
        txt, u = A._call(model, key, system, content, mt); usd_u.append(u)
        try: return A.first_json(txt), usd_u
        except Exception as e: last = e
    raise last

def frames_at(clip, times, out_dir, width=768, fps=24.0):
    """PNG (JPEG via ffmpeg's mjpeg encoder failed on limited-range video on Windows, 2026-11-10, P004). A time at
    or past the last decodable frame writes nothing, so step back one frame at a time (up to 12) until it does."""
    paths = []
    for k, t in enumerate(times):
        p = os.path.join(out_dir, f"act_{k:02d}.png")
        for back in range(13):
            tt = max(0.0, t - back / fps)
            subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-ss", f"{tt:.3f}", "-i", clip, "-frames:v", "1",
                            "-vf", f"scale={width}:-2", p], check=False)
            if os.path.exists(p) and os.path.getsize(p) > 0: break
        else:
            raise RuntimeError(f"no frame could be read near {t:.2f} s")
        paths.append(p)
    return paths

def analyze(clip, action, out_dir, model="claude-sonnet-5-5", n=8, use=None, force=False, log=print):
    log = log or (lambda *a: None)
    import ai_review as A
    from fc_common import probe
    os.makedirs(out_dir, exist_ok=True)
    cp = os.path.join(out_dir, "action_check.json")
    saved_desc = None
    if os.path.exists(cp) and not force:
        r = json.load(open(cp, encoding="utf-8"))
        if r.get("action") == action and r.get("verdict") in ("PASS", "FLAG", "FAIL") and r.get("compare_version", 1) == COMPARE_VERSION:
            return dict(r, cached=True)
        if r.get("description"): saved_desc = r            # the frames did not change: only re-run the comparison
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key: return {"verdict": "NOT CHECKED", "why": "no API key and no saved result", "action": action}
    if not action: return {"verdict": "NOT CHECKED", "why": "the shot has no action text"}
    pi, pw, pr, po = A.PRICES.get(model, (2.0, 2.5, 0.1, 10.0)); usd = 0.0
    if saved_desc:
        desc, times = saved_desc["description"], saved_desc.get("times", [])
        return _compare(desc, times, action, model, key, cp, usd, pi, po, log, reused=True)
    w, h, fps, dur = probe(clip)
    t0, t1 = (use[0], min(use[1], dur)) if use else (0.0, dur)
    t1 = max(t0, t1 - 2.0 / fps)
    times = [round(t0 + (t1 - t0) * k / (n - 1), 3) for k in range(n)]
    tmp = tempfile.mkdtemp(prefix="act_")
    paths = frames_at(clip, times, tmp, fps=fps)
    content = []
    for t, p in zip(times, paths):
        content += [{"type": "text", "text": f"t={t:.2f} s"}, A.img_block(p, 768)[0]]
    desc, us = _json_call(A, model, key, BLIND, content, 2000)
    usd += sum((int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6 for u in us)
    import shutil; shutil.rmtree(tmp, ignore_errors=True)
    return _compare(desc, times, action, model, key, cp, usd, pi, po, log)

def _compare(desc, times, action, model, key, cp, usd, pi, po, log, reused=False):
    import ai_review as A
    cmp_, us = _json_call(A, model, key, COMPARE, [{"type": "text", "text": "Blind description:\n" + json.dumps(desc, indent=1)
                                              + "\n\nThe shot's action:\n" + action}], 1200)
    usd += sum((int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6 for u in us)
    v = (cmp_.get("verdict") or "FLAG").upper()
    res = {"verdict": v if v in ("PASS", "FLAG", "FAIL") else "FLAG", "action": action, "times": times, "description": desc,
           "matches": cmp_.get("matches", ""), "differs": cmp_.get("differs", ""), "confidence": cmp_.get("confidence", ""),
           "model": model, "usd": round(usd, 4), "compare_version": COMPARE_VERSION, "description_reused": reused}
    json.dump(res, open(cp, "w", encoding="utf-8"), indent=1)
    log(f"action check: {res['verdict']} ({res['confidence']}) - {res['differs'] or res['matches']}  (${usd:.3f})")
    return res

def apply(verdict, ar):
    """The clip verdict after the action check. Measured 2026-11-11 (SuperCool 55, comparison v2): the only action
    FAIL was P030 (high confidence, the real defect: he keeps the folder), 0 good clips failed; action FLAGs fell on
    clips already flagged plus minor P006 ("the turn barely reads"). Policy:
      - a clip already FAIL, or NOT REVIEWED (a spec question comes first), is left as it is;
      - action FAIL with HIGH confidence -> "FAIL (action)";
      - action FAIL with medium/low confidence, or action FLAG -> at least "FLAG" (a person looks);
      - PASS / NOT CHECKED / ERROR -> unchanged.
    Returns (new_verdict, reason or "")."""
    v = (ar or {}).get("verdict"); conf = ((ar or {}).get("confidence") or "").lower()
    why = ((ar or {}).get("differs") or "").strip()
    if verdict.startswith("FAIL") or verdict.startswith("NOT REVIEWED"): return verdict, ""
    if v == "FAIL" and conf == "high": return "FAIL (action)", f"ACTION: {why}"
    if v in ("FAIL", "FLAG"): return ("FLAG" if verdict == "PASS" else verdict), f"action {v.lower()} ({conf or '?'}): {why}"
    return verdict, ""

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("clip"); ap.add_argument("--action", required=True)
    ap.add_argument("--out"); ap.add_argument("--frames", type=int, default=8); ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--use"); ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.clip)), "action_check")
    use = [float(x) for x in a.use.split("-")] if a.use else None
    r = analyze(a.clip, a.action, out, a.model, a.frames, use, a.force)
    print(json.dumps({k: v for k, v in r.items() if k != "description"}, indent=1)); print(json.dumps(r.get("description"), indent=1))

if __name__ == "__main__":
    main()

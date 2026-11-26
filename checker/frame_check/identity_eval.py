"""identity_eval.py - measure face_id.identity() and start_check() on every labelled photoreal set. @anlim

2026-11-26 (KAMK face test): the identity check compared each clip only with its own start frame and missed 14 of 21
face failures Londi labelled; two new measures (start image vs uploaded photo, clip vs uploaded photo) were added.
This collects every person's numbers once (slow part) so rules can be compared fast, on clips the rules were NOT fitted
to (Kijan, SuperCool) as well as on KAMK.

  python identity_eval.py collect --cases identity_eval_cases.json --root DIR --out scores.json [--workers 4]
  python identity_eval.py rules --scores scores.json

cases JSON: {set: [{"set", "shot", "label", "clip", "start", "faces": {name: [paths]}, "people_labels"?: {name: label}}]}
Labels: per clip (pass | minor | fail) or per person (held | drifted | swapped | unsure). --root replaces the device prefix
(everything before "vid_projects/") so the same file works on the PC and in the cloud.
"""
import argparse, json, os, sys
from concurrent.futures import ProcessPoolExecutor
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def fix(p, root):
    if not root: return p
    p = p.replace("\\", "/"); i = p.lower().find("vid_projects/")
    return os.path.join(root, p[i + len("vid_projects/"):]) if i >= 0 else p

def one(args):
    case, root = args
    import face_id
    faces = {n: [fix(x, root) for x in v] for n, v in case["faces"].items()}
    clip, start = fix(case["clip"], root), fix(case["start"], root)
    try:
        r = face_id.identity(clip, faces, start, card_thr=None)
        s = face_id.start_check(start, faces, thr=None)
        return {**case, "identity": r, "start_check": s}
    except Exception as e:
        return {**case, "error": f"{type(e).__name__}: {e}"}

def collect(a):
    cases = json.load(open(a.cases)); todo = [(c, a.root) for v in cases.values() for c in v]
    done = json.load(open(a.out)) if os.path.exists(a.out) else []
    have = {(d["set"], d["shot"]) for d in done if "error" not in d}
    todo = [t for t in todo if (t[0]["set"], t[0]["shot"]) not in have]
    print(f"{len(todo)} to score, {len(have)} already", flush=True)
    done = [d for d in done if "error" not in d]
    with ProcessPoolExecutor(a.workers) as ex:
        for r in ex.map(one, todo):
            done.append(r); json.dump(done, open(a.out, "w"), indent=1, default=float)
            print(r["set"], r["shot"], r.get("error") or {n: (p.get("median"), p.get("card_median"), p.get("start_card"))
                                                         for n, p in r["identity"]["people"].items()}, flush=True)

BAD_CLIP = {"fail"}; GOOD_CLIP = {"pass"}

def rows(scores):
    """One row per (clip, person) with a label: bad True/False/None (unknown)."""
    out = []
    for d in scores:
        if "error" in d or d["identity"].get("error"): continue
        pl = d.get("people_labels") or {}
        for n, p in d["identity"]["people"].items():
            if pl:
                lab = pl.get(n); bad = None if lab in (None, "unsure") else lab != "held"
            else:
                lab = d["label"]; bad = True if lab in BAD_CLIP else False if lab in GOOD_CLIP else None
            sc = d["start_check"]["people"].get(n, {})
            out.append({"set": d["set"], "shot": d["shot"], "name": n, "label": lab, "bad": bad, "clip_label": d["label"],
                        "per_person": bool(pl), **{k: p.get(k) for k in ("median", "card_median", "card_min", "seen", "start_card")},
                        "start_score": sc.get("score")})
    return out

def rules(a):
    R = rows(json.load(open(a.scores)))
    def v(x): return x if x is not None else 9
    variants = {
        "today: vs start < 0.40": lambda r: v(r["median"]) < 0.40,
        "start image vs photo < 0.35": lambda r: v(r["start_score"]) < 0.35,
        "start image vs photo < 0.30": lambda r: v(r["start_score"]) < 0.30,
        "clip vs photo < 0.44": lambda r: v(r["card_median"]) < 0.44,
        "clip vs photo < 0.35": lambda r: v(r["card_median"]) < 0.35,
        "clip vs photo < 0.30": lambda r: v(r["card_median"]) < 0.30,
        "clip fell >0.10 below its start image (vs photo)": lambda r: r["card_median"] is not None and r["start_score"] is not None and r["start_score"] - r["card_median"] > 0.10,
        "today OR start<0.35": lambda r: v(r["median"]) < 0.40 or v(r["start_score"]) < 0.35,
        "today OR clip<0.35": lambda r: v(r["median"]) < 0.40 or v(r["card_median"]) < 0.35,
        "today OR clip<0.44": lambda r: v(r["median"]) < 0.40 or v(r["card_median"]) < 0.44,
    }
    sets = sorted({r["set"] for r in R})
    print("Per person (KAMK) or per clip-person (others: a clip's label applies to everyone in it; a 'fail' clip may have "
          "failed for reasons other than faces, so 'caught' there is an upper bound on usefulness, while flags on 'pass' "
          "clips are real false alarms).")
    for s in sets:
        rs = [r for r in R if r["set"] == s]; bad = [r for r in rs if r["bad"] is True]; good = [r for r in rs if r["bad"] is False]
        print(f"\n== {s}: {len(rs)} people, bad {len(bad)}, good {len(good)}, unknown {len(rs) - len(bad) - len(good)}")
        for k, f in variants.items():
            print(f"  {k:50s} bad flagged {sum(map(f, bad)):3d}/{len(bad):<3d} good flagged {sum(map(f, good)):3d}/{len(good)}")
    print("\n-- good people flagged by 'clip vs photo < 0.44' or 'start < 0.35' outside KAMK:")
    for r in R:
        if r["bad"] is False and not r["per_person"] and (v(r["card_median"]) < 0.44 or v(r["start_score"]) < 0.35):
            print(f"  {r['set']:22s} {r['shot']:10s} {r['name']:6s} start {r['start_score']} clip_vs_photo {r['card_median']} vs_start {r['median']}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect"); c.add_argument("--cases", required=True); c.add_argument("--root"); c.add_argument("--out", required=True)
    c.add_argument("--workers", type=int, default=4)
    r = sub.add_parser("rules"); r.add_argument("--scores", required=True)
    a = ap.parse_args(); (collect if a.cmd == "collect" else rules)(a)

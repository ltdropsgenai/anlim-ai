"""height_check.py - are the characters in a still drawn at the right sizes relative to each other? @anlim

Why: relative height has gone wrong three ways and nothing caught it at the still stage: the Phase 0 S2 still (King
drawn bigger than Layana), the talking shot's still and clip (seated, the same height - Londi 2026-11-16, which
"continue" then carried into the next shot), and the first live new setup (King 96 % of Layana's height; his card
says about 85 %). The room check ignores characters and the frame review's RELATIVE HEIGHT rule fires on good clips
as often as on bad ones.
How:
  1. Cut each character out (cutout.py; with the location's plate when it fits). Sizes are compared in order (the
     tallest card vs the tallest drawn); telling who is who by colour did not work on these stills.
  2. MEASURE (free) a pair only when both stand with their feet in the picture at about the same depth (feet within
     3 % of the frame height): head-to-feet height ratio vs the ratio of their cards' height units.
     WRONG when it is off by more than TOL (6 %).
  3. Anything else (sitting, kneeling, cut off, at different depths, a head count that does not match) goes to ONE
     AI question with the still and the references: is each shorter character drawn clearly shorter, about as the
     cards say, allowing for poses and distance?  ~$0.01 with Sonnet. No API key -> NOT CHECKED for those pairs.
Verdict: OK | WRONG | UNSURE | NOT CHECKED, with one plain sentence per problem for the creator.

  python height_check.py STILL.png --cast "Layana=10:ref_layana.png" --cast "King=8.5:ref_king.png" [--plate P.png] [--out DIR] [--no-ai]
  python height_check.py --clip clip.mp4 --cast Layana=10:<ref.png> --cast King=8.5:<ref.png> --out <dir>   (last frame)
  python height_check.py --bench cases.json      (labelled stills: {"cases": [{"id", "still", "plate"?, "cast": [...], "want"}]})
  in code: height_check.check(still, cast=[{"name", "height", "ref"}], plate=None, out_dir=None, ai=True)
"""
import argparse, itertools, json, os, sys, tempfile
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
import numpy as np
import cv2
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

VERSION = 1
TOL = 0.06          # measured/expected ratio may be off by this much
SAME_DEPTH = 0.03   # feet within this share of the frame height = same distance from the camera
MODEL = "claude-sonnet-5-5"

SYSTEM = """You check ONE still from a video (a cartoon or a photoreal film) for character SIZES only: is each character drawn at the
right height relative to the others? You get the still, then a reference picture of each character with their height
in units (a character of 8.5 units next to one of 10 is about 85 % as tall: when both stand, the shorter one's head top
is around the taller one's eyebrows or eyes). Allow for pose and distance: someone sitting, kneeling or further from
the camera is drawn smaller; compare head sizes and body proportions too, not only head tops. Ignore everything else
(faces, clothes, room). Name characters as the references do.
Answer with ONE JSON object:
{"pairs": [{"taller": "<name>", "shorter": "<name>", "looks": "right|same height|reversed|too small|too big",
            "confidence": "high|medium|low", "why": "<one sentence, at most 25 words>"}],
 "verdict": "OK|WRONG|UNSURE"}
WRONG when any pair is not "right" with medium or high confidence; UNSURE when you cannot tell."""


def _hist(img):
    """Hue/saturation histogram of a cut-out's non-white pixels."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m = (img.min(axis=2) < 235).astype(np.uint8)
    h = cv2.calcHist([hsv], [0, 1], m, [30, 8], [0, 180, 0, 256])
    return cv2.normalize(h, h).flatten()


def identify(cut_paths, cast):
    """Best assignment of cut-outs (left to right) to cast members by colour; None when it cannot be told."""
    refs = [c.get("ref") for c in cast]
    if len(cut_paths) != len(cast) or not all(r and os.path.exists(r) for r in refs): return None, 0.0
    hc = [_hist(cv2.imread(p)) for p in cut_paths]; hr = [_hist(cv2.imread(r)) for r in refs]
    S = np.array([[cv2.compareHist(a, b, cv2.HISTCMP_CORREL) for b in hr] for a in hc])
    perms = sorted(((sum(S[i, p[i]] for i in range(len(p))), p) for p in itertools.permutations(range(len(cast)))), reverse=True)
    best, second = perms[0], (perms[1] if len(perms) > 1 else (-9, None))
    margin = float(best[0] - second[0])
    return (list(best[1]) if margin > 0.15 else None), margin   # who is cut-out i: cast[best[1][i]]


def _measurable(box):
    x0, y0, x1, y1 = box
    return y1 < 0.985 and y0 > 0.01 and (y1 - y0) / max(1e-6, x1 - x0) > 1.6   # whole body in frame, upright


def check(still, cast, plate=None, out_dir=None, ai=True, model=MODEL, log=None):
    import cutout as CU
    log = log or (lambda *a: None)
    out_dir = out_dir or tempfile.mkdtemp(prefix="height_")
    cuts = CU.cutouts(still, os.path.join(out_dir, "cuts"), plate=plate)
    res = {"verdict": None, "measured": [], "ai": None, "notes": [], "people_found": len(cuts), "version": VERSION, "usd": 0.0}
    cast = [c for c in cast if c.get("height")]
    if len(cast) < 2:
        res.update(verdict="NOT CHECKED", notes=["fewer than two characters with a height on their card"]); return res
    # Who is who is NOT needed to measure: sizes are compared in order (tallest card vs tallest drawn, ...). Telling the
    # characters apart by colour failed on these stills (2026-11-16: skin and black clothes dominate; margins 0.02-0.15),
    # so a REVERSED pair (the shorter one drawn taller, Phase 0 S2) reads as "same height or close" here, or goes to the AI.
    order = sorted(range(len(cuts)), key=lambda k: -(cuts[k]["box"][3] - cuts[k]["box"][1]))
    names = sorted(cast, key=lambda c: -c["height"])
    todo = []
    if len(cuts) != len(cast):
        res["notes"].append(f"found {len(cuts)} character(s) for {len(cast)} on the cast")
        todo.append(("all", "all"))
    else:
        for x, y in itertools.combinations(range(len(order)), 2):
            a, b = names[x], names[y]
            if a["height"] == b["height"]: continue
            ba, bb = cuts[order[x]]["box"], cuts[order[y]]["box"]
            if _measurable(ba) and _measurable(bb) and abs(ba[3] - bb[3]) <= SAME_DEPTH:
                ha, hb = ba[3] - ba[1], bb[3] - bb[1]
                want, got = b["height"] / a["height"], hb / ha
                ok = abs(got / want - 1) <= TOL
                m = {"taller": a["name"], "shorter": b["name"], "expected": round(want, 3), "measured": round(float(got), 3), "ok": ok}
                if not ok:
                    m["say"] = (f"{b['name']} and {a['name']} are drawn about the same height; their cards say {b['name']} is about "
                                f"{round(100 * want)} % of {a['name']}'s height." if got >= 0.97 else
                                f"The shorter character is drawn at {round(100 * got)} % of the taller one's height; the cards say about "
                                f"{round(100 * want)} % ({b['name']} vs {a['name']}).")
                res["measured"].append(m)
            else:
                todo.append((a["name"], b["name"]))
    if todo:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not ai or not key:
            res["notes"].append("sitting, cut off or at different distances: needs the AI question, which was not asked (no API key)")
        else:
            import ai_review as A
            content = [{"type": "text", "text": "The still:"}, A.img_block(still, 1600)[0]]
            for c in cast:
                if c.get("ref") and os.path.exists(c["ref"]):
                    content += [{"type": "text", "text": f"{c['name']}: {c['height']} units. Reference:"}, A.img_block(c["ref"], 768)[0]]
                else:
                    content += [{"type": "text", "text": f"{c['name']}: {c['height']} units (no reference picture)."}]
            if todo and todo[0][0] != "all":
                content.append({"type": "text", "text": "Check these pairs: " + "; ".join(f"{x} vs {y}" for x, y in todo)})
            txt, u = A._call(model, key, SYSTEM, content, 3000)   # Sonnet 5.5 thinks by default: room for it (2026-11-17)
            pi, pw, pr, po = A.PRICES.get(model, (2.0, 2.5, 0.1, 10.0))
            res["usd"] = round((int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6, 4)
            try: res["ai"] = A.first_json(txt)
            except Exception: res["ai"] = {"verdict": "UNSURE", "pairs": [], "error": "unreadable reply"}
    bad = [m for m in res["measured"] if not m["ok"]]
    ai_v = (res["ai"] or {}).get("verdict")
    for p in (res["ai"] or {}).get("pairs", []):
        if p.get("looks") != "right" and p.get("confidence") in ("high", "medium"):
            bad.append({"say": f"{p.get('shorter')} vs {p.get('taller')}: {p.get('looks')} - {p.get('why', '')}"})
    if bad: res["verdict"] = "WRONG"
    elif ai_v == "UNSURE": res["verdict"] = "UNSURE"
    elif res["measured"] or ai_v == "OK": res["verdict"] = "OK"
    else: res["verdict"] = "NOT CHECKED"
    res["problems"] = [m["say"] for m in bad if m.get("say")]
    res["notes"] = [n for n in res["notes"] if n]
    json.dump(res, open(os.path.join(out_dir, "height_check.json"), "w"), indent=1, default=float)
    log(f"height: {res['verdict']} {res['problems']}")
    return res


def last_frame(clip, out_png):
    """The clip's last decodable frame as a PNG; returns its time in seconds (the frame count in the header can be
    off by a frame or two, so the last few frames are read through)."""
    cap = cv2.VideoCapture(clip)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0); fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    if n > 5: cap.set(cv2.CAP_PROP_POS_FRAMES, n - 5)
    last, i = None, max(0, n - 5) - 1
    while True:
        ok, f = cap.read()
        if not ok: break
        last, i = f, i + 1
    cap.release()
    if last is None: raise ValueError("no frame could be read from the clip")
    os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
    cv2.imwrite(out_png, last)
    return round(i / fps, 2)


def check_clip_end(clip, cast, out_dir, ai=True, model=MODEL, log=None, force=False):
    """2026-11-16: the height check on a finished clip's LAST frame. Sizes drift during a clip (Phase 0 S5: seated,
    Layana and King end the same height) and the next shot's Continue start frame IS this frame, so it is caught on
    the clip, before it is approved. The start frame was checked when it was made in the app. Cached in out_dir."""
    d = os.path.join(out_dir, "height_end"); cache = os.path.join(d, "height_check.json")
    if not force and os.path.exists(cache):
        r = json.load(open(cache, encoding="utf-8"))
        if r.get("version") == VERSION and "end_t" in r: return r
    png = os.path.join(d, "last.png")
    t = last_frame(clip, png)
    r = check(png, cast, out_dir=d, ai=ai, model=model, log=log)
    r["end_t"] = t; r["still"] = png
    json.dump(r, open(cache, "w"), indent=1, default=float)
    return r


def apply(verdict, hr):
    """WRONG -> at least FLAG (a person looks), with a timeline mark at the last frame. FLAG only for now: 9 labelled
    stills is too few to fail a clip on. FAIL and NOT REVIEWED stay."""
    if hr.get("verdict") != "WRONG" or verdict.startswith(("FAIL", "NOT REVIEWED")):
        return verdict, "", []
    probs = "; ".join(hr.get("problems") or ["the characters' sizes do not match their cards"])
    why = f"heights wrong at the end of the clip: {probs}"[:300]
    flags = [{"t_s": hr.get("end_t"), "frame": "ht0", "verdict": "FAIL", "rules": ["HEIGHTS"],
              "note": ("last frame: " + probs)[:280]}]
    return ("FLAG" if verdict == "PASS" else verdict), why, flags


def _cast_arg(s):
    name, rest = s.split("=", 1); h, _, ref = rest.partition(":")
    return {"name": name, "height": float(h), "ref": ref or None}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("still", nargs="?"); ap.add_argument("--cast", action="append", default=[])
    ap.add_argument("--plate"); ap.add_argument("--out"); ap.add_argument("--no-ai", action="store_true"); ap.add_argument("--bench")
    ap.add_argument("--clip", help="check a finished clip's last frame instead of a still")
    a = ap.parse_args()
    if a.bench:
        root = os.path.dirname(os.path.dirname(HERE))
        P = lambda p: p if (not p or os.path.isabs(p)) else os.path.join(root, *p.split("/"))
        cases = json.load(open(a.bench, encoding="utf-8"))["cases"]; tot = 0.0; score = []
        for c in cases:
            cast = [dict(x, ref=P(x.get("ref"))) for x in c["cast"]]
            r = check(P(c["still"]), cast, plate=P(c.get("plate")), out_dir=os.path.join(os.path.dirname(os.path.abspath(a.bench)), c["id"]), ai=not a.no_ai)
            tot += r["usd"]; hit = (c.get("want") in (None, "unscored")) or r["verdict"] == c["want"]; score.append(hit)
            print(f"{c['id']:14s} want {c.get('want', '-'):9s} got {r['verdict']:11s} {'ok ' if hit else 'MISS'} "
                  f"measured={[(m['shorter'], m['measured'], m['expected']) for m in r['measured']]} ai={(r['ai'] or {}).get('verdict')} "
                  f"{r['problems'][:1] or r['notes'][:1]}")
        print(f"{sum(score)}/{len(score)} as labelled, ${tot:.3f}")
        return
    if a.clip:
        r = check_clip_end(a.clip, [_cast_arg(x) for x in a.cast], a.out or tempfile.mkdtemp(prefix="height_"), ai=not a.no_ai, log=print, force=True)
        print(json.dumps({k: r.get(k) for k in ("verdict", "problems", "notes", "measured", "end_t", "usd", "still")}, indent=1, default=float))
        return
    r = check(a.still, [_cast_arg(x) for x in a.cast], plate=a.plate, out_dir=a.out, ai=not a.no_ai, log=print)
    print(json.dumps(r, indent=1, default=float))

if __name__ == "__main__":
    main()

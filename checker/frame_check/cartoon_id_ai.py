"""cartoon_id_ai.py - does each drawn character keep their look through a clip? One AI question per clip. @anlim

Why (2026-11-26, KAMK cartoon face test, Londi's labels on 16 takes): the face model (SFace) cannot tell drawn faces
apart (AUC 0.53-0.68 on every score; it put men's faces under a woman), and general image embeddings of the face crops
did no better (DINOv2 0.57-0.60, CLIP 0.48-0.77 on 11-14 clips). So the comparison is asked of a vision model: the
start frame and four later frames, plus each character's uploaded picture only to say who is who.

  python cartoon_id_ai.py judge --clip C.mp4 --start S.png --cast "Anlim=photo.png" --cast "Partner=" [--model ...]
  python cartoon_id_ai.py eval --cases cases.json --labels labels.txt [--model claude-sonnet-5-5] [--max-usd 2] [--yes]

cases.json: [{"name": "C_FT1_kling", "clip": path, "start": path or null (null = the clip's first frame),
              "cast": {name: photo path or null}}]; labels.txt: lines "C_FT1_kling|Anlim = held|drifted|swapped|unsure".
Needs ANTHROPIC_API_KEY in the environment or in ..\\..\\worker\\.env (read here, never printed). Prices: ai_review.PRICES.
"""
import argparse, json, os, sys, tempfile
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
import ai_review as A

SYSTEM = """You check drawn (cartoon) video clips for character consistency. Image 1 is the approved START FRAME of a
clip; the following frames come from later in the same clip, in order. The last images are the creator's uploaded
pictures of each character, given ONLY to tell you who is who: the cartoon redraw changes faces from those pictures on
purpose, so never judge a character against their picture.
For each named character, compare them in the later frames with how they look in the START FRAME: face shape, eyes,
nose, hair (style, length, colour), skin tone, apparent age, facial hair, glasses, build, clothes.
- held: the same character throughout (pose, angle, expression, lighting and motion blur may change).
- drifted: in at least one later frame they look like a noticeably different character (a different face, hair, age
  or skin tone), even partly or briefly.
- swapped: they took on another cast member's look, or two characters traded looks or places.
- not_visible: too small, hidden or turned away in the later frames to judge.
Answer with ONE JSON object: {"characters": {"<name>": {"verdict": "held|drifted|swapped|not_visible",
"frames": [later frame numbers where it shows], "why": "<at most 20 words>"}}}"""

def key():
    k = os.environ.get("ANTHROPIC_API_KEY")
    if k: return k
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "worker", ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            if line.strip().startswith("ANTHROPIC_API_KEY="): return line.split("=", 1)[1].strip().strip('"')
    sys.exit("ANTHROPIC_API_KEY is not set (environment or worker/.env)")

def frames(clip, n=4, width=1280):
    cap = cv2.VideoCapture(clip); total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); fps = cap.get(cv2.CAP_PROP_FPS) or 24
    idx = [round((total - 1) * (k + 1) / n) for k in range(n)]; out = []; tmp = tempfile.mkdtemp(prefix="cid_")
    first = None
    for i in [0] + idx:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i); ok, im = cap.read()
        if not ok: continue
        if im.shape[1] > width: im = cv2.resize(im, (width, int(im.shape[0] * width / im.shape[1])), interpolation=cv2.INTER_AREA)
        p = os.path.join(tmp, f"f{i}.jpg"); cv2.imwrite(p, im, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if i == 0: first = p
        else: out.append((round(i / fps, 2), p))
    return first, out

def judge(clip, start, cast, model="claude-sonnet-5-5", k=None):
    first, later = frames(clip)
    content = [{"type": "text", "text": "Image 1: START FRAME."}, A.img_block(start or first, 1600)[0]]
    for j, (t, p) in enumerate(later):
        content += [{"type": "text", "text": f"Later frame {j + 2} (at {t} s):"}, A.img_block(p, 1600)[0]]
    for n, ph in cast.items():
        if ph: content += [{"type": "text", "text": f"Uploaded picture of {n} (who is who only):"}, A.img_block(ph, 512)[0]]
    names = ", ".join(cast)
    content.append({"type": "text", "text": f"Characters in this clip: {names}. Judge each one as described."})
    txt, usage = A._call(model, k or key(), SYSTEM, content, max_tokens=800)
    pi, _, _, po = A.PRICES.get(model, (4.0, 5.0, 0.2, 20.0))
    usd = usage.get("input_tokens", 0) * pi / 1e6 + usage.get("output_tokens", 0) * po / 1e6
    try: r = A.first_json(txt) or {}
    except Exception: r = {}
    return {"characters": (r.get("characters") or {}), "usd": round(usd, 4), "raw": txt[:2000]}

def cmd_judge(a):
    cast = dict(x.split("=", 1) for x in a.cast); cast = {n: (p or None) for n, p in cast.items()}
    print(json.dumps(judge(a.clip, a.start, cast, a.model), indent=1))

def cmd_eval(a):
    cases = json.load(open(a.cases)); labels = {}
    for line in open(a.labels, encoding="utf-8"):
        if " = " in line: kk, v = line.strip().split(" = "); t, n = kk.split("|"); labels[(t, n)] = v
    est = len(cases) * 0.03 if "sonnet" in a.model else len(cases) * 0.003
    if not a.yes:
        sys.exit(f"about ${est:.2f} for {len(cases)} clips with {a.model} (rough: ~10k tokens a clip); add --yes to run")
    k = key(); spent = 0.0; out = []
    res_path = os.path.splitext(a.cases)[0] + f"_ai_{a.model}.json"
    for c in cases:
        if spent > a.max_usd: print("stopped: --max-usd reached"); break
        r = judge(c["clip"], c.get("start"), c["cast"], a.model, k); spent += r["usd"]
        for n in c["cast"]:
            lab = labels.get((c["name"], n)); got = (r["characters"].get(n) or {}).get("verdict")
            out.append({"take": c["name"], "name": n, "label": lab, "ai": got, "why": (r["characters"].get(n) or {}).get("why")})
            print(f"{c['name']:16s} {n:12s} label {str(lab):8s} ai {got}", flush=True)
        json.dump(out, open(res_path, "w"), indent=1)
    sc = [o for o in out if o["label"] not in (None, "unsure") and o["ai"] not in (None, "not_visible")]
    bad = lambda v: v in ("drifted", "swapped")
    tp = sum(bad(o["label"]) and bad(o["ai"]) for o in sc); fn = sum(bad(o["label"]) and not bad(o["ai"]) for o in sc)
    fp = sum((not bad(o["label"])) and bad(o["ai"]) for o in sc); tn = sum((not bad(o["label"])) and not bad(o["ai"]) for o in sc)
    print(f"\n{a.model}: failures caught {tp}/{tp + fn}, held flagged {fp}/{fp + tn}, "
          f"not judged {len(out) - len(sc)}; spent ${spent:.3f}; results in {res_path}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("judge"); j.add_argument("--clip", required=True); j.add_argument("--start"); j.add_argument("--cast", action="append", required=True)
    j.add_argument("--model", default="claude-sonnet-5-5")
    e = sub.add_parser("eval"); e.add_argument("--cases", required=True); e.add_argument("--labels", required=True)
    e.add_argument("--model", default="claude-sonnet-5-5"); e.add_argument("--max-usd", type=float, default=2.0); e.add_argument("--yes", action="store_true")
    a = ap.parse_args(); (cmd_judge if a.cmd == "judge" else cmd_eval)(a)

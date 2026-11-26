"""cartoon_id_ai.py - does each drawn character keep their look through a clip? One AI question per clip. @anlim

Why (2026-11-26, KAMK cartoon face test, Londi's labels on 16 takes): the face model (SFace) cannot tell drawn faces
apart (AUC 0.53-0.68 on every score; it put men's faces under a woman), and general image embeddings of the face crops
did no better (DINOv2 0.57-0.60, CLIP 0.48-0.77 on 11-14 clips). So the comparison is asked of a vision model: the
start frame and four later frames, plus each character's uploaded picture only to say who is who.

  python cartoon_id_ai.py judge --clip C.mp4 --start S.png --cast "Anlim=photo.png" --cast "Partner=" [--model ...]
  python cartoon_id_ai.py eval --cases cases.json --labels labels.txt [--model claude-sonnet-5-5] [--max-usd 2] [--yes] [--faces]

v1 (four frames, whole-frame view) caught 0 of 10 KAMK failures and flagged 0 of 18 held, $0.26 with Sonnet: it read the
clothes and hair as the same character ("same bearded man... cream henley"). v2 (--faces) adds face crops and says so.

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

FACES_NOTE = """
FACE CROPS: after each frame come enlarged crops of every face found in it (drawn faces are found well enough; who is
who is for you to decide). Judge identity from the FACE: shape of the face and jaw, eyes, eyebrows, nose, mouth, facial
hair, skin tone, apparent age. Clothes, hairstyle and position are NOT evidence that it is the same character: a video
model often keeps the clothes and hair while the face becomes someone else's. If the face in a later crop would not pass
for the same drawn character as in the start-frame crops, say drifted."""

def face_crops(path, n=6, size=384):
    """Enlarged crops of the biggest faces in a frame (YuNet), saved next to it."""
    import face_id
    im = cv2.imread(path); F = face_id.Faces(0.6); h, w = im.shape[:2]; k = 1280 / max(h, w)
    sm = cv2.resize(im, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_CUBIC)
    F.det.setInputSize((sm.shape[1], sm.shape[0])); _, f = F.det.detect(sm); out = []
    rows = sorted((r for r in (f if f is not None else []) if r[2] / k >= 14), key=lambda r: -r[2])[:n]
    for i, r in enumerate(sorted(rows, key=lambda r: r[0])):
        x, y, bw, bh = [float(v / k) for v in r[:4]]; pad = 0.45
        x0, y0 = max(0, int(x - pad * bw)), max(0, int(y - pad * bh)); x1, y1 = min(w, int(x + bw * (1 + pad))), min(h, int(y + bh * (1 + pad)))
        c = im[y0:y1, x0:x1]; s = size / max(c.shape[:2]); c = cv2.resize(c, (int(c.shape[1] * s), int(c.shape[0] * s)), interpolation=cv2.INTER_CUBIC)
        p = f"{path[:-4]}_face{i}.jpg"; cv2.imwrite(p, c, [cv2.IMWRITE_JPEG_QUALITY, 92]); out.append(p)
    return out

def judge(clip, start, cast, model="claude-sonnet-5-5", k=None, faces=False):
    first, later = frames(clip, n=6 if faces else 4)
    content = [{"type": "text", "text": "Image 1: START FRAME."}, A.img_block(start or first, 1600)[0]]
    if faces:
        for c in face_crops(start or first): content += [{"type": "text", "text": "Start-frame face crop:"}, A.img_block(c, 400)[0]]
    for j, (t, p) in enumerate(later):
        content += [{"type": "text", "text": f"Later frame {j + 2} (at {t} s):"}, A.img_block(p, 1600)[0]]
        if faces:
            for c in face_crops(p): content += [{"type": "text", "text": f"Face crop from frame {j + 2}:"}, A.img_block(c, 400)[0]]
    for n, ph in cast.items():
        if ph: content += [{"type": "text", "text": f"Uploaded picture of {n} (who is who only):"}, A.img_block(ph, 512)[0]]
    names = ", ".join(cast)
    content.append({"type": "text", "text": f"Characters in this clip: {names}. Judge each one as described."})
    txt, usage = A._call(model, k or key(), SYSTEM + (FACES_NOTE if faces else ""), content, max_tokens=800)
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
    est = (len(cases) * 0.03 if "sonnet" in a.model else len(cases) * 0.003) * (2.5 if a.faces else 1)
    if not a.yes:
        sys.exit(f"about ${est:.2f} for {len(cases)} clips with {a.model} (rough: ~10k tokens a clip); add --yes to run")
    k = key(); spent = 0.0; out = []
    res_path = os.path.splitext(a.cases)[0] + f"_ai_{a.model}{'_faces' if a.faces else ''}.json"
    for c in cases:
        if spent > a.max_usd: print("stopped: --max-usd reached"); break
        r = judge(c["clip"], c.get("start"), c["cast"], a.model, k, faces=a.faces); spent += r["usd"]
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
    e.add_argument("--faces", action="store_true", help="v2 (2026-11-26): six later frames plus enlarged face crops, and judge the face only "
                   "(v1 judged by clothes and hair: 0 of 10 failures caught on KAMK)")
    a = ap.parse_args(); (cmd_judge if a.cmd == "judge" else cmd_eval)(a)

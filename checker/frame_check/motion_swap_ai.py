"""motion_swap_ai.py - did a motion-transfer render keep who is who? Checked shot by shot by Claude. @anlim

2026-11-20: motion transfer (Genjutsu / Genjutsu Light) maps the source clip's people to the creator's characters again at
each camera cut and sometimes gets one shot wrong (rooftop test: the 9-10 s close-up came back with the other fighter;
the app's first live run also swapped the opening flip). motion_swap.py tried to catch this from clothing colours and
missed it: close-ups hold 0-1 detectable people and the colour clusters drift. This version asks a vision model.

 1. Shots are found in the render (sync_check.find_cuts). Each shot gives one moment (two for shots over 3 s).
 2. For each moment the source frame and the render frame are put side by side on one picture.
 3. One Claude call gets the creator's character images, the who-is-who text (if any) and all moments, and answers which
    render character plays each source person in each shot.
 4. The mapping most sure shots agree with is "who is who" (or the who-is-who text, when the model could apply it).
    Shots that disagree are listed with their times.

Never a FAIL (2026-11-20 policy: the checker only flags). FLAG with times; NOT SURE when the model is unsure of most
shots; NOT CHECKED when there is no key or the call fails. One call per clip.

  python motion_swap_ai.py RENDER.mp4 SOURCE.mp4 --refs a.png [b.png ...] [--who "text"] [--json out.json]
      [--sheets DIR]   only write the side-by-side pictures (no call)
"""
import argparse, io, json, os, sys
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from role_source import frames_rgb
from sync_check import find_cuts
from ai_review import _call, img_block, first_json, PRICES

MODEL = os.environ.get("MOTION_SWAP_MODEL", "claude-sonnet-5-5")
FRAME_W = 512          # each half of a side-by-side picture
MAX_MOMENTS = 16

SYSTEM = """You check a motion-transfer video. The creator filmed or found a SOURCE clip and asked an AI to redraw it with
their own characters (the REFERENCE images), keeping every move, camera angle and cut. The AI re-decides who plays whom
at each camera cut and sometimes swaps two characters for a shot. Your job is to find those shots.

You get: the reference images, optionally the creator's who-is-who text, then numbered moments. Each moment is one
picture: SOURCE frame on the left, RENDER frame on the right, taken at the same time.

Method:
- Name each distinct person of the SOURCE once, by what does not change between shots (clothing, hair, build), as P1, P2...
- Name each REFERENCE character once as C1, C2... (in reference order, by look).
- For every moment, match each source person to the render character drawn in the SAME place doing the SAME pose and
  motion. Judge by pose and position, then name the render character by its look (clothes, hair, weapon).
- A person off-screen or too small/blurred to tell: leave them out. If you cannot tell at all, sure=false.
- If the who-is-who text says which source person should be which character, give that as "expected".

Answer with ONE JSON object and nothing else:
{"source_people": {"P1": "<6-12 words>", ...}, "characters": {"C1": "<6-12 words>", ...},
 "expected": {"P1": "C1", ...} or null,
 "moments": [{"m": 1, "map": {"P1": "C2", "P2": "C1"}, "sure": true, "why": "<at most 15 words>"}, ...]}"""


def _label(im, text):
    d = ImageDraw.Draw(im); d.rectangle([0, 0, 8 * len(text) + 10, 18], fill=(0, 0, 0)); d.text((5, 3), text, fill=(255, 255, 0))
    return im


def moments(render, source):
    """[(t_seconds, shot_no, render_rgb, source_rgb)] - the middle of each shot, plus thirds for shots over 3 s."""
    R, rf = frames_rgb(render, w=FRAME_W); S, sf = frames_rgb(source, w=FRAME_W)
    n = min(len(R), int(len(S) / sf * rf))                       # the render can run past its (rounded-up) source
    cuts = [c for c in sorted(set(find_cuts(R[:n].astype(np.float32).mean(-1)))) if 0 < c < n]
    bounds = [0] + cuts + [n]; out = []
    for k in range(len(bounds) - 1):
        a, b = bounds[k], bounds[k + 1]
        if b - a < 4: continue                                   # a flash of a few frames: not a shot
        picks = [a + (b - a) // 2] if (b - a) / rf <= 3 else [a + (b - a) // 3, a + 2 * (b - a) // 3]
        for i in picks:
            j = min(int(round(i / rf * sf)), len(S) - 1)
            out.append((round(i / rf, 2), k + 1, R[i], S[j], round(a / rf, 2), round(b / rf, 2)))
    if len(out) > MAX_MOMENTS:                                   # keep it to one cheap call: even spread
        out = [out[int(x)] for x in np.linspace(0, len(out) - 1, MAX_MOMENTS)]
    return out


def sheet(mo, idx):
    t, shot, r, s = mo[0], mo[1], mo[2], mo[3]
    h = max(r.shape[0], s.shape[0]); im = Image.new("RGB", (FRAME_W * 2 + 8, h), (40, 40, 40))
    im.paste(_label(Image.fromarray(s), f"{idx} SOURCE {t:.1f}s"), (0, 0))
    im.paste(_label(Image.fromarray(r), f"{idx} RENDER {t:.1f}s"), (FRAME_W + 8, 0))
    return im


def _block(im):
    import base64
    b = io.BytesIO(); im.save(b, "JPEG", quality=88)
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(b.getvalue()).decode()}}


def judge(answer, mos):
    """Majority (or expected) mapping, then the moments that disagree, merged per shot."""
    ms = {int(x.get("m", 0)): x for x in answer.get("moments", []) if isinstance(x, dict)}
    expected = answer.get("expected") or None
    votes = {}
    for x in ms.values():
        if not x.get("sure"): continue
        for p, c in (x.get("map") or {}).items(): votes.setdefault(p, {}).setdefault(c, 0); votes[p][c] += 1
    majority = {p: max(v, key=v.get) for p, v in votes.items()}
    truth = expected if expected and all(p in majority for p in expected) else majority
    bad = []
    for i, mo in enumerate(mos, 1):
        x = ms.get(i)
        if not x or not x.get("sure"): continue
        wrong = [p for p, c in (x.get("map") or {}).items() if p in truth and truth[p] != c]
        if wrong: bad.append((mo, wrong, x.get("why", "")))
    issues = {}
    for mo, wrong, why in bad:
        shot = mo[1]
        if shot not in issues:
            issues[shot] = {"kind": "swap", "shot": shot, "from_s": mo[4], "to_s": mo[5], "people": sorted(set(wrong)), "why": why}
    out = []
    for x in issues.values():
        x["text"] = f"who is who looks swapped in the shot at {x['from_s']:.1f}-{x['to_s']:.1f} s ({x['why']})"
        out.append(x)
    sure = sum(1 for x in ms.values() if x.get("sure"))
    return out, truth, sure, (expected is not None and truth is expected)


def analyze(render, source, refs, who=None, key=None, log=print, model=MODEL):
    log = log or (lambda *a: None)
    res = {"render": os.path.basename(render), "source": os.path.basename(source), "verdict": "NOT CHECKED", "issues": [], "model": model}
    key = key or os.environ.get("ANTHROPIC_API_KEY")
    if not key: res["why"] = "ANTHROPIC_API_KEY is not set"; log(f"motion swap: {res['why']}"); return res
    mos = moments(render, source)
    if len(mos) < 1: res["why"] = "no shots found"; return res
    content = [{"type": "text", "text": f"REFERENCE images ({len(refs)}):"}]
    for p in refs: content.append(img_block(p, cap=1024)[0])
    content.append({"type": "text", "text": f"Who is who (creator's words): {who.strip()}" if who and who.strip() else "No who-is-who text was given."})
    for i, mo in enumerate(mos, 1):
        content.append({"type": "text", "text": f"Moment {i} (shot {mo[1]}, {mo[0]:.1f} s):"}); content.append(_block(sheet(mo, i)))
    try:
        txt, usage = _call(model, key, SYSTEM, content, max_tokens=3000)
        ans = first_json(txt)
    except Exception as e:
        res["why"] = f"the check could not run ({type(e).__name__})"; log(f"motion swap: {res['why']}: {e}"); return res
    p = PRICES.get(model, (0, 0, 0, 0))
    cost = (usage.get("input_tokens", 0) * p[0] + usage.get("output_tokens", 0) * p[3]) / 1e6
    issues, truth, sure, used_expected = judge(ans, mos)
    res.update({"moments": len(mos), "moments_sure": sure, "mapping": truth, "from_who_text": used_expected,
                "source_people": ans.get("source_people"), "characters": ans.get("characters"), "issues": issues,
                "usd": round(cost, 4), "usage": usage, "answer": ans,
                "times": [{"m": i, "t": mo[0], "shot": mo[1]} for i, mo in enumerate(mos, 1)]})
    if sure < max(2, len(mos) // 2): res["verdict"] = "NOT SURE"
    else: res["verdict"] = "FLAG" if issues else "PASS"
    log(f"motion swap {res['render']}: {len(mos)} moments, {sure} sure, mapping {truth}"
        f"{' (from who-is-who)' if used_expected else ''} -> {res['verdict']}  ${cost:.3f}")
    for x in issues: log("  " + x["text"])
    return res


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("render"); ap.add_argument("source")
    ap.add_argument("--refs", nargs="+", default=[]); ap.add_argument("--who"); ap.add_argument("--json")
    ap.add_argument("--sheets"); ap.add_argument("--model", default=MODEL)
    a = ap.parse_args()
    if a.sheets:
        os.makedirs(a.sheets, exist_ok=True)
        for i, mo in enumerate(moments(a.render, a.source), 1): sheet(mo, i).save(os.path.join(a.sheets, f"m{i:02d}.jpg"), quality=85)
        print("sheets in", a.sheets); return
    res = analyze(a.render, a.source, a.refs, a.who, model=a.model)
    if a.json: json.dump(res, open(a.json, "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()

"""passthrough_check.py - did a character walk THROUGH furniture? One clip-level AI question. @anlim

Why: frame-by-frame review cannot see it. In app clip S3 (2026-11-12, rejected by Londi: "she walks through the
table, the generator masked the parts of her body inside it") every single frame is an ordinary picture of a girl
partly hidden by a table; Haiku flagged a few frames, Sonnet's second opinion dismissed them as "ordinary
occlusion", and the action check passed it. The defect only exists across time: in front of the table, then behind
it, then in front again, without ever going around its end. Phase 0 labels show the same thing 3 more times
(S3_r1_klingS, S3_r2_gemini, S3_r3_gemini).
The tell (Londi, 2026-11-12): walking past a table, the feet are either in front of all its legs and drawn over them,
or behind and hidden by the front legs. In S3 her feet are drawn fully visible BETWEEN the table's front and back
legs - standing inside its footprint, which is impossible. That is checkable in a single frame.
Root cause (Londi, same day): she walks a straight line at the table's own floor depth, a collision course; in S3_r1_gemini
she steps on the table's legs at 0.75, 1.25, 1.5, 1.75 and 2.0 s.
The object detector cannot find the moment itself (it loses both the table and the girl exactly while she crosses),
so code only decides WHETHER to ask: furniture in the approved start frame. The question goes to the AI with the
whole clip as time-stamped frame strips (4 per second), asking it to trace each moving character's feet.

  python passthrough_check.py CLIP --out QA_DIR [--start START.png]       (one clip; cached in QA_DIR)
  python passthrough_check.py --bench passthrough_cases.json              (labelled clips: caught / false alarms / $)

Status: MEASURING (2026-11-12). Not in the clip verdict until the benchmark says how far to trust it.
"""
import argparse, json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np

FURNITURE = ("dining table", "chair", "couch", "bed", "bench", "toilet")   # COCO names the detector knows
VERSION = 3   # v2: Londi's rule - feet drawn between the furniture's legs = inside it; v3: foot on a leg = CONTACT and straight path at the furniture's depth (S3_r1_gemini; Londi)
SYSTEM = """You check a generated 2D cartoon video clip for ONE defect: a character's feet or legs inside solid furniture
(table, sofa, chair, bed, shelf, counter) - walking THROUGH it instead of in front of, behind, around or onto it.
You get the clip as frames in time order, 4 per second, with the time printed on each frame.

THE TEST - use it on every frame where a character's feet are near a piece of furniture. The floor recedes upward,
so where a foot touches the floor tells how far back it is, and so does where each furniture leg touches the floor
(the front legs' bottoms are lower in the picture than the back legs' bottoms).
- IN FRONT (possible): the feet touch the floor LOWER in the picture than the furniture's front legs, and the feet
  and legs are drawn OVER the furniture's legs.
- BEHIND (possible): the feet touch the floor HIGHER than the furniture's back legs, and the furniture's front
  legs and top are drawn OVER the feet and lower legs (they are partly hidden).
- INSIDE (impossible): the feet touch the floor BETWEEN the front and back legs' floor lines - under the tabletop,
  between its legs - and are drawn fully visible there, with the furniture's legs beside or behind them. A real
  table's front legs would hide feet that far back, or the feet would be in front of them. This is the defect,
  even in a single frame, unless the character is clearly crawling under the furniture or sitting on it.
- ON A LEG (impossible): a foot touches the floor at the SAME height in the picture as one of the furniture's leg
  bottoms AND at the same left-right spot, so the foot and the leg occupy the same place - the foot stands on the
  leg's foot, merges with it, or the two are drawn overlapping with neither clearly in front. Real feet pass in
  front of a leg (foot lower, drawn over it) or behind it (foot higher, hidden by it). Report this as CONTACT.
- COLLISION COURSE: a character walks in a straight line at a floor depth that lies between a piece of furniture's
  front and back legs, across its left-right width. That path cannot get past without hitting it; a real person
  curves in front of it or goes around behind it. Follow the feet's floor line across frames: if it stays at the
  furniture's own depth while crossing its width, report THROUGH or CONTACT even if no single frame is conclusive.
Supporting sign: over a few frames a character goes from in front of a piece of furniture to behind it (or the
reverse) while staying inside its left-right width, never going around its end.
NOT a defect: feet in front and drawn over the furniture; feet behind and correctly hidden by it; going around its
end; sitting on a sofa or chair; furniture that moves only because the camera pans.

Track every character who moves, frame by frame, before deciding: for each frame near furniture, note where the
feet touch the floor compared with the front and back legs, and which is drawn on top. Answer with ONE JSON object:
{"furniture": ["<each piece, with where it stands>"],
 "tracks": [{"character": "<short description>", "path": "<one or two sentences: where the feet go relative to each piece of furniture, with times>"}],
 "verdict": "THROUGH|CONTACT|OK",
 "confidence": "high|medium|low",
 "events": [{"character": "...", "furniture": "...", "from_t": 0.0, "to_t": 0.0, "what": "<at most 25 words: where the feet are vs the legs, and what is drawn on top>"}]}
THROUGH = feet inside the furniture's footprint / passed through it; CONTACT = a foot on or merged with a furniture leg; OK = neither."""


# Actions that move a character across the floor or onto furniture: run the check even when the detector finds no
# furniture (it missed the blue sofa in the S4 start still, 2026-11-12).
import re
MOVES = re.compile(r"\b(walk|walks|walking|step|steps|stepping|run|runs|running|sit|sits|sitting|sat|jump|jumps|"
                   r"cross|crosses|move|moves|turns? and|goes|go to|climb|climbs|lies down|stand up|stands up|dance|dances)\b", re.I)


def apply(verdict, pt):
    """Clip verdict after the furniture check -> (new verdict, reason, extra flags for the review timeline).
    THROUGH or CONTACT -> at least FLAG (a person looks); never FAIL yet (4-5 examples). FAIL and NOT REVIEWED stay."""
    if pt.get("verdict") not in ("THROUGH", "CONTACT") or verdict.startswith(("FAIL", "NOT REVIEWED")):
        return verdict, "", []
    ev = pt.get("events") or []
    what = "; ".join(f"{e.get('from_t')}-{e.get('to_t')} s {e.get('what', '')}" for e in ev[:2]) or pt.get("why", "")
    why = f"furniture {pt['verdict'].lower()} ({pt.get('confidence', '?')}): {what}"[:300]
    flags = [{"t_s": float(e.get("from_t") or 0), "frame": f"pt{i}", "verdict": "FAIL",
              "rules": ["FEET THROUGH FURNITURE" if pt["verdict"] == "THROUGH" else "FOOT ON FURNITURE"],
              "note": f"{e.get('from_t')}-{e.get('to_t')} s: {e.get('what', '')}"[:300]} for i, e in enumerate(ev[:4])]
    return ("FLAG" if verdict == "PASS" else verdict), why, flags


def frames(clip, fps=4.0, width=512):
    """(t, BGR image) samples, resized to `width`, via ffmpeg (no font needed)."""
    from fc_common import probe
    w, h = probe(clip)[:2]; hh = int(round(h * width / w / 2) * 2)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", clip, "-vf", f"fps={fps},scale={width}:{hh}", "-f", "rawvideo",
                          "-pix_fmt", "bgr24", "-"], capture_output=True, check=True).stdout
    n = len(raw) // (width * hh * 3)
    return [(round(i / fps, 2), np.frombuffer(raw, np.uint8, width * hh * 3, i * width * hh * 3).reshape(hh, width, 3).copy())
            for i in range(n)]


def sheets(clip, out_dir, fps=4.0, cols=4, rows=3, width=512):
    """Time-stamped frame strips (cols x rows per image; 4 x 512 = 2048 px, under ai_review.img_block's 2576 px
    high-resolution cap, so frames are not shrunk again). Returns [(path, [times])]."""
    import cv2
    fr = frames(clip, fps, width); per = cols * rows; out = []
    for s in range(0, len(fr), per):
        chunk = fr[s:s + per]; h = chunk[0][1].shape[0]
        sheet = np.full((h * ((len(chunk) + cols - 1) // cols), width * cols, 3), 255, np.uint8)
        for i, (t, im) in enumerate(chunk):
            r, c = divmod(i, cols)
            cv2.rectangle(im, (0, 0), (104, 30), (0, 0, 0), -1)
            cv2.putText(im, f"{t:.2f} s", (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
            cv2.rectangle(im, (0, 0), (width - 1, h - 1), (255, 255, 255), 2)
            sheet[r * h:(r + 1) * h, c * width:(c + 1) * width] = im
        p = os.path.join(out_dir, f"passthrough_sheet_{len(out) + 1}.jpg")
        cv2.imwrite(p, sheet, [cv2.IMWRITE_JPEG_QUALITY, 88]); out.append((p, [t for t, _ in chunk]))
    return out


def furniture_in(image_path=None, clip=None):
    """Furniture the detector finds in the approved start frame (or the clip's first frame)."""
    import cv2, objects_check as O
    im = cv2.imread(image_path) if image_path and os.path.exists(image_path) else frames(clip, 1, 640)[0][1]
    return sorted({d["cls"] for d in O.Detector(0.30).detect(im) if d["cls"] in FURNITURE})


def analyze(clip, out_dir, model="claude-sonnet-5-5", start=None, force=False, ask_always=False, log=print):
    """Cached in OUT/passthrough_check.json. Returns {"verdict": THROUGH|CONTACT|OK|NOT CHECKED|ERROR, ...}."""
    log = log or (lambda *a: None)
    import ai_review as A
    os.makedirs(out_dir, exist_ok=True); cp = os.path.join(out_dir, "passthrough_check.json")
    if os.path.exists(cp) and not force:
        s = json.load(open(cp, encoding="utf-8"))
        if s.get("version") == VERSION and s.get("model") == model: return dict(s, cached=True)
    furn = furniture_in(start, clip)
    if not furn and not ask_always:
        r = {"verdict": "NOT CHECKED", "why": "no furniture in the start frame", "usd": 0.0, "version": VERSION, "model": model}
        json.dump(r, open(cp, "w", encoding="utf-8"), indent=1); return r
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key: return {"verdict": "NOT CHECKED", "why": "ANTHROPIC_API_KEY not set", "usd": 0.0}
    sh = sheets(clip, out_dir)
    content = [{"type": "text", "text": f"Furniture the object detector saw in the first frame: {', '.join(furn) or 'none listed'}"
                f" (detector names; it can miss or misname cartoon furniture). {len(sh)} image(s) follow, in time order."}]
    for p, ts in sh:
        content += [{"type": "text", "text": f"Frames {ts[0]:.2f}-{ts[-1]:.2f} s, left to right, top to bottom:"}, A.img_block(p)[0]]
    pi, pw, pr, po = A.PRICES.get(model, (2.0, 2.5, 0.1, 10.0)); usd = 0.0; ans = None
    for mt in (2500, 5000):                      # one retry with a bigger budget when the reply has no JSON
        try:
            txt, u = A._call(model, key, SYSTEM, content, mt)
            usd += (int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6
            ans = A.first_json(txt)
            if ans and ans.get("verdict") in ("THROUGH", "CONTACT", "OK"): break
        except Exception as e:
            ans = {"verdict": "ERROR", "why": f"{type(e).__name__}: {str(e)[:150]}"}
    if not ans or ans.get("verdict") not in ("THROUGH", "CONTACT", "OK", "ERROR"):
        ans = {"verdict": "ERROR", "why": "no readable answer"}
    r = dict(ans, furniture_detected=furn, usd=round(usd, 4), version=VERSION, model=model, sheets=[p for p, _ in sh])
    json.dump(r, open(cp, "w", encoding="utf-8"), indent=1)
    log(f"passthrough: {r['verdict']} ({r.get('confidence', '')}) ${usd:.3f}")
    return r


def bench(cases_path, model, force=False):
    cases = json.load(open(cases_path, encoding="utf-8"))
    base = os.path.dirname(os.path.abspath(cases_path)); out_root = os.path.join(HERE, "_tests", "passthrough_v%d" % VERSION)
    rows, spent = [], 0.0
    for c in cases["cases"]:
        clip = c["clip"] if os.path.isabs(c["clip"]) else os.path.join(base, c["clip"])
        if not os.path.exists(clip): print(f"  missing: {clip}"); continue
        r = analyze(clip, os.path.join(out_root, c["id"]), model, start=c.get("start"), force=force, ask_always=True, log=None)
        spent += 0 if r.get("cached") else r.get("usd", 0)
        hit = r["verdict"] in ("THROUGH", "CONTACT")
        ok = hit == (c["expect"] == "through")
        rows.append((c, r, hit, ok))
        ev = "; ".join(f"{e.get('from_t')}-{e.get('to_t')} s {e.get('what', '')}" for e in r.get("events", [])[:2])
        print(f"{'ok ' if ok else 'XX '} {c['id']:<22} expect {c['expect']:<8} got {r['verdict']:<8} {r.get('confidence', ''):<6} "
              f"${r.get('usd', 0):.3f}{' (cached)' if r.get('cached') else ''}  {ev[:110]}")
    pos = [x for x in rows if x[0]["expect"] == "through"]; neg = [x for x in rows if x[0]["expect"] == "ok"]
    print(f"\nwalk-throughs caught: {sum(x[2] for x in pos)} of {len(pos)}   false alarms: {sum(x[2] for x in neg)} of {len(neg)}"
          f"   errors: {sum(1 for x in rows if x[1]['verdict'] == 'ERROR')}   spent this run: ${spent:.2f}"
          f"   per clip: ${(sum(x[1].get('usd', 0) for x in rows) / max(1, len(rows))):.3f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip", nargs="?"); ap.add_argument("--out"); ap.add_argument("--start")
    ap.add_argument("--model", default="claude-sonnet-5-5"); ap.add_argument("--force", action="store_true")
    ap.add_argument("--bench"); ap.add_argument("--sheets-only", action="store_true", help="write the frame strips, no API")
    a = ap.parse_args()
    if a.bench: return bench(a.bench, a.model, a.force)
    if not a.clip or not a.out: ap.error("CLIP and --out are required (or --bench CASES.json)")
    if a.sheets_only:
        os.makedirs(a.out, exist_ok=True)
        for p, ts in sheets(a.clip, a.out): print(p, f"{ts[0]:.2f}-{ts[-1]:.2f} s")
        print("furniture in start frame:", furniture_in(a.start, a.clip)); return
    print(json.dumps(analyze(a.clip, a.out, a.model, a.start, a.force), indent=1))


if __name__ == "__main__":
    main()

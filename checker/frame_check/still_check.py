"""still_check.py - does a made still physically show what was asked? One AI question per still. @anlim

Why (2026-11-17, Kijan photoreal new setups): "Him and Her sit side by side on the sofa" came back twice with the room
intact but the two people perched on the front edge of the sofa, then sitting in front of it on nothing (Londi: "they are
not even sitting on the sofa"). No pixel check sees that; the room and height checks passed or were not about it.
Asks: are seated people really sitting ON the seat (weight on the cushion), standing people with both feet on the
floor, held things in hands, nobody floating, merged with furniture or cut through it? About $0.01 (Sonnet 5.5).

  python still_check.py STILL.png --ask "Him and Her sit side by side on the sofa on the left" [--cast "Him:man" ...]
  in code: still_check.check(still, instruction, cast=[{"name","kind","what"}], out_dir=None) -> {"verdict": OK|WRONG|UNSURE|NOT CHECKED, "problems": [...], "usd"}
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MODEL = "claude-sonnet-5-5"
SYSTEM = """You check ONE still from a video (cartoon or photoreal) for PHYSICAL STAGING only: does the picture really
show the bodies doing what the instruction says, the way they would in the real world? Check each person or animal:
- sitting: the bottom and thighs rest ON the seat (sofa, chair, bed), the body sinks into it a little, the back is
  near the backrest unless leaning forward; NOT perched on the very front edge as if about to stand, NOT in front of
  the seat sitting on nothing, NOT floating above it, NOT merged into it;
- standing or walking: feet on the floor, not floating, not sunk into the floor or furniture;
- holding or touching: the hand really holds or touches the thing; nothing hangs in the air;
- nobody passes through furniture or another body; limbs are not missing or duplicated;
- gaze: each person looks at what they are doing or watching (the ball, the play, the person they talk to, the thing
  in their hands), NOT into the camera, unless the instruction asks them to look at the camera or the viewer
  (2026-11-24: a goalkeeper drawn facing the lens instead of the attacker; nothing flagged it).
Ignore the faces' identity, clothes, heights, colours, lighting and the room's decor: other checks cover those.
Answer with ONE JSON object:
{"people": [{"name": "<name or position>", "doing": "<what they actually do, at most 12 words>",
             "ok": true|false, "problem": "<if not ok: at most 20 words>", "confidence": "high|medium|low"}],
 "verdict": "OK|WRONG|UNSURE"}
WRONG when anyone is not ok with medium or high confidence; UNSURE when you cannot tell."""


def check(still, instruction, cast=None, out_dir=None, model=MODEL, ai=True):
    res = {"verdict": "NOT CHECKED", "problems": [], "usd": 0.0, "ai": None}
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not ai or not key or not (instruction or "").strip():
        res["notes"] = ["staging not checked: " + ("no instruction" if not (instruction or "").strip() else "no API key")]
        return res
    import ai_review as A
    who = "; ".join(f"{c.get('name')}: {c.get('kind') or 'person'}{(', ' + c['what']) if c.get('what') else ''}" for c in (cast or []))
    content = [{"type": "text", "text": f"Instruction: {instruction.strip()}" + (f"\nCast: {who}" if who else "")},
               A.img_block(still, 1600)[0]]
    # 2026-11-17 live: the first reply (budget 700) came back unreadable - Sonnet 5.5 thinks by default and the thinking
    # counts against max_tokens. Up to two tries with a bigger budget; the raw reply is kept for debugging.
    pi, pw, pr, po = A.PRICES.get(model, (2.0, 2.5, 0.1, 10.0))
    res["ai"], raws = None, []
    for mt in (3000, 6000):
        txt, u = A._call(model, key, SYSTEM, content, mt)
        res["usd"] = round(res["usd"] + (int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6, 4)
        raws.append(txt)
        try:
            res["ai"] = A.first_json(txt)
            if (res["ai"].get("verdict") or "").upper() in ("OK", "WRONG", "UNSURE"): break
        except Exception:
            res["ai"] = None
    if not res["ai"]: res["ai"] = {"verdict": "UNSURE", "people": [], "error": "unreadable reply"}
    res["raw"] = [r[-1500:] for r in raws]
    bad = [p for p in res["ai"].get("people", []) if p.get("ok") is False and p.get("confidence") in ("high", "medium")]
    res["problems"] = [f"{p.get('name')}: {p.get('problem') or p.get('doing')}" for p in bad]
    v = res["ai"].get("verdict")
    res["verdict"] = "WRONG" if bad else ("UNSURE" if v == "UNSURE" else "OK")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        json.dump(res, open(os.path.join(out_dir, "still_check.json"), "w"), indent=1)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("still"); ap.add_argument("--ask", required=True); ap.add_argument("--cast", action="append", default=[])
    ap.add_argument("--out"); ap.add_argument("--model", default=MODEL)
    a = ap.parse_args()
    cast = [{"name": x.split(":")[0], "what": (x.split(":", 1) + [""])[1]} for x in a.cast]
    print(json.dumps(check(a.still, a.ask, cast, a.out, a.model), indent=1))


if __name__ == "__main__":
    main()

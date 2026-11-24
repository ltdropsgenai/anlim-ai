"""moderate.py - may anlim make this? One AI question before anything is sent to a paid image, video or audio model. @anlim

Why (2026-11-23, Londi: "all of the above need to be fixed"): anlim had no content check of its own. The only protections
were the Terms ("Do not use anlim to make content that depicts real people without their consent, sexual content
involving minors, content that harasses or deceives people, or anything illegal") and the providers' own filters, which
differ from model to model. This asks Claude once per job, with the job's words and the pictures it would send.

  in code: moderate.check(text, images=[local paths], look="cartoon"|"photoreal", kind="clip"|"frame"|"audio")
           -> {"verdict": "ALLOW"|"BLOCK", "category": "...", "reason": "...", "usd": 0.0x, "model": "..."}
  python moderate.py --text "..." [--image a.png ...] [--look photoreal]

What is blocked (the categories below; everything else is allowed, including cartoon fights, slapstick, horror and
drama): sexual content of anyone under 18 or anyone who looks it; sexual content or nudity; a real, named public figure
in a photoreal picture or video, or anyone shown in a sexual, humiliating or deceptive (fake news, fake endorsement,
fake crime) way; hate against a protected group; graphic gore or torture made to shock; encouraging self-harm;
harassment or threats against a real person.
Limits, said plainly: Claude does not recognise people from their faces, so a public figure is caught by name (in the
words, a character's name or description), not from an uploaded photo. Photos of real people are covered by the
likeness consent the creator confirms when uploading (studio.likeness_consents).
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MODEL_TEXT = "claude-haiku-5-5"      # words only (audio scripts, prompts without pictures): fast and cheap
MODEL_IMAGES = "claude-sonnet-5-5"   # with pictures: better at judging what a picture shows
CATEGORIES = ["minors_sexual", "sexual", "real_person", "hate", "gore", "self_harm", "harassment"]

SYSTEM = """You are the content check of anlim, an app where solo creators make cartoon and photoreal video. You get
the words of ONE job (a picture, a video clip or a sound) and, for pictures and clips, the images it would be made from.
Decide whether anlim may make it. Judge what the RESULT would show, not the creator's intent.

BLOCK only for these categories:
- minors_sexual: anything sexual, suggestive or nude involving someone under 18 or who looks under 18. Always block.
- sexual: sexual acts, nudity, or sexually explicit or fetish content of anyone.
- real_person: a real, named public figure (politician, celebrity, athlete, etc.) in a PHOTOREAL picture or video; or
  any real person (named or pictured) shown in a sexual, humiliating, violent or deceptive way (fake news, a fake
  endorsement or statement, a fake crime). A clearly cartoon caricature of a public figure that is not sexual,
  humiliating or deceptive is allowed. You will not be able to recognise people from faces; do not try. Judge names
  and descriptions.
- hate: content attacking or demeaning people for race, ethnicity, religion, nationality, gender, sexual orientation,
  disability or another protected trait, or praising hate groups or their symbols.
- gore: graphic gore, dismemberment or torture shown to shock. Fights, action, peril, cartoon violence, horror mood,
  injuries without graphic detail and war stories are ALLOWED.
- self_harm: showing or encouraging suicide or self-harm as something to do.
- harassment: threats, bullying or targeting of a real private person.

Everything else is ALLOW: drama, comedy, fights, monsters, sad or dark themes, kissing between adults, swimwear, etc.
When unsure, ALLOW, unless it might involve a minor in a sexual way: then BLOCK.

Answer with ONE JSON object and nothing else:
{"verdict": "ALLOW"|"BLOCK", "category": "<one of the categories, or none>",
 "reason": "<if BLOCK: at most 25 words, addressed to the creator, saying what cannot be made; else empty>"}"""


def check(text, images=None, look="cartoon", kind="clip", model=None, key=None):
    import ai_review as A
    key = key or os.environ.get("ANTHROPIC_API_KEY")
    if not key: raise RuntimeError("no ANTHROPIC_API_KEY: the content check cannot run")
    imgs = [p for p in (images or []) if p and os.path.exists(p)][:6]
    model = model or (MODEL_IMAGES if imgs else MODEL_TEXT)
    content = [{"type": "text", "text": f"Job: {kind}. Look: {look}.\nWords:\n{(text or '').strip()[:6000] or '(none)'}"}]
    for p in imgs:
        content.append(A.img_block(p, 1024)[0])
    pi, pw, pr, po = A.PRICES.get(model, (2.0, 2.5, 0.1, 10.0))
    usd, ans, raw = 0.0, None, ""
    for mt in (1500, 4000):          # thinking counts against max_tokens (still_check.py, 2026-11-17): a bigger second try
        raw, u = A._call(model, key, SYSTEM, content, mt)
        usd += (int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6
        try:
            ans = A.first_json(raw)
            if str(ans.get("verdict", "")).upper() in ("ALLOW", "BLOCK"): break
        except Exception:
            ans = None
    if not ans or str(ans.get("verdict", "")).upper() not in ("ALLOW", "BLOCK"):
        # an unreadable answer is not an ALLOW: the worker retries, then fails the job with nothing charged
        raise RuntimeError("the content check gave no readable answer")
    v = str(ans["verdict"]).upper()
    cat = ans.get("category") if ans.get("category") in CATEGORIES else ("none" if v == "ALLOW" else "other")
    return {"verdict": v, "category": cat, "reason": (ans.get("reason") or "").strip()[:300] if v == "BLOCK" else "",
            "usd": round(usd, 5), "model": model, "images": len(imgs)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default=""); ap.add_argument("--image", action="append", default=[])
    ap.add_argument("--look", default="cartoon"); ap.add_argument("--kind", default="clip")
    a = ap.parse_args()
    print(json.dumps(check(a.text, a.image, a.look, a.kind), indent=1))


if __name__ == "__main__":
    main()

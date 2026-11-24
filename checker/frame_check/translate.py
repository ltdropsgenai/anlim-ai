"""translate.py - anlim's run-time text in the creator's language, and creators' shot text in English. @anlim

Why (2026-11-24, Londi: "English, Spanish and French ... everything, UI and what anlim makes"): the app's own words are in
its catalogs (app/src/i18n), but some text is written while anlim runs: errors, check findings, cut notes, notices. The
worker sends new ones here in batches and keeps the answers in studio.translations, so each message is translated once.
The other way, a creator's Spanish or French shot text is put into English for the image and video models.

  in code: translate.run(["Shot ⟨0⟩: trimmed to ⟨1⟩ s.", ...], "es") -> {"out": [...], "usd": 0.00x, "model": "..."}
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MODEL = "claude-haiku-5-5"
NAMES = {"es": "Spanish (neutral Latin American, informal tú)", "fr": "French (vous)", "en": "English"}

GLOSSARY = """anlim is a video app. Use these terms:
- shot = plano (es) / plan (fr); scene = escena / scène; cut (the finished video) = montaje / montage
- start frame = fotograma inicial / image de départ; end frame = fotograma final / image de fin
- plate (an empty-room picture of a location) = fondo vacío / fond vide; credits = créditos / crédits
- voiceover = voz en off / voix off; narration = narración / narration; lip sync = sincronización labial / synchro labiale
- keep / reject a clip = conservar / rechazar, garder / rejeter; Cast & places = Reparto y lugares / Distribution et lieux"""


def system(lang):
    if lang == "en":
        return ("You translate a video creator's shot descriptions into plain English for image and video AI models. "
                "Keep every name exactly as written (characters, places), keep the meaning, the order of events and any "
                "camera words; do not add or remove details. If a text is already English, return it unchanged.")
    return (f"You translate short messages from a video app into {NAMES[lang]}. They are shown to the app's users.\n"
            f"{GLOSSARY}\nKeep exactly as they are: markers like ⟨0⟩ ⟨1⟩ (numbers go there), {{names}} in braces, words "
            "in square brackets such as [whispers], names of people, products and models (Kling, MiniMax, ElevenLabs, "
            "Stripe...), file names, codes, URLs and email addresses. Keep the tone plain and short, like the English.")


def run(texts, lang, key=None):
    import ai_review as A
    if lang not in NAMES: raise ValueError("lang must be en, es or fr")
    texts = [str(t) for t in (texts or [])][:60]
    if not texts: return {"out": [], "usd": 0.0, "model": MODEL}
    key = key or os.environ.get("ANTHROPIC_API_KEY")
    if not key: raise RuntimeError("no ANTHROPIC_API_KEY: translation cannot run")
    content = [{"type": "text", "text": "Translate each item. Answer with ONE JSON object and nothing else: "
                "{\"out\": [<one string per item, same order>]}\nItems:\n" + json.dumps(texts, ensure_ascii=False)}]
    pi, pw, pr, po = A.PRICES.get(MODEL, (1.0, 1.25, 0.1, 5.0))
    usd = 0.0
    for mt in (4000, 12000):
        raw, u = A._call(MODEL, key, system(lang), content, mt)
        usd += (int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6
        try:
            out = A.first_json(raw).get("out")
            if isinstance(out, list) and len(out) == len(texts) and all(isinstance(x, str) for x in out):
                return {"out": out, "usd": round(usd, 5), "model": MODEL}
        except Exception:
            pass
    raise RuntimeError("the translation gave no readable answer")

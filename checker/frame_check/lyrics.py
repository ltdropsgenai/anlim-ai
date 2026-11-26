"""lyrics.py - original song lyrics from a creator's description, ready for anlim's songs. @anlim

Why (2026-11-26, Londi: a composer "akin to Suno" inside anlim, with a lyrics writer): the creator says what the song is
about (and optionally the language, style and length); this writes lyrics with [Section] tags on their own lines, which
both song makers read (ElevenLabs Music: one composition-plan chunk per tag; MiniMax Music 3: structure tags on their
own lines). The creator edits them before the song is made.

  in code: lyrics.write(brief, language=None, styles=None, length_s=None) -> {"title", "lyrics", "usd", "model"}
  python lyrics.py --brief "a love song about ..." [--language "Haitian Creole"] [--styles "kompa"] [--length 120]

Rules given to the model: original words only (no lines from existing songs, no real singer's or band's name, no
"in the style of" a real artist in the words), singable, about the length asked (roughly 2.2 sung words a second
minus room for intros and breaks), in the language asked (or the brief's own language).
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MODEL = "claude-sonnet-5-5"

SYSTEM = """You write ORIGINAL song lyrics for anlim, an app where creators make short videos and their music.
Write lyrics from the creator's description. Rules:
- Original words only. Never reuse lines or a recognisable hook from an existing song, and never name a real singer,
  band or songwriter in the lyrics or the title.
- Structure: section tags in square brackets, each on its own line, from this set: [Intro], [Verse 1], [Verse 2],
  [Verse 3], [Pre-Chorus], [Chorus], [Post-Chorus], [Bridge], [Hook], [Instrumental break], [Outro]. Lyric lines under
  each tag, one sung line per line. No other notes, no chords, no stage directions, no blank tags except
  [Intro], [Instrumental break] and [Outro].
- Fit the length: about 2 sung words per second of the song, less if the style is slow; leave room for intros and
  breaks. A 60-second song is about a verse and a chorus; 2 to 3 minutes is two verses, a chorus repeated, and maybe a
  bridge.
- Write in the language asked; if none is asked, in the language of the description. Keep natural spelling for that
  language (for Haitian Creole, standard Kreyòl orthography).
- Singable: even line lengths within a section, clear rhymes or assonance where the style expects them, a chorus
  that repeats.
- If the description asks for anything sexual involving minors, hate, or harassment of a real person, return an empty
  lyrics string and a title of "".
Answer with ONE JSON object and nothing else: {"title": "<short title>", "lyrics": "<the lyrics, \\n between lines>"}"""


def write(brief, language=None, styles=None, length_s=None, model=None, key=None):
    import ai_review as A
    key = key or os.environ.get("ANTHROPIC_API_KEY")
    if not key: raise RuntimeError("no ANTHROPIC_API_KEY: the lyrics writer cannot run")
    model = model or MODEL
    ask = [f"Description: {brief.strip()[:1500]}"]
    if language: ask.append(f"Language: {language}")
    if styles: ask.append(f"Musical style (for the feel, not to name in the lyrics): {styles[:500]}")
    ask.append(f"Song length: about {int(length_s)} seconds" if length_s else "Song length: about 90 seconds")
    pi, pw, pr, po = A.PRICES.get(model, (2.0, 2.5, 0.1, 10.0))
    usd, ans = 0.0, None
    for mt in (2500, 5000):
        raw, u = A._call(model, key, SYSTEM, [{"type": "text", "text": "\n".join(ask)}], mt)
        usd += (int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6
        try:
            ans = A.first_json(raw)
            if isinstance(ans.get("lyrics"), str): break
        except Exception:
            ans = None
    if not ans or not isinstance(ans.get("lyrics"), str):
        raise RuntimeError("the lyrics writer gave no readable answer")
    lyr = ans["lyrics"].replace("\r", "").strip()
    if not lyr: raise RuntimeError("the lyrics writer declined this description")
    return {"title": str(ans.get("title") or "").strip()[:120], "lyrics": lyr[:3500], "usd": round(usd, 5), "model": model}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--brief", required=True); ap.add_argument("--language"); ap.add_argument("--styles")
    ap.add_argument("--length", type=float)
    a = ap.parse_args()
    print(json.dumps(write(a.brief, a.language, a.styles, a.length), ensure_ascii=False, indent=1))

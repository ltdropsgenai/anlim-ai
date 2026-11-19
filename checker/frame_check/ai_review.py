"""ai_review.py - AI verdicts on the full-size frames exported by frame_check / stills_check. @anlim

Every frame is reviewed ALONE, at full size, with its references - never in a grid.

  python ai_review.py pack  DIR [--rules RULES.md] [--only flagged|all]
      Writes DIR/AI_REVIEW_TASK.md: the protocol, the rules and the frame list, for a Claude
      session to work through one image at a time, appending verdicts to DIR/verdicts.jsonl.
  python ai_review.py api   DIR [--rules RULES.md] [--only ...] [--model claude-opus-5-5] [--price 4] [--yes]
      Same review through the Claude API (needs ANTHROPIC_API_KEY). Without --yes it only prints
      the cost estimate and spends nothing.
  python ai_review.py apply DIR [--flags FLAGS.json] [--rules RULES.md]
      Merges verdicts.jsonl into review.html. A PASS that leaves any rule NOT CHECKED (or missing)
      is shown as INCOMPLETE: NOT CHECKED never counts as PASS. With the flags file downloaded
      from the viewer, also prints where the AI and the human agreed and disagreed.
  python ai_review.py record DIR [--rules RULES.md] [--render-id ID] [--retries N] [--editorial PASS|FAIL]
                       [--note TEXT] [--ledger LEDGER.csv]
      Writes DIR/clip_record.json: QC gates A-G (Character, Set, Anatomy, Camera, Motion, Editorial,
      Technical) as PASS / FAIL / NOT CHECKED with frame evidence, render ID and paid retries, and
      appends one row to the ledger CSV if given.

verdicts.jsonl: one JSON object per line:
  {"key": "f276", "description": "...", "verdict": "PASS|FAIL|UNSURE",
   "checks": {"HEAD COUNT": "PASS", "ANATOMY": "FAIL", "EDITORIAL": "NOT CHECKED", ...},
   "issues": [{"rule": "ANATOMY", "region": "front hand, centre right", "note": "extra thumb"}]}
"""
import argparse, base64, csv, io, json, os, re, sys, time, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import write_viewer

HERE = os.path.dirname(os.path.abspath(__file__))

PROTOCOL = """## Protocol (follow for EVERY frame, in order)
1. Open the output image ALONE at full size. Never review a grid or contact sheet.
2. Before reading the rules, write what the frame shows: who and how many, where each one is,
   what each is holding and which way it faces, what each is doing, and the room. This is the
   `description`. Do not use the shot's intended content to fill it in: write only what you see.
3. Open each reference (source frame, set plate, character sheets) and compare.
4. Go through every rule and give each one PASS, FAIL or NOT CHECKED in `checks` (rule name as
   written, e.g. "ANATOMY"). Use NOT CHECKED when the frame cannot show it (EDITORIAL needs the
   whole clip; MOTION needs the video) or the region is too small: never write PASS for a rule
   you did not look at. For each FAIL give the rule, the region of the frame, and a note.
5. Verdict: FAIL if any rule is broken; UNSURE if a region is too small or blurred to judge
   (say which); PASS only when every rule was checked and holds. NOT CHECKED never counts as PASS:
   the tool shows a PASS with any NOT CHECKED rule as INCOMPLETE.
6. Zoom: if a hand, face, mouth or prop is small, crop it from the full-size image and look again
   before passing it.
7. Append one JSON line per frame to verdicts.jsonl (format at the end of this file).
8. Heights (only when the series has a lineup file): for each character, add a "measures" entry with
   points as fractions of the image (x, y from the top-left, 0-1), measured on the FULL-SIZE image:
   "head" = top of the hair as drawn (the lineup's convention), "base" = feet, or the shared line
   (counter or table edge) with "baseline": true, "sl"/"sr" = left/right shoulder edges. Then run
   measure.py report. Your points are a first pass: a person's clicks in the viewer override them.
"""

def load(d):
    man = json.load(open(os.path.join(d, "manifest.json")))
    return man

def todo(man, only):
    fr = man["frames"]
    if only == "flagged":
        fr = [f for f in fr if any(w != "sweep" for w in f.get("why", []))] or fr
    return fr

def rules_text(path):
    return open(path or os.path.join(HERE, "default_rules.md"), encoding="utf-8").read()

GATES = {"A": "Character", "B": "Set", "C": "Anatomy", "D": "Camera", "E": "Motion", "F": "Editorial", "G": "Technical"}
# gate for rule names in older rules files that have no [X] tag
OLD_GATE = {"HEAD COUNT": "A", "IDENTITY": "A", "WARDROBE": "A", "RELATIVE HEIGHT": "A", "FIXED DETAILS": "A",
            "SET LAYOUT": "B", "ANATOMY": "C", "EVERY CREATURE": "C", "BODY CONTACT": "C", "NATURAL POSES": "C",
            "MOUTHS": "C", "SCREEN SIDE": "D", "CAMERA": "D", "HELD OBJECTS FACE THE HOLDER": "E", "PROPS": "E",
            "NO MATERIALISING": "E", "MOTION": "E", "REFLECTIONS AND SHADOWS": "E", "EDITORIAL": "F",
            "LIGHTING": "G", "TEXT": "G", "IMAGE QUALITY": "G"}

def parse_rules(path):
    """[(RULE NAME, gate letter)] from lines like '3. [A] WARDROBE: ...' (tag optional)."""
    out = []
    for line in rules_text(path).splitlines():
        m = re.match(r"\s*\d+\.\s*(?:\[([A-G])\]\s*)?([A-Z][A-Z0-9 /&'-]*?)(?:\s*\(video\))?\s*:", line)
        if m:
            name = m.group(2).strip(); out.append((name, m.group(1) or OLD_GATE.get(name, "?")))
    return out

def norm(x):
    x = (x or "").strip().upper().replace("_", " ")
    return "NOT CHECKED" if x in ("NOT CHECKED", "NOTCHECKED", "N/A", "NA", "") else x

def effective(v, rules):
    """Verdict after the NOT-CHECKED rule: a PASS with unchecked rules becomes INCOMPLETE."""
    given = (v.get("verdict") or "").upper()
    checks = {k.upper(): norm(x) for k, x in (v.get("checks") or {}).items()}
    if any(x == "FAIL" for x in checks.values()) and given == "PASS":
        return "FAIL", []
    unchecked = [r for r, _ in rules if checks.get(r, "NOT CHECKED") != "PASS"]
    if given == "PASS" and unchecked:
        return "INCOMPLETE", unchecked
    return given, unchecked

def shot_context(d):
    """The shot spec shot_qc.py saved next to the frames: what the shot is meant to show, who is in it,
    the camera, and reference pictures. Without it (first live run, 2026-11-10) the reviewer left head
    count, identity, wardrobe, set, props and screen side NOT CHECKED on every frame."""
    p = os.path.join(d, "shot_spec.json")
    if not os.path.exists(p): return "", []
    from shot_qc import _walk                         # paths written on another machine -> this one
    sp = _walk(json.load(open(p, encoding="utf-8"))); t = ["## The shot (judge every frame against this)"]
    if sp.get("action"): t.append(f"- Action: {sp['action']}")
    if sp.get("cast"): t.append("- Cast: " + "; ".join(f"{k}: {v}" for k, v in sp["cast"].items()))
    if sp.get("people") is not None: t.append(f"- People in frame: {sp['people']} (head count, including extras)")
    if sp.get("camera"): t.append(f"- Camera: {sp['camera']}")
    for k in ("wardrobe", "props", "blocking", "notes"):
        if sp.get(k): t.append(f"- {k.capitalize()}: {sp[k]}")
    refs = []
    if sp.get("start_frame"): refs.append({"label": "approved start frame (the set, cast and framing as approved)", "src": sp["start_frame"]})
    for name, paths in (sp.get("faces") or {}).items():
        for q in (paths if isinstance(paths, list) else [paths])[:1]:
            refs.append({"label": f"character reference: {name}", "src": q})
    return "\n".join(t) + "\n", refs[:3]

QUIET = """Write an issue ONLY for something you see that is wrong or doubtful in THIS frame. Do not write
issues saying references or a spec are missing: mark those rules NOT CHECKED in `checks` and move on.
Keep it short: description at most 40 words, each issue note at most 30 words.
A person or limb HIDDEN behind another person, their own body or an object is not missing, fused or merged:
people pass in front of each other and arms disappear behind torsos. Fail ANATOMY or BODY CONTACT only for
what is visibly wrong in the visible part (an extra or melted hand, a limb bent impossibly, two bodies
blending into one shape). (Benchmark 2026-11-10: a woman walking behind a man was failed as "merged", and a
man seen from behind as "arm missing".)
If the action text and the approved start frame disagree (a prop or person the text names is not in the
approved frame), the approved frame wins: say so once in the description and do not FAIL frames for it.
Give every issue a "box": [x0, y0, x1, y1], fractions of the OUTPUT frame (0-1 from the top-left) around
the problem. The tool compares that box with the approved start frame: a region that looks the same as in
the approved frame is not a new defect, so the verdict is lowered (a misread of a small object in P003,
2026-11-10, failed 13 frames of an approved clip for a photo that never changed).
The approved start frame shows WHO and WHAT belongs in the shot (faces, outfits, props and who holds
them, set fixtures). It is not a position check for later frames: people walk, turn and leave through a
frame edge as the action plays. Do not fail SCREEN SIDE, NATURAL POSES or blocking because someone moved.
If the camera has moved (CAMERA FAIL), things it reveals or hides at the frame edges (a new bin, a person
leaving the frame, more or less of the building) are consequences of that one move: mention them in the
CAMERA note only, not as SET LAYOUT, HEAD COUNT or NO MATERIALISING failures. Fail those rules only for
changes the camera move cannot explain (a fixture that changes shape mid-frame, a person who vanishes away
from an edge, a prop that moves to another person)."""

def cmd_pack(a):
    man = load(a.dir); fr = todo(man, a.only); ctx, crefs = shot_context(a.dir)
    lines = [f"# AI review task: {man['clip']}", "", f"Frames to review: {len(fr)} (folder: this file's folder)", "", PROTOCOL, QUIET, "",
             ctx, ("Shot references for every frame: " + "; ".join(f"{r['label']}: {r['src']}" for r in crefs) + "\n") if crefs else "",
             "## Rules", rules_text(a.rules), "", "## Frames (review in this order)", ""]
    for f in fr:
        refs = ", ".join(f"{r['label']}: {r['src']}" for r in f.get("refs", [])) or "none"
        t = f" at {f['t']:.3f} s" if f.get("t") is not None else ""
        lines.append(f"- key `{f['key']}`{t}: output `{f['out']}`; refs: {refs}; code flags: {'; '.join(f.get('why', [])) or 'none'}")
    lines += ["", "## verdicts.jsonl line format", "",
              '{"key": "<key>", "description": "<what you see>", "verdict": "PASS|FAIL|UNSURE", '
              '"checks": {"<RULE>": "PASS|FAIL|NOT CHECKED", ...every rule...}, '
              '"issues": [{"rule": "<RULE>", "region": "<where>", "box": [x0, y0, x1, y1], "note": "<what is wrong>"}], '
              '"measures": {"<Character>": {"head": [x, y], "base": [x, y], "baseline": true, "sl": [x, y], "sr": [x, y]}}}  '
              '(measures optional)']
    open(os.path.join(a.dir, "AI_REVIEW_TASK.md"), "w", encoding="utf-8").write("\n".join(lines))
    vp = os.path.join(a.dir, "verdicts.jsonl")
    if not os.path.exists(vp): open(vp, "w").close()
    print(f"wrote {os.path.join(a.dir, 'AI_REVIEW_TASK.md')} ({len(fr)} frames)")

def img_block(path, cap=2576):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    if max(im.size) > cap:                        # 2576 = high-resolution tier long-edge limit; refs go smaller
        s = cap / max(im.size); im = im.resize((int(im.width * s), int(im.height * s)))
    b = io.BytesIO(); im.save(b, "JPEG", quality=92)
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(b.getvalue()).decode()}}, im.size

# USD per million tokens: input, 5-minute cache write, cache read, output.
# Source: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-11-10). Check before relying on it.
PRICES = {"claude-opus-5-5": (4.0, 5.0, 0.20, 20.0), "claude-sonnet-5-5": (2.0, 2.5, 0.10, 10.0),
          "claude-haiku-5-5": (0.10, 0.125, 0.01, 0.50)}

def estimate(d, only="flagged", price=4.0, model="claude-opus-5-5", rules=None):
    """(frames, tokens sent, USD) for an API review of review folder d, with prompt caching: the rules and
    shot references are written to the cache once and read back at the cache price for every other frame.
    Image tokens = w*h/750 after the long-edge cap (Anthropic vision docs). Output is 1,200 tokens a frame, measured
    on P018 (2026-11-10): 53,909 (Opus 5.5) and 55,490 (Sonnet 5.5) output tokens for 45 frames. An estimate: the run prints the real usage."""
    from PIL import Image
    pi, pw, pr, po = PRICES.get(model, (price, price * 1.25, price * 0.1, price * 5))
    fr = todo(load(d), only); n = len(fr); frame_tok = 0
    for f in fr:
        for p in [f["out"]] + [r["src"] for r in f.get("refs", [])]:
            w, h = Image.open(os.path.join(d, p)).size; s = min(1.0, 2576 / max(w, h)); frame_tok += int(w * s * h * s / 750) + 150
    ctx, crefs = shot_context(d)
    cached = (len(PROTOCOL) + len(QUIET) + len(ctx) + len(rules_text(rules))) // 4
    for r in crefs:
        if os.path.exists(r["src"]):
            w, h = Image.open(r["src"]).size; s = min(1.0, 1280 / max(w, h)); cached += int(w * s * h * s / 750)
    usd = (cached * pw + cached * max(0, n - 1) * pr + frame_tok * pi + n * 1200 * po) / 1e6
    return n, cached * n + frame_tok, usd

def cmd_api(a):
    man = load(a.dir); fr = todo(man, a.only); rules = rules_text(a.rules); ctx, crefs = shot_context(a.dir)
    _, tok, cost = estimate(a.dir, a.only, a.price, a.model, a.rules)
    print(f"{len(fr)} frames, about {tok:,} tokens sent, about ${cost:.2f} with {a.model} list prices, caching and output included (estimate)")
    sp = os.path.join(a.dir, "shot_spec.json")
    if os.path.exists(sp) and not getattr(a, "force", False):
        from shot_qc import spec_vs_start
        ok, msg = spec_vs_start(json.load(open(sp, encoding="utf-8")))
        print(msg)
        if not ok: print("Nothing sent. Fix shot_spec.json, or add --force to review against it anyway."); return
    if not a.yes: print("Nothing sent. Re-run with --yes to spend."); return
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key: sys.exit("ANTHROPIC_API_KEY is not set")
    vname = getattr(a, "verdicts", None) or "verdicts.jsonl"
    vp = open(os.path.join(a.dir, vname), "a", encoding="utf-8")
    use = {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0}
    system = [{"type": "text", "text": "You check generated video frames for defects.\n" + PROTOCOL + "\n" + QUIET + "\n\n" + ctx + "\n# Rules\n" + rules,
               "cache_control": {"type": "ephemeral"}}]
    shot_refs = []
    for r in crefs:                                       # shot references: absolute paths from the spec
        if os.path.exists(r["src"]):
            shot_refs += [{"type": "text", "text": f"Reference - {r['label']}:"}, img_block(r["src"], 1280)[0]]
    if shot_refs: shot_refs[-1]["cache_control"] = {"type": "ephemeral"}   # same refs on every frame: cached

    def review_one(f):
        """One frame, one API call. Returns (verdict, usage, error, raw)."""
        content = [dict(c) for c in shot_refs]
        for r in f.get("refs", []):
            content += [{"type": "text", "text": f"Reference - {r['label']}:"}, img_block(os.path.join(a.dir, r["src"]))[0]]
        content += [{"type": "text", "text": "OUTPUT frame to check:"}, img_block(os.path.join(a.dir, f["out"]))[0],
                    {"type": "text", "text": "Code flags for this frame: " + ("; ".join(f.get("why", [])) or "none") +
                     "\nAnswer with ONE JSON object only: {\"description\":..., \"verdict\":\"PASS|FAIL|UNSURE\", "
                     "\"checks\":{\"<RULE>\":\"PASS|FAIL|NOT CHECKED\" for every rule}, "
                     "\"issues\":[{\"rule\":..., \"region\":..., \"box\":[x0,y0,x1,y1] fractions of the OUTPUT frame around the problem, \"note\":...}]}"}]
        body = {"model": a.model, "max_tokens": 8000, "system": system, "messages": [{"role": "user", "content": content}],
                **request_options(getattr(a, "effort", None), getattr(a, "thinking", None))}
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                     headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        raw = None; u = {}
        try:
            raw = urllib.request.urlopen(req, timeout=180).read().decode("utf-8", "replace")
            resp = json.loads(raw); u = resp.get("usage") or {}
            # the reply's content is a LIST of blocks (thinking, text, ...): read every text block, not
            # content[0] - the first live run (2026-11-10) failed on every frame because block 0 was not text
            txt = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
            if not txt.strip():
                raise ValueError(f"no text block in reply (stop_reason {resp.get('stop_reason')}, "
                                 f"block types {[b.get('type') for b in resp.get('content', [])]})")
            return first_json(txt), u, None, raw
        except Exception as e:
            if isinstance(e, urllib.error.HTTPError):
                try: raw = e.read().decode("utf-8", "replace")
                except Exception: pass
            return ({"verdict": "UNSURE", "description": "", "issues": [{"rule": "REVIEW", "note": f"API/parse error: {e}"}]}, u, e, raw)

    # frames go out `workers` at a time; the first frame goes alone so the cache is written once, then read
    workers = max(1, int(getattr(a, "workers", 1) or 1)); failed = errors = 0; sent = 0
    cam_ok = code_camera_ok(a.dir); got = {}; txf = spec_text_forbidden(a.dir)
    batches = [fr[:1]] + [fr[i:i + workers] for i in range(1, len(fr), workers)]
    from concurrent.futures import ThreadPoolExecutor
    stopped = None
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for batch in batches:
            if not batch: continue
            if getattr(a, "stop_after", 0) and failed >= a.stop_after and clip_verdict(man, got, cam_ok, txf)[0] == "FAIL":
                stopped = f"  stopped early: the clip already FAILS by the clip rules ({len(fr) - sent} frames not sent)"; break
            for f, (v, u, err, raw) in zip(batch, ex.map(review_one, batch)):
                sent += 1
                for k in use: use[k] += int(u.get(k) or 0)
                if err is not None:
                    errors += 1
                    with open(os.path.join(a.dir, "api_errors.jsonl"), "a", encoding="utf-8") as eh:   # the raw reply, to debug
                        eh.write(json.dumps({"key": f["key"], "error": str(err), "raw": (raw or "")[:20000]}) + "\n")
                else:
                    errors = 0
                v["key"] = f["key"]; vp.write(json.dumps(v) + "\n"); vp.flush(); got[f["key"]] = v
                if (v.get("verdict") or "").upper() == "FAIL": failed += 1
                print(f"  {f['key']}: {v.get('verdict')}  {'; '.join(i.get('note', '') for i in v.get('issues', []))}")
            if errors >= 2:
                stopped = (f"STOPPED after {errors} failed frames in a row so no more money is spent; "
                           f"see {os.path.join(a.dir, 'api_errors.jsonl')}"); break
        # Sparse sweep after an early stop: the frames that failed first are not always where the defect a repair
        # must fix is (Keycard B7b failed on f0-f16 for earbuds; the papers unfold about 7 s in and were never seen).
        # Up to `sweep` frames spread over the rest are reviewed so the repair planner gets the whole defect map.
        if stopped and stopped.lstrip().startswith("stopped early") and int(getattr(a, "sweep", 8) or 0) > 0:
            pick = sweep_pick(fr[sent:], int(getattr(a, "sweep", 8)))
            if pick:
                print(f"  sweep: {len(pick)} of the {len(fr) - sent} unsent frames, spread over the rest of the clip")
                stopped = stopped.replace("frames not sent)", f"frames not sent; {len(pick)} of them reviewed by the sweep)")
                for f, (v, u, err, raw) in zip(pick, ex.map(review_one, pick)):
                    for k in use: use[k] += int(u.get(k) or 0)
                    v["key"] = f["key"]; v["sweep"] = True; vp.write(json.dumps(v) + "\n"); vp.flush(); got[f["key"]] = v
                    print(f"  {f['key']} (sweep): {v.get('verdict')}  {'; '.join(i.get('note', '') for i in v.get('issues', []))}")
    vp.close()
    if stopped: print(stopped)
    pi, pw, pr, po = PRICES.get(a.model, (a.price, a.price * 1.25, a.price * 0.1, a.price * 5))
    usd = (use["input_tokens"] * pi + use["cache_creation_input_tokens"] * pw + use["cache_read_input_tokens"] * pr
           + use["output_tokens"] * po) / 1e6
    print(f"ACTUAL usage: {use} -> about ${usd:.2f} at {a.model} list prices")
    with open(os.path.join(a.dir, "api_usage.jsonl"), "a", encoding="utf-8") as uh:
        uh.write(json.dumps({"when": time.strftime("%Y-%m-%d %H:%M"), "model": a.model, "frames": sent,
                             "effort": getattr(a, "effort", None), "thinking": getattr(a, "thinking", None),
                             **use, "usd": round(usd, 4)}) + "\n")
    cmd_apply(argparse.Namespace(dir=a.dir, flags=None, rules=a.rules, verdicts=vname))
    if stopped and stopped.startswith("STOPPED"): raise ApiStopped(stopped)
    return usd

# Default checker models, one place for every tool (batch_eval, shot_qc). Chosen 2026-11-12 from exp_review.py on the
# three benchmarks (119 clips): Haiku 5.5 with thinking off as the frame reviewer caught 27/27 bad clips, passed 0,
# wrongly failed 3 good ones (Sonnet: 26/27, 1 passed, 5), for $4.13 against $31.98 and 0.6-0.9 min per clip.
# Second opinions and the action check stay on Sonnet 5.5 (not tested on Haiku). Fast action (fights) is untested.
DEFAULTS = {"review_model": "claude-haiku-5-5", "verify_model": "claude-sonnet-5-5", "action_model": "claude-sonnet-5-5"}
DEFAULT_THINKING = {"claude-haiku-5-5": "disabled"}   # per reviewer model; others keep the model's own default

def request_options(effort=None, thinking=None):
    """Extra Messages API fields that set how much the reviewer thinks (cost control, 2026-11-11).
    Thinking is ON by default on Claude 5.x models and is billed as output even though the reply hides it
    (docs: platform.claude.com/docs/en/build-with-claude/thinking). Sonnet 5.5 defaults to effort "high",
    Haiku 5.5 to "medium" (docs: .../effort). effort: low | medium | high | xhigh | max -> output_config.effort.
    thinking: adaptive | disabled (Haiku 5.5, effort high or below) | between_tools (Sonnet 5.5's lowest setting,
    effort low/medium/high). None leaves the model's default."""
    o = {}
    if effort: o["output_config"] = {"effort": effort}
    if thinking: o["thinking"] = {"type": thinking}
    return o

def ping(model, key, effort=None, thinking=None):
    """One tiny request with the same model and options, before a paid run: an option the model refuses fails
    here for a fraction of a cent instead of on the first frames. Returns (ok, message)."""
    body = {"model": model, "max_tokens": 1000, "messages": [{"role": "user", "content": 'Reply with {"ok": true}'}],
            **request_options(effort, thinking)}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                 headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace"))
        return True, f"ok ({model}, effort {effort or 'default'}, thinking {thinking or 'default'}; usage {resp.get('usage')})"
    except urllib.error.HTTPError as e:
        try: msg = e.read().decode("utf-8", "replace")[:400]
        except Exception: msg = ""
        return False, f"HTTP {e.code}: {msg}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"

def first_json(txt):
    """The first JSON object in a reply; text or a second object after it is ignored (P009 f24, 2026-11-10:
    "Extra data" when the model wrote two objects)."""
    return json.JSONDecoder().raw_decode(txt[txt.index("{"):])[0]

def _call(model, key, system, content, max_tokens=2000):
    body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                 headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=180).read().decode("utf-8", "replace"))
    txt = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
    return txt, resp.get("usage") or {}

VERIFY_SYSTEM = """You double-check a claimed defect in a frame of a generated video before the clip is thrown away and
paid for again. Be skeptical of the claim. REJECT it when the frame is explained by ordinary things: a person or limb
hidden behind another person, their own body or an object; motion blur on a moving hand; a face or object too small
or soft to judge; a camera move; the approved start frame already showing the same. CONFIRM only when you can point
to a clear generation defect in this frame (an extra or melted hand, two bodies blended into one shape, a different
person's face clearly visible, an object appearing from nothing, a limb drawn as a different body part such as a kick
drawn as a hand or a hand drawn as a shoe). Otherwise answer UNCERTAIN.
Answer with ONE JSON object: {"decision": "CONFIRMED|REJECTED|UNCERTAIN", "why": "<at most 25 words>"}"""

def _verify_call(model, key, content):
    """One second-opinion question. The reply must hold a JSON object with a known decision; one retry with a
    doubled budget when it does not (cut off, prose, or a refusal). Returns ({"decision": ..., "why": ...}, [usage]);
    decision "ERROR" when both tries fail or the call raises - the caller leaves an ERROR out of the vote."""
    usage, last = [], ""
    for mt in (600, 1200):
        try:
            txt, u = _call(model, key, VERIFY_SYSTEM, content, mt); usage.append(u)
        except Exception as e:
            return {"decision": "ERROR", "why": f"call failed: {type(e).__name__}: {str(e)[:120]}"}, usage
        try:
            r = first_json(txt)
            if (r.get("decision") or "").upper() in ("CONFIRMED", "REJECTED", "UNCERTAIN"): return r, usage
            last = f"unknown decision {r.get('decision')!r}"
        except Exception:
            last = "no JSON in reply: " + " ".join((txt or "<empty>").split())[:120]
    return {"decision": "ERROR", "why": last}, usage

def keep_rule(decs):
    """FAIL stays when >= 2 frames are CONFIRMED, or when the checker never REJECTS and is UNCERTAIN/CONFIRMED on
    >= 2 frames. Benchmark v4 (2026-11-10): every false fail came back mostly REJECTED (P011 RR, P026 RRR/RRR/CR/UR,
    P037_b RRR, P013 RRR/RRR) while the true fingers defect P002 came back UUU - "can't verify the finger count"
    is not an innocent explanation, so it must not clear the clip. Tuned on 6 clips: re-test on new ones."""
    c, r = decs.count("CONFIRMED"), decs.count("REJECTED")
    return c >= 2 or (r == 0 and len(decs) >= 2)

def verify_fail(d, model="claude-sonnet-5-5", per_rule=3, log=print, force=False):
    """Second opinion on a clip the AI review would FAIL. For each failing rule, up to `per_rule` of its
    frames are re-checked one by one by a skeptical prompt with the approved start frame. A rule stays a FAIL
    unless the checker positively explains it away (see keep_rule); otherwise the clip drops to FLAG. Benchmark
    2026-11-10: three good clips were failed for persistent misreads (people passing behind each other, an
    arm hidden by the body, identity on small blurred faces). Returns (verdict, kept, dropped, usd)."""
    log = log or (lambda *x: None)
    key = os.environ.get("ANTHROPIC_API_KEY")       # None = offline: saved decisions only, never a call
    man = load(d); ver = read_verdicts(d); cam = code_camera_ok(d)
    cv, rf, rg = clip_verdict(man, ver, cam, spec_text_forbidden(d))
    # Not a FAIL: nothing to verify. Return the FLAG reasons too (bug S1, 2026-11-10: they were returned as
    # [], so shot_qc showed an AI FLAG with no reason).
    if cv != "FAIL": return cv, rf, rg, 0.0
    _, crefs = shot_context(d); start = next((r for r in crefs if "start frame" in r["label"]), None)
    outs = {f["key"]: f["out"] for f in man["frames"]}
    pi, pw, pr, po = PRICES.get(model, (2.0, 2.5, 0.1, 10.0)); usd = 0.0; kept, dropped = [], []
    cache = {}; calls = 0
    vp = os.path.join(d, "ai_verify.json")
    if os.path.exists(vp) and not force:     # reuse earlier per-frame decisions (free rescore)
        j = json.load(open(vp, encoding="utf-8"))
        for line in j.get("kept", []) + j.get("dropped", []):
            r0 = line.split(":")[0]
            for k, dec, why in re.findall(r"(f\d+) (CONFIRMED|REJECTED|UNCERTAIN): (.*?)(?= \| f\d+ |$)", line.split(":", 1)[1]):
                if why.startswith("check failed:"): continue    # an error saved by the old code: ask again
                cache[(r0, k)] = (dec, why)
    # Hard rules first, and stop at the first rule the second opinion keeps: one kept rule FAILs the clip, so
    # checking the rest only costs money (2026-11-13, clip 15: 7 failing rules x 3 frames = 21 Sonnet calls).
    # Rules left unchecked are reported as such and do not change the verdict.
    hard = ["EVERY CREATURE", "HEAD COUNT", "NO MATERIALISING", "IDENTITY", "WARDROBE", "SET LAYOUT"]
    rf = sorted(rf, key=lambda l: hard.index(l.split(":")[0]) if l.split(":")[0] in hard else len(hard))
    for line in rf:
        rule = line.split(":")[0]; keys = re.findall(r"f\d+", line.split(":", 1)[1])
        if kept:
            kept.append(f"{rule}: not checked by the second opinion (the clip already FAILs on {kept[0].split(':')[0]})")
            continue
        # A saved decision counts even when its frame image is gone (2026-11-17: the app's check folders keep only
        # some frames after the review, so an offline rescore of 12 app clips found 1 of 3 frames per rule and
        # turned 5 clips the app had FLAGged into FAIL "only 1 frame checked").
        keys = [k for k in keys if (rule, k) in cache or (k in outs and os.path.exists(os.path.join(d, outs[k])))][:per_rule]
        decs = []; notes = []
        for k in keys:
            if (rule, k) in cache:
                dec, why = cache[(rule, k)]; decs.append(dec); notes.append(f"{k} {dec}: {why}"); continue
            if not key:
                notes.append(f"{k} NOT VERIFIED (offline)"); continue
            claim = "; ".join(i.get("note", "") for i in ver[k].get("issues", []) if rule in (i.get("rule") or "").upper()) or rule
            content = []
            if start and os.path.exists(start["src"]):
                content += [{"type": "text", "text": "Approved start frame:"}, img_block(start["src"], 1280)[0]]
            content += [{"type": "text", "text": "Frame to check:"}, img_block(os.path.join(d, outs[k]))[0],
                        {"type": "text", "text": f"Claimed defect ({rule}): {claim}"}]
            calls += 1
            r, us = _verify_call(model, key, content)
            for u in us: usd += (int(u.get("input_tokens") or 0) * pi + int(u.get("output_tokens") or 0) * po) / 1e6
            if r.get("decision") == "ERROR":
                # A failed check is not a verdict: it is left out of the vote (Phase 0 2026-11-11: two replies with no
                # JSON were counted as UNCERTAIN and kept S1_r2_gemini's NO MATERIALISING failed on errors alone).
                notes.append(f"{k} ERROR (not counted): {r['why']}"); continue
            dec = (r.get("decision") or "UNCERTAIN").upper()
            if dec not in ("CONFIRMED", "REJECTED", "UNCERTAIN"): dec = "UNCERTAIN"
            decs.append(dec); notes.append(f"{k} {dec}: {r.get('why', '')}")
        # Fewer than 2 frames could be checked (frames deleted from disk, or offline): the FAIL stands
        # unverified rather than being cleared without evidence (bug S2, 2026-11-10).
        keep = keep_rule(decs) if len(decs) >= 2 else True
        if len(decs) < 2: notes.append(f"only {len(decs)} frame(s) checked: FAIL kept unverified")
        (kept if keep else dropped).append(f"{rule}: " + " | ".join(notes))
        log(f"  second opinion {rule}: {'/'.join(x[0] for x in decs)} (C confirmed, U uncertain, R rejected) -> "
            f"{'FAIL kept' if keep else 'dropped to FLAG'}")
    verdict = "FAIL" if kept else ("FLAG" if (dropped or rg) else "PASS")
    if calls or not os.path.exists(vp):     # only a run that asked something new rewrites the record
        json.dump({"verdict": verdict, "kept": kept, "dropped": dropped, "usd": round(usd, 4)},
                  open(vp, "w", encoding="utf-8"), indent=1)
    return verdict, kept, dropped, usd

class ApiStopped(RuntimeError):
    """Two API calls in a row failed: the review stopped to protect the budget."""

def read_verdicts(d, name=None):
    ver = {}
    p = os.path.join(d, name or "verdicts.jsonl")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if line: v = json.loads(line); ver[v["key"]] = v       # later lines win
    return ver

def cmd_apply(a):
    man = load(a.dir); ver = read_verdicts(a.dir, getattr(a, "verdicts", None)); rules = parse_rules(getattr(a, "rules", None))
    for v in ver.values():
        eff, unchecked = effective(v, rules)
        if eff != (v.get("verdict") or "").upper():
            v["verdict_given"] = v.get("verdict"); v["verdict"] = eff
            if eff == "INCOMPLETE":
                v.setdefault("issues", []).append({"rule": "NOT CHECKED", "region": "-",
                    "note": "PASS given but not checked: " + ", ".join(unchecked)})
    low = verify_against_start(a.dir, man, ver)
    if low: print(f"  start-frame check: {low} FAIL frame(s) lowered to UNSURE - their flagged regions match the approved start frame")
    for f in man["frames"]:
        if f["key"] in ver: f["ai"] = ver[f["key"]]
    write_viewer(man, a.dir)
    c = {}
    for v in ver.values(): c[v.get("verdict")] = c.get(v.get("verdict"), 0) + 1
    print(f"applied {len(ver)} verdicts: {c}")
    summarize(man, ver, a.dir)
    cv, rf, rg = clip_verdict(man, ver, code_camera_ok(a.dir), spec_text_forbidden(a.dir))
    print(f"  CLIP VERDICT (AI part): {cv}" + "".join(f"\n    fail: {x}" for x in rf) + "".join(f"\n    flag: {x}" for x in rg[:6]))
    json.dump({"verdict": cv, "fail": rf, "flag": rg}, open(os.path.join(a.dir, "ai_clip_verdict.json"), "w", encoding="utf-8"), indent=1)
    inc = [k for k, v in ver.items() if v.get("verdict") == "INCOMPLETE"]
    if inc: print(f"  INCOMPLETE (PASS with rules not checked - not a pass): {inc}")
    nok = len(man["frames"]) - len([f for f in man["frames"] if f["key"] in ver])
    if nok: print(f"  {nok} frame(s) have no verdict yet")
    return ver
    if a.flags:
        human = set(json.load(open(a.flags)).get("flags", {}).keys())
        keys = {f["key"] for f in man["frames"]}; human = {k if k in keys else f"f{k}" for k in human}
        ai_bad = {k for k, v in ver.items() if v.get("verdict") in ("FAIL", "UNSURE", "INCOMPLETE")}
        print(f"  both flagged: {sorted(human & ai_bad)}")
        print(f"  human only (AI missed): {sorted(human - ai_bad)}")
        print(f"  AI only (check, may be false alarms): {sorted(ai_bad - human)}")

def _box_diff(start, frame, box):
    """How different is `box` (fractions of the frame) from the same place in the approved start frame?
    Aligns the start frame to this frame first (the camera may have moved), blurs both and matches tone,
    then returns the share of 8 px blocks that differ (0-1), or None when alignment fails."""
    import cv2, numpy as np
    a = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY); b = cv2.cvtColor(start, cv2.COLOR_BGR2GRAY)
    b = cv2.resize(b, (a.shape[1], int(b.shape[0] * a.shape[1] / b.shape[1])))
    orb = cv2.ORB_create(4000); ka, da = orb.detectAndCompute(a, None); kb, db = orb.detectAndCompute(b, None)
    if da is None or db is None: return None
    m = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(db, da)
    if len(m) < 30: return None
    M, inl = cv2.estimateAffinePartial2D(np.float32([kb[x.queryIdx].pt for x in m]), np.float32([ka[x.trainIdx].pt for x in m]),
                                         method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if M is None or inl.sum() < 20: return None
    b = cv2.warpAffine(b, M, (a.shape[1], a.shape[0]), borderValue=0)   # outside the approved frame = black = different
    H, W = a.shape; x0, y0, x1, y1 = box
    pw, ph = (x1 - x0) * 0.15, (y1 - y0) * 0.15                       # a little context around the box
    X0, Y0 = max(0, int((x0 - pw) * W)), max(0, int((y0 - ph) * H)); X1, Y1 = min(W, int((x1 + pw) * W)), min(H, int((y1 + ph) * H))
    if X1 - X0 < 16 or Y1 - Y0 < 16: return None
    # local fine alignment: a whole-frame fit can leave a few pixels of error at the edges of the frame
    # (P003 f36: 10 px, which made an unchanged photo read as 13% different)
    sr = 12; ta = a[Y0:Y1, X0:X1]
    win = b[max(0, Y0 - sr):min(H, Y1 + sr), max(0, X0 - sr):min(W, X1 + sr)]
    if win.shape[0] >= ta.shape[0] and win.shape[1] >= ta.shape[1]:
        _, _, _, loc = cv2.minMaxLoc(cv2.matchTemplate(win, ta, cv2.TM_CCOEFF_NORMED))
        ox, oy = max(0, X0 - sr) + loc[0], max(0, Y0 - sr) + loc[1]
        cbw = b[oy:oy + ta.shape[0], ox:ox + ta.shape[1]]
    else:
        cbw = b[Y0:Y1, X0:X1]
    ca = cv2.GaussianBlur(ta, (0, 0), 1.5).astype(np.float32); cb = cv2.GaussianBlur(cbw, (0, 0), 1.5).astype(np.float32)
    cb = (cb - cb.mean()) / (cb.std() + 1e-6) * ca.std() + ca.mean()
    h8, w8 = (Y1 - Y0) // 8 * 8, (X1 - X0) // 8 * 8
    d = np.abs(ca[:h8, :w8] - cb[:h8, :w8]).reshape(h8 // 8, 8, w8 // 8, 8).mean((1, 3))
    return float((d > 18).mean())

# Under 3% of 8 px blocks differing = the region matches the approved start frame. Measured 2026-11-10:
# P003's unchanged photo 0.0-1.7% (the misread); a face whose lips parted 9%; a walking woman 0.17 s in 7.8%;
# P018's moved coffee cup 69-77%. 3% keeps small real changes (lips) from being lowered.
SAME_LIMIT = 0.03

def verify_against_start(d, man, ver):
    """Lower FAIL issues whose box matches the approved start frame (they are not new). Writes
    "start_check" on each checked issue; a FAIL whose every boxed issue matches becomes UNSURE."""
    sp = os.path.join(d, "shot_spec.json")
    if not os.path.exists(sp): return 0
    import cv2
    from shot_qc import _walk
    st_path = _walk(json.load(open(sp, encoding="utf-8"))).get("start_frame")
    if not st_path or not os.path.exists(st_path): return 0
    start = cv2.imread(st_path); outs = {f["key"]: f["out"] for f in man["frames"]}; lowered = 0
    for k, v in ver.items():
        if (v.get("verdict") or "").upper() != "FAIL" or k not in outs: continue
        fr = cv2.imread(os.path.join(d, outs[k])); boxed = same = 0
        for i in v.get("issues", []):
            b = i.get("box")
            if not (isinstance(b, list) and len(b) == 4): continue
            try: b = [max(0.0, min(1.0, float(x))) for x in b]
            except (TypeError, ValueError): continue
            if b[2] <= b[0] or b[3] <= b[1]: continue
            r = _box_diff(start, fr, b); boxed += 1
            if r is None: i["start_check"] = "could not align"; continue
            i["start_check"] = f"{r:.0%} of the boxed region differs from the approved start frame"
            if r < SAME_LIMIT:
                i["start_check"] += " - SAME as approved: not a new defect (if it is wrong, the approved frame is wrong)"; same += 1
        if boxed and same == boxed:
            v["verdict_given"] = v.get("verdict_given") or "FAIL"; v["verdict"] = "UNSURE"; lowered += 1
            for i in v.get("issues", []):
                for r, x in list((v.get("checks") or {}).items()):
                    if norm(x) == "FAIL" and r.upper() in (i.get("rule") or "").upper(): v["checks"][r] = "UNSURE"
            v.setdefault("issues", []).append({"rule": "START CHECK", "region": "-",
                "note": "every region flagged here matches the approved start frame; lowered from FAIL - look if in doubt"})
    return lowered

# Clip verdict policy, from the 55-clip benchmark (2026-11-10; tuned on those clips, so check it on new ones).
MINOR = {"MOUTHS", "NATURAL POSES", "IMAGE QUALITY", "SCREEN SIDE", "LIGHTING", "EDITORIAL", "FIXED DETAILS"}
CAMERA_CONSEQUENCES = {"SET LAYOUT", "NO MATERIALISING", "HEAD COUNT"}
# 2026-11-16 auto-pass: the frame review's UNCONFIRMED flags (single frames, minor rules, fails the second opinion
# rejected) were on 29 of 29 good clips and on the bad ones about as often (Phase 0 + MiniMax, 84 labelled clips), so
# on their own they no longer hold a clip back: they stay as notes and timeline marks. These rules still FLAG when
# they repeat this many times without being rejected: the severe kinds of defect, where a person should look.
SEVERE_FLAG = {"IDENTITY": 2, "WARDROBE": 1, "EVERY CREATURE": 1, "HEAD COUNT": 2, "NO MATERIALISING": 2,
               "REFLECTIONS AND SHADOWS": 1}   # SuperCool P016_alt: an extra figure in the shop glass


def ai_part(cv, flag_lines, style=None):
    """The frame review's share of the clip verdict: FAIL (a confirmed fail), FLAG (a severe rule repeats, see
    SEVERE_FLAG) or PASS. flag_lines: clip_verdict's flag lines plus the second opinion's dropped (REJECTED) lines.
    Measured on cartoon clips (Phase 0, MiniMax) first; photoreal since 2026-11-17 with IMAGE QUALITY added (below).
    Before that photoreal FLAGged on any flag line: SuperCool's bad P049 (tilt to the feet, sneakers recoloured,
    gravel turned to concrete) has only unconfirmed ANATOMY / IMAGE QUALITY / SET LAYOUT flags."""
    if cv == "FAIL": return "FAIL"
    # 2026-11-17: photoreal uses the same rule, with IMAGE QUALITY on 3+ frames added (SuperCool's bad P049 has only
    # unconfirmed ANATOMY 2 / IMAGE QUALITY 3 / SET LAYOUT 1 lines - it stays a FLAG). Simulated on the saved answers
    # of the three photoreal benchmarks (Windows run of 2026-11-17): good clips auto-passed SuperCool 10 -> 19 of 34,
    # Keycard 1 -> 4 of 11, Kijan 0 -> 1 of 8; no bad clip passes. IMAGE QUALITY 3 was chosen with P049 in view
    # (one clip): treat it as a guess until new photoreal rejects confirm it.
    sev = SEVERE_FLAG if (style or "").lower() == "cartoon" else {**SEVERE_FLAG, "IMAGE QUALITY": 3}
    for l in flag_lines:
        if "REJECTED" in l: continue
        m = re.match(r"([A-Z][A-Z ()]*?): (\d+) frame", l)
        if m and m.group(1) in sev and int(m.group(2)) >= sev[m.group(1)]: return "FLAG"
    return "PASS"

def code_camera_ok(d):
    """True/False when shot_qc ran the camera check on this clip (it then decides CAMERA), else None."""
    p = os.path.join(d, "shot_qc.json")
    if not os.path.exists(p): return None
    q = json.load(open(p, encoding="utf-8"))
    return None if "camera" not in q.get("checks_run", []) else not bool(q.get("evidence", {}).get("QC-D"))

def spec_text_forbidden(d):
    """True when the shot spec in d says "no_text": then a TEXT failure can fail the clip; otherwise TEXT only flags."""
    try: return bool(json.load(open(os.path.join(d, "shot_spec.json"), encoding="utf-8")).get("no_text"))
    except Exception: return False

def sweep_pick(remaining, n=8):
    """Up to n frames spread evenly over the frames an early stop left unsent (first and last included)."""
    if n <= 0 or not remaining: return []
    if len(remaining) <= n: return list(remaining)
    idx = sorted({round(i * (len(remaining) - 1) / (n - 1)) for i in range(n)})
    return [remaining[i] for i in idx]

def clip_verdict(man, ver, code_camera_ok=None, text_forbidden=False):
    """FAIL / FLAG / PASS for the clip from the per-frame AI verdicts, with reasons.
    - CAMERA: the code camera check decides when it ran (code_camera_ok True/False); AI camera calls are notes.
      In a frame where the AI failed CAMERA, SET LAYOUT / NO MATERIALISING / HEAD COUNT failures are taken as
      things the move revealed or hid, not separate defects.
    - MINOR rules (mouths, poses, image quality, screen side, lighting, editorial, fixed details) can only FLAG.
    - Any other rule fails the clip only when it fails in 2 CONSECUTIVE sampled frames (a real generation
      defect persists; a one-frame motion smear or misread does not); a single frame is a FLAG."""
    order = [f["key"] for f in man["frames"]]; idx = {k: i for i, k in enumerate(order)}
    per = {}                                              # rule -> sorted frame indexes that FAIL it
    for k, v in ver.items():
        if k not in idx: continue
        fails = {r.upper() for r, x in (v.get("checks") or {}).items() if norm(x) == "FAIL"}
        cam = "CAMERA" in fails
        for r in fails:
            if r == "CAMERA" and code_camera_ok is not None: continue
            if cam and r in CAMERA_CONSEQUENCES: continue
            per.setdefault(r, []).append(idx[k])
    # Frames an early stop left unreviewed sit between the sweep frames, so sweep frames are never "consecutive".
    # 2026-11-13, path test clip 15 (MiniMax): two green dog creatures failed EVERY CREATURE / HEAD COUNT /
    # IDENTITY in sweep frames f120, f136, f156 and the clip only FLAGged (Londi rejected it). Rule: 3+ failing
    # frames in a row among the REVIEWED frames (no reviewed frame between them that passes the rule) also FAIL.
    # Two such frames stay a FLAG (unit "not consecutive -> FLAG").
    reviewed = sorted(idx[k] for k in ver if k in idx); rpos = {ix: j for j, ix in enumerate(reviewed)}
    reasons_fail, reasons_flag = [], []
    for r, xs in sorted(per.items()):
        xs = sorted(set(xs)); keys = [order[i] for i in xs]
        consec = any(b - a == 1 for a, b in zip(xs, xs[1:]))
        run = best = 1
        for a, b in zip(xs, xs[1:]):
            run = run + 1 if rpos[b] - rpos[a] == 1 else 1; best = max(best, run)
        line = f"{r}: {len(xs)} frame(s) {', '.join(keys[:6])}"
        if r in MINOR or (r == "TEXT" and not text_forbidden): reasons_flag.append(line)
        elif consec: reasons_fail.append(line + " (consecutive)")
        elif best >= 3: reasons_fail.append(line + f" ({best} in a row of the reviewed frames)")
        else: reasons_flag.append(line + " (not consecutive)")
    v = "FAIL" if reasons_fail else ("FLAG" if reasons_flag else "PASS")
    return v, reasons_fail, reasons_flag

def summarize(man, ver, d):
    """One line per rule that FAILED, with every frame that failed it, instead of 45 separate notes.
    Written to ai_summary.json and printed; record uses it as the gate evidence."""
    order = {f["key"]: i for i, f in enumerate(man["frames"])}; tim = {f["key"]: f.get("t") for f in man["frames"]}
    by = {}
    for k, v in ver.items():
        for r, x in (v.get("checks") or {}).items():
            if norm(x) == "FAIL":
                note = next((i.get("note", "") for i in v.get("issues", []) if r.upper() in (i.get("rule") or "").upper()), "")
                by.setdefault(r.upper(), []).append((order.get(k, 9999), k, note))
    out = []
    for r, xs in sorted(by.items(), key=lambda z: -len(z[1])):
        xs.sort(); keys = [k for _, k, _ in xs]
        ts = [tim[k] for k in keys if tim.get(k) is not None]
        span = f" ({min(ts):.2f}-{max(ts):.2f} s)" if ts else ""
        out.append({"rule": r, "frames": keys, "count": len(keys), "example": next((n for _, _, n in xs if n), "")[:300],
                    "line": f"{r}: {len(keys)} frame(s){span}: {', '.join(keys[:12])}{' ...' if len(keys) > 12 else ''}"})
    json.dump(out, open(os.path.join(d, "ai_summary.json"), "w", encoding="utf-8"), indent=1)   # last applied run
    if out:
        print("  failures by rule:")
        for o in out: print(f"    {o['line']}\n      e.g. {o['example'][:160]}")
    return out

def cmd_record(a):
    """QC gates A-G for the clip. A gate is PASS only if every rule in it is PASS on every frame."""
    mp = os.path.join(a.dir, "manifest.json")
    man = load(a.dir) if os.path.exists(mp) else {"clip": None, "frames": []}   # code-only record is allowed
    ver = read_verdicts(a.dir, getattr(a, "verdicts", None)); rules = parse_rules(a.rules)
    frames = [f for f in man["frames"]]
    gate = {g: {"status": "PASS", "evidence": [], "unchecked": set()} for g in GATES}
    if not frames or not ver:
        for g in gate.values(): g["status"] = "NOT CHECKED"
    for f in frames:
        v = ver.get(f["key"])
        t = f" ({f['t']:.2f} s)" if f.get("t") is not None else ""
        checks = {k.upper(): norm(x) for k, x in ((v or {}).get("checks") or {}).items()}
        for r, g in rules:
            if g not in gate: continue
            st = checks.get(r, "NOT CHECKED") if v else "NOT CHECKED"
            if v and st == "NOT CHECKED" and (v.get("verdict") or "").upper() == "FAIL" and \
                    any((i.get("rule") or "").upper() == r for i in v.get("issues", [])):
                st = "FAIL"
            if st == "FAIL":
                gate[g]["status"] = "FAIL"
                notes = [i.get("note", "") for i in (v or {}).get("issues", []) if (i.get("rule") or "").upper() == r]
                gate[g]["evidence"].append(f"{f['key']}{t} {r}: {'; '.join(notes) or 'fail'}")
            elif st != "PASS":
                gate[g]["unchecked"].add(r)
                if gate[g]["status"] == "PASS": gate[g]["status"] = "NOT CHECKED"
    if a.editorial:
        gate["F"]["status"] = a.editorial.upper(); gate["F"]["unchecked"] = set()
    # code checks from shot_qc.py: they can FAIL a gate, never pass one
    sq = os.path.join(a.dir, "shot_qc.json")
    if os.path.exists(sq):
        q = json.load(open(sq, encoding="utf-8"))
        for g in GATES:
            for e in q.get("evidence", {}).get(f"QC-{g}", []):
                gate[g]["status"] = "FAIL"; gate[g]["evidence"].append("code: " + e)
        if a.render_id is None: a.render_id = q.get("render_id")
        if not man.get("clip"): man["clip"] = q.get("shot_id") or q.get("clip")
        if a.retries is None: a.retries = q.get("paid_retries")
    # frame_check code flags are evidence too (they do not set a gate to PASS)
    code = [f"{f['key']}: {w}" for f in frames for w in f.get("why", []) if w != "sweep"]
    if os.path.exists(sq): code = []        # already merged into the gates above
    rec = {"clip": man.get("clip"), "reviewed": time.strftime("%Y-%m-%d %H:%M"),
           "render_id": a.render_id, "paid_retries": a.retries, "note": a.note,
           "frames": len(frames), "frames_with_verdict": len([f for f in frames if f["key"] in ver]),
           "gates": {f"QC-{g} {GATES[g]}": {"status": gate[g]["status"], "evidence": gate[g]["evidence"],
                                            "not_checked": sorted(gate[g]["unchecked"])} for g in GATES},
           "code_flags": code, "rules_without_gate": [r for r, g in rules if g not in GATES]}
    overall = "FAIL" if any(x["status"] == "FAIL" for x in rec["gates"].values()) else \
              "PASS" if all(x["status"] == "PASS" for x in rec["gates"].values()) else "NOT CHECKED"
    rec["overall"] = overall
    json.dump(rec, open(os.path.join(a.dir, "clip_record.json"), "w", encoding="utf-8"), indent=1)
    print(f"clip record: {os.path.join(a.dir, 'clip_record.json')}  overall {overall}")
    for k, x in rec["gates"].items():
        extra = ("  not checked: " + ", ".join(x["not_checked"])) if x["not_checked"] else ""
        print(f"  {k:16s} {x['status']:12s}{extra}")
        for e in x["evidence"][:4]: print(f"      {e}")
    if rec["rules_without_gate"]: print(f"  rules with no gate letter (add [A]-[G]): {rec['rules_without_gate']}")
    if a.ledger:
        new = not os.path.exists(a.ledger)
        with open(a.ledger, "a", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            if new: w.writerow(["reviewed", "clip", "render_id", "paid_retries", "overall"] + [f"QC-{g}" for g in GATES] + ["note", "evidence"])
            w.writerow([rec["reviewed"], rec["clip"], a.render_id or "", a.retries if a.retries is not None else "", overall] +
                       [gate[g]["status"] for g in GATES] + [a.note or "", " | ".join(e for g in GATES for e in gate[g]["evidence"])])
        print(f"  ledger row added: {a.ledger}")

def cmd_compare(a):
    """Two review runs of the same frames (e.g. two models): per rule, which frames each one FAILED,
    where they agree, and the verdict counts. Uses the later lines of each file."""
    man = load(a.dir); A_ = read_verdicts(a.dir, a.a); B_ = read_verdicts(a.dir, a.b)
    keys = [f["key"] for f in man["frames"] if f["key"] in A_ and f["key"] in B_]
    def fails(V):
        out = {}
        for k in keys:
            for r, x in (V[k].get("checks") or {}).items():
                if norm(x) == "FAIL": out.setdefault(r.upper(), set()).add(k)
        return out
    fa, fb = fails(A_), fails(B_)
    cnt = lambda V: {x: sum(1 for k in keys if (V[k].get("verdict") or "").upper() == x) for x in ("PASS", "FAIL", "UNSURE")}
    print(f"{len(keys)} frames reviewed by both.  {a.a}: {cnt(A_)}   {a.b}: {cnt(B_)}")
    for r in sorted(set(fa) | set(fb), key=lambda r: -len(fa.get(r, set()) | fb.get(r, set()))):
        x, y = fa.get(r, set()), fb.get(r, set())
        o = lambda z: ", ".join(sorted(z, key=keys.index)) or "-"
        print(f"  {r}: both {len(x & y)} [{o(x & y)}] | only {a.a} {len(x - y)} [{o(x - y)}] | only {a.b} {len(y - x)} [{o(y - x)}]")
    hc = lambda V: sum(1 for k in keys if norm((V[k].get("checks") or {}).get("HEAD COUNT")) != "NOT CHECKED")
    print(f"  HEAD COUNT checked on: {a.a} {hc(A_)}, {a.b} {hc(B_)} of {len(keys)} frames")

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pack"); p.add_argument("dir"); p.add_argument("--rules"); p.add_argument("--only", default="all", choices=["all", "flagged"])
    p = sub.add_parser("api"); p.add_argument("dir"); p.add_argument("--rules"); p.add_argument("--only", default="flagged", choices=["all", "flagged"])
    p.add_argument("--model", default="claude-opus-5-5"); p.add_argument("--price", type=float, default=4.0); p.add_argument("--yes", action="store_true")
    p.add_argument("--verdicts", help="results file in DIR (default verdicts.jsonl); one per model to compare runs")
    p.add_argument("--force", action="store_true", help="review even if the shot spec disagrees with the approved start frame")
    p.add_argument("--stop-after", type=int, default=0, help="stop after N FAIL frames (enough to fail the clip); 0 = review all")
    p.add_argument("--workers", type=int, default=1, help="frames sent at the same time (4 is about 4x faster; same cost)")
    p.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"], help="output_config.effort (model default if absent)")
    p.add_argument("--thinking", choices=["adaptive", "disabled", "between_tools"], help="thinking type (model default if absent)")
    p = sub.add_parser("apply"); p.add_argument("dir"); p.add_argument("--flags"); p.add_argument("--rules"); p.add_argument("--verdicts")
    p = sub.add_parser("compare"); p.add_argument("dir"); p.add_argument("a"); p.add_argument("b")
    p = sub.add_parser("record"); p.add_argument("dir"); p.add_argument("--rules"); p.add_argument("--render-id")
    p.add_argument("--retries", type=int); p.add_argument("--editorial", choices=["PASS", "FAIL", "pass", "fail"])
    p.add_argument("--note"); p.add_argument("--ledger")
    a = ap.parse_args()
    try:
        {"pack": cmd_pack, "api": cmd_api, "apply": cmd_apply, "record": cmd_record, "compare": cmd_compare}[a.cmd](a)
    except ApiStopped as e:
        sys.exit(str(e))

if __name__ == "__main__":
    main()

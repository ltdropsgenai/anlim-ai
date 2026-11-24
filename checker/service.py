r"""Checker service: the app's worker sends one finished clip, this runs the frame checker on it. @anlim

Python standard library only (no installs beyond what frame_check already needs).

  POST /check   {"generation_id": "...", "spec": {...shot_qc spec; "clip" and "out" are local paths...},
                 "max_usd": 0.15, "confirmed_spec": true|false}
                -> {"verdict": "PASS"|"FLAG"|"FAIL"|"NOT_REVIEWED"|"ERROR", "reasons": [...], "frame_flags": [...],
                    "review_usd": .., "verify_usd": .., "action_usd": .., "models": {...}, "action": {...}}
  POST /end_frame {"start": "<local png>", "end": "<local png>", "out": "<dir>"}
                -> frame_check/end_frame.check: {"verdict": "PASS"|"FLAG", "drift": [...], "why": ...}
                Free (no API). The worker calls it before submitting a shot that has an end frame.
  POST /compose {"start", "edited", "out_png", "out", "plates"?: [...] (or "plate"), "expect"?: n characters} -> frame_check/end_frame.compose + its check (free).
                "revealed": areas a character left; "source" plate (from the location's empty room) or edit (drawn
                by the image model: a person should look).
                The worker calls it after the image model edits a still (end frame, start still, plate).
  POST /last_frame {"video": "<local mp4>", "out_png": "<local png>"} -> {"verdict": "PASS", "frames": n, "size": [w, h]}
                The last decodable frame of a clip (free). Start stills that continue from the previous clip.
  POST /height {"still", "cast": [{"name", "height", "ref"}], "plate"?, "out"} -> frame_check/height_check.check:
                {"verdict": "OK"|"WRONG"|"UNSURE"|"NOT CHECKED", "problems": [...], "measured": [...], "ai": {...}, "usd"}
                Standing pairs are measured (free); anything else is one AI question (about $0.01, needs ANTHROPIC_API_KEY).
  POST /reposition_fit {"start", "plates"?} -> frame_check/end_frame.reposition_fit: {"verdict": "PASS"|"FLAG", "cover",
                "plate_fit", "why"}. Free. The worker calls it before paying for a "same room, new positions" start still.
  POST /motion_check {"render", "source", "refs": [...], "who"?} -> frame_check/motion_swap_ai.analyze: did a motion
       transfer keep who is who in every shot? {"verdict": "PASS"|"FLAG"|"NOT_REVIEWED", "issues", "usd", ...}
  POST /still_check {"still", "instruction", "subjects"?, "out"?} -> frame_check/still_check.check: {"verdict":
                "OK"|"WRONG"|"UNSURE"|"NOT CHECKED", "problems", "usd"}. Physical staging of a made still (~$0.01).
  Every frame route above also takes "look" (cartoon | photoreal) and "subjects" ([{"name", "kind": person | animal |
  object, "what"}]): what counts as a character and which matting model cuts them out (2026-11-16).
  POST /moderate {"text", "images"?: [local paths], "look"?, "kind"?: clip | frame | audio} -> frame_check/moderate.check:
                {"verdict": "ALLOW"|"BLOCK", "category", "reason", "usd", "model"}. One AI question (about $0.001 for words,
                about $0.01 with pictures) before a paid model is called (2026-11-23).
  GET  /health  -> {"ok": true, "mode": "real"|"fake", "frame_check": "<dir>"}

Environment:
  CHECKER_TOKEN       shared secret; requests must send "Authorization: Bearer <token>" (required). If not set
                      in the environment it is read from ..\worker\.env
  FRAME_CHECK_DIR     folder of frame_check (default C:\\vid_projects\\_tools\\frame_check)
  CHECKER_PORT        default 8787;  CHECKER_HOST default 127.0.0.1 (same machine as the worker)
  CHECKER_MAX_JOBS    clips checked at once (default 2; each review already runs 4 API calls in parallel)
  CHECKER_MODE        "real" (default) or "fake" (tests: verdict comes from spec["fake_verdict"], no API spend)
  ANTHROPIC_API_KEY   used by frame_check in real mode
"""
import json, os, sys, threading, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FC = os.environ.get("FRAME_CHECK_DIR", r"C:\vid_projects\_tools\frame_check")
MODE = os.environ.get("CHECKER_MODE", "real")
def _env_file(name="CHECKER_TOKEN"):
    r"""A setting from ..\worker\.env, so each secret is set in one place only."""
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "worker", ".env")
    try:
        for line in open(p, encoding="utf-8"):
            k, _, v = line.strip().partition("=")
            if k.strip() == name: return v.strip().strip('"')
    except OSError:
        pass
    return ""
_env_file_token = _env_file

def _real(v):
    return v if v and not v.strip().startswith("<") else ""   # an unfilled "<...>" placeholder is not a token

TOKEN = _real(os.environ.get("CHECKER_TOKEN", "")) or _real(_env_file_token())
SLOTS = threading.BoundedSemaphore(int(os.environ.get("CHECKER_MAX_JOBS", "2")))
# 2026-11-18: the key lived only in the PowerShell window it was typed into; after a reboot the checker started
# without it, the frame checks quietly said "not checked (no API key)" and every clip check died (ai_review exits
# with SystemExit, which killed the request: the worker saw "fetch failed" 5 times). Now: also read from worker\.env.
if not _real(os.environ.get("ANTHROPIC_API_KEY", "")) and _real(_env_file("ANTHROPIC_API_KEY")):
    os.environ["ANTHROPIC_API_KEY"] = _real(_env_file("ANTHROPIC_API_KEY"))
if MODE == "real":
    sys.path.insert(0, FC)
    import pipeline   # noqa: E402  (frame_check/pipeline.py)

def fake_check(spec):
    v = spec.get("fake_verdict", "PASS")
    return {"verdict": v, "reasons": [f"fake {v}"], "review_usd": 0.0, "verify_usd": 0.0, "action_usd": 0.0,
            "frame_flags": [{"t_s": 2.5, "frame": "f60", "verdict": "FAIL", "rules": ["ANATOMY"], "note": "fake"}]
                           if v != "PASS" else [], "models": {"review": "fake"}, "action": None}

def run_check(body):
    spec = body["spec"]
    for k in ("clip", "out"):
        if not spec.get(k): raise ValueError(f"spec.{k} is required")
    if not os.path.exists(spec["clip"]): raise FileNotFoundError(spec["clip"])
    if MODE == "fake": return fake_check(spec)
    return pipeline.check_clip(spec, max_usd=float(body.get("max_usd", 0.15)),
                               confirmed_spec=bool(body.get("confirmed_spec")), log=None)

_EF_LOCK = threading.Lock()   # the detector and matting model are loaded once and are not thread-safe

def _subjects(body):
    """The look ("cartoon" | "photoreal") and cast [{"name", "kind": person|animal|object, "what"}] of a request:
    end_frame.subjects picks the detector classes and the matting model from them (2026-11-16). Without them: people,
    cartoon, as before."""
    if FC not in sys.path: sys.path.insert(0, FC)
    import end_frame
    cast = [c for c in (body.get("subjects") or []) if isinstance(c, dict)]
    return end_frame.subjects(body.get("look") or "cartoon", cast or None)

def run_end_frame(body):
    for k in ("start", "end"):
        if not body.get(k): raise ValueError(f"{k} is required")
        if not os.path.exists(body[k]): raise FileNotFoundError(body[k])
    if MODE == "fake":
        v = body.get("fake_verdict", "PASS")
        return {"verdict": v, "drift": [] if v == "PASS" else [{"box": [0.7, 0.4, 0.9, 0.55], "area_pct": 1.5}],
                "why": f"fake {v}", "matting": False}
    if FC not in sys.path: sys.path.insert(0, FC)
    import end_frame   # frame_check/end_frame.py
    with _EF_LOCK, _subjects(body):
        return end_frame.check(body["start"], body["end"], body.get("out"))

def run_compose(body):
    """POST /compose {"start", "edited", "out_png", "out"}: frame_check end_frame.compose (room from the start still,
    characters from the edit), then its check. Free (no API)."""
    for k in ("start", "edited", "out_png"):
        if not body.get(k): raise ValueError(f"{k} is required")
    for k in ("start", "edited"):
        if not os.path.exists(body[k]): raise FileNotFoundError(body[k])
    if MODE == "fake":
        import shutil
        shutil.copyfile(body["edited"], body["out_png"])
        v = body.get("fake_verdict", "PASS")
        return {"verdict": v, "drift": [] if v == "PASS" else [{"box": [0.7, 0.4, 0.9, 0.55], "area_pct": 1.5}],
                "why": f"fake {v}", "matting": False, "composed": body["out_png"]}
    if FC not in sys.path: sys.path.insert(0, FC)
    import end_frame
    with _EF_LOCK, _subjects(body):
        plates = body.get("plates") or ([body["plate"]] if body.get("plate") else [])
        plates = [p for p in plates if p and os.path.exists(p)]       # one per camera framing; the first that fits is used
        return end_frame.compose(body["start"], body["edited"], body["out_png"], body.get("out"), plate=plates or None,
                                 expect=body.get("expect"))

def run_reposition_fit(body):
    """POST /reposition_fit {"start", "plates"?}: before paying for a "same room, new positions" edit, is the still a
    close-up with no fitting plate (the room behind the characters would be invented)? Free (no API). 2026-11-16."""
    if not body.get("start"): raise ValueError("start is required")
    if not os.path.exists(body["start"]): raise FileNotFoundError(body["start"])
    if MODE == "fake":
        return {"verdict": "PASS", "cover": 0.0, "people": 0, "plate_fit": None, "plate_path": None, "drift": [], "why": None}
    if FC not in sys.path: sys.path.insert(0, FC)
    import end_frame
    plates = [p for p in (body.get("plates") or []) if p and os.path.exists(p)]
    with _EF_LOCK, _subjects(body):
        return end_frame.reposition_fit(body["start"], plates or None)

def run_cutouts(body):
    """POST /cutouts {"image", "out_dir", "plate"?}: frame_check cutout.py - each character cut out onto white, left to
    right, with warnings (cut off by the frame edge, overlapping, small, background may come along). Free (no API)."""
    for k in ("image", "out_dir"):
        if not body.get(k): raise ValueError(f"{k} is required")
    if not os.path.exists(body["image"]): raise FileNotFoundError(body["image"])
    plate = body.get("plates") or body.get("plate") or None          # a path, or a list (one per camera framing)
    for p_ in ([plate] if isinstance(plate, str) else (plate or [])):
        if not os.path.exists(p_): raise FileNotFoundError(p_)
    if MODE == "fake":
        import shutil
        os.makedirs(body["out_dir"], exist_ok=True)
        p = os.path.join(body["out_dir"], "cutout_1.png"); shutil.copyfile(body["image"], p)
        return {"verdict": "PASS", "cutouts": [{"index": 1, "path": p, "box": [0.1, 0.1, 0.4, 0.9], "warnings": ["fake"]}], "drift": []}
    if FC not in sys.path: sys.path.insert(0, FC)
    import cutout
    with _EF_LOCK, _subjects(body):
        res = cutout.cutouts(body["image"], body["out_dir"], plate=plate)
    return {"verdict": "PASS", "cutouts": res, "drift": []}

def run_height(body):
    """POST /height: are the characters drawn at the right heights relative to each other (their cards' height units)?"""
    for k in ("still", "out"):
        if not body.get(k): raise ValueError(f"{k} is required")
    if not os.path.exists(body["still"]): raise FileNotFoundError(body["still"])
    cast = body.get("cast") or []
    if MODE == "fake":
        v = body.get("fake_verdict", "OK")
        return {"verdict": v, "problems": [] if v == "OK" else ["fake: King and Layana are drawn about the same height"],
                "measured": [], "ai": None, "notes": [], "usd": 0.0, "drift": []}
    if FC not in sys.path: sys.path.insert(0, FC)
    import height_check
    with _EF_LOCK, _subjects(body):
        r = height_check.check(body["still"], cast, plate=body.get("plate") or None, out_dir=body["out"], log=lambda *a: None)
    r["drift"] = []
    return r

def run_still_check(body):
    """POST /still_check {"still", "instruction", "subjects"?, "out"?}: frame_check still_check - are the people really
    doing what was asked (sitting ON the seat, feet on the floor, hands holding)? One AI question, about $0.01 (2026-11-17)."""
    if not body.get("still"): raise ValueError("still is required")
    if not os.path.exists(body["still"]): raise FileNotFoundError(body["still"])
    if MODE == "fake":
        v = body.get("fake_verdict", "OK")
        return {"verdict": v, "problems": [] if v == "OK" else ["fake: sitting on nothing"], "usd": 0.0, "drift": []}
    if FC not in sys.path: sys.path.insert(0, FC)
    import still_check
    r = still_check.check(body["still"], body.get("instruction") or "", body.get("subjects") or [], body.get("out"))
    r["drift"] = []
    return r

def run_motion_check(body):
    """POST /motion_check: one vision call over the render's shots against the source clip (2026-11-20). Never FAIL:
    PASS, FLAG with the swapped shots, or NOT_REVIEWED when the model was unsure or the call could not run."""
    for k in ("render", "source"):
        if not body.get(k): raise ValueError(f"{k} is required")
        if not os.path.exists(body[k]): raise FileNotFoundError(body[k])
    refs = [r for r in (body.get("refs") or []) if r and os.path.exists(r)]
    if MODE == "fake":
        return {"verdict": body.get("fake_verdict", "PASS"), "issues": [], "usd": 0.0, "reasons": []}
    if FC not in sys.path: sys.path.insert(0, FC)
    import motion_swap_ai
    r = motion_swap_ai.analyze(body["render"], body["source"], refs, body.get("who"), log=None)
    v = {"PASS": "PASS", "FLAG": "FLAG"}.get(r.get("verdict"), "NOT_REVIEWED")
    reasons = [x["text"] for x in r.get("issues", [])] or ([r["why"]] if r.get("why") else [])
    if r.get("verdict") == "NOT SURE": reasons = ["the swap check could not tell who is who in most shots"]
    r.pop("answer", None)
    return {"verdict": v, "reasons": reasons, "usd": r.get("usd", 0.0), "detail": r,
            "frame_flags": [{"t_s": x["from_s"], "verdict": "FLAG", "rules": ["SWAP"], "note": x["text"]} for x in r.get("issues", [])]}

def run_moderate(body):
    """POST /moderate: may anlim make this job? (frame_check/moderate.py, 2026-11-23). In fake mode the verdict comes from
    body["fake_verdict"] (default ALLOW)."""
    imgs = [p for p in (body.get("images") or []) if p]
    for p in imgs:
        if not os.path.exists(p): raise FileNotFoundError(p)
    if MODE == "fake":
        v = body.get("fake_verdict", "ALLOW")
        return {"verdict": v, "category": "none" if v == "ALLOW" else "sexual", "reason": "" if v == "ALLOW" else "fake block",
                "usd": 0.0, "model": "fake", "images": len(imgs), "drift": []}
    if FC not in sys.path: sys.path.insert(0, FC)
    import moderate
    r = moderate.check(body.get("text") or "", imgs, body.get("look") or "cartoon", body.get("kind") or "clip")
    r["drift"] = []
    return r

def run_last_frame(body):
    """POST /last_frame {"video", "out_png"}: the clip's last decodable frame as a PNG. The frame count in the header
    can be off by a frame or two, so the last few frames are read through and the last one that decodes is kept."""
    for k in ("video", "out_png"):
        if not body.get(k): raise ValueError(f"{k} is required")
    if not os.path.exists(body["video"]): raise FileNotFoundError(body["video"])
    import cv2
    cap = cv2.VideoCapture(body["video"])
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if n > 5: cap.set(cv2.CAP_PROP_POS_FRAMES, n - 5)
    last = None
    while True:
        ok, f = cap.read()
        if not ok: break
        last = f
    if last is None and n > 5:          # seeking failed on this file: read it all
        cap.release(); cap = cv2.VideoCapture(body["video"])
        while True:
            ok, f = cap.read()
            if not ok: break
            last = f
    cap.release()
    if last is None: raise ValueError("no frame could be read from the clip")
    os.makedirs(os.path.dirname(os.path.abspath(body["out_png"])), exist_ok=True)
    cv2.imwrite(body["out_png"], last)
    return {"verdict": "PASS", "frames": n, "size": [int(last.shape[1]), int(last.shape[0])], "drift": []}

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj, default=str).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _authed(self):
        return TOKEN and self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def do_GET(self):
        if self.path == "/health": return self._send(200, {"ok": True, "mode": MODE, "frame_check": FC})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/check", "/motion_check", "/end_frame", "/compose", "/last_frame", "/cutouts", "/height", "/reposition_fit", "/still_check", "/moderate"): return self._send(404, {"error": "not found"})
        if not self._authed(): return self._send(401, {"error": "unauthorized"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "bad json"})
        if self.path in ("/end_frame", "/compose", "/last_frame", "/cutouts", "/height", "/reposition_fit", "/still_check", "/moderate"):
            try:
                r = {"/end_frame": run_end_frame, "/compose": run_compose, "/last_frame": run_last_frame,
                     "/cutouts": run_cutouts, "/height": run_height, "/reposition_fit": run_reposition_fit, "/still_check": run_still_check,
                     "/moderate": run_moderate}[self.path](body)
                name = body.get("end") or body.get("edited") or body.get("video") or body.get("image") or body.get("still") or ""
                print(f"[{self.path[1:]}] {os.path.basename(name)}: {r['verdict']} ({len(r.get('drift', []))} drift)", flush=True)
                return self._send(200, r)
            except (ValueError, FileNotFoundError) as e:
                return self._send(400, {"verdict": "ERROR", "error": f"{type(e).__name__}: {e}"})
            except (Exception, SystemExit) as e:
                traceback.print_exc()
                return self._send(500, {"verdict": "ERROR", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        if self.path == "/motion_check":
            with SLOTS:
                try:
                    r = run_motion_check(body)
                    print(f"[motion_check] {os.path.basename(body.get('render', ''))}: {r['verdict']} (${r.get('usd', 0):.3f})", flush=True)
                    return self._send(200, r)
                except (ValueError, FileNotFoundError) as e:
                    return self._send(400, {"verdict": "ERROR", "error": f"{type(e).__name__}: {e}"})
                except (Exception, SystemExit) as e:
                    traceback.print_exc()
                    return self._send(500, {"verdict": "ERROR", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        with SLOTS:
            try:
                r = run_check(body)
                print(f"[check] {body.get('generation_id')}: {r['verdict']} "
                      f"(${r.get('review_usd', 0) + r.get('verify_usd', 0) + r.get('action_usd', 0) + r.get('passthrough_usd', 0) + r.get('height_usd', 0):.3f})", flush=True)
                self._send(200, r)
            except (ValueError, FileNotFoundError) as e:
                self._send(400, {"verdict": "ERROR", "error": f"{type(e).__name__}: {e}"})
            except (Exception, SystemExit) as e:
                traceback.print_exc()
                self._send(500, {"verdict": "ERROR", "error": f"{type(e).__name__}: {str(e)[:300]}"})

    def log_message(self, *a): pass

def main():
    if not TOKEN: sys.exit("no CHECKER_TOKEN: put CHECKER_TOKEN=<long random string> in worker\\.env (see README)")
    host = os.environ.get("CHECKER_HOST", "127.0.0.1"); port = int(os.environ.get("CHECKER_PORT", "8787"))
    print(f"checker service on http://{host}:{port}  mode={MODE}  frame_check={FC}", flush=True)
    if MODE == "real" and not _real(os.environ.get("ANTHROPIC_API_KEY", "")):
        print("WARNING: no ANTHROPIC_API_KEY (environment or worker\\.env): the AI checks (clip review, heights, poses) "
              "cannot run - every clip will come back as an error for a person to review", flush=True)
    else:
        print("AI checks: key found", flush=True)
    print("leave this window open; Ctrl+C stops the service", flush=True)
    try:
        ThreadingHTTPServer((host, port), H).serve_forever()
    except KeyboardInterrupt:
        print("checker service stopped", flush=True)

if __name__ == "__main__":
    main()

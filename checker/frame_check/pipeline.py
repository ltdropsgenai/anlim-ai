"""pipeline.py - check ONE generated clip the way the benchmarks measured it, for the app's checker service. @anlim

The steps are batch_eval.py's per-clip flow (benchmark v8, 2026-11-11; default models 2026-11-12), in a function:
  1. code checks (shot_qc.run, with full-size frame export)          -> FAIL (code) stops here
  2. AI frame review of every exported frame (ai_review.cmd_api)       -> per-frame verdicts
  3. clip verdict: a rule FAILs the clip only in 2 consecutive frames (ai_review.clip_verdict)
  4. second opinion on an AI FAIL (ai_review.verify_fail)
  5. clip-level action check (action_check.analyze/apply)
Returns verdict PASS / FLAG / FAIL, or NOT_REVIEWED (the spec disagrees with the approved start frame, or the
estimate is over the clip's checking budget) - the app shows NOT_REVIEWED to the creator as "needs a look".

  from pipeline import check_clip
  r = check_clip(spec)      # spec as in shot_qc.py: clip, out, start_frame, action, cast, style, people, camera, ...

A change to the flow here must also be made in batch_eval.py (and the reverse); regress.py unit.pipeline_flow
checks the verdict mapping.
"""
import argparse, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ai_review

def _frame_flags(out, ver, man):
    """Frames the reviewer FAILed or was UNSURE about, with their time in the clip, for the review UI."""
    tim = {f["key"]: f.get("t") for f in man["frames"]}; flags = []
    for k, v in ver.items():
        verdict = (v.get("verdict") or "").upper()
        if verdict not in ("FAIL", "UNSURE"): continue
        rules = sorted(r.upper() for r, x in (v.get("checks") or {}).items() if ai_review.norm(x) in ("FAIL", "UNSURE"))
        note = "; ".join(i.get("note", "") for i in v.get("issues", []) if i.get("note"))[:300]
        flags.append({"t_s": tim.get(k), "frame": k, "verdict": verdict, "rules": rules, "note": note})
    return sorted(flags, key=lambda f: (f["t_s"] is None, f["t_s"] or 0))

def check_clip(spec, review_model=None, verify_model=None, action_model=None, thinking=None,
               max_usd=0.15, stop_after=3, workers=4, confirmed_spec=False, log=None):
    """confirmed_spec=True: a person confirmed the cast against the approved start frame (the app: the creator
    approves the still together with the shot's cast list), so the detector head-count check does not block the
    review. Phase 0 S1 (2026-11-12): the detector counted 1 child on a 2-child cartoon still."""
    import shot_qc
    review_model = review_model or ai_review.DEFAULTS["review_model"]
    verify_model = verify_model or ai_review.DEFAULTS["verify_model"]
    action_model = action_model or ai_review.DEFAULTS["action_model"]
    if thinking is None: thinking = ai_review.DEFAULT_THINKING.get(review_model)
    spec = dict(spec); spec.setdefault("frame_check", {}); spec.pop("ai_review", None)   # the AI steps run here, not in shot_qc
    out = spec["out"]
    res = {"verdict": None, "reasons": [], "flags": [], "frame_flags": [], "review_usd": 0.0, "verify_usd": 0.0,
           "action_usd": 0.0, "models": {"review": review_model, "thinking": thinking, "verify": verify_model,
                                          "action": action_model}, "action": None}
    q = shot_qc.run(spec, log=log)
    res["code"] = {"verdict": q["verdict"], "evidence": q["evidence"], "notes": q["notes"]}
    if q["verdict"] == "FAIL":
        res["verdict"] = "FAIL"; res["stage"] = "code"
        res["reasons"] = [f"{g}: {e}" for g, ev in q["evidence"].items() for e in ev[:2]]
        return res
    n, _, est = ai_review.estimate(out, "flagged", 4.0, review_model)
    if est > max_usd:
        res.update(verdict="NOT_REVIEWED", stage="budget", reasons=[f"review estimate ${est:.2f} is over the ${max_usd:.2f} per-clip budget"])
        return res
    usd = ai_review.cmd_api(argparse.Namespace(dir=out, rules=None, only="flagged", model=review_model, price=4.0, yes=True,
                                               effort=None, thinking=thinking, stop_after=stop_after, workers=workers,
                                               verdicts="verdicts.jsonl", force=bool(confirmed_spec)))
    if usd is None:
        res.update(verdict="NOT_REVIEWED", stage="spec", reasons=["the shot spec disagrees with the approved start frame"])
        return res
    res["review_usd"] = round(usd, 4)
    ver = ai_review.cmd_apply(argparse.Namespace(dir=out, flags=None, rules=None, verdicts="verdicts.jsonl"))
    man = json.load(open(os.path.join(out, "manifest.json"), encoding="utf-8"))
    cv, rf, rg = ai_review.clip_verdict(man, ver, ai_review.code_camera_ok(out), ai_review.spec_text_forbidden(out))
    if cv == "FAIL":
        cv, rf, dropped, vusd = ai_review.verify_fail(out, verify_model, log=log or (lambda *x: None))
        rg = rg + dropped; res["verify_usd"] = round(vusd, 4)
    ap_ = ai_review.ai_part(cv, rg, spec.get("style"))                # 2026-11-16: unconfirmed frame flags are notes, not a FLAG
    verdict = "FAIL (AI)" if ap_ == "FAIL" else ("FLAG" if ap_ == "FLAG" or q.get("flags") else "PASS")
    res["ai_notes"] = len(rg)
    reasons = rf + rg + q.get("flags", [])
    res["frame_flags"] = _frame_flags(out, ver, man)
    act = (spec.get("action") or "").strip()
    if act:
        import action_check
        try: ar = action_check.analyze(spec["clip"], act, out, action_model, use=spec.get("use"), log=log)
        except Exception as e: ar = {"verdict": "ERROR", "why": f"{type(e).__name__}: {str(e)[:150]}"}
        res["action_usd"] = round(ar.get("usd", 0) or 0, 4)
        res["action"] = {k: ar.get(k) for k in ("verdict", "confidence", "differs", "why")}
        newv, why_ = action_check.apply(verdict, ar)
        if why_: reasons = [why_] + reasons
        verdict = newv
    # Feet through or on furniture (passthrough_check, 2026-11-12: 4 of 4 walk-throughs caught, 0 of 13 good clips
    # flagged). FLAG only - a person looks - until there are more examples. Runs when the start frame shows furniture
    # or the action says someone moves (the detector missed the S4 sofa).
    if spec.get("passthrough", True) and spec.get("start_frame") and not verdict.startswith("FAIL"):
        import passthrough_check as PT
        try:
            furn = PT.furniture_in(spec["start_frame"], spec["clip"])
            if furn or PT.MOVES.search(act):
                pt = PT.analyze(spec["clip"], out, verify_model, start=spec["start_frame"], ask_always=True, log=log)
            else:
                pt = {"verdict": "NOT CHECKED", "why": "no furniture and no movement"}
        except Exception as e:
            pt = {"verdict": "ERROR", "why": f"{type(e).__name__}: {str(e)[:150]}"}
        res["passthrough_usd"] = round(pt.get("usd", 0) or 0, 4)
        res["passthrough"] = {k: pt.get(k) for k in ("verdict", "confidence", "events", "why")}
        new_v, why_, flags_ = PT.apply(verdict, pt)
        if why_: reasons = [why_] + reasons
        res["frame_flags"] = sorted(res["frame_flags"] + flags_, key=lambda f: (f["t_s"] is None, f["t_s"] or 0))
        verdict = new_v
    # Props that moved in the room (room_drift, 2026-11-16: the shelf toys in 4 of 9 bad MiniMax walks, never named by
    # the frame review; a sofa that grows or scoots in 3 bad sit clips). Code only, no API. Any locked-camera clip
    # (walking actions at 0.5 % of the frame, others at 1.0 %); FLAG only.
    if spec.get("room_drift", True) and not verdict.startswith("FAIL"):
        import room_drift as RD
        # cartoon only (photoreal streets have passers-by and traffic: 6 of 32 good SuperCool clips false-alarmed, walking
        # ones too); walking at 0.5 % of the frame, other actions at 1.0 %
        if RD.locked(spec.get("camera")) and (spec.get("style") or "").lower() == "cartoon":
            try: rd = RD.analyze(spec["clip"], out, log=log, walking=bool(RD.WALKING.search(act)))
            except Exception as e: rd = {"verdict": "ERROR", "why": f"{type(e).__name__}: {str(e)[:150]}"}
            res["room_drift"] = {k: rd.get(k) for k in ("verdict", "drift", "why")}
            new_v, why_, flags_ = RD.apply(verdict, rd)
            if why_: reasons = [why_] + reasons
            res["frame_flags"] = sorted(res["frame_flags"] + flags_, key=lambda f: (f["t_s"] is None, f["t_s"] or 0))
            verdict = new_v
    # Character heights at the end of the clip (height_check, 2026-11-16: 9/9 labelled stills; the S5 talking clip
    # ended with Layana and King the same height and was approved). spec["heights"]: [{name, height, ref}] from the
    # character cards; needs two or more. Standing pairs measured free, the rest one AI question (~$0.01). FLAG only.
    hs = [h for h in (spec.get("heights") or []) if h.get("height")]
    if spec.get("height_check", True) and len(hs) >= 2 and not verdict.startswith("FAIL"):
        import height_check as HC, end_frame as EF
        # the cast's kinds and the look pick the detector classes and the matting model (2026-11-17)
        look = "cartoon" if (spec.get("style") or "").lower() == "cartoon" else "photoreal"
        try:
            with EF.subjects(look, spec.get("subjects") or None):
                hr = HC.check_clip_end(spec["clip"], hs, out, log=log)
        except Exception as e: hr = {"verdict": "ERROR", "problems": [], "why": f"{type(e).__name__}: {str(e)[:150]}"}
        res["height_usd"] = round(hr.get("usd", 0) or 0, 4)
        res["height"] = {k: hr.get(k) for k in ("verdict", "problems", "notes", "measured", "end_t", "why")}
        new_v, why_, flags_ = HC.apply(verdict, hr)
        if why_: reasons = [why_] + reasons
        res["frame_flags"] = sorted(res["frame_flags"] + flags_, key=lambda f: (f["t_s"] is None, f["t_s"] or 0))
        verdict = new_v
    # Walking / moving clips are never passed automatically (2026-11-16, Londi: the two "moon-walking" Phase 0 clips,
    # feet sliding without stepping, "are unacceptable"). Nothing here can tell sliding feet from steps yet, and they
    # had only been held by unrelated frame flags. Both looks, any cast that moves across the floor. Until a foot-slide
    # check exists a person looks at the feet.
    import room_drift as RD
    walking = bool(RD.FEET_MOVE.search(spec.get("action") or "")) and spec.get("walk_guard", True)
    if verdict == "PASS" and walking:
        verdict = "FLAG (walk)"
        reasons = ["walking: the checker cannot yet tell sliding feet from real steps; watch the feet (each foot lifts "
                   "and lands, no gliding)"] + reasons
    # Foot-slide check (2026-11-17, MEASURING): only with FOOT_SLIDE_GATE=on, until its bench says how far to trust it.
    # A high-confidence "real steps" lifts the walk guard; SLIDE flags. About $0.05 a walking clip (Sonnet).
    if walking and os.environ.get("FOOT_SLIDE_GATE", "off") == "on" and not verdict.startswith(("FAIL", "NOT")):
        try:
            import foot_slide_check as FS
            fs = FS.analyze(spec["clip"], out, log=log)
            res["foot_slide"] = {k: fs.get(k) for k in ("verdict", "confidence", "events", "why", "usd")}
            res["action_usd"] = round(res.get("action_usd", 0.0) + (0 if fs.get("cached") else fs.get("usd", 0.0)), 4)
            new_v, why_, flags_ = FS.apply(verdict, fs, walking)
            res["frame_flags"] = sorted(res["frame_flags"] + flags_, key=lambda f: (f["t_s"] is None, f["t_s"] or 0))
            if new_v == "PASS" and verdict == "FLAG (walk)": reasons = [r for r in reasons if not r.startswith("walking:")]
            if why_: reasons = [why_] + reasons
            verdict = new_v
        except Exception as e:
            log and log(f"foot slide check skipped: {e}")
    res["verdict"] = "FAIL" if verdict.startswith("FAIL") else ("FLAG" if verdict.startswith("FLAG") else
                     ("PASS" if verdict == "PASS" else "NOT_REVIEWED"))
    res["stage"] = verdict; res["reasons"] = reasons[:20]
    return res

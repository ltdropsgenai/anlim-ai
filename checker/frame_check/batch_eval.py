"""batch_eval.py - score the whole QC pipeline against clips a person has already judged. @anlim

Every clip sits in a folder named for its human verdict (pass / minor / fail). For each clip this
writes a shot spec from the shot manifest (its own wording, nothing invented), runs shot_qc.py (free
code checks + full-size export), and, only when the code finds nothing, the AI review with early stop.
It then compares the pipeline's verdict with the human one.

  python batch_eval.py --clips DIR_WITH_pass_minor_fail --manifest shot_manifest.csv --stills FINALS_DIR
                       --bible CHARACTER_BIBLE_DIR --out EVAL_DIR [--model claude-haiku-5-5] [--max-usd 20]
                       [--workers 4] [--stop-after 3] [--only P003,P018] [--keep-frames]

Pipeline verdict per clip: FAIL (code) | FAIL (AI: 3+ frames FAIL) | FLAG (1-2 FAIL frames, a person
should look) | PASS (no FAIL frame). Resumes: clips already in results.csv are skipped. Stops before a clip
whose estimated cost would take the run past --max-usd. To save disk, exported PNGs of frames that came
back PASS are deleted after scoring (--keep-frames keeps everything).
Results: EVAL_DIR/results.csv and EVAL_DIR/summary.txt.
"""
import argparse, csv, glob, json, os, re, sys, time
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import shot_qc, ai_review

FIELDS = ["shot", "label", "pipeline", "code_gates_failed", "ai_fail_frames", "ai_unsure_frames", "ai_frames_sent",
          "usd", "top_reasons", "when", "action", "action_why", "room_drift"]

def bible_refs(bible):
    """C01 -> [master image], C04 -> [ref image] ... from folders named C0x..."""
    refs = {}
    for d in sorted(glob.glob(os.path.join(bible, "C0*"))):
        if not os.path.isdir(d): continue
        code = os.path.basename(d)[:3]
        pics = sorted(glob.glob(os.path.join(d, "*master*.png"))) or sorted(glob.glob(os.path.join(d, "*ref*.png")))
        if pics: refs[code] = pics[:1]
    return refs

def make_spec(row, clip, out, stills, refs):
    looks = row.get("looks", ""); codes = sorted(set(re.findall(r"C0\d", looks)))
    shot = row["placement"]; mode = (row.get("mode") or "").split()
    spec = {"shot_id": shot, "clip": clip, "out": out,
            "start_frame": os.path.join(stills, f"{shot}_final.jpg"),
            "min_duration": float(row["dur_s"]) if row.get("dur_s") else None,
            "size": "1344x768", "fps": 24,
            "camera": "locked" if mode and mode[0].upper() == "LOCKED" else None,
            "action": (row.get("action") or "") + " (wording from the shot manifest, unedited)",
            "cast": {c: "reference attached; exactly one of this person" for c in codes},
            "faces": {c: refs[c] for c in codes if c in refs},
            "frame_check": {}}
    if "extra" not in looks.lower(): spec["people"] = len(codes)   # extras: count unknown, not checked
    else: spec["cast"]["extras"] = "pedestrians or passers-by as in the approved start frame"
    return {k: v for k, v in spec.items() if v is not None}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips"); ap.add_argument("--manifest"); ap.add_argument("--stills")
    ap.add_argument("--bible"); ap.add_argument("--out", required=True)
    ap.add_argument("--cases", help="labelled cases JSON instead of the SuperCool folders: {\"cases\": [{\"shot\", \"label\": "
                    "pass|minor|fail|unscored, \"clip\", \"spec\": {...shot_qc spec without clip/out...}}]}")
    ap.add_argument("--model", default=ai_review.DEFAULTS["review_model"], help="frame reviewer (default Haiku 5.5, thinking off)")
    ap.add_argument("--max-usd", type=float, default=20.0)
    ap.add_argument("--workers", type=int, default=4); ap.add_argument("--stop-after", type=int, default=3)
    ap.add_argument("--only", default=""); ap.add_argument("--keep-frames", action="store_true")
    ap.add_argument("--no-verify", action="store_true", help="skip the second opinion on AI FAILs")
    ap.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"],
                    help="reviewer effort (output_config.effort; the model's default if absent: Sonnet 5.5 high, Haiku 5.5 medium)")
    ap.add_argument("--thinking", choices=["adaptive", "disabled", "between_tools"],
                    help="reviewer thinking type (default: the model's, which is on; billed as output)")
    ap.add_argument("--verify-model", default=ai_review.DEFAULTS["verify_model"], help="second opinion on AI FAILs (default Sonnet 5.5)")
    ap.add_argument("--action-model", default=ai_review.DEFAULTS["action_model"], help="action check (default Sonnet 5.5)")
    ap.add_argument("--room-drift", action="store_true", help="compute room_drift where no saved result exists (free, about "
                    "40 s a clip); without it only saved results are applied")
    ap.add_argument("--action-check", action="store_true", help="also run action_check.py on every clip (2 calls, about "
                    "$0.02 each with Sonnet; cached per clip). Recorded in the 'action' column and applied to the verdict "
                    "by action_check.apply (high-confidence FAIL fails the clip; other FAIL/FLAG flag it)")
    ap.add_argument("--offline", action="store_true", help="never call the API: saved verdicts and second opinions "
                    "only; a clip that would need a new review is scored NOT REVIEWED (offline). Used by regress.py")
    ap.add_argument("--tag", default="_v2", help="suffix of the rescore results files (default _v2)")
    ap.add_argument("--rereview", default="", help="shots whose saved AI verdicts are set aside and reviewed again "
                    "(after a prompt change); the old file is kept as verdicts_before<tag>.jsonl")
    ap.add_argument("--rescore", action="store_true", help="re-run the free checks with the current rules, reuse saved AI "
                    "verdicts, review only clips that now need it; writes results_v2.csv and summary_v2.txt")
    a = ap.parse_args()
    shot_qc.check_deps()
    if a.offline: os.environ.pop("ANTHROPIC_API_KEY", None)        # makes a paid call impossible in this process
    elif not os.environ.get("ANTHROPIC_API_KEY"): sys.exit("ANTHROPIC_API_KEY is not set (or use --rescore --offline)")
    if a.thinking is None: a.thinking = ai_review.DEFAULT_THINKING.get(a.model)
    if not a.offline:
        # an option the API refuses should cost a fraction of a cent here, not stop the run on its first frames
        for m_, e_, t_ in {(a.model, a.effort, a.thinking), (a.verify_model, None, None), (a.action_model, None, None)}:
            ok_, msg_ = ai_review.ping(m_, os.environ["ANTHROPIC_API_KEY"], e_, t_)
            print(f"preflight {msg_}")
            if not ok_: sys.exit("preflight failed: fix --model / --effort / --thinking before a paid run")
    os.makedirs(a.out, exist_ok=True)
    cases = None
    if a.cases:
        cases = {c["shot"]: c for c in json.load(open(a.cases, encoding="utf-8"))["cases"]}
        rows, refs = {}, {}
    else:
        if not (a.clips and a.manifest and a.stills and a.bible): sys.exit("give --cases, or --clips --manifest --stills --bible")
        rows = {r["placement"]: r for r in csv.DictReader(open(a.manifest, encoding="utf-8-sig"))}
        refs = bible_refs(a.bible)
    # Spec confirmations a person made (the app's "creator confirmed the head count"), per shot: e.g.
    # {"P038": {"confirmed": "the 2 people in the printed photo are not cast", "force_spec": true}}
    ov_path = os.path.join(a.out, "spec_confirmations.json")
    overrides = json.load(open(ov_path, encoding="utf-8")) if os.path.exists(ov_path) else {}
    clips = []
    if cases is not None:
        # paths in a cases file may be spelled for another machine: re-base them like shot_qc does
        clips = [(s_, c_["label"], shot_qc.localize(c_["clip"])) for s_, c_ in cases.items()]
        for s_, c_ in cases.items():
            if "ai_review" in c_.get("spec", {}): sys.exit(f"{s_}: remove 'ai_review' from the case spec - batch_eval runs the review itself (it would be paid twice)")
    for label in (() if cases is not None else ("pass", "minor", "fail")):
        for c in sorted(glob.glob(os.path.join(a.clips, label, "*.mp4"))):
            shot = os.path.basename(c)[:-4]
            if shot.split("_")[0] in rows: clips.append((shot, label, c))
    only = {x.strip() for x in a.only.split(",") if x.strip()}
    if only: clips = [c for c in clips if c[0] in only]
    tag = a.tag if a.rescore else ""
    rere = {x.strip() for x in a.rereview.split(",") if x.strip()}
    res_path = os.path.join(a.out, f"results{tag}.csv"); done = {}
    if os.path.exists(res_path):
        for r in csv.DictReader(open(res_path, encoding="utf-8")): done[r["shot"]] = r
    spent = sum(float(r["usd"] or 0) for r in done.values())
    print(f"{len(clips)} clips ({sum(1 for c in clips if c[0] in done)} already scored), ${spent:.2f} spent so far, cap ${a.max_usd:.2f}")
    new = not os.path.exists(res_path)
    # a results file from before a new column keeps its own header (extra columns are not written into it)
    fields = FIELDS if new else next(csv.reader(open(res_path, encoding="utf-8")))
    fh = open(res_path, "a", newline="", encoding="utf-8"); w = csv.DictWriter(fh, fields, extrasaction="ignore")
    if new: w.writeheader()
    missing = []
    for shot, label, clip in clips:
        if shot in done: continue
        if not os.path.exists(clip):
            # not recorded, so a later run scores it (Phase 0, 2026-11-11: one render still in progress would have
            # stopped a 47-clip run - shot_qc raises FileNotFoundError)
            print(f"\n=== {shot}: clip not on disk yet, skipped ({clip})"); missing.append(shot); continue
        out = os.path.join(a.out, shot)
        if cases is not None:
            spec = dict(cases[shot].get("spec", {}), shot_id=shot, clip=clip, out=out)
            spec.setdefault("frame_check", {})
        else:
            spec = make_spec(rows[shot.split("_")[0]], clip, out, a.stills, refs)
        if a.rescore and os.path.exists(os.path.join(out, "manifest.json")): spec.pop("frame_check", None)   # frames already exported
        if shot in rere and os.path.exists(os.path.join(out, "verdicts.jsonl")):
            os.replace(os.path.join(out, "verdicts.jsonl"), os.path.join(out, f"verdicts_before{tag}.jsonl"))
            # the saved second opinions answered the OLD verdicts; reusing them for a new review would carry old-spec
            # answers into the new result (found before the Keycard re-review, 2026-11-11)
            if os.path.exists(os.path.join(out, "ai_verify.json")):
                os.replace(os.path.join(out, "ai_verify.json"), os.path.join(out, f"ai_verify_before{tag}.json"))
            # frames a person or the review did not need were deleted after the last run (passed AND never-sent ones,
            # since the early stop): re-export when ANY is missing, not just the first (Keycard 2026-11-11: f0 was a kept
            # FAIL frame, f20 had been deleted -> crash in estimate)
            fr_ = json.load(open(os.path.join(out, "manifest.json")))["frames"]
            if any(not os.path.exists(os.path.join(out, f["out"])) for f in fr_):
                spec["frame_check"] = dict(spec.get("frame_check") or {})
        # Any clip that will be (re)reviewed needs all its frames on disk; earlier runs delete unneeded ones. Checked here
        # too, not only for --rereview: a run that crashed after setting the old verdicts aside has none left to re-review.
        mp_ = os.path.join(out, "manifest.json")
        if not a.offline and os.path.exists(mp_) and not os.path.exists(os.path.join(out, "verdicts.jsonl")):
            if any(not os.path.exists(os.path.join(out, f["out"])) for f in json.load(open(mp_))["frames"]):
                spec["frame_check"] = dict(spec.get("frame_check") or {})
        print(f"\n=== {shot} (human: {label})")
        q = shot_qc.run(spec, log=None)
        row = {"shot": shot, "label": label, "code_gates_failed": " ".join(g for g, ev in q["evidence"].items()),
               "ai_fail_frames": "", "ai_unsure_frames": "", "ai_frames_sent": 0, "usd": 0.0, "when": time.strftime("%Y-%m-%d %H:%M")}
        if q["verdict"] == "FAIL":
            row["pipeline"] = "FAIL (code)"
            row["top_reasons"] = " | ".join(e for ev in q["evidence"].values() for e in ev[:1])[:300]
        elif a.rescore and os.path.exists(os.path.join(out, "verdicts.jsonl")):
            man = json.load(open(os.path.join(out, "manifest.json"))); ver = ai_review.read_verdicts(out)
            cv, rf, rg = ai_review.clip_verdict(man, ver, ai_review.code_camera_ok(out), ai_review.spec_text_forbidden(out))
            vusd = 0.0
            if cv == "FAIL" and not a.no_verify:
                cv, rf, dropped, vusd = ai_review.verify_fail(out, a.verify_model); rg = rg + dropped; spent += vusd
            row.update(ai_fail_frames=sum(1 for v in ver.values() if (v.get("verdict") or "").upper() == "FAIL"),
                       ai_frames_sent=len(ver), usd=round(vusd, 4))
            ap_ = ai_review.ai_part(cv, rg, (cases[shot]["spec"] if cases is not None else spec).get("style")); row["pipeline"] = "FAIL (AI)" if ap_ == "FAIL" else ("FLAG" if ap_ == "FLAG" or q.get("flags") else "PASS")
            row["top_reasons"] = " | ".join(rf + rg + q.get("flags", []))[:300]
        elif a.offline:          # same answer a paid run would give when the spec check stops it; else "offline"
            ok_, msg_ = shot_qc.spec_vs_start(spec)
            if not ok_ and not overrides.get(shot, {}).get("force_spec"): row["pipeline"] = "NOT REVIEWED (spec check)"; row["top_reasons"] = "spec disagrees with the approved start frame"
            else: row["pipeline"] = "NOT REVIEWED (offline)"; row["top_reasons"] = "no saved AI verdicts; offline run does not call the API"
        else:
            if shot in overrides: print(f"spec confirmed by a person: {overrides[shot].get('confirmed', '')}")
            n, _, est = ai_review.estimate(out, "flagged", 4.0, a.model)
            if spent + est > a.max_usd:
                print(f"STOP: this clip's estimate ${est:.2f} would take the run past the ${a.max_usd:.2f} cap (spent ${spent:.2f})"); break
            try:
                usd = ai_review.cmd_api(argparse.Namespace(dir=out, rules=None, only="flagged", model=a.model, price=4.0, yes=True,
                                                           effort=a.effort, thinking=a.thinking,
                                                           stop_after=a.stop_after, workers=a.workers, verdicts="verdicts.jsonl",
                                                           force=bool(overrides.get(shot, {}).get("force_spec"))))
            except ai_review.ApiStopped as e:
                print(str(e)); break
            if usd is None:                               # spec check refused: no spend
                row["pipeline"] = "NOT REVIEWED (spec check)"; row["top_reasons"] = "spec disagrees with the approved start frame"
            else:
                spent += usd; row["usd"] = round(usd, 4)
                ver = ai_review.cmd_apply(argparse.Namespace(dir=out, flags=None, rules=None, verdicts="verdicts.jsonl"))
                fails = [k for k, v in ver.items() if (v.get("verdict") or "").upper() == "FAIL"]
                uns = [k for k, v in ver.items() if (v.get("verdict") or "").upper() == "UNSURE"]
                row.update(ai_fail_frames=len(fails), ai_unsure_frames=len(uns), ai_frames_sent=len(ver))
                man = json.load(open(os.path.join(out, "manifest.json")))
                cv, rf, rg = ai_review.clip_verdict(man, ver, ai_review.code_camera_ok(out), ai_review.spec_text_forbidden(out))
                if cv == "FAIL" and not a.no_verify:
                    cv, rf, dropped, vusd = ai_review.verify_fail(out, a.verify_model); rg = rg + dropped
                    spent += vusd; row["usd"] = round(float(row["usd"]) + vusd, 4)
                ap_ = ai_review.ai_part(cv, rg, (cases[shot]["spec"] if cases is not None else spec).get("style")); row["pipeline"] = "FAIL (AI)" if ap_ == "FAIL" else ("FLAG" if ap_ == "FLAG" or q.get("flags") else "PASS")
                row["top_reasons"] = " | ".join(rf + rg + q.get("flags", []))[:300]
                if not a.keep_frames:                     # keep only frames worth looking at
                    keep = {f"{k}" for k in fails + uns}
                    for f in man["frames"]:
                        if f["key"] not in keep:
                            try: os.remove(os.path.join(out, f["out"]))
                            except OSError: pass
        act_saved = os.path.join(out, "action_check.json")
        if a.action_check or os.path.exists(act_saved):
            # a saved action result is re-applied even without --action-check (free): Phase 0 2026-11-11, an offline
            # --rescore without the flag dropped S5_r3_gemini's action FLAG and turned the clip FLAG -> PASS
            import action_check
            act = (cases[shot]["spec"].get("action", "") if cases is not None else (rows[shot.split("_")[0]].get("action") or "")).strip()
            if not a.action_check:
                s_ = json.load(open(act_saved, encoding="utf-8"))
                ok_ = s_.get("action") == act and s_.get("compare_version", 1) == action_check.COMPARE_VERSION
                ar = dict(s_, cached=True) if ok_ else {"verdict": "NOT CHECKED", "why": "saved action check is for other "
                                                        "action text or an older comparison - run with --action-check"}
            elif spent + 0.05 > a.max_usd and not a.offline:
                ar = {"verdict": "NOT CHECKED", "why": f"spend cap ${a.max_usd:.2f} reached"}
                cached = os.path.join(out, "action_check.json")
                if os.path.exists(cached): ar = dict(json.load(open(cached, encoding="utf-8")), cached=True)
            else:
                try: ar = action_check.analyze(clip, act, out, a.action_model, log=None)
                except Exception as e:                  # one clip's problem must not stop the batch (P004, 2026-11-10)
                    ar = {"verdict": "ERROR", "why": f"{type(e).__name__}: {str(e)[:150]}"}
            if not ar.get("cached"): spent += ar.get("usd", 0); row["usd"] = round(float(row["usd"]) + ar.get("usd", 0), 4)
            row["action"] = ar["verdict"]; row["action_why"] = (ar.get("differs") or ar.get("why") or "")[:200]
            newv, why_ = action_check.apply(row["pipeline"], ar)           # in the verdict since 2026-11-11 (v8)
            if newv != row["pipeline"] or why_:
                row["pipeline"] = newv; row["top_reasons"] = (why_ + " | " + (row.get("top_reasons") or ""))[:300]
            print(f"    action check: {ar['verdict']} {('(' + ar.get('confidence', '') + ')') if ar.get('confidence') else ''} {row['action_why'][:150]}")
        # room drift (2026-11-16): as the pipeline, any locked-camera clip; from the saved result in out/room_drift when
        # there is one (free either way, but ~40 s a clip to compute: --room-drift computes the missing ones)
        import room_drift as RD
        spec_ = cases[shot]["spec"] if cases is not None else spec
        act_ = (spec_.get("action") or "")
        if not row["pipeline"].startswith(("FAIL", "NOT REVIEWED")) and RD.locked(spec_.get("camera")) and \
                (spec_.get("style") or "").lower() == "cartoon":
            have = os.path.exists(os.path.join(out, "room_drift", "room_drift.json"))
            if have or a.room_drift:
                try: rd = RD.analyze(clip, out, walking=bool(RD.WALKING.search(act_)))
                except Exception as e: rd = {"verdict": "ERROR", "why": str(e)[:150]}
                row["room_drift"] = rd.get("verdict")
                newv, why_, _ = RD.apply(row["pipeline"], rd)
                if why_: row["pipeline"] = newv; row["top_reasons"] = (why_ + " | " + (row.get("top_reasons") or ""))[:300]
            else:
                row["room_drift"] = "NOT CHECKED"
        # walk guard (2026-11-16, as pipeline.py): a moving clip is never passed automatically until a foot-slide check exists
        if row["pipeline"] == "PASS" and RD.FEET_MOVE.search(act_) and spec_.get("walk_guard", True):
            row["pipeline"] = "FLAG"
            row["top_reasons"] = ("walking: watch the feet (sliding vs stepping) | " + (row.get("top_reasons") or ""))[:300]
        print(f"--> {shot}: human {label}, pipeline {row['pipeline']}  (${float(row['usd']):.2f}; total ${spent:.2f})")
        w.writerow(row); fh.flush(); done[shot] = row
    fh.close()
    # summary
    rs = list(csv.DictReader(open(res_path, encoding="utf-8")))
    lines = [f"Scored {len(rs)} clips, ${sum(float(r['usd'] or 0) for r in rs):.2f} spent in this pass (review {a.model}, thinking {a.thinking or 'model default'}; second opinion {a.verify_model}; action {a.action_model})", ""]
    for lab in ("pass", "minor", "fail", "unscored"):
        sub = [r for r in rs if r["label"] == lab]
        if not sub: continue
        c = {}
        for r in sub: c[r["pipeline"]] = c.get(r["pipeline"], 0) + 1
        lines.append(f"human {lab:5s} ({len(sub)}): " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
    p_ = [r for r in rs if r["label"] == "pass"]; f_ = [r for r in rs if r["label"] == "fail"]
    if p_: lines.append(f"\nGood clips failed by the pipeline (false fails): {sum(1 for r in p_ if r['pipeline'].startswith('FAIL'))} of {len(p_)}"
                        f"; flagged for a look: {sum(1 for r in p_ if r['pipeline'] == 'FLAG')}")
    if p_: lines.append(f"Good clips passed with no one needing to look: {sum(1 for r in p_ if r['pipeline'] == 'PASS')} of {len(p_)}")
    if f_: lines.append(f"Bad clips caught (FAIL or FLAG): {sum(1 for r in f_ if r['pipeline'].startswith(('FAIL', 'FLAG')))} of {len(f_)}"
                        f"; failed automatically: {sum(1 for r in f_ if r['pipeline'].startswith('FAIL'))}"
                        f"; passed by mistake: {sum(1 for r in f_ if r['pipeline'] == 'PASS')}")
    if any(r.get("action") for r in rs):
        lines.append("\nAction check (applied to the verdict: high-confidence FAIL -> FAIL (action), other FAIL/FLAG -> FLAG):")
        for lab in ("pass", "minor", "fail"):
            sub = [r for r in rs if r["label"] == lab and r.get("action")]
            c = {}
            for r in sub: c[r["action"]] = c.get(r["action"], 0) + 1
            if sub: lines.append(f"  human {lab:5s} ({len(sub)}): " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
        newly = [r["shot"] for r in rs if r["label"] == "fail" and r.get("action") == "FAIL" and not r["pipeline"].startswith("FAIL")]
        false_ = [r["shot"] for r in rs if r["label"] == "pass" and r.get("action") == "FAIL"]
        lines.append(f"  if an action FAIL failed the clip: bad clips newly failed {newly or 'none'}; good clips wrongly failed {false_ or 'none'}")
    if missing: lines.append(f"\nNOT SCORED, clip not on disk: {', '.join(missing)} (run again once they are there)")
    lines.append(f"\nPer clip: results{tag}.csv (top_reasons says why).")
    if a.rescore and not a.cases: lines.append("NOTE: the rules were tuned on these same clips (2026-11-10), so these numbers are optimistic; "
                               "check them on clips the rules have not seen.")
    if a.cases: lines.append("Cases file: " + a.cases + " (labels and their sources are in it).")
    open(os.path.join(a.out, f"summary{tag}.txt"), "w", encoding="utf-8").write("\n".join(lines))
    print("\n" + "\n".join(lines))

if __name__ == "__main__":
    main()

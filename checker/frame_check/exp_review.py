"""exp_review.py - re-review the benchmarks with a cheaper reviewer setting and compare. PAID (capped). @anlim

Why: the AI review is the checker's main cost, and fewer frames lost bad clips (cost_sim.py, 2026-11-11: every 2nd
frame let P049 through). So each frame must get cheaper instead: a cheaper model (Haiku 5.5 is 20x cheaper per token
than Sonnet 5.5), less hidden thinking (thinking is on by default and billed as output), or both.

Each variant reviews the three benchmarks from scratch into _tests\\exp_<variant>\\<bench> (frames re-exported, code
checks re-run; the saved Sonnet results are not touched). The saved Sonnet action checks and the person's spec
confirmations are copied in, so the action check costs nothing and the comparison is about the frame review only.
Second opinions on AI FAILs use --verify-model (default Sonnet 5.5).

  python exp_review.py --variant haiku_med --model claude-haiku-5-5
  python exp_review.py --variant sonnet_low --model claude-sonnet-5-5 --effort low
  python exp_review.py --report haiku_med sonnet_low          (no API: compare finished variants with the baseline)

Cap: --max-usd per benchmark (default 6). batch_eval resumes, so a stopped run continues where it stopped.
"""
import argparse, csv, json, os, shutil, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))      # ...\vid_projects
T = os.path.join(HERE, "_tests")
MW = "music_projects/M_Ap_Rete_Mwen/04_video/work"
BENCH = {   # name: (baseline out dir, baseline results file, batch_eval inputs)
    "supercool": (os.path.join(T, "eval_supercool_2026-11-10"), "results_regress.csv",
                  ["--clips", os.path.join(ROOT, MW, "08_SUPERCOOL_CLIPS_2026-10-22"),
                   "--manifest", os.path.join(ROOT, MW, "05_BLOCKING_CAMERA_MAPS/shot_manifest_v1.csv"),
                   "--stills", os.path.join(ROOT, MW, "06_STORYBOARD_STILLS/v2_3D_checked/finals"),
                   "--bible", os.path.join(ROOT, MW, "03_CHARACTER_BIBLE")]),
    "keycard": (os.path.join(T, "eval_keycard_v4"), "results_regress.csv",
                ["--cases", os.path.join(T, "eval_keycard_v4/cases.json")]),
    "phase0": (os.path.normpath(os.path.join(ROOT, "_phase0/route_test_2026-11-11/qa")), "results_v8.csv",
               ["--cases", os.path.join(ROOT, "_phase0/route_test_2026-11-11/cases.json")]),
}

def kind(p):
    if p.startswith("FAIL"): return "FAIL"
    if p == "FLAG" or "spec check" in p: return "FLAG"
    if p == "PASS": return "PASS"
    return "UNKNOWN"

def last_review_usd(d):
    """USD of the LAST review run in this clip folder (api_usage.jsonl gains a line per run; a re-review appends)."""
    p = os.path.join(d, "api_usage.jsonl"); last = None
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            if line.strip(): last = json.loads(line)
    return (float(last.get("usd") or 0), last) if last else (0.0, None)

def verify_usd(d):
    p = os.path.join(d, "ai_verify.json")
    return float(json.load(open(p, encoding="utf-8")).get("usd") or 0) if os.path.exists(p) else 0.0

def frame_fails(d):
    p = os.path.join(d, "verdicts.jsonl"); out = {}
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            if line.strip():
                v = json.loads(line); out[v["key"]] = (v.get("verdict") or "").upper() == "FAIL"
    return out

def run(a):
    for name, (base, _, inputs) in BENCH.items():
        if a.bench and name not in a.bench: continue
        out = os.path.join(T, f"exp_{a.variant}", name); os.makedirs(out, exist_ok=True)
        if os.path.exists(os.path.join(base, "spec_confirmations.json")):
            shutil.copy(os.path.join(base, "spec_confirmations.json"), out)
        for shot in os.listdir(base):
            src = os.path.join(base, shot, "action_check.json")
            if os.path.isfile(src):
                os.makedirs(os.path.join(out, shot), exist_ok=True)
                if not os.path.exists(os.path.join(out, shot, "action_check.json")): shutil.copy(src, os.path.join(out, shot))
        cmd = [sys.executable, os.path.join(HERE, "batch_eval.py"), *inputs, "--out", out, "--model", a.model,
               "--verify-model", a.verify_model, "--max-usd", str(a.max_usd)]
        if a.effort: cmd += ["--effort", a.effort]
        if a.thinking: cmd += ["--thinking", a.thinking]
        print(f"\n##### {a.variant} / {name}: " + " ".join(cmd[1:3] + cmd[-8:]), flush=True)
        r = subprocess.run(cmd)
        if r.returncode: sys.exit(f"batch_eval stopped on {name} (exit {r.returncode}); fix and run again - it resumes")
    report(a.variant and [a.variant])

def summarize(rows):
    def c(lab, k): return sum(1 for r in rows if r["label"] == lab and kind(r["pipeline"]) == k)
    return {"good FAIL": c("pass", "FAIL"), "good FLAG": c("pass", "FLAG"), "good PASS": c("pass", "PASS"),
            "bad caught": sum(1 for r in rows if r["label"] == "fail" and kind(r["pipeline"]) in ("FAIL", "FLAG")),
            "bad of": sum(1 for r in rows if r["label"] == "fail"), "bad PASS": c("fail", "PASS"),
            "unknown": sum(1 for r in rows if kind(r["pipeline"]) == "UNKNOWN")}

def report(variants):
    for name, (base, resf, _) in BENCH.items():
        bp = os.path.join(base, resf)
        if not os.path.exists(bp): continue
        brows = {r["shot"]: r for r in csv.DictReader(open(bp, encoding="utf-8"))}
        cols = [("baseline", brows, base)]
        for v in variants:
            p = os.path.join(T, f"exp_{v}", name, "results.csv")
            if os.path.exists(p): cols.append((v, {r["shot"]: r for r in csv.DictReader(open(p, encoding="utf-8"))}, os.path.dirname(p)))
        print(f"\n=== {name}")
        print(f"{'':12s}{'clips':>6} {'review $':>9} {'verify $':>9} {'out tok/frame':>13} | {'good FAIL':>9} {'FLAG':>5} {'PASS':>5} | "
              f"{'bad caught':>10} {'PASS':>5} | unknown | frames: Sonnet FAIL missed / new FAIL")
        bff = {s: frame_fails(os.path.join(base, s)) for s in brows}
        for label, rows, d in cols:
            shots = [s for s in rows if s in brows]
            for s in shots: rows[s]["label"] = brows[s]["label"]          # the baseline file carries the merged labels
            rev = ver = 0.0; out_tok = frames = 0
            for s in shots:
                u, last = last_review_usd(os.path.join(d, s)); rev += u; ver += verify_usd(os.path.join(d, s))
                if last: out_tok += int(last.get("output_tokens") or 0); frames += int(last.get("frames") or 0)
            m = summarize([rows[s] for s in shots])
            miss = new = 0
            if label != "baseline":
                for s in shots:
                    vf = frame_fails(os.path.join(d, s))
                    for k, f in bff[s].items():
                        if k in vf:
                            miss += f and not vf[k]; new += vf[k] and not f
            print(f"{label:12s}{len(shots):>6} {rev:>9.2f} {ver:>9.2f} {(out_tok / frames if frames else 0):>13.0f} | "
                  f"{m['good FAIL']:>9} {m['good FLAG']:>5} {m['good PASS']:>5} | {m['bad caught']:>4} of {m['bad of']:<3} {m['bad PASS']:>5} | "
                  f"{m['unknown']:>7} | {'' if label == 'baseline' else f'{miss} / {new}'}")
            if label != "baseline":
                lost = [f"{s} ({rows[s]['label']}): {brows[s]['pipeline']} -> {rows[s]['pipeline']}" for s in shots
                        if rows[s]["label"] == "fail" and kind(rows[s]["pipeline"]) == "PASS"]
                if lost: print("            BAD CLIP PASSES: " + "; ".join(lost))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant"); ap.add_argument("--model", default="claude-haiku-5-5")
    ap.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--thinking", choices=["adaptive", "disabled", "between_tools"])
    ap.add_argument("--verify-model", default="claude-sonnet-5-5"); ap.add_argument("--max-usd", type=float, default=6.0)
    ap.add_argument("--bench", action="append", choices=list(BENCH)); ap.add_argument("--report", nargs="*")
    a = ap.parse_args()
    if a.report is not None: report(a.report); return
    if not a.variant: sys.exit("--variant NAME is required (or --report NAMES)")
    run(a)

if __name__ == "__main__":
    main()

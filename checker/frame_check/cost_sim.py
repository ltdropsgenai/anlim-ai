"""cost_sim.py - what would the checker have said with FEWER frames reviewed? Offline, $0, no API. @anlim

Why: the AI review is the checker's main cost (Phase 0 2026-11-11: $0.35 of a $0.83 Kling clip, 42%), and cost scales
with frames sent (each frame is one call: about 1,400 input tokens + 600-1,500 output tokens with Sonnet 5.5).
Every reviewed clip already has a verdict for each frame it sent (30 frames, every 4th video frame = 6 per second).
This tool keeps only every k-th of those frames, as if the clip had been exported at a lower rate, and re-runs the
real decision code on them - ai_review.clip_verdict, verify_fail (saved second opinions only), the code-check
result in shot_qc.json, and action_check.apply - then compares with the human labels.

  python cost_sim.py                                  (the three benchmarks, strides 1 2 3 4)
  python cost_sim.py --bench NAME=OUT_DIR=RESULTS.csv --stride 1,2,3,4,6

  OUT_DIR       a batch_eval --out folder (one sub-folder per clip, as batch_eval leaves them)
  RESULTS.csv   a results*.csv in it: its 'label' column is the human label and its 'pipeline' column is
                checked against stride 1 (they must agree, or the simulation is not faithful)

Limits (read before trusting a number):
  - A second opinion that was never asked (a rule that only FAILs at the new stride) cannot be asked offline: that
    rule stays FAIL, unverified - so a sparse stride can show MORE fails than a real run would. Counted as 'unverified'.
  - A clip's review stopped early once it FAILED; frames it never sent have no verdict and are skipped.
  - Cost is the clip's actual review cost x (frames kept / frames sent): the fixed cache part is small.
"""
import argparse, csv, json, os, shutil, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))      # ...\vid_projects

DEFAULT = [("supercool", r"_tools\frame_check\_tests\eval_supercool_2026-11-10", "results_regress.csv"),
           ("keycard", r"_tools\frame_check\_tests\eval_keycard_v4", "results_regress.csv"),
           ("phase0", r"_phase0\route_test_2026-11-11\qa", "results_v8.csv")]
COPY = ("manifest.json", "verdicts.jsonl", "shot_qc.json", "shot_spec.json", "ai_verify.json", "action_check.json")

def no_api():
    os.environ.pop("ANTHROPIC_API_KEY", None)
    import urllib.request
    def refuse(*a, **k): raise RuntimeError("cost_sim.py: an API call was attempted")
    urllib.request.urlopen = refuse

def kind(p):
    if p.startswith("FAIL"): return "FAIL"
    if p == "FLAG" or "spec check" in p: return "FLAG"
    if p == "PASS": return "PASS"
    return "UNKNOWN"

def review_usd(d):
    p = os.path.join(d, "api_usage.jsonl"); usd = 0.0
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            if line.strip(): usd += float(json.loads(line).get("usd") or 0)
    return usd

def simulate(src, k, row, tmp):
    """(pipeline, review_usd_estimate, frames_kept, unverified) for one clip folder at stride k."""
    import ai_review as A, action_check as AC
    q = json.load(open(os.path.join(src, "shot_qc.json"), encoding="utf-8")) if os.path.exists(os.path.join(src, "shot_qc.json")) else {}
    usd_all = review_usd(src)
    if q.get("verdict") == "FAIL": return row["pipeline"] if row["pipeline"].startswith("FAIL (code)") else "FAIL (code)", 0.0, 0, 0
    if not os.path.exists(os.path.join(src, "verdicts.jsonl")):
        return row["pipeline"], 0.0, 0, 0                          # NOT REVIEWED (spec check / offline): unchanged
    d = os.path.join(tmp, os.path.basename(src)); shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    for f in COPY:
        if os.path.exists(os.path.join(src, f)): shutil.copy(os.path.join(src, f), d)
    man = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))
    ver = A.read_verdicts(d)
    sent = [f for f in man["frames"] if f["key"] in ver]
    keep = [f for j, f in enumerate(man["frames"]) if j % k == 0]   # the lower export rate
    man["frames"] = keep
    kept = {f["key"] for f in keep}
    json.dump(man, open(os.path.join(d, "manifest.json"), "w", encoding="utf-8"))
    with open(os.path.join(d, "verdicts.jsonl"), "w", encoding="utf-8") as fh:
        for key, v in ver.items():
            if key in kept: fh.write(json.dumps(v) + "\n")
    for f in keep: open(os.path.join(d, f["out"]), "wb").close()   # verify_fail only checks the frame file exists
    ver2 = A.read_verdicts(d)
    cv, rf, rg = A.clip_verdict(man, ver2, A.code_camera_ok(d), A.spec_text_forbidden(d))
    unver = 0
    if cv == "FAIL":
        cv, rf, dropped, _ = A.verify_fail(d, log=None); rg = rg + dropped
        unver = sum(1 for line in rf if "NOT VERIFIED (offline)" in line or "kept unverified" in line)
    p = "FAIL (AI)" if cv == "FAIL" else ("FLAG" if cv == "FLAG" or q.get("flags") else "PASS")
    ap = os.path.join(src, "action_check.json")
    if os.path.exists(ap): p, _ = AC.apply(p, json.load(open(ap, encoding="utf-8")))
    n_sent = len(sent) or 1
    return p, usd_all * len(ver2) / n_sent, len(ver2), unver

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--bench", action="append", default=[])
    ap.add_argument("--stride", default="1,2,3,4"); ap.add_argument("--show", action="store_true", help="list every clip that changes")
    a = ap.parse_args(); no_api()
    benches = [tuple(b.split("=", 2)) for b in a.bench] or [(n, os.path.join(ROOT, o), r) for n, o, r in DEFAULT]
    strides = [int(x) for x in a.stride.split(",")]
    tmp = tempfile.mkdtemp(prefix="cost_sim_")
    print(f"strides {strides} = every {', '.join(str(4 * s) for s in strides)}th video frame "
          f"(about {', '.join(f'{24 / (4 * s):.1f}' for s in strides)} frames per second at 24 fps)")
    tot = {s: {"usd": 0.0} for s in strides}
    try:
        for name, out, res in benches:
            out = os.path.join(ROOT, out) if not os.path.isabs(out) else out
            rp = res if os.path.isabs(res) else os.path.join(out, res)
            if not os.path.exists(rp): print(f"\n{name}: {rp} not found - skipped"); continue
            rows = list(csv.DictReader(open(rp, encoding="utf-8")))
            print(f"\n=== {name}: {len(rows)} clips ({rp})")
            print(f"{'stride':>6} {'frames':>7} {'review $':>9} | {'good: FAIL':>10} {'FLAG':>5} {'PASS':>5} | "
                  f"{'minor: FAIL':>11} {'FLAG':>5} {'PASS':>5} | {'bad: caught':>11} {'FAIL':>5} {'PASS':>5} | unverified")
            base = {}
            for s in strides:
                res_s, usd, frames, unv = {}, 0.0, 0, 0
                for r in rows:
                    src = os.path.join(out, r["shot"])
                    if not os.path.isdir(src): res_s[r["shot"]] = r["pipeline"]; continue
                    p, u, n, uv = simulate(src, s, r, tmp)
                    res_s[r["shot"]] = p; usd += u; frames += n; unv += uv
                if s == strides[0]:
                    base = res_s
                    if s == 1:
                        bad = [f"{r['shot']}: saved {r['pipeline']} / simulated {res_s[r['shot']]}" for r in rows
                               if kind(r["pipeline"]) != kind(res_s[r["shot"]])]
                        print(("  stride 1 reproduces the saved results" if not bad else
                               "  WARNING stride 1 differs from the saved results:\n    " + "\n    ".join(bad)))
                tot[s]["usd"] += usd
                def cnt(lab, kk): return sum(1 for r in rows if r["label"] == lab and kind(res_s[r["shot"]]) == kk)
                caught = sum(1 for r in rows if r["label"] == "fail" and kind(res_s[r["shot"]]) in ("FAIL", "FLAG"))
                print(f"{s:>6} {frames:>7} {usd:>9.2f} | {cnt('pass','FAIL'):>10} {cnt('pass','FLAG'):>5} {cnt('pass','PASS'):>5} | "
                      f"{cnt('minor','FAIL'):>11} {cnt('minor','FLAG'):>5} {cnt('minor','PASS'):>5} | "
                      f"{caught:>5} of {sum(1 for r in rows if r['label'] == 'fail'):<3} {cnt('fail','FAIL'):>5} {cnt('fail','PASS'):>5} | {unv}")
                if s != strides[0]:
                    ch = [f"{r['shot']} ({r['label']}): {base[r['shot']]} -> {res_s[r['shot']]}" for r in rows
                          if kind(base[r["shot"]]) != kind(res_s[r["shot"]])]
                    lost = [c for c in ch if "(fail)" in c and c.endswith("PASS")]
                    if lost: print("         BAD CLIP NOW PASSES: " + "; ".join(lost))
                    if a.show and ch: print("         changed: " + "; ".join(ch))
        print("\nreview cost, all benchmarks: " + ", ".join(f"stride {s} ${tot[s]['usd']:.2f}" for s in strides))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    main()

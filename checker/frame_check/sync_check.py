"""sync_check.py - does a generated clip keep the source's timing? @anlim

Motion-transfer renders copy the driving video's cuts. When a clip is repaired by splicing in a short
re-render, frames get dropped or doubled at the join and everything after it runs ahead of (or behind)
the source, which shows when the episode cuts back to the real footage or plays them side by side.
EP18 (2026-11-10) found three such splices by hand: b1 2 frames ahead from f103, b3 1-2 frames from f58,
g 5 frames from f63. This finds them by comparing the cut times of the render with the source's.

  python sync_check.py RENDER.mp4 SOURCE.mp4 [--tol 0.9] [--json out.json]

Result per source cut: the render cut that matches it (within --search frames), the offset in render
frames (+ = the render cuts LATE, - = EARLY / runs ahead), and runs of consecutive cuts with the same
offset reported as "from fN the render runs K frames ahead". Also lists cuts that exist only in the
render (an invented cut, e.g. a close-up the source does not have) or only in the source (a missed cut).
"""
import argparse, json, os, subprocess, sys
import numpy as np

W, H = 96, 54

def gray_frames(p):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-vf", f"scale={W}:{H},format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    n = len(raw) // (W * H)
    return np.frombuffer(raw[:n * W * H], np.uint8).reshape(n, H, W).astype(np.float32)

def fps_of(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
                        "-of", "csv=p=0", p], capture_output=True, text=True).stdout.strip()
    a, b = (r.split("/") + ["1"])[:2]; return float(a) / float(b)

def find_cuts(G):
    """Same rule as frame_check.analyse: a big change that persists (3 frames later the picture is still
    nearer the new shot than any of the 3 frames before). Returns frame indices where the new shot starts."""
    n = len(G); d1 = np.array([0.0] + [np.abs(G[i] - G[i - 1]).mean() for i in range(1, n)])
    med = float(np.median(d1[1:])) + 1e-6; cuts = []
    for i in range(1, n - 3):
        if d1[i] > max(2.5 * med, 8.0):
            to_new = np.abs(G[i + 3] - G[i]).mean()
            to_old = min(np.abs(G[i + 3] - G[j]).mean() for j in range(max(0, i - 3), i))
            if to_new < 0.6 * to_old: cuts.append(i)
    return cuts

def guided_cut(d1, exp, search):
    """Strongest jump in the render near where a source cut should land: the frame within +-search whose
    change is largest relative to the typical change around it. A cartoon cut can be too similar in tone to
    pass the blind detector (EP18 b1: the render cut at f147 exactly on time, the blind detector missed it
    and paired the source cut with a reframe at f153). Returns (frame, strength) or (None, 0)."""
    n = len(d1); lo, hi = max(1, int(np.floor(exp - search))), min(n - 1, int(np.ceil(exp + search)))
    if hi <= lo: return None, 0.0
    cand = []
    for i in range(lo, hi + 1):
        ctx = np.concatenate([d1[max(1, i - 12):i], d1[i + 1:min(n, i + 13)]])
        if len(ctx) < 4: continue
        r = d1[i] / (float(np.median(ctx)) + 1.0)
        if d1[i] > 6.0 and r >= 3.0: cand.append((abs(i - exp), -r, i))
    if not cand: return None, 0.0
    _, r, i = min(cand)          # the NEAREST cut-like jump: fast action makes other big jumps nearby
    return i, -r

def classify(matched, tol=0.9, single=3.0):
    """Split matched cuts (dicts with "offset" in render frames, in time order) into drift runs and lone
    off cuts. Drift = 3+ consecutive cuts off by >= tol in the same direction, or 2+ when their median is
    2+ frames off. A lone cut 1-2 frames off is ordinary (30->24 fps rounding and cut detection; un-spliced
    EP18 renders had single cuts at +1.6 / -1.4); one 3+ frames off is reported alone. Calibrated
    2026-11-10 on EP18: rejected splices b1 (-2 x4 cuts), b3 (-1.2,-1.2,-1.8 from f58), g (-5 x5) -> drift;
    approved re-splices stay within +-0.8. Returns (runs, singles)."""
    runs, cur = [], []
    for p in matched:
        bad = abs(p["offset"]) >= tol
        if bad and cur and np.sign(cur[-1]["offset"]) == np.sign(p["offset"]): cur.append(p)
        else:
            if cur: runs.append(cur)
            cur = [p] if bad else []
    if cur: runs.append(cur)
    def is_drift(r): return len(r) >= 3 or (len(r) >= 2 and abs(float(np.median([p["offset"] for p in r]))) >= 2)
    singles = [p for r in runs if not is_drift(r) for p in r if abs(p["offset"]) >= single]
    return [r for r in runs if is_drift(r)], singles

def analyze(render, source, tol=0.9, search=8, start=0.0, log=print, single=3.0):
    """start: seconds into the source where the render begins (0 when the render was made from this frag)."""
    log = log or (lambda *a: None)
    rf, sf = fps_of(render), fps_of(source)
    GR = gray_frames(render); Rc, Sc = find_cuts(GR), find_cuts(gray_frames(source))
    d1 = np.array([0.0] + [np.abs(GR[i] - GR[i - 1]).mean() for i in range(1, len(GR))])
    pairs, used = [], set()
    for sc in Sc:
        exp = (sc / sf - start) * rf                      # where this cut should land in the render, in render frames
        if exp < 0 or exp > len(GR) - 1: continue
        rc, strength = guided_cut(d1, exp, search)
        if rc is None: pairs.append({"src_frame": sc, "src_t": round(sc / sf, 3), "expected": round(exp, 2), "render_frame": None}); continue
        used.update(range(rc - 1, rc + 2))
        pairs.append({"src_frame": sc, "src_t": round(sc / sf, 3), "expected": round(exp, 2), "render_frame": rc,
                      "offset": round(rc - exp, 2), "strength": round(strength, 1)})
    extra = [rc for rc in Rc if rc not in used]
    issues = []
    matched = [p for p in pairs if p.get("render_frame") is not None]
    runs, singles = classify(matched, tol, single)
    for p in singles:
        f0 = p["render_frame"]
        issues.append({"kind": "cut_off", "from_frame": f0, "t": round(f0 / rf, 3), "offset_frames": p["offset"],
                       "text": f"one cut off: the render cuts at f{f0} ({f0 / rf:.2f} s), {abs(p['offset']):.0f} frame(s) "
                               f"{'early' if p['offset'] < 0 else 'late'} against the source"})
    for run in runs:
        off = float(np.median([p["offset"] for p in run])); f0 = run[0]["render_frame"]
        where = "runs %.0f frame(s) AHEAD of the source (cuts early)" % -off if off < 0 else "runs %.0f frame(s) BEHIND the source (cuts late)" % off
        issues.append({"kind": "drift", "from_frame": f0, "t": round(f0 / rf, 3), "offset_frames": round(off, 1),
                       "cuts": len(run), "text": f"from f{f0} ({f0 / rf:.2f} s) the render {where}, over {len(run)} cut(s)"})
    for p in pairs:
        if p.get("render_frame") is None:
            issues.append({"kind": "missing_cut", "t": round(p["expected"] / rf, 3),
                           "text": f"source cut at {p['src_t']:.2f} s has no matching cut in the render (within {search} frames)"})
    for rc in extra:
        issues.append({"kind": "extra_cut", "from_frame": rc, "t": round(rc / rf, 3),
                       "text": f"render cuts at f{rc} ({rc / rf:.2f} s) where the source does not"})
    ok_cuts = sum(1 for p in matched if abs(p["offset"]) < tol)
    res = {"render": os.path.basename(render), "source": os.path.basename(source), "render_fps": rf, "source_fps": sf,
           "render_cuts": Rc, "source_cuts": Sc, "pairs": pairs, "issues": issues,
           "verdict": "FAIL" if any(i["kind"] == "drift" for i in issues) else ("FLAG" if any(i["kind"] == "cut_off" for i in issues) else "PASS"),
           "summary": f"{ok_cuts} of {len(pairs)} source cuts matched within {tol} frames; {len(issues)} issue(s)"}
    log(f"sync {res['render']} vs {res['source']}: {res['summary']} -> {res['verdict']}")
    for i in issues: log("  " + i["text"])
    return res

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("render"); ap.add_argument("source")
    ap.add_argument("--tol", type=float, default=0.9, help="offset in render frames that counts toward drift")
    ap.add_argument("--search", type=int, default=8); ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--json")
    a = ap.parse_args()
    res = analyze(a.render, a.source, a.tol, a.search, a.start)
    if a.json: json.dump(res, open(a.json, "w", encoding="utf-8"), indent=1)
    sys.exit(1 if res["verdict"] == "FAIL" else 0)

if __name__ == "__main__":
    main()

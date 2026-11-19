"""repair_plan.py - the cheapest way to fix a failed render, then build and check the fix. @anlim

Encodes how EP18 (Name That Fight, 2026-11-10) was actually repaired, from its render log:
  - a problem outside the seconds the edit uses is IGNORED              (b1 v3 swap at 2.3-3.8 s, edit used 4-12 s)
  - a bad tail the edit does not need is TRIMMED                        (pr_g to 11.25 s, b3 to 11.2 s, pr_b1 to 7.9 s)
  - a small part wrong on a few frames is a PIXEL EDIT on its box       (b2 third hand f181-f183, g pouch f63-f66,
                                                                          collar recoloured f232-f236; 0.25 cr/frame)
  - anything else is a SHORT RE-RENDER of a ~3 s piece of the source,   (shotD/E/F/G/H/I: 3 s fragments, start frame
    starting at the cut before the problem, spliced back in              = the render's own frame at the in-point)
  - several re-renders covering most of the used part = one FULL RE-RENDER
Motion transfer bills about 7 credits/s (log: 28 for 3-4 s, 84 for 12 s); the re-render has a 3 s minimum.

Splicing dropped or doubled frames at the joins (b1 2 frames ahead from f103, b3 1-2 from f58, g 5 from f63) and
the fix was to hold a frame ("test f12 held x3"). `build` splices frame-exactly, then runs sync_check against the
source and holds or drops frames at the out-join until the cuts line up again.

  python repair_plan.py plan  RENDER.mp4 --defects defects.json [--source FRAG.mp4] [--use 4.0-12.0]
  python repair_plan.py from-review QA_DIR [--out defects.json]        defects from ai_review verdicts
  python repair_plan.py build RENDER.mp4 PATCH.mp4 --replace 90-104 [--patch-from 0] --out OUT.mp4 [--source FRAG.mp4]

defects.json: [{"from": 181, "to": 183, "rule": "ANATOMY", "note": "third hand at her belt", "box": [0.4,0.5,0.5,0.6]}, ...]
(frames of the render; box optional, fractions x0,y0,x1,y1; "kind": "role_swap" / "sync" also accepted)
"""
import argparse, json, os, re, subprocess, sys, tempfile
import numpy as np
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

COST = {"rerender_per_s": 7.0, "rerender_min_s": 3.0, "rerender_max_s": 5.0, "edit_per_frame": 0.25}
EDITABLE_RULES = {"WARDROBE", "PROPS", "NO MATERIALISING", "IMAGE QUALITY", "TEXT", "FIXED DETAILS", "LIGHTING"}
SMALL_PART = re.compile(r"\b(extra|third|additional|second|duplicate|stray|floating|pouch|holster|collar|smudge|recolou?r)", re.I)
MAX_EDIT_FRAMES = 6          # EP18 pixel edits were 3-5 frames
MAX_EDIT_AREA = 0.15         # box share of the frame
LEAD_CUT_S = 1.5             # use the cut before the problem as the in-point if it is this close
TAIL_CUT_S = 2.0             # end the patch on the next cut if it is this close (the join then hides in the cut)
MERGE_GAP_S = 1.0            # two re-renders closer than this become one

def probe(p):
    from fc_common import probe as pr
    return pr(p)

def render_cuts(path):
    import sync_check
    return sync_check.find_cuts(sync_check.gray_frames(path))

def kind_of(d):
    if d.get("kind") in ("role_swap", "sync"): return d["kind"]
    r = (d.get("rule") or "").upper()
    if "ROLE" in r or "SWAP" in (d.get("note") or "").upper(): return "role_swap"
    return r or "UNKNOWN"

def editable(d):
    """A pixel edit fixes a small wrong PART on a few frames, not a wrong action, person or pose."""
    n = d["to"] - d["from"] + 1
    if n > MAX_EDIT_FRAMES: return False, f"{n} frames (pixel edits stay at {MAX_EDIT_FRAMES} or fewer)"
    b = d.get("box")
    if b and (b[2] - b[0]) * (b[3] - b[1]) > MAX_EDIT_AREA: return False, "the wrong area is too large for an edit"
    k = kind_of(d)
    if k in EDITABLE_RULES: return True, f"{k} on {n} frame(s)"
    if k == "ANATOMY" and SMALL_PART.search(d.get("note") or ""): return True, f"a stray body part on {n} frame(s)"
    return False, f"{k} is an action/person problem, not a part"

def plan(defects, n_frames, fps, cuts, use=None, cost=COST):
    """defects: list of {"from","to",...} in render frames. cuts: render frames where a new shot starts.
    Returns {"actions": [...], "total_credits": x, "notes": [...]}."""
    use_f = (int(round(use[0] * fps)), min(n_frames - 1, int(round(use[1] * fps)))) if use else (0, n_frames - 1)
    acts, notes = [], []
    for d in sorted(defects, key=lambda x: x["from"]):
        a, b = int(d["from"]), int(d["to"]); k = kind_of(d)
        base = {"frames": [a, b], "seconds": [round(a / fps, 2), round((b + 1) / fps, 2)], "problem": f"{k}: {d.get('note', '')}".strip(": ")}
        if b < use_f[0] or a > use_f[1]:
            acts.append(dict(base, action="ignore", why="outside the part the edit uses", credits=0.0)); continue
        if k == "sync":
            acts.append(dict(base, action="retime", why="frames dropped/doubled at a join: hold or drop frames (build does this)", credits=0.0)); continue
        if not use and b >= n_frames - 1 - int(1.0 * fps) and a >= n_frames - int(1.0 * fps):
            acts.append(dict(base, action="trim", why=f"only the last second: end the clip at {a / fps:.2f} s if the edit does not need the tail",
                             trim_to_s=round(a / fps, 3), credits=0.0)); continue
        ok, why = editable(d)
        if ok:
            acts.append(dict(base, action="pixel_edit", why=why, box=d.get("box"),
                             credits=round((b - a + 1) * cost["edit_per_frame"], 2))); continue
        acts.append(dict(base, action="rerender", why=why))
    # merge re-renders that are close, then place in/out points on cuts
    rr = [x for x in acts if x["action"] == "rerender"]; rest = [x for x in acts if x["action"] != "rerender"]
    merged = []
    for x in rr:
        if merged and x["frames"][0] - merged[-1]["frames"][1] <= MERGE_GAP_S * fps:
            m = merged[-1]; m["frames"][1] = max(m["frames"][1], x["frames"][1]); m["problem"] += " + " + x["problem"]
        else: merged.append(dict(x, frames=list(x["frames"])))
    for m in merged:
        a, b = m["frames"]
        before = [c for c in cuts if c <= a and a - c <= LEAD_CUT_S * fps]
        s = max(before) if before else max(0, a - 6)
        after = [c for c in cuts if c > b and c - b <= TAIL_CUT_S * fps]
        e = min(after) if after else min(n_frames, b + 7)
        need_s = (e - s) / fps
        length = min(max(cost["rerender_min_s"], round(need_s + 0.25, 2)), max(cost["rerender_max_s"], need_s + 0.25))
        m.update(replace=[s, e - 1], in_point=("cut" if before else "6 frames before"), out_point=("cut" if after else "6 frames after"),
                 fragment_start_s=round(s / fps, 3), fragment_len_s=round(length, 2),
                 start_frame=f"render frame {s} (the first frame being replaced; check it is clean)",
                 credits=round(max(cost["rerender_min_s"], length) * cost["rerender_per_s"], 1),
                 seconds=[round(s / fps, 2), round(e / fps, 2)])
    used_s = (use_f[1] - use_f[0] + 1) / fps; rr_s = sum((m["replace"][1] - m["replace"][0] + 1) / fps for m in merged)
    if merged and rr_s > 0.5 * used_s:
        full = {"action": "full_rerender", "frames": [use_f[0], use_f[1]], "seconds": [round(use_f[0] / fps, 2), round((use_f[1] + 1) / fps, 2)],
                "why": f"re-renders would cover {rr_s:.1f} of the {used_s:.1f} s used", "problem": " + ".join(m["problem"] for m in merged),
                "credits": round(max(cost["rerender_min_s"], n_frames / fps) * cost["rerender_per_s"], 1)}
        merged = [full]
    acts = sorted(rest + merged, key=lambda x: x["frames"][0])
    tot = round(sum(x["credits"] for x in acts), 2)
    full_cost = round(max(cost["rerender_min_s"], n_frames / fps) * cost["rerender_per_s"], 1)
    notes.append(f"plan {tot} credits vs {full_cost} for re-rendering the whole clip")
    if any(x["action"] in ("rerender", "full_rerender") for x in acts):
        notes.append("after splicing, build runs sync_check against the source and holds/drops frames at the join")
    return {"actions": acts, "total_credits": tot, "full_rerender_credits": full_cost, "notes": notes}

def defects_from_review(d, gap=8):
    """Failed AI-review frames grouped per rule into frame ranges (frames up to `gap` apart join), with the union
    of the boxes the reviewer gave and its first note."""
    import ai_review as A
    man = A.load(d); ver = A.read_verdicts(d); idx = {f["key"]: f["i"] for f in man["frames"]}
    per = {}
    for k, v in ver.items():
        if k not in idx: continue
        for r, x in (v.get("checks") or {}).items():
            if A.norm(x) != "FAIL": continue
            iss = next((i for i in v.get("issues", []) if r.upper() in (i.get("rule") or "").upper()), {})
            per.setdefault(r.upper(), []).append((idx[k], iss.get("box"), iss.get("note", "")))
    out = []
    for r, xs in per.items():
        xs.sort(key=lambda z: z[0]); cur = None
        for i, box, note in xs:
            if cur and i - cur["to"] <= gap:
                cur["to"] = i
                if box and cur.get("box"): cur["box"] = [min(cur["box"][0], box[0]), min(cur["box"][1], box[1]), max(cur["box"][2], box[2]), max(cur["box"][3], box[3])]
            else:
                if cur: out.append(cur)
                cur = {"from": i, "to": i, "rule": r, "note": note, **({"box": box} if box else {})}
        if cur: out.append(cur)
    return sorted(out, key=lambda x: x["from"])

# ------------------------------------------------------------------ build: frame-exact splice + sync repair
def _seg(src, a, b, label, hold=0):
    """frames a..b (inclusive) of input `src`, optionally the last frame held `hold` extra times."""
    f = f"[{src}:v]trim=start_frame={a}:end_frame={b + 1},setpts=PTS-STARTPTS"
    if hold > 0: f += f",tpad=stop_mode=clone:stop={hold}"
    return f + f"[{label}]"

def splice(render, patch, replace, patch_from, out, n_patch=None, hold=0):
    """render[0:s] + patch[patch_from : patch_from + n_patch] + the last patch frame held `hold` more times
    + render[e+1:]. n_patch defaults to the replaced length (e-s+1). The patch is scaled to the render size.
    Returns the frame count written."""
    w, h, fps, dur = probe(render); n = int(round(dur * fps)); s, e = replace
    k = (e - s + 1) if n_patch is None else n_patch
    if k < 1: raise ValueError("splice needs at least one patch frame")
    parts, labels = [], []
    if s > 0: parts.append(_seg(0, 0, s - 1, "a")); labels.append("[a]")
    parts.append(f"[1:v]scale={w}:{h},fps={fps},trim=start_frame={patch_from}:end_frame={patch_from + k},setpts=PTS-STARTPTS"
                 + (f",tpad=stop_mode=clone:stop={hold}" if hold > 0 else "") + "[b]"); labels.append("[b]")
    if e + 1 < n: parts.append(_seg(0, e + 1, n - 1, "c")); labels.append("[c]")
    fc = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(labels)}:v=1:a=0,format=yuv420p[v]"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", render, "-i", patch, "-filter_complex", fc, "-map", "[v]",
                    "-r", str(fps), "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", out], check=True)
    return int(round(probe(out)[3] * fps))

def match_out_cut(render, patch, replace, patch_from, search=4):
    """When the render cuts right after the replaced range, end the patch on ITS OWN cut and hold/drop to land
    exactly on the render's cut. EP18 b1: the re-rendered kick cut 2 frames early (test f13 vs v5 f105); the
    accepted fix was test f0-11 + f12 held x3. Without this the patch's next shot leaks in before the render's.
    Returns (hold, drop, note)."""
    import sync_check
    s, e = replace; k = e - s + 1
    rc = sync_check.find_cuts(sync_check.gray_frames(render))
    if not any(abs(c - (e + 1)) <= 1 for c in rc): return 0, 0, "out-join is not on a cut"
    pc = [c for c in sync_check.find_cuts(sync_check.gray_frames(patch)) if abs(c - (patch_from + k)) <= search]
    if not pc: return 0, 0, "patch has no cut near the out-join"
    c = min(pc, key=lambda x: abs(x - (patch_from + k))); use = c - patch_from
    return (k - use, 0, f"patch cut at its f{c}: {use} patch frames + last held {k - use}") if use <= k else \
           (0, use - k, f"patch cut at its f{c}: {use - k} frame(s) late, dropped")

def build(render, patch, replace, patch_from, out, source=None, start=0.0, log=print, tries=3):
    """Splice, land the patch's own cut on the render's cut at the out-join (match_out_cut), then check the cuts
    after the join against the source and hold or drop frames at the END of the patch (where EP18's fixes
    went) until sync_check finds no drift after the join."""
    log = log or (lambda *a: None)
    k = replace[1] - replace[0] + 1
    h0, d0, mnote = match_out_cut(render, patch, replace, patch_from); hist = []
    n_patch = k - h0 - d0 if h0 else k            # patch frames up to its own cut; the rest is held
    base_hold = h0                                # drop d0: the patch cut late, take fewer frames (same n_patch rule)
    if d0: n_patch, base_hold = k, 0
    log(f"  out-join: {mnote}")
    adj = 0                                       # sync correction in frames: + hold more, - take fewer
    for t in range(tries):
        hold = base_hold + max(adj, 0); np_ = n_patch - max(-adj, 0)
        drop = k - np_ - base_hold if np_ + base_hold < k else 0
        nfr = splice(render, patch, replace, patch_from, out, np_, hold)
        if not source: return {"out": out, "frames": nfr, "hold": hold, "drop": drop, "out_join": mnote, "sync": "not checked (no source)"}
        import sync_check
        r = sync_check.analyze(out, source, start=start, log=None)
        after = [i for i in r["issues"] if i["kind"] in ("drift", "cut_off") and i.get("from_frame", 0) >= replace[0] - 2]
        drift = [i for i in after if i["kind"] == "drift"]
        hist.append({"hold": hold, "drop": drop, "frames": nfr, "verdict": r["verdict"], "after_join": [i["text"] for i in after]})
        log(f"  splice try {t + 1}: hold {hold}, drop {drop}, {nfr} frames -> sync {r['verdict']}" + (f" ({after[0]['text']})" if after else ""))
        if not drift: return {"out": out, "frames": nfr, "hold": hold, "drop": drop, "out_join": mnote, "sync": r["verdict"], "tries": hist}
        adj -= int(round(drift[0]["offset_frames"]))     # - = render ahead (cuts early) -> hold more; + = behind -> fewer
    return {"out": out, "frames": nfr, "hold": hold, "drop": drop, "sync": "STILL OUT OF SYNC", "tries": hist}

def apply_edits(render, edits, out, feather=0.15):
    """Put edited frames back into the clip ON THEIR BOX ONLY, as EP18 did ("gpt_image_2_6 edit composited on the
    pouch box only"). edits: [{"frame": 63, "image": "f63_edit.png", "box": [x0,y0,x1,y1] fractions}]. The box edge
    is feathered by `feather` of the box size so the patch does not show. Returns a report proving that nothing
    outside the boxes changed (max pixel change outside, per edited frame)."""
    import cv2
    w, h, fps, dur = probe(render)
    by = {int(e["frame"]): e for e in edits}
    tmp = tempfile.mkdtemp(prefix="edits_")
    subprocess.run(["ffmpeg", "-v", "error", "-i", render, os.path.join(tmp, "f%06d.png")], check=True)
    rep = []
    for i, e in sorted(by.items()):
        fp = os.path.join(tmp, f"f{i + 1:06d}.png"); orig = cv2.imread(fp)
        if orig is None: raise ValueError(f"frame {i} not in the clip")
        ed = cv2.imread(e["image"])
        if ed is None: raise ValueError(f"cannot read {e['image']}")
        ed = cv2.resize(ed, (w, h))
        x0, y0, x1, y1 = [int(round(v * s_)) for v, s_ in zip(e["box"], (w, h, w, h))]
        m = np.zeros((h, w), np.float32); m[y0:y1, x0:x1] = 1.0
        k = max(1, int(feather * min(x1 - x0, y1 - y0))) | 1
        m = cv2.GaussianBlur(m, (k * 2 + 1, k * 2 + 1), 0)          # soft edge across the box border
        m[:max(0, y0 - k), :] = 0; m[min(h, y1 + k):, :] = 0; m[:, :max(0, x0 - k)] = 0; m[:, min(w, x1 + k):] = 0
        res = (orig * (1 - m[..., None]) + ed * m[..., None]).round().astype(np.uint8)
        outside = np.ones((h, w), bool); outside[max(0, y0 - k):y1 + k, max(0, x0 - k):x1 + k] = False
        rep.append({"frame": i, "changed_inside": round(float(np.abs(res.astype(int) - orig)[~outside].mean()), 2),
                    "max_change_outside": int(np.abs(res.astype(int) - orig)[outside].max())})
        cv2.imwrite(fp, res)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(fps), "-i", os.path.join(tmp, "f%06d.png"),
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", out], check=True)
    import shutil; shutil.rmtree(tmp, ignore_errors=True)
    return {"out": out, "edited": rep, "outside_untouched": all(r["max_change_outside"] == 0 for r in rep)}

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan"); p.add_argument("render"); p.add_argument("--defects", required=True); p.add_argument("--use")
    p.add_argument("--json")
    r = sub.add_parser("from-review"); r.add_argument("dir"); r.add_argument("--out")
    b = sub.add_parser("build"); b.add_argument("render"); b.add_argument("patch"); b.add_argument("--replace", required=True)
    b.add_argument("--patch-from", type=int, default=0); b.add_argument("--out", required=True); b.add_argument("--source")
    b.add_argument("--start", type=float, default=0.0)
    a = ap.parse_args()
    if a.cmd == "plan":
        w, h, fps, dur = probe(a.render); n = int(round(dur * fps))
        use = [float(x) for x in a.use.split("-")] if a.use else None
        res = plan(json.load(open(a.defects)), n, fps, render_cuts(a.render), use)
        for x in res["actions"]:
            extra = f"  re-render {x['fragment_len_s']} s of source from {x['fragment_start_s']} s, replace f{x['replace'][0]}-f{x['replace'][1]}" if x["action"] == "rerender" else ""
            print(f"{x['action']:13s} f{x['frames'][0]}-f{x['frames'][1]} ({x['seconds'][0]}-{x['seconds'][1]} s)  {x['credits']} cr  {x['problem']}  [{x['why']}]{extra}")
        for nn in res["notes"]: print("note:", nn)
        if a.json: json.dump(res, open(a.json, "w"), indent=1)
    elif a.cmd == "from-review":
        res = defects_from_review(a.dir); print(json.dumps(res, indent=1))
        if a.out: json.dump(res, open(a.out, "w"), indent=1)
    else:
        s, e = [int(x) for x in a.replace.split("-")]
        res = build(a.render, a.patch, (s, e), a.patch_from, a.out, a.source, a.start)
        print(json.dumps({k: v for k, v in res.items() if k != "tries"}))

if __name__ == "__main__":
    main()

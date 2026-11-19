"""measure.py - height and body-build checks from clicked points. @anlim

Points come from the review viewer (press M: head-top, base, left and right shoulder edge per
character; download "flags + measures") and/or from AI verdict lines that carry a "measures" field.
Coordinates are fractions of the image (0-1); this script converts them to pixels at full size.

  python measure.py attach DIR --lineup lineup.json        # put the cast names into the viewer
  python measure.py report DIR --lineup lineup.json [--measures flags_<clip>.json] [--tol 0.03]

Checks:
- PAIR RATIO: two characters measured above the SAME shared line (base y within 2% of the image
  height) must have head-top heights in the lineup's range for that pair (or lineup height ratio +-5%).
  Feet-based pairs are reported but marked "depth unverified" when their feet are not level.
- BUILD: shoulder width / full height (feet-based only) inside the character's "build" range.
- DRIFT (video): the same character measured in 2+ frames of one shot must keep its height within
  --tol (default 0.03 = 3%), the Director lesson 21 rule.
- PROP SCALE: a prop measured as "prop:<name>" (top and bottom clicks) against its owner's head
  height (head-top to chin) must be in the lineup's "ratio_to_head" range. From the music-video
  backpack lesson (M_Ap_Rete_Mwen: backpack height about 2.0x head height). Lineup entry:
  "props": {"backpack": {"owner": "C01", "ratio_to_head": [1.8, 2.2]}}
  The prop and the owner must be at about the same distance from the camera (worn or held).
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import write_viewer

def load_measures(d, path):
    out = {}
    vp = os.path.join(d, "verdicts.jsonl")
    if os.path.exists(vp):                              # AI-supplied points first; human ones override
        for line in open(vp, encoding="utf-8"):
            line = line.strip()
            if line:
                v = json.loads(line)
                if v.get("measures"): out.setdefault(v["key"], {}).update(v["measures"])
    if path:
        for key, chars in (json.load(open(path)).get("measures") or {}).items():
            out.setdefault(str(key), {}).update(chars)
    return out

def size_of(d, man, f):
    if man.get("size"): return man["size"]
    from PIL import Image
    return list(Image.open(os.path.join(d, f["out"])).size)

def cmd_attach(a):
    man = json.load(open(os.path.join(a.dir, "manifest.json"))); man["lineup"] = json.load(open(a.lineup))
    write_viewer(man, a.dir); print("lineup attached:", ", ".join(man["lineup"].get("characters", {})))

def cmd_report(a):
    man = json.load(open(os.path.join(a.dir, "manifest.json"))); L = json.load(open(a.lineup)); man["lineup"] = L
    tol = a.tol if a.tol is not None else L.get("drift_tol", 0.03)
    chars = L.get("characters", {}); pairs = L.get("pairs", [])
    M = load_measures(a.dir, a.measures)
    lines = [f"# Height and build report: {man['clip']}", "", f"Lineup: {L.get('series', a.lineup)}  ·  drift tolerance {tol:.0%}", ""]
    rows = {}; flags = {}
    for f in man["frames"]:
        key = f.get("key") or str(f["i"]); m = M.get(key) or M.get(str(f["i"]))
        if not m: continue
        f["measures"] = m; W, H = size_of(a.dir, man, f); rows[key] = {}
        props = L.get("props", {})
        for c, p in m.items():
            if not (p.get("head") and p.get("base")): continue
            if c.startswith("prop:"):
                n = c[5:]; spec = props.get(n, {}); own = m.get(spec.get("owner", ""), {})
                pl = ((p["base"][0] - p["head"][0]) ** 2 * W * W + (p["base"][1] - p["head"][1]) ** 2 * H * H) ** 0.5
                r = {"prop": True, "len": pl}
                if own.get("head") and own.get("chin"):
                    hh = ((own["chin"][0] - own["head"][0]) ** 2 * W * W + (own["chin"][1] - own["head"][1]) ** 2 * H * H) ** 0.5
                    r["ratio"] = pl / hh; r["owner"] = spec["owner"]
                rows[key][c] = r; continue
            hp = abs(p["base"][1] - p["head"][1]) * H
            r = {"h": hp, "baseline": bool(p.get("baseline")), "base_y": p["base"][1] * H}
            if p.get("sl") and p.get("sr"):
                r["sw"] = ((p["sr"][0] - p["sl"][0]) ** 2 * W * W + (p["sr"][1] - p["sl"][1]) ** 2 * H * H) ** 0.5
                if not r["baseline"]: r["build"] = r["sw"] / hp
            rows[key][c] = r
        msgs = []
        R = rows[key]
        for c, r in list(R.items()):
            if r.get("prop") and "ratio" in r:
                lo, hi = L["props"][c[5:]]["ratio_to_head"]
                if not lo <= r["ratio"] <= hi:
                    msgs.append(f"PROP: {c[5:]} is {r['ratio']:.2f}x {r['owner']}'s head height, range {lo}-{hi}")
            elif r.get("prop"):
                msgs.append(f"PROP: {c[5:]} measured but its owner has no head-top and chin on this frame")
        R = {c: r for c, r in R.items() if not r.get("prop")}
        # pair ratios
        names = list(R)
        for i in range(len(names)):
            for j in range(i + 1, len(names)):          # each pair ONCE
                ca, cb = names[i], names[j]
                spec = next((q for q in pairs if q["a"] == ca and q["b"] == cb), None)
                rev = next((q for q in pairs if q["a"] == cb and q["b"] == ca), None)
                if rev and not spec: ca, cb, spec = cb, ca, rev    # use the stated orientation
                ra, rb = R[ca], R[cb]
                if spec: lo, hi = spec["range"]
                elif chars.get(ca, {}).get("height") and chars.get(cb, {}).get("height"):
                    e = chars[ca]["height"] / chars[cb]["height"]; lo, hi = e * 0.95, e * 1.05
                else: continue
                ratio = ra["h"] / rb["h"]
                same_line = abs(ra["base_y"] - rb["base_y"]) <= 0.02 * H
                note = "" if same_line else (" (depth unverified: bases not level)")
                ok = lo <= ratio <= hi
                lines_txt = f"{ca}/{cb} = {ratio:.3f}, target {lo:.2f}-{hi:.2f}{note}"
                if same_line and not ok: msgs.append("HEIGHT: " + lines_txt)
                rows[key].setdefault("_pairs", []).append(lines_txt + ("" if ok else "  <-- OUT"))
        # build
        for c, r in R.items():
            if c.startswith("_") or "build" not in r: continue
            br = chars.get(c, {}).get("build")
            if br and not (br[0] <= r["build"] <= br[1]): msgs.append(f"BUILD: {c} shoulder/height {r['build']:.3f}, range {br[0]}-{br[1]}")
        if msgs: flags[key] = msgs
    # drift within a shot (video)
    if man.get("kind") == "video":
        cuts = [0] + list(man.get("cuts", [])) + [10 ** 9]; byshot = {}
        for f in man["frames"]:
            key = f.get("key") or str(f["i"])
            if key not in rows: continue
            shot = max(c for c in cuts if c <= f["i"])
            for c, r in rows[key].items():
                if not c.startswith("_") and not r.get("prop"): byshot.setdefault((shot, c), []).append((f["i"], key, r["h"]))
        for (shot, c), pts in byshot.items():
            if len(pts) < 2: continue
            pts.sort(); h0 = pts[0][2]
            for i, key, h in pts[1:]:
                if abs(h - h0) / h0 > tol:
                    flags.setdefault(key, []).append(f"DRIFT: {c} height {h:.0f} px vs {h0:.0f} px at frame {pts[0][0]} in the same shot ({(h - h0) / h0:+.1%}); "
                                                     f"real only if the camera is locked and {c} stays at the same depth")
    for f in man["frames"]:
        key = f.get("key") or str(f["i"])
        f["why"] = [w for w in f.get("why", []) if not w.startswith(("HEIGHT:", "BUILD:", "DRIFT:", "PROP:"))] + flags.get(key, [])
    for key in rows:
        lines.append(f"## {key}")
        for c, r in rows[key].items():
            if c.startswith("_"): continue
            if r.get("prop"):
                lines.append(f"- {c}: {r['len']:.0f} px" + (f", {r['ratio']:.2f}x {r['owner']}'s head" if "ratio" in r else "")); continue
            s = f"- {c}: {r['h']:.0f} px {'above shared line' if r['baseline'] else 'tall'}"
            if "sw" in r: s += f", shoulders {r['sw']:.0f} px" + (f", build {r['build']:.3f}" if "build" in r else "")
            lines.append(s)
        for t in rows[key].get("_pairs", []): lines.append(f"- pair {t}")
        for t in flags.get(key, []): lines.append(f"- **{t}**")
        lines.append("")
    open(os.path.join(a.dir, "measure_report.md"), "w", encoding="utf-8").write("\n".join(lines))
    write_viewer(man, a.dir)
    print("\n".join(lines))

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("attach"); p.add_argument("dir"); p.add_argument("--lineup", required=True)
    p = sub.add_parser("report"); p.add_argument("dir"); p.add_argument("--lineup", required=True)
    p.add_argument("--measures"); p.add_argument("--tol", type=float)
    a = ap.parse_args(); {"attach": cmd_attach, "report": cmd_report}[a.cmd](a)

if __name__ == "__main__":
    main()

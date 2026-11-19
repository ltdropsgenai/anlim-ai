"""sequence_check.py - continuity across cuts, shot to shot. @anlim

KAMK audit, root cause 3: "QA compared each clip only to its own still - never to neighbouring shots."
This compares the LAST frame of each shot with the FIRST frame of the next, in edit order:
- SET (same camera setup only): room layout, scale, camera shift and missing fixtures vs the previous
  shot, using the set-plate comparison with the previous frame as the plate.
- SIDES (with --roles): characters' left/right order flips across the cut (180-degree rule; fine on a
  planned reverse angle, so it is a review flag, not a verdict).
- LOOK: lighting or colour-grade jump (average brightness and warmth) between the two frames.

  python sequence_check.py ITEM ITEM ... [--setups setups.json] [--roles roles.json] [--out DIR]
      [--look-thr 12]
ITEMs are clips (.mp4/.mov/.webm) or stills, in edit order. setups.json maps file names to camera
setup labels, e.g. {"S08a.mp4": "kitchen-wide", "S08b.mp4": "kitchen-wide", "S08c.mp4": "island-close"};
without it every cut is treated as a possible new setup (SET checks are reported but not flagged).
"""
import argparse, json, os, subprocess, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import plate_compare, write_viewer, locate_role, validate_roles

VID = (".mp4", ".mov", ".webm", ".mkv")

def frame_png(path, which, dst):
    if path.lower().endswith(VID):
        if which == "first":
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-frames:v", "1", dst], check=True)
        else:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.25", "-i", path, "-update", "1", dst], check=True)
    else:
        from PIL import Image; Image.open(path).convert("RGB").save(dst)
    return dst

def rgb(p):
    from PIL import Image
    im = Image.open(p).convert("RGB"); w = 320; im = im.resize((w, int(im.height * w / im.width)))
    return np.asarray(im)

def sides(a, roles, notes):
    out = {}
    for r in roles:
        loc = locate_role(a, r)
        if isinstance(loc, str): notes.append(f"{r['name']}: {loc}")
        else: out[r["name"]] = loc[0]
    return out

def look(a):
    f = a.astype(np.float32); bright = float(f.mean()); warm = float((f[..., 0] - f[..., 2]).mean())
    return bright, warm

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("items", nargs="+"); ap.add_argument("--setups"); ap.add_argument("--roles")
    ap.add_argument("--out"); ap.add_argument("--look-thr", type=float, default=12.0); ap.add_argument("--name", default="sequence")
    ap.add_argument("--plate", help="EMPTY set plate, used to check the role colours are unique to the characters")
    a = ap.parse_args()
    setups = json.load(open(a.setups)) if a.setups else {}
    roles = json.load(open(a.roles)) if a.roles else []
    role_msgs = []
    if roles and a.plate:
        roles, role_msgs = validate_roles(roles, a.plate)
    elif roles:
        role_msgs = ["roles: colours NOT validated against an empty set plate (--plate); SIDES flags can be false "
                     "if a character colour also appears in the set"]
    for m in role_msgs: print(m)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.items[0])), "sequence_check"); os.makedirs(out, exist_ok=True)
    frames = []
    for k in range(1, len(a.items)):
        pa, pb = a.items[k - 1], a.items[k]; na, nb = os.path.basename(pa), os.path.basename(pb)
        A = frame_png(pa, "last", os.path.join(out, f"cut{k:03d}_A_last_{os.path.splitext(na)[0]}.png"))
        B = frame_png(pb, "first", os.path.join(out, f"cut{k:03d}_B_first_{os.path.splitext(nb)[0]}.png"))
        sa, sb = setups.get(na), setups.get(nb); same = bool(sa) and sa == sb
        why, info = [], {}
        ov = os.path.join(out, f"cut{k:03d}_set_overlay.jpg")
        pc = plate_compare(B, A, ov)
        info["set"] = {k2: v for k2, v in pc.items() if k2 != "missing_cells"}
        if same:
            why += ["SET: " + w for w in pc["why"] if "partly hidden" not in w]
        elif not setups:
            info["set_note"] = "no setup labels: layout differences are not flagged"
        if roles:
            na_, nb_ = [], []
            ra, rb = sides(rgb(A), roles, na_), sides(rgb(B), roles, nb_)
            info["sides"] = {"before": ra, "after": rb, "skipped_before": na_, "skipped_after": nb_}
            common = [n for n in ra if n in rb]
            for i in range(len(common)):
                for j in range(i + 1, len(common)):
                    x, y = common[i], common[j]
                    if (ra[x] < ra[y]) != (rb[x] < rb[y]):
                        why.append(f"SIDES: {x} and {y} swap screen sides across the cut (fine only on a planned reverse angle)")
        ba, wa = look(rgb(A)); bb, wb = look(rgb(B)); info["look"] = {"brightness": [round(ba, 1), round(bb, 1)], "warmth": [round(wa, 1), round(wb, 1)]}
        if abs(bb - ba) > a.look_thr * 1.5: why.append(f"LOOK: brightness jumps {ba:.0f} -> {bb:.0f} across the cut")
        if abs(wb - wa) > a.look_thr: why.append(f"LOOK: colour warmth jumps {wa:+.0f} -> {wb:+.0f} (red minus blue) across the cut")
        refs = [{"label": f"end of {na}", "src": os.path.basename(A)}]
        if pc.get("ok"): refs.append({"label": "set check (red = previous shot's structure not found)", "src": os.path.basename(ov)})
        if k == 1: why = role_msgs + why
        frames.append({"i": k, "key": f"cut{k:03d}", "label": f"cut {k}: {na} -> {nb}" + (f"  [{sa} -> {sb}]" if setups else ""),
                       "t": None, "why": why, "out": os.path.basename(B), "refs": refs, "continuity": info})
        print(f"cut {k:3d}  {na} -> {nb}: " + (" | ".join(why) if why else "no continuity flags"))
    write_viewer({"kind": "sequence", "clip": a.name, "frames": frames}, out)
    print(f"  review: {os.path.join(out, 'review.html')}")

if __name__ == "__main__":
    main()

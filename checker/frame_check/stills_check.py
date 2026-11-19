"""stills_check.py - full-size review of stills (start/end frames, keyframes, storyboard). @anlim

Each still is shown alone at full size beside its references (set plate, character sheets,
previous approved still). With a plate, the room is checked against it: scale, camera shift
and rotation, and plate areas whose structure is missing (red boxes on an overlay image).

  python stills_check.py STILL_OR_DIR [more ...] [--plate PLATE.png] [--ref LABEL=PATH ...]
                         [--map map.json] [--out DIR]

map.json (optional) gives per-still plates and references:
  {"H1.png": {"plate": "M2_sink.png", "refs": {"Sol": "sol_sheet.png"}}, ...}
"""
import argparse, json, os, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import plate_compare, write_viewer

EXT = (".png", ".jpg", ".jpeg", ".webp")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+"); ap.add_argument("--plate"); ap.add_argument("--ref", action="append", default=[])
    ap.add_argument("--map"); ap.add_argument("--out"); ap.add_argument("--name", default="stills")
    a = ap.parse_args()
    files = []
    for p in a.inputs:
        if os.path.isdir(p): files += sorted(os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(EXT))
        else: files.append(p)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(files[0])), "stills_check")
    os.makedirs(out, exist_ok=True)
    mp = json.load(open(a.map)) if a.map else {}
    base_dir = os.path.dirname(os.path.abspath(a.map)) if a.map else ""
    copied = {}
    def bring(path):
        if path not in copied:
            name = f"ref_{len(copied):02d}_" + os.path.basename(path); shutil.copy(path, os.path.join(out, name)); copied[path] = name
        return copied[path]
    frames = []
    for k, f in enumerate(files):
        name = os.path.basename(f); spec = mp.get(name, {})
        key = name if sum(1 for g in files if os.path.basename(g) == name) == 1 else f"{k:03d}_{name}"
        plate = spec.get("plate"); plate = os.path.join(base_dir, plate) if plate and not os.path.isabs(plate) else plate
        plate = plate or a.plate
        refs = []
        for lab_path in a.ref:
            lab, p = lab_path.split("=", 1); refs.append({"label": lab, "src": bring(p)})
        for lab, p in spec.get("refs", {}).items():
            p = os.path.join(base_dir, p) if not os.path.isabs(p) else p; refs.append({"label": lab, "src": bring(p)})
        dst = f"still_{k:03d}_{name}"; shutil.copy(f, os.path.join(out, dst))
        why, pr, overlay = [], None, None
        if plate:
            refs.insert(0, {"label": "set plate", "src": bring(plate)})
            overlay = f"plate_overlay_{k:03d}_{os.path.splitext(name)[0]}.jpg"
            pr = plate_compare(f, plate, os.path.join(out, overlay))
            why += ["plate: " + w for w in pr["why"]]
            if not pr.get("ok"): overlay = None
        frames.append({"i": k, "key": key, "label": name, "t": None, "why": why, "out": dst, "refs": refs,
                       "overlay": overlay, "plate": pr})
        print(f"  {name:32s} " + (" | ".join(why) if why else "no code flags") +
              (f"  [room scale {pr['scale_room']}, structure {pr['structure_found']:.0%}]" if pr and pr.get("ok") else ""))
    man = {"kind": "stills", "clip": a.name, "frames": frames}
    write_viewer(man, out)
    print(f"  review: {os.path.join(out, 'review.html')}")

if __name__ == "__main__":
    main()

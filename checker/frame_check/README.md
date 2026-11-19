# frame_check · @anlim

Full-size review of generated video and stills. Code checks every frame on small copies; the
frames worth looking at are exported at native resolution as separate images (never tiled), and
`review.html` shows them one at a time, beside their references, with AI verdicts and your flags.

| File | What it does |
|---|---|
| `frame_check.py` | Video: every-frame code checks, full-size export, viewer |
| `stills_check.py` | Stills (start/end frames, keyframes): full-size viewer beside references, set-plate check |
| `ai_review.py` | AI verdicts on the exported frames: session mode (protocol file), API mode, apply + agreement report |
| `edit_check.py` | Image edits: aligns AFTER to BEFORE, boxes every change outside the intended region |
| `sequence_check.py` | Continuity across cuts: end of each shot vs start of the next (set, screen sides, lighting) |
| `measure.py` | Height and body-build checks from points clicked in the viewer (or given by the AI pass) |
| `shot_qc.py` | **App entry point:** one call per rendered shot; runs every check its spec allows, maps results to QC gates |
| `objects_check.py` | People and objects through the clip (YOLOX, COCO): head count vs spec, things that appear or vanish |
| `pose_check.py` | Body keypoints for every person (person boxes + pose per crop). Building block, NOT used for gates (see tests) |
| `camera_check.py` | Camera move vs the shot spec (locked / push-in / pan / tilt), rigid background |
| `face_id.py` | Face-identity scores against character references (photoreal only; see limits) |
| `deliver_check.py` | Before upload: sound vs the music master, picture vs the approved cut, size / fps / length |
| `batch_eval.py` | Scores the whole pipeline against clips a person already judged (pass / minor / fail folders) |
| `end_frame.py` | End frames made by editing the start still: `check` flags anything outside the characters that moved (free, before a render); `compose` rebuilds the end frame with the room taken from the start still |
| `fc_common.py` | Shared: frame export, set-plate comparison, viewer |
| `default_rules.md` | The rule list from your production notes; copy per series and add series rules |

## Code checks
- **Video, every frame:** cuts (a change that persists); 1- and 2-frame outliers (flashes, smears,
  swaps that flip back); dark corners vs the clip's own corners; with `--roles`, a character's
  colours jumping and returning within 6 frames, and two characters' order flipping in a shot.
- **Still images:** a shot that does not change at all for 2 s. Whether the shot's ACTION happens is
  rule 15 for the AI/human review: pixel motion cannot tell (tested on the Keycard v4 verdicts).
- **Re-renders (`--previous OLD.mp4 --window 4.0-5.5`):** compares the new version with the previous
  one frame by frame and flags every frame that changed OUTSIDE the window the re-render was meant
  to fix (EP08/EP12/EP15 swap lesson). If the whole clip was regenerated it says so instead, because
  frame-by-frame comparison can't isolate errors then.
- **Set plate (`--plate`, stills and video):** room scale vs the plate, camera shift and rotation,
  plate areas with no structure left (fixture removed/moved) vs partly hidden (usually a person).
  In video it also flags a room that grows or shrinks within one shot. A deliberate push-in or
  zoom flags too: confirm it against the shot plan.
- **The plate must be the EMPTY set** (no characters), one per camera setup. A master with the cast
  in it reports the cast's positions as differences.

## Run (Windows PowerShell; needs Python 3 with numpy, Pillow and opencv-python, and ffmpeg on PATH)
```powershell
$Tool = "C:\vid_projects\_tools\frame_check"
$Ep   = "C:\vid_projects\peleas\ep18_name_that_fight"
Set-Location $Ep

# video (add --source for motion transfer, --plate for a locked set)
python "$Tool\frame_check.py" "$Ep\clips\out_im_b1.mp4" --roles "$Ep\project\roles_im.json" --out "$Ep\qa\frame_check\im_b1"

# stills against a set plate, with extra references
$R = "C:\vid_projects\kids_youtube\Color_by_Color_assets\rebuild"
# --plate must be the EMPTY plate of the same kitchen and camera setup as the stills (placeholder path below)
python "$Tool\stills_check.py" "$R\dirbatch4" --plate "C:\path\to\empty_sink_setup_plate.png" --ref "Sol=C:\path\to\sol_sheet.png" --out "$R\dirbatch4\stills_check"

# re-render: compare with the previous version; window = seconds you meant to fix
python "$Tool\frame_check.py" "$Ep\clips\out_im_b1.mp4" --previous "$Ep\clips\rejected\out_im_b1_v1.mp4" --window 4.0-5.5 --out "$Ep\qa\frame_check\im_b1_v2"

# image edit: did it change only the intended region? (fractions: x0,y0,x1,y1)
$O = "C:\vid_projects\kids_youtube\Color_by_Color_assets\openart_test"
python "$Tool\edit_check.py" "$O\prep_table_P0.png" "$O\prep_table_P1.png" --region 0.40,0.62,0.60,0.78

# AI review: write the task file for a Claude session, then merge its verdicts
python "$Tool\ai_review.py" pack  "$Ep\qa\frame_check\im_b1" --only flagged
python "$Tool\ai_review.py" apply "$Ep\qa\frame_check\im_b1" --flags "C:\Users\londi\Downloads\flags_out_im_b1_mp4.json"

# AI review through the API: prints the cost estimate; add --yes to spend
python "$Tool\ai_review.py" api "$Ep\qa\frame_check\im_b1" --only flagged

Start-Process "$Ep\qa\frame_check\im_b1\review.html"
```

## Continuity across cuts (sequence_check.py)
Compares the last frame of each shot with the first frame of the next, in edit order:
- **SET** (only between shots labelled with the same camera setup in `setups.json`): room layout, scale,
  camera shift, fixtures missing vs the previous shot.
- **SIDES** (with `--roles`): two characters swap screen sides across the cut. Fine on a planned reverse
  angle, so it is a flag to look at, not a verdict.
- **LOOK**: brightness or colour-warmth jump across the cut (the Keycard cold-to-warm grade jump).
```powershell
$Tool = "C:\vid_projects\_tools\frame_check"
$Clips = "C:\vid_projects\keycard\v4\clips"
Set-Location $Clips
# first write setups.json: {"B1.mp4": "park-path", "B2A.mp4": "park-path", ...} (one label per camera setup)
python "$Tool\sequence_check.py" "$Clips\B1.mp4" "$Clips\B2A.mp4" "$Clips\B2B.mp4" "$Clips\B3.mp4" --setups "$Clips\setups.json" --out "$Clips\sequence_check"
```

### Character colours (roles.json) must be unique to the character
Tracking a character by colour only works if nothing else in the frame has that colour. Tested
2026-11-10: in the Ep 6 kitchen, Sol's orange shirt matches the wooden cabinets, so "Sol" was placed on
the cabinets and a false SIDES flag appeared. The tools now (a) use the largest patch of the colour only
when it holds most of the matching pixels, and (b) with `--plate <empty set>`, switch off any role whose
colour covers more than 0.2% of the empty set. Without a plate they print a warning. Pick colours that
appear on the character only (EP18: slate tunic vs mustard shirt in a white-and-green glasshouse).

## Height and body build (measure.py)
1. One lineup file per series (example: `C:\vid_projects\kids_youtube\Color_by_Color_assets\lineup_ep6.json`):
   each character's relative height, optional `build` range (shoulder width / full height, measured
   on the approved single-figure reference at full size), pair ranges such as Sol/Ama 0.75-0.82, and
   the drift tolerance (0.03). Write down the head-top convention and keep it the same everywhere.
2. `measure.py attach <review folder> --lineup <lineup>` puts the names into the viewer.
3. In the viewer: type or pick the character, tick "base is a shared line" when feet are hidden and
   you use the counter or table edge, press M, then click head-top, base, left shoulder edge, right
   shoulder edge, chin (Enter skips the shoulders, then Enter skips the chin; Backspace undoes, Esc
   stops). Use Z (actual size) for precise clicks. "Download flags + measures" saves everything.
   Props: list them in the lineup (`"props": {"backpack": {"owner": "C01", "ratio_to_head": [1.8, 2.2]}}`),
   pick `prop:backpack` in the viewer and click its top and bottom. The report checks the prop's length
   against its owner's head height (head-top to chin) - the M_Ap_Rete_Mwen backpack lesson.
4. `measure.py report <review folder> --lineup <lineup> --measures <downloaded json>` checks:
   - pair ratios for characters on the SAME shared line (bases within 2% of the image height);
     feet-based pairs whose feet are not level are reported as "depth unverified", not flagged;
   - build (feet-based only) against each character's range;
   - drift: the same character's height within one shot must stay within the tolerance.
   Results go to `measure_report.md` and into the viewer as frame flags.

```powershell
$Tool = "C:\vid_projects\_tools\frame_check"
$Lineup = "C:\vid_projects\kids_youtube\Color_by_Color_assets\lineup_ep6.json"
$Rev = "C:\vid_projects\kids_youtube\Color_by_Color_assets\rebuild\dirbatch4\stills_check"
Set-Location "C:\vid_projects\kids_youtube\Color_by_Color_assets"
python "$Tool\measure.py" attach $Rev --lineup $Lineup
Start-Process "$Rev\review.html"
python "$Tool\measure.py" report $Rev --lineup $Lineup --measures "C:\Users\londi\Downloads\flags_stills.json"
```

## AI review (session mode)
`pack` writes `AI_REVIEW_TASK.md` in the review folder: the protocol, the rules and the frame list.
Tell the cowork session: "Work through AI_REVIEW_TASK.md in <folder>". The protocol makes it open
each frame alone at full size, write what it sees before reading the rules, check every rule,
cite a region for every problem, and append one line per frame to `verdicts.jsonl`. `apply` then
shows the verdicts in the viewer. With your downloaded flags file, `apply` also lists frames you
both flagged, frames only you flagged (AI misses) and frames only the AI flagged.

## Using the tools from the app (shot_qc.py and the analyze() functions)
Every check is also a function that returns a dict, so the app imports them instead of reading printed text:
`camera_check.analyze(clip, expect)`, `face_id.analyze(clip, {"C01": [paths]})`,
`deliver_check.analyze(video, master_audio=..., approved=...)`, `shot_qc.run(spec)` (pass `log=None` for silence).
`shot_qc.run` takes the shot spec the app already holds (the shot compiler writes it) and runs:
size / fps / clip shorter than its edit slot (G); **frame 0 vs the approved start still** (B: a different
picture, or the same picture re-framed); camera move vs spec (D); face identity (A, photoreal only); and,
people count and objects appearing or vanishing (`"people"`, `"allow_objects"`, `"track_objects"`: A and E);
with `"frame_check": {...}`, the every-frame checks and full-size export (flags mapped to gates); and with
`"ai_review": {"only": "flagged", "max_usd": 0.50}`, it writes the AI review task and, only when
ANTHROPIC_API_KEY is set AND the cost estimate is under `max_usd`, runs the API review (otherwise it
says why it did not). Re-running shot_qc on the same folder replaces its shot_qc.json.
**Code checks can FAIL a gate; they never PASS one.** A shot with no code flags comes back
`NEEDS REVIEW`, never PASS. `ai_review.py record` reads `shot_qc.json` from the same folder and merges
the code failures into the gate table with the review's verdicts.
```powershell
$Tool = "C:\vid_projects\_tools\frame_check"
$T = "C:\vid_projects\_tools\frame_check\_tests\shotqc_2026-11-10"
Set-Location $T
python "$Tool\shot_qc.py" "$T\P018_spec.json"
python "$Tool\ai_review.py" record "$T\P018" --ledger "$T\ledger.csv"
```
Example specs (built from the M_Ap_Rete_Mwen shot manifest): `_tests\shotqc_2026-11-10\P0xx_spec.json`.

## QC gates and the clip record (from the music-video Production Bible v2)
Every rule in `default_rules.md` carries its gate letter: A Character, B Set, C Anatomy, D Camera,
E Motion and props, F Editorial, G Technical. The AI protocol now asks for PASS / FAIL / NOT CHECKED
on EVERY rule for every frame (`checks` in verdicts.jsonl). **NOT CHECKED never counts as PASS:**
`apply` shows a PASS that left any rule unchecked as INCOMPLETE, and `record` writes the clip's
gate table with frame evidence, render ID and paid retries:
```powershell
$Tool = "C:\vid_projects\_tools\frame_check"
$Ep   = "C:\vid_projects\peleas\ep18_name_that_fight"
Set-Location $Ep
python "$Tool\ai_review.py" record "$Ep\qa\frame_check\im_b1" --render-id "<render id>" --retries 2 --editorial PASS --ledger "$Ep\qa\clip_ledger.csv"
```
A gate is PASS only when every rule in it is PASS on every reviewed frame. EDITORIAL (F) is judged on
the whole clip, so give it with `--editorial` after watching. Old rules files without gate letters
still work (known rule names are mapped; others are listed as "no gate letter").
New rules from the music lessons: WARDROBE (outfit and footwear per scene/day), carry side and size
next to a hand or head (PROPS), NO MATERIALISING (start frame must contain the object or it enters
from off screen), REFLECTIONS AND SHADOWS (glass stays see-through), CAMERA, IMAGE QUALITY, EDITORIAL.

## Camera move vs spec (camera_check.py)
```powershell
$Tool = "C:\vid_projects\_tools\frame_check"
$W = "C:\vid_projects\music_projects\M_Ap_Rete_Mwen\04_video\work\08_SUPERCOOL_CLIPS_2026-10-22"
Set-Location $W
python "$Tool\camera_check.py" "$W\minor\P013.mp4" --expect locked
python "$Tool\camera_check.py" "$W\pass\P007.mp4" --expect locked --json "$W\P007_camera.json"
```
`--expect` takes locked, push-in, pull-out, pan-left, pan-right, tilt-up, tilt-down or any, joined
with + (push-in+pan-left). Directions are the camera's. It reports the zoom, travel (fraction of
frame width) and roll from the first frame, a move that goes out and comes back ("push-in and back
(peak 0.058 at 2.00 s)") when it lasts 0.5 s or more,
and LOOK AT times where few background points agree (a big subject moving, or a warping or redrawn
background). Default tolerance 2% (`--scale-tol`, `--shift-tol`).

## Face identity (face_id.py) - photoreal faces only
```powershell
$Tool = "C:\vid_projects\_tools\frame_check"
$W = "C:\vid_projects\music_projects\M_Ap_Rete_Mwen\04_video\work"
Set-Location $W
python "$Tool\face_id.py" "$W\08_SUPERCOOL_CLIPS_2026-10-22\fail\P029.mp4" --ref "C01=$W\03_CHARACTER_BIBLE\C01\C01_master_M4_28ad1308.png" --ref "C02=$W\03_CHARACTER_BIBLE\C02\C02_master_W4_aaa35d73.png"
```
Uses OpenCV's YuNet detector and SFace recognizer (`models\`, OpenCV Zoo, Apache-2.0; about 39 MB).
Score is cosine similarity; 0.363 is OpenCV's suggested same-person threshold. Faces seen in profile
or from behind (eye spacing under 0.2 of the face box), and detections under 0.85 confidence (real
faces scored 0.90-0.93; the back of a head scored 0.71), are listed but NOT scored, because they score as
low as a different person. It warns when two references score above 0.5 against each other: then the
model cannot tell them apart and the scores mean nothing (this is what happens with cartoon faces).

## Delivery check (deliver_check.py) - run before every upload
```powershell
$Tool = "C:\vid_projects\_tools\frame_check"
$P = "C:\vid_projects\music_projects\Fanm_Vanyan"
Set-Location $P
python "$Tool\deliver_check.py" "$P\04_video\final\Fanm_Vanyan_final.mp4" --master-audio "$P\03_audio\Fanm_Vanyan_FINAL_AUDIO.mp3" --size 1920x1080 --out "$P\04_video\final\deliver_check"
# add --approved "<approved cut>.mp4" to compare pictures every second (--every)
```
Sound: lines the delivered track up with the master over the whole song, then reports the offset, the
LEVEL change (correlation alone cannot see a level change - see tests) and, second by second, where the
sound stops matching (something else in the mix, a re-cut, a fade). Very quiet master seconds (below
-40 dBFS, fade tails) are notes, not problems. Picture: compares 16x16-pixel blocks at the same
times, so a small changed area (a re-rendered hand, a box) is not averaged away.

## Viewer keys
Left/Right: frame · N: next frame flagged by code or AI · Z: actual pixel size · F or Enter: flag
with the note in the box · "Download flags" saves your flags as JSON.

## Tests run (2026-11-09/10)
- Video, EP18 im_b1 with a planted 2-frame left/right swap (frames 110-111): caught by all three
  swap checks; the clean clip shows nothing there. Clean clip: 4 cuts, 1 flag (frame 239).
- Stills vs the M2_sink master: planted 15% zoom read as +15% room scale; a painted-out sink area
  read as 4 areas with no plate structure (0% found) vs 20-35% where people stand; the two table
  shots from another camera setup read as not matching the plate.
- Video plate: a 3 s clip zooming 15% read as "room scale changes within shot (1.00 to 1.15)".
- AI review session mode on 3 frames of im_b1: f276 FAIL (extra digit on her front hand),
  f239 UNSURE (merged legs during the cartwheel; needs the source frame), f40 PASS. Viewer
  displays them with no script errors. Not yet confirmed by Londi.
- API mode: cost estimate only (19 frames, about $0.21); no API key in the cowork environment,
  so the API call itself is untested.

## Tests run 2026-11-10 (second batch)
- Re-render: a 2-frame change at 4.58 s with the "fixed window" at 8-9 s was flagged (difference 54
  vs encode noise 0.6); with the window covering it, nothing was flagged. Comparing against a
  different clip reported "whole clip regenerated".
- Frozen: a 3 s still-image clip flagged as a frozen shot; a moving (zoom) clip did not.
- Edit check, real files: P0 -> P1 platter edit changed only the red arc (0.8% of the image). With a
  planted recoloured cup, the cup was boxed as a change outside the intended region (0.2%).
- Edit check across the real platter sequence: P1 -> P2 and P2 -> P3 redrew the fruit in ALL six bowls
  (strawberries rearranged, banana slices reshaped, kiwi and blueberries changed) when only one row
  was meant to change - the Director lesson 22 failure, now measured. See
  `_tests/edit_2026-11-10/P1_to_P2_bowls_before_after_overlay.png`.
- Pose model (MediaPipe Pose 0.10.14, single-person) on 30 frames: returned a pose for 24, but at full
  size: placed face/shoulders well on the person it picked; in two-character contact shots it put one
  wrist on the OTHER character's fist; on a legs-only frame it invented a face and shoulders; in the kids
  kitchen it picked one person (Mom, or Ama) and ignored the rest, including the child the shot was
  about. Not usable as a defect detector. Next test: the multi-person PoseLandmarker (model download
  from Google storage works in the cowork environment). Images in `_tests/pose_2026-11-10/`.

## Tests run 2026-11-10 (measure)
- Viewer, driven in a real browser: Sol and Ama on the W0 kitchen still measured above the island
  edge (y 411): Sol 149 px, Ama 226 px. Report: Sol/Ama = 0.656 vs the lesson 21 target 0.75-0.82
  (the coded lineup gives 0.74). +-3 px per head-top moves the ratio about +-0.02, so it is outside
  either way. A candidate for Londi to judge, not a confirmed error. Files in
  `_tests/measure_2026-11-10/`.
- Drift (synthetic points on the im_b1 manifest): +4% within one shot flagged; a frame in another
  shot not compared. Build: 0.467 vs 0.34-0.42 flagged, 0.269 vs 0.24-0.30 passed. AI-supplied
  points in verdicts.jsonl are read; human points override them.
- Not yet checked: how accurately the AI pass places points compared with your clicks.

## Review of reasoning and code (2026-11-10)
Bugs found and fixed:
1. `measure.py` checked a pair twice with two different targets when characters were listed in the
   other order (lineup ratio +-5% vs the stated range); a ratio of 0.72 could fail one and pass the
   other. Now each pair is checked once, against the stated range (inverted when reversed).
2. The frozen-shot threshold (0.50, from keycard/tools/qc.py) was never validated. On the Keycard v4
   verdicts it flagged 3 approved clips and missed 2 of 4 rejected ones, because "zero motion" there
   meant the story action never happened. Now only literal stills are flagged (threshold 0.10); the
   action check stays with review rule 15. On 40 ABC episode clips the old threshold would also have
   flagged 14 normal singing shots.
3. Character colour tracking averaged every matching pixel, so a colour shared with the set gave a wrong
   position and a false SIDES flag (Sol's orange vs wood cabinets). Fixed as described above.
4. Drift flags now say they are only real if the camera is locked and the character stays at the same
   depth (a push-in or a walk toward camera also changes size).
5. `edit_check.py` now says when alignment failed instead of silently comparing unaligned images.
6. Frame export uses `-fps_mode passthrough` on new ffmpeg builds and falls back to `-vsync 0` on old ones
   (the cowork environment has ffmpeg 4.4).
7. Two inputs with the same file name in `stills_check.py` no longer share one key.
Re-run after the fixes: the planted EP18 swap is still caught by all three checks; the edit check and
the measure report give the same results as before.

Reasoning that still rests on assumptions:
- The 6 fps sweep and the d x f sampling estimate assume a defect is visible in any frame it spans.
- Session-mode AI review is told to open each frame alone at full size; I can't confirm whether the
  session's image reader shrinks large images, so the protocol also asks for crops of small details.
- Same shared line is treated as same depth; true only when the line (counter edge) faces the camera.

## Tests run 2026-11-10 (music-project refinements)
QC gates (copy of the ep18 v2_im_b1 review, `_tests\gates_2026-11-10`):
- The 245 verdicts written so far across the ep18 v2 reviews have no per-rule checks; under the new rule
  every one of their 191 PASS verdicts reads INCOMPLETE. A planted PASS with EDITORIAL and MOTION left
  NOT CHECKED came out INCOMPLETE; a planted PASS with all 22 rules checked stayed PASS. `record` gave
  QC-A FAIL (role swaps f96-f105), QC-C FAIL (extra hands f106, f107, f192, f239), other gates NOT CHECKED.
Delivery (`_tests\deliver_2026-11-10`):
- Kijan against `KIJAN_POU_M_FE_-_Anlim_Remastered.mp3` (the wrong master, picked by me first): match
  -38.7 dB, flagged. Against `Kijan_Pou_M_Fe_FINAL_AUDIO.mp3`: offset 0, level -0.01 dB, match 39.6 dB.
- Planted 60 s copy (tone mixed in at 20-23 s, +2 dB, red box at 30-32 s): all three caught (level
  +1.96 dB, "differs at 20-23 s", picture different at 30.5 and 31.5 s). A whole-frame PSNR test missed
  the box (25.2 dB), which is why the picture test uses blocks.
- The 8 music finals against their FINAL_AUDIO files: 6 clean (match 33-120 dB, offset 0).
  **Fanm_Vanyan_final.mp4 is +1.78 dB louder than Fanm_Vanyan_FINAL_AUDIO.mp3** (ffmpeg volumedetect,
  independent check: mean -16.2 vs -17.9 dB, peak -1.5 vs -3.2 dB). Its FINAL_AUDIO.txt says it was
  verified "match >= 0.9998" by cross-correlation, which does not see a level change. Si_M_Te: only
  the last, near-silent second (fade tail, about -55 dB) differs: a note, not a problem.
Camera (`_tests\camera_2026-11-10`, `mapre_locked.txt`):
- Planted: locked with a moving character -> locked; 3% and 10% push-in -> push-in (x1.029, x1.096);
  9.4% pan -> pan-right; 6% zoom that returns -> "drifts and returns".
- M_Ap_Rete_Mwen SuperCool clips specced LOCKED: P013 (your note: unrequested 2-4% push-in) -> push-in
  x1.048; P018 (camera pans) -> pan-right 24% with roll; P020 (camera drifts) -> pan-right 6.6%;
  P049 (tilts down) -> flagged as moving, but labelled pan-right with a vertical move that returns -
  the label is wrong there. 11 other locked clips (P002-P007, P016, P017, P028) read locked.
- Two false alarms found and fixed during testing: a kids clip (ES_L5) where the girl tilting her head
  read as a 2.5 degree camera roll (fixed by matching the set at the frame edges first and against the
  first frame directly), and P007, a man walking away close to the lens (two odd samples; now a
  LOOK AT note, a drift must last 0.5 s).
- P001 (FLOAT lateral; the batch note says "the camera stays locked; the float never happens"): the tool
  says the camera moves (zoom x0.953, roll 2.5 degrees), and a first/last frame blend shows the lamp
  and coffee table doubled. Worth a look: the camera does appear to move, though not as the spec's float.
Face identity (`_tests\face_2026-11-10`):
- P029 (your fail note: hard cut to a different, older man): every face after 2.0 s scores 0.15-0.24
  against C01 -> flagged. Front/three-quarter C01 shots that passed: 0.37-0.68, none flagged.
- Before the turned-face rule, 3 passed clips (P009, P037, P045) were flagged: all three show C01 in
  profile from behind (scores 0.14-0.29, eye spacing 0.0-0.1 of the face box vs 0.26-0.45 for front
  faces). Now listed as "turned away, check by eye".
- Cartoons: the detector misses some drawn faces at its default setting, and two different cartoon
  children (Layana, King) score 0.66-0.74 against each other, the same as Layana A vs Layana B (0.73).
  Not usable for cartoon identity; the tool now warns when references are not told apart.
Prop scale (`_tests\props_2026-11-10`): planted cup 0.40x Sol's head (in range) and plate 1.00x Ama's
head (range 0.5-0.7) -> plate flagged. Viewer clicks for prop top/bottom and the chin step tested in a
headless browser with no script errors.

## Tests run 2026-11-10 (app entry point)
`shot_qc.py` on four SuperCool shots with specs from the shot manifest (`_tests\shotqc_2026-11-10`):
- P018 (fail: "doesn't start on the still; camera pans"): FAIL on B (starts on the still re-framed,
  scale x1.063), D (pull-out, pan, 5.4 degree roll) and G (1280x720 vs 1344x768).
- P029 (fail: hard cut to a different man): FAIL on A (5 faces match no reference) and D (the camera
  chain breaks at the cut).
- P013 (minor: unrequested push-in): FAIL on D. A first run also flagged A from the back of his head,
  read as a face at 0.71 confidence; fixed with the 0.85 confidence floor.
- P003 (pass): NEEDS REVIEW, no code flags.
- Start frame vs approved still, 20 clips: 0-2.5% of blocks differ for clips that start on the still;
  P049 and P053 4.6% (not checked by eye); P018's difference is a 6.3% re-frame, which the block test
  alone missed (0.0% after alignment), so the alignment's scale and shift are checked too.
- Camera: P049 (tilts down at 3.3 s) is still labelled a pan-right; its tilt is not separated from the
  pan. It is flagged as not locked, but the direction label is wrong.

## Tests run 2026-11-10 (objects, pose, AI-review hook)
Objects (`objects_check.py`, YOLOX-S, 2 samples a second; head count from the shot manifest's cast):
- P020 (fail: people appear on the empty bench from 2.3 s): PEOPLE 3 at 2.0 s, rising to 8.
- P053 (fail: 10-12 people appear on the ridge from 2.7 s): PEOPLE 2 at 3.0 s, rising to 10.
- P042 (fail: groceries appear and pile up from 0.8 s): an object "appears" at 2.5 s, which the detector
  calls a sports ball (oranges), plus a skateboard and suitcase it saw for 2 samples (listed as look-at).
  The class names are the detector's guesses; the timing is the useful part.
- P029: the cut to other people shows as 4-5 people after 2.0 s.
- Passes P003, P007, P024, P041, P043 (cast 1-2): no problems (P043 had one stray 3-person sample, ignored
  by the 2-sample rule). P021 (minor, small reflection in the door glass) and P016_alt (extra figure in the
  shop glass) were NOT caught: reflections too small for the detector.
- Known false count: P038's printed photo has people in it, counted as 3 people (photos and screens count).
- Kids cartoons: the chibi children are detected as "teddy bear", not "person" (W0, ES_L5), so head count
  does not work on that style. The EP18 style (adult proportions) is detected as people.
Pose (`pose_check.py`, top-down, `_tests\pose2_2026-11-10`):
- P042 (photoreal, two people): each person gets their own skeleton (the old test's limb mix-ups cannot
  happen across boxes); the standing woman is right; the kneeling man's legs are wrong.
- EP18 f106 (cartoon): the woman's upper body is about right, her raised leg is wrong; the boxer seen from
  behind gets no pose. The extra hand on her chest is not something pose can see.
- Kids chibi style: no people found, so no pose.
- Facing: the first rule (eyes and shoulders visible) called a woman turned to the man "camera"; it now uses
  the nose between the ears (head_turn: 0 = at the camera), which reads her as turned (-0.42).
Verdict: not reliable enough to fail shots. Possible use: pre-filling measure points for a person to
correct, on photoreal or adult-proportion styles only.
AI review from shot_qc: P018 with frame_check + ai_review: 45 frames packed, estimate about $0.49, not run
(no API key). With a key set and a $0.10 cap: not run, "estimate $0.49 is over the $0.10 cap". The run
with a key under the cap is untested (no key).

## Tests run 2026-11-10 (cartoon head count, photo and glass regions)
Cartoon head count (`--style cartoon` / spec `"style": "cartoon"`): chibi children are detected as
"teddy bear" as often as "person", so both count as people (one per body) at 0.30 confidence. Calibrated on
16 kids frames I counted one by one (6 Color by Color kitchen frames with 4 children, 10 ABC frames with
0-3): 13/16 exact, never more people than there were; misses were 3 undercounts (children behind the
kitchen island; two children seated close at a table; 2 of 3 at the ice-cream stand). Person-only at its
best threshold: 11/16. Planted test: ABC EN_L39 (2 children) with a head count of 1 -> PEOPLE flagged.
Regions (`--regions` / spec `"regions"`), fixed boxes for locked shots:
- photo: people inside are left out of the head count. P038 (a hand and a framed photo of two people,
  head count 1) went from "3 people" to clean, with "2 people inside the framed photo" as a note.
- glass: people inside are searched with enlarged tiles, and flagged when more than in the first frame
  (or than "expect"). Planted test: a semi-transparent figure (60% opacity, 20% of frame height) pasted
  into P016's shop window from 2.0 s -> "REFLECTION at 2.0 s"; head count unaffected.
- Not caught: the real P016_alt reflection. It is a faint dark figure right beside the actor's shoulder;
  the detector saw it in 1 of 26 samples (0.5 confidence), and smaller tiles (240 px, 3x slower) found
  nothing more. Faint reflections stay with the full-size review (rule 18).

## First live API review (P018, 2026-11-10, run by Londi)
45 frames, no API errors after the reply-parsing fix. Verdicts: 16 FAIL, 26 UNSURE, 3 INCOMPLETE.
- Real catches, checked by eye: the woman walks right with her head turned to the camera (NATURAL POSES,
  9 frames, 0.00-4.17 s); garbled generated text on a paper sign (TEXT, f164).
- False alarms: REFLECTIONS AND SHADOWS failed 10 frames for "the glass does not reflect the walkers" and
  passed 23 frames showing the same thing. Rule 18 now fails only reflections or shadows that are wrong,
  not ones that are absent.
- Gaps: no shot context was sent, so HEAD COUNT was left unchecked on 40 frames, IDENTITY on all 45, and
  the notes repeated "no shot spec provided". The P018 note's "second copy of him" was not found.
Changes made from it:
- shot_qc.py saves the spec as `shot_spec.json` beside the frames; the review now gets the action, cast,
  head count, camera, notes, and up to 3 reference pictures (approved start frame, character sheets).
- Prompt caching: the rules and references are cached and read back for every frame at the cache price.
- The prompt asks for short notes and no issues about missing references (those rules go NOT CHECKED).
- `apply` prints and saves `ai_summary.json`: one line per failed rule with every frame that failed it.
- Each run prints and logs (`api_usage.jsonl`) the real token usage and its cost at list prices.
- Cost: the first run's "$0.49" counted input only. With output included, and the references now added,
  the estimate for P018 is about $1.12 on Opus 5.5 and $0.56 on Sonnet 5.5 (list prices from
  platform.claude.com/docs/en/about-claude/pricing, read 2026-11-10: Opus 5.5 $4 in / $20 out / $0.20
  cache read; Sonnet 5.5 $2 / $10 / $0.10). Output (about 900 tokens a frame, guessed) is most of it.

## Opus 5.5 vs Sonnet 5.5 on two labelled clips (2026-11-10, run by Londi)
| Clip (Londi's label) | Opus 5.5 | Sonnet 5.5 |
|---|---|---|
| P018 (fail) | 45/45 FAIL: camera move, cup moved to another person, woman gone, garbled text | 45/45 FAIL: same, plus 24 SCREEN SIDE, 9 WARDROBE, 6 FIXED DETAILS mostly for normal walking |
| P003 (pass) | 13 FAIL / 8 UNSURE: a 70 px framed photo misread as "changed to a snowy mountain"; checked by eye, it never changes | 3 FAIL: lips parted (2, the start frame shows the same), identity/framing at f36 (1) |
| Actual cost | $1.39 (P018), $1.00 (P003) | $0.71, $0.36 |
Two clips are not enough to choose; both caught the real failures on P018.
Start-frame check (`apply`): every issue now carries a box; the code aligns the approved start frame to
the output frame and measures how much of the box differs. Under 3% of 8 px blocks = the same as approved,
so not a new defect; a FAIL whose every boxed issue is the same becomes UNSURE. On P003's Opus verdicts
(boxes added by hand for the test) it lowered 10 of the 13 false FAIL frames; f36 (a softer frame, 13%)
and f72 (7%) stayed, and f40 stayed because of its lips note (8% - a small real change is not lowered).
Calibration: unchanged photo 0-1.7%, parted lips 8-9%, a walker 0.17 s in 5-8%, the moved cup 68-78%.

## Benchmark (batch_eval.py)
Runs every clip in pass/, minor/ and fail/ through shot_qc (free checks) and, when those find nothing, the
AI review (4 frames at a time, stop after 3 FAIL frames), then compares with the human folder. Specs come
from the shot manifest's own wording; the reviewer is told the approved start frame wins where the text
disagrees. Stops before a clip whose estimate would pass --max-usd; resumes where it left off; deletes the
exported PNGs of frames that passed. Tested 2026-11-10 with a simulated API on P003 (36 calls, resume file,
cleanup); the real run is untested.

## Benchmark run 1 (55 SuperCool clips, Sonnet 5.5, $9.39, 2026-11-10)
Bad clips caught: 12 of 12. Good clips failed: 18 of 34 (12 by the free checks, 6 by the AI). Causes and
the rule changes made (tuned on these clips, so re-check on new ones):
- Object detector "something appeared" (chair, train, book, potted plant) failed 6 good clips -> a note.
- Face score 0.33-0.35 for the right man failed 2 -> fail only below 0.25 (wrong people scored 0.10-0.15).
- Start frame 5.1-5.5% different failed 2 -> fail at 8%.
- A 3.2% camera drift you accepted failed 1 -> camera fails at 5% or 2 degrees of roll; smaller = FLAG.
- The AI's own camera calls failed 3 that the code camera check passed -> the code decides CAMERA, and
  set/appearance failures in the same frame count as consequences of the move.
- Open mouth while singing, a bigger smile than the brief, one-frame hand smears failed 4 -> mouths, poses,
  image quality, screen side, lighting, editorial and fixed details can only FLAG; other rules fail the clip
  only when the same rule fails in 2 consecutive sampled frames. Early stop now waits for that.
Clip verdicts are three-way: FAIL (regenerate), FLAG (a person looks at the listed frames), PASS.
`batch_eval.py --rescore` re-runs the free checks, reuses the saved AI verdicts and reviews only clips that
now need it (results_v2.csv, summary_v2.txt).

## Known limits
- Colour thresholds in `roles.json` are tuned per episode and can drift after a re-encode.
- No code checks yet for anatomy, hands, mouths, blinks, prop tracking or motion transfer pose vs
  source: those rely on full-size review (you and/or the AI pass). Identity has a code check for
  photoreal faces only (face_id.py). Pose detection
  was tested and is not reliable on these styles yet (see tests).
- The cowork environment's disk is shared and nearly full (about 870 MB free on 2026-11-10 after adding the 39 MB face models); each
  video review exports about 90 full-size PNGs (~120 MB), so write `--out` into your project folders.
- Plate check needs OpenCV; tested on one kitchen set only.
- Note (2026-11-10): `Color_by_Color_assets/plates/KIT_base.png` is a different kitchen (white cabinets,
  counter sink) from the rebuild stills and `M2_sink.png` (wood cabinets, teal island sink). There is no
  empty plate of the rebuild kitchen yet.

## Second opinion before an AI FAIL (2026-11-10)

`ai_review.verify_fail(clip_dir, model)` runs only when the AI review would FAIL a clip. For each failing rule it
re-checks up to 3 of that rule's frames, one call per frame, with a skeptical prompt (`VERIFY_SYSTEM`) and the approved
start frame. A rule keeps the FAIL only if at least 2 frames come back CONFIRMED; otherwise it drops to FLAG.
Writes `ai_verify.json`. Used by `shot_qc.py` (after the AI review) and `batch_eval.py` (turn off with `--no-verify`).
Why: in benchmark v3, 3 good clips (P011, P026, P037_b) were failed for misreads that lasted several frames
(small blurred faces, people passing behind each other, an arm hidden by the body). A FAIL means paying for a
regeneration, so it is checked once more first.

`first_json(txt)` reads only the first JSON object in a reply (P009 f24 returned two objects: "Extra data").

Benchmark, SuperCool batch, 55 clips (34 good / 9 minor / 12 bad), Sonnet 5.5:
| run | cost | good clips failed | bad clips caught | bad clips passed |
|---|---|---|---|---|
| 1 | $9.39 | 18/34 | 12/12 | 0 |
| v2 | $3.29 | 6/34 | 12/12 | 0 |
| v3 | $1.73 | 5/34 | 12/12 (9 FAIL, 3 FLAG) | 0 |
Caveat: the rules were tuned on these same clips, so these numbers are optimistic until tested on new clips.

### Second opinion, v4 result and fix (2026-11-10)
v4 rescore ($0.26): good clips failed 2/34 (was 5; P011, P026, P037_b now FLAG), bad clips caught 12/12, none passed.
But the true fingers defect P002 dropped to FLAG: the checker said UNCERTAIN on all 3 frames ("can't verify the
finger count"). Every false fail came back mostly REJECTED. So `keep_rule`: a rule keeps its FAIL with >= 2
CONFIRMED, or with no REJECTED and >= 2 frames checked. Applied to the saved v4 decisions (no new calls):
P002 FAIL, P042 FAIL, P011/P026/P037_b/P013 FLAG. Tuned on 6 clips. `verify_fail` reuses `ai_verify.json`
decisions, so a rescore costs nothing (`force=True` asks again).

### Second opinion: a failed check is not a vote (2026-11-11, Phase 0)
Two replies on S1_r2_gemini had no JSON object; the error ("check failed: substring not found") was recorded as
UNCERTAIN, and UU keeps a FAIL, so a rule stayed failed on errors alone. Now `_verify_call` retries once with a
doubled budget; if the reply still has no JSON with a known decision (or the call raises), the frame is recorded as
`ERROR (not counted)` with the start of the reply, and left out of `keep_rule`. Fewer than 2 counted decisions still
means "FAIL kept unverified" (bug S2 policy). Errors saved by the old code are asked again on the next online run.
Test: `unit.verify_errors` (mocked API).

## Motion transfer checks from Name That Fight EP18 (2026-11-10)
EP18 (Ip Man 3 recast as a woman vs a grey-haired boxer) needed 20+ re-renders and splices. Its rejected
renders, with frame numbers written down at the time, are the test set (`peleas\ep18_name_that_fight\rejected\NOTES.md`).

**sync_check.py** - cut timing against the driving video. A spliced repair dropped or doubled frames at the join
and everything after ran ahead of the source. Guided matching (nearest cut-like jump to where each source cut
should land) + drift = 3 or more consecutive cuts off by >= 0.9 frames in one direction (or 2 cuts >= 2 frames).
Result: all 3 rejected splices FAIL at the frames the notes give (b1 -2 frames from f103, b3 -1.2 from f58,
g -5 frames), none of the 14 approved renders FAIL. A single cut 3+ frames off is a FLAG (the b3 tail).
Missing/extra cuts are notes only.

**role_source.py** - role swap against the source. Motion-transfer models re-map characters by position after
each cut, so a whole shot can be swapped, which frame_check's in-shot order check cannot see. Source actors are
found with YOLOX and clustered by clothing colour; the actor-to-character mapping is a vote of shots (not frames,
not the first frame: b3 v2's first two-person frame was inside the swapped shot). NOT SURE under 3 shots or
< 60% agreement. Result: b3 v2 FAIL f32-f47 (notes: f29-f59); b1 v3 FAIL 2.50-3.67 s (your note: 2.3-3.8 s);
approved b1 and b3 PASS, g v3 PASS. About 90 s per 12 s clip on this PC (step 4).
People count vs source was tried and is a NOTE only: approved fight close-ups got as many "extra person" hits
as the real one (g v3 f280-f287).

**frame_check --dense-motion 20** - every frame of the fastest 20% of motion is exported for review. The
anatomy defects at contact last 2-8 frames and a 4-frame sweep can step over them; the top 20% held 3/3, 5/5
and 5/6 of the known defect frames while covering 36-43% of each clip. On by default for shots with "driving".
Tried and dropped: "contact" from the two characters' clothing colours being close (did not separate defects).

**shot_qc spec keys**: "driving": {"video", "start", "roles", "step"} and "use": [t0, t1] (the seconds of the
render the edit uses; problems outside it become flags - EP18 b1 v3's swap was outside the 4-12 s used).
Fixed: frame_check markers such as "cut (...)" were turned into gate-G failures; cuts and sampling markers
are now ignored, outliers/dark corners are flags.

**Rules**: IDENTITY adds drift toward the source actor (gender-swapped Ip Man turning into a Donnie Yen lookalike);
WARDROBE adds accessories not in the design and recoloured parts; ANATOMY adds limb-type swaps at contact
(kick drawn as a hand, hand drawn as a shoe) and says to check every frame of a contact beat; new rule 23
SOURCE MATCH (people count, roles per shot, nothing copied from the source footage, check the last second).

App notes from the EP18 render log (not code): iconic finishes were blocked by the provider's IP / NSFW filters
(refunded) - plan alternates; ~4 concurrent jobs, the 5th returned "out of credits"; motion transfer ~7 credits/s;
short 3 s repair re-renders from the frame before the defect + splice + pixel edits on 1-4 frames were cheaper
than full re-renders, but every splice needs sync_check.
| v4 | $0.26 | 2/34 | 12/12 (8 FAIL, 4 FLAG; P002 wrongly dropped to FLAG) | 0 |
| v5 | $0.00 (reused v4 answers) | 2/34 | 12/12 (9 FAIL, 3 FLAG) | 0 |
v5 remaining false fails: P010, P027 (code head count). Not reviewed: P043, P028, P050 (spec vs start-frame head count disagree).

## Regression suite (regress.py, 2026-11-10)
Run after ANY change to these tools. Never calls the paid API (the key is removed inside the process and any
web call raises), never edits the saved test data (the benchmark rescore regenerates shot_spec.json with this
machine's paths, nothing else).
  python regress.py                  quick (~2 min): 7 unit tests + 18 EP18/SuperCool data cases
  python regress.py --full           + role-vs-source cases, end-to-end shot_qc, the 55-clip benchmark rescore
  python regress.py --full --accept  accept this run's benchmark verdicts as the new baseline (after checking them)
  python regress.py --only sync      just the cases whose id contains "sync"
Cases: regress_cases.json (each says what it protects and where the expected answer came from). Baseline:
regress_baseline.json (seeded from results_v5.csv). Reports: _tests/regress/. Exit code 1 on any FAIL/ERROR.
Checked that it catches breakage: the old keep rule, "every off cut is drift", "every marker is a failure"
and a too-small fast-motion share each turned the matching cases red.
batch_eval gained --offline (no key needed, never calls the API; a clip without saved verdicts is
"NOT REVIEWED (spec check)" or "NOT REVIEWED (offline)").

Bugs fixed while building it (each now has a case):
- S1 shot_qc showed an AI FLAG with no reason (verify_fail returned [] for a non-FAIL clip).
- S2 a failing rule whose frames were deleted from disk was dropped to FLAG without being checked; now it
  stays FAIL, marked unverified (also when offline).
- S3 verify_fail ignored its saved answers when no API key was set; it also rewrote ai_verify.json on every
  call - now only when it asked something new.
- batch_eval --rescore could still spend on a clip without saved verdicts; --offline makes that impossible.
- role_source with fewer than two roles crashed; now NOT CHECKED.

## Repair planner (repair_plan.py, 2026-11-10)
The cheapest fix for a failed render, built from how EP18 was actually repaired (render log), then built and checked.
  python repair_plan.py from-review QA_DIR --out defects.json          failed AI-review frames -> frame ranges per rule (+ boxes)
  python repair_plan.py plan RENDER.mp4 --defects defects.json [--use 4.0-12.0] [--json plan.json]
  python repair_plan.py build RENDER.mp4 PATCH.mp4 --replace 90-104 [--patch-from 0] --out OUT.mp4 --source FRAG.mp4
Actions, in order of preference: ignore (outside the used seconds) -> retime (sync drift: hold/drop frames, free)
-> trim (only the last second, no use window given) -> pixel_edit (a small wrong PART on <= 6 frames, box <= 15% of the
frame: WARDROBE/PROPS/NO MATERIALISING/... or a stray body part; 0.25 cr/frame) -> rerender (a 3-5 s piece of the
source, in-point on the cut before the problem if within 1.5 s, out-point on the next cut if within 2 s; ~7 cr/s,
3 s minimum; re-renders under 1 s apart are merged) -> full_rerender (re-renders would cover over half the used part).
On the EP18 defects the plans match what was done (ignore b1 v3, edits for the third hand / pouch / collar, re-render
from 0.5 s for the g pouch+jacket) and are cheaper where shots were close: b2 and g each needed 2 re-renders
(~42 cr), the planner merges them into one (21 cr).
build: (1) lands the PATCH'S OWN CUT on the render's cut at the out-join, holding its last frame (EP18 b1: the
re-rendered kick cut 2 frames early; rebuilt result matches the approved splice2 on every frame, max diff 1.1/255);
(2) runs sync_check against the source and holds/drops frames until no drift after the join. Note: sync_check alone
does NOT see a 2-frame leak at the join (it passed without step 1) - step 1 is what prevents it.
apply_edits(render, [{"frame", "image", "box"}], out): an edited frame (from an image model) is composited on its box
only, feathered; the report proves the change outside the boxes is exactly 0.
Not built: calling the generators (re-render, image edit) - the app's worker does that with the plan's fragment
times and start frames.

### Head count on the approved start = spec question (2026-11-10)
shot_qc: extra people that the approved start already contains are a SPEC CHECK flag, not a code FAIL. The approved
start count is the still's detector count, or the clip's frame 0 when the start check confirmed frame 0 is the still
(the detector can disagree between the two: P010's held photo scores 0.47 on the clip, under 0.45 on the still).
People beyond that count, appearing during the shot, still FAIL (P020, P053 unchanged). Offline check on
P010/P027/P020/P053: P010 FAIL (code) -> goes to review, P027 -> NOT REVIEWED (spec check), P020/P053 still FAIL.

## Clip-level action check (action_check.py, 2026-11-10) - MEASURING, not in the verdict yet
The frame review judges single frames; a reversed action (P030: "he hands the folder back" came out as him
TAKING it) looks fine frame by frame, and the review, shown the action text, repeated it in its own notes.
action_check: call 1 sees 8 frames in time order and NO action text -> blind description (who, what, which
direction, in what order, how it ends); call 2 (text only) compares that description with the shot's action ->
PASS / FLAG (weak, partial, extra move) / FAIL (missing, reversed, different action). ~$0.02/clip with Sonnet,
cached in action_check.json. unit.action_blind proves the frames call never contains the action text.
batch_eval --action-check records it in an "action" column and the summary says what would change if an
action FAIL failed the clip. Decide after measuring on the 55 clips.

### Action check is IN the verdict (2026-11-11, benchmark v8, $0.25)
Comparison v2 (the approved first frame wins over set-up the script describes) removed all 3 false FAILs of v7.
v8 action check: good clips FAIL 0 / FLAG 3 (all already flagged), minor FLAG 2 (P006 "turn barely reads" was PASS),
bad FAIL 1 = P030 (high confidence: "he keeps hold of it ... walks away carrying it").
action_check.apply: clip already FAIL or NOT REVIEWED -> unchanged; action FAIL + high confidence -> "FAIL (action)";
other action FAIL/FLAG -> at least FLAG. In batch_eval (--action-check), shot_qc (with ai_review; "action_check": false
turns it off; gate E) and the regression benchmark (offline, cached results). Unit: unit.action_apply.
Caveat: one caught example (P030), tuned on these clips. shot_qc's use of it is unit-tested via apply, not yet run
end to end with a key.

## Unseen-clip test: Keycard v4 (2026-11-11) and what changed
Labels from Londi's notes on the delivered v4 master (cases.json; batch_eval --cases works for any labelled set).
Run 1 ($4.34) was spoiled by a stale spec (CASTING.md "never above the shoulders", contradicted by the approved clips).
Run 2 ($6.51): B2A FAIL for the right reasons; B7b FAIL for a wrong reason (earbuds) - its real defect never reached
because of early stop; good clips 1 PASS / 7 FLAG / 3 FAIL (two-shot read as a head count, earbuds removed earlier in
the story, a garbled patch). Lessons: per-shot state (scene ledger), the spec must follow approvals, early stop hides
the defect a repair needs, set text policy. Keycard is now benchmark.keycard_v4 in regress.py.
Changes:
- TEXT (rule 21): readable set signage and plain patches are fine; garbled text / real brand logos FLAG; a TEXT failure
  fails the clip only when the shot spec has "no_text": true (Londi's call).
- Sweep after early stop: when the review stops early on a FAIL, up to 8 more frames spread over the rest of the clip
  are reviewed (about $0.10-0.30) so the repair planner sees the whole defect map. "sweep": 0 turns it off.

## Cost simulation: fewer frames (cost_sim.py, 2026-11-11)
The AI review is about 42% of a Kling clip's cost (Phase 0: $0.35 of $0.83), and its cost scales with frames sent.
`cost_sim.py` keeps every k-th of the frames a saved review already judged (as if exported at a lower rate),
re-runs the real decision code (clip_verdict, saved second opinions, the code result in shot_qc.json, the action
check) and compares with the human labels, for each benchmark and stride. Offline, $0. Stride 1 must reproduce the
saved results (it says so). A rule that newly FAILs at a sparse stride has no saved second opinion and stays FAIL
"unverified", so sparse strides can over-fail slightly. Next levers after this: shorter output (63% of the review
bill is output tokens), and Haiku 5.5 as a first pass ($0.10 / $0.50 per million tokens vs Sonnet 5.5 $2 / $10).

## Reviewer cost controls and the cheaper-reviewer experiment (exp_review.py, 2026-11-11)
cost_sim showed fewer frames loses bad clips (every 2nd frame: P049 passes; its defect showed only on f44/f60/f76).
So each frame must get cheaper. Facts (Anthropic docs, read 2026-11-11): Sonnet 5.5 $2 in / $10 out per million
tokens, Haiku 5.5 $0.10 / $0.50; thinking is ON by default on Claude 5.x and billed as output even though the reply
hides it; Sonnet 5.5 defaults to effort "high", Haiku 5.5 to "medium". Our requests set neither, so part of the
output share (63% of the review bill) is hidden thinking.
- `ai_review.request_options(effort, thinking)` -> `output_config.effort` / `thinking.type`; `--effort` and
  `--thinking` on `ai_review.py api` and `batch_eval.py`. `--verify-model` keeps second opinions on Sonnet.
- `ai_review.ping` + a batch_eval preflight: an option the API refuses fails for a fraction of a cent, before frames.
- `api_usage.jsonl` records effort and thinking per run.
- `exp_review.py --variant NAME --model M [--effort E] [--thinking T]` re-reviews all three benchmarks into
  `_tests\exp_NAME\` (saved Sonnet action checks and spec confirmations copied in), then reports cost, output
  tokens per frame, labels vs pipeline, and frames Sonnet failed that the variant missed. `--report A B` compares
  finished variants offline. Test `unit.request_options`.

## Default models (2026-11-12, from exp_review.py on all 3 benchmarks, 119 clips)
One shared setting, `DEFAULTS` and `DEFAULT_THINKING` in `ai_review.py`, which `batch_eval.py` reads:
- frame review: **Haiku 5.5, thinking off** (variant haiku_nothink)
- second opinion on an AI FAIL: **Sonnet 5.5**
- clip action check: **Sonnet 5.5**

| Variant | review $ | verify $ | bad clips caught | good clips falsely FAILed | good clips auto-PASS |
|---|---|---|---|---|---|
| Sonnet 5.5 (old default) | 30.48 | 1.50 | 26 of 27 | 5 | 18 of 61 |
| Haiku 5.5, effort medium | 4.69 | 1.33 | 27 of 27 | 5 | 13 of 61 |
| Haiku 5.5, thinking off | 1.87 | 2.26 | 27 of 27 | 3 | 12 of 61 |

Review plus verify fell from $31.98 to $4.13 (87% less) with no bad clip passed. Cost: fewer good clips pass
without a person looking (12 vs 18 of 61). Per Phase 0 Kling clip the checker is about $0.036 for review and
second opinions, about $0.06 with the Sonnet action check.
Not tested on any model: very fast action drawn on twos with cuts (Name That Fight EP20 rk_g). Treat those
clips' FAILs as "look here", not as final.
`regress.py` unit test `unit.default_models` fails if these defaults change; re-run exp_review before changing them.
Override per run: `--model`, `--thinking`, `--verify-model`, `--action-model`.
`shot_qc.py` uses the same defaults (was Opus 5.5 for all three steps until 2026-11-12). In a shot spec's
`"ai_review"` block, `"model"` alone pins all three steps (e.g. `"claude-opus-5-5"`, so specs that already name
Opus keep it); `"verify_model"`, `"action_model"` and `"thinking"` override one step each.

## End frames (end_frame.py, 2026-11-12)
Why: Phase 0 S3. Three end frames made by editing the approved start still ("same room, Layana at the shelf")
all had the shelf toys squeezed sideways: the image model redrew the whole picture and made room for her. The
video model lands on the end frame, so it slid the toys across the shelf during the clip (Londi's catch, clips
7 and 10-12). The edits also shifted the whole room 6-7 px down, which reads as a small camera move.

```powershell
$Tool = "C:\vid_projects\_tools\frame_check"
$St   = "C:\vid_projects\_phase0\route_test_2026-11-11\stills"
# free check: anything outside the characters that changed between start and end (exit code 1 = FLAG)
python "$Tool\end_frame.py" check "$St\S3_walk_pan.png" "$St\S3_end_turn.png" --out "$St\end_frame_check"
# rebuild an edited end frame so only the characters change
python "$Tool\end_frame.py" compose "$St\S3_walk_pan.png" "$St\S3_end_turn.png" "$St\S3_end_turn_composed.png"
```
- **check:** both frames aligned (the edit's whole-picture shift is measured and reported as `align`), characters
  masked in both (YOLOX people boxes, merged per body, then cut out with rembg `isnet-anime`), colour difference
  outside them boxed. PASS / FLAG with boxes in fractions; `end_frame_check.png` shows start | end with the
  characters tinted blue and drift boxed red. `--allow x0,y0,x1,y1` for a prop the shot means to move.
- **compose:** room pixel-for-pixel from the start still; characters from the edit; the spot a character left is
  the edit's repaint, Poisson-blended (cv2.seamlessClone) so it matches the wall and floor; one overall colour
  correction on the edit; then a repair pass restores from the start still anything the check still finds.
- **The app runs check before every render with an end frame** (worker `END_FRAME_GATE`, default `block`: the job
  fails before it is sent to the video model and the credits come back; `warn` only logs; `off`). Checker
  service endpoint `POST /end_frame`.
- Needs `python -m pip install "rembg[cpu]"` (onnxruntime; the 176 MB matting model downloads on first use).
  Without it the masks are the people boxes, which cannot see drift inside a character's box.

Tests (2026-11-12, `regress.py --only end_frame`, slow case, about 2 min on CPU):
| End frame | check | compose |
|---|---|---|
| S3_end_shelf2 (first edit) | FLAG, shelf toys + blocks | PASS |
| S3_end_watch (King turned) | FLAG, shelf toys + blocks | PASS |
| S3_end_turn (Layana stopped, facing camera) | FLAG, shelf toys + blocks | PASS |
| S3_end_turn_fixed (hand fix: shelf pasted from the start still, no alignment) | FLAG: the rest of the room is still 6-14 px off | - |
| start still vs itself | PASS | - |
Found and fixed while testing: a mask without Layana's head (the counting step kept a neck-down box; masks now
merge overlapping boxes); a ghost of the start position on the wall and a smudge beside King's head (wider mask
where a character left, Poisson blending only away from a character's new outline); a lighter halo (colour
correction); the ring stacker taken as part of Layana's arm (repair pass).
LIMITS: one room, locked camera (a deliberate new angle is drift everywhere); tested on one cartoon style and one
shot; the cut-out can leave a small streak where a prop touches a character (S3_end_watch composed: by her leg),
so look at the composed frame before using it.

## Sweep frames can FAIL a clip; second opinion stops at the first kept rule (2026-11-13)
Path test clip 15 (MiniMax): two green dog creatures appeared at 4-7 s. Haiku failed EVERY CREATURE, HEAD COUNT,
IDENTITY and WARDROBE in f120, f136, f156, but those were sweep frames (the review had stopped early on table
false alarms and sampled the rest thinly), so the frames between them were never reviewed and the "2 consecutive
frames" rule could not fire. Sonnet then correctly dismissed the table false alarms and the clip ended at FLAG.
Londi rejected it.
- `clip_verdict`: 3+ failing frames in a row among the REVIEWED frames (no reviewed frame between them that passes
  the rule) now FAIL too, reported as "(3 in a row of the reviewed frames)". Two such frames stay a FLAG; MINOR
  rules still only flag. Clip 15 rescored offline: FAIL.
- `verify_fail`: hard rules first (EVERY CREATURE, HEAD COUNT, NO MATERIALISING, IDENTITY, WARDROBE, SET LAYOUT),
  and it stops at the first rule it keeps; the others are listed as "not checked by the second opinion". Same
  verdict, at most 3 Sonnet calls once a defect is confirmed (clip 15 would otherwise have made 21).
- Tests: `unit.clip_verdict` 4 new cases. Run `regress.py --full` (no API) to see whether any benchmark clip changed.

"""Shared helpers for frame_check, stills_check and ai_review. @anlim"""
import json, os, subprocess
import numpy as np

def probe(p):
    o = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate:format=duration", "-of", "json", p],
                       capture_output=True, text=True, check=True).stdout
    d = json.loads(o); s = d["streams"][0]; n, m = s["r_frame_rate"].split("/")
    return int(s["width"]), int(s["height"]), float(n) / float(m), float(d["format"]["duration"])

def hsv(f):
    a = f.astype(np.float32) / 255; r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = a.max(-1); mn = a.min(-1); d = mx - mn + 1e-6
    hh = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return hh, d / (mx + 1e-6), mx

def locate_role(f, role, min_area=0.002, dominance=0.5):
    """Position of a character found by its colours in an RGB frame, as (x, y) fractions, or a string
    saying why not. Uses the LARGEST patch of the colour, and only when that patch holds at least
    `dominance` of all matching pixels: a colour that also appears elsewhere (wood cabinets, cups, another
    character) is reported as 'colour not unique' instead of giving a wrong position."""
    import cv2
    h0, h1, s0, s1, v0, v1 = role["hsv"]; H, S, V = hsv(f)
    m = ((H >= h0) & (H <= h1) & (S >= s0) & (S <= s1) & (V >= v0) & (V <= v1)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    total = int(m.sum())
    if total < role.get("min_area", min_area) * m.size: return "absent"
    n, lab, st, cen = cv2.connectedComponentsWithStats(m)
    big = 1 + int(np.argmax(st[1:, 4]))
    if st[big, 4] < dominance * total: return "colour not unique"
    return (float(cen[big][0] / m.shape[1]), float(cen[big][1] / m.shape[0]))

def validate_roles(roles, plate_path, limit=0.002):
    """Split roles into usable / disabled by checking each colour on the EMPTY set plate: a character
    colour that already covers more than `limit` of the empty set (wood cabinets read as 'orange') would
    give false positions. Returns (usable, messages)."""
    from PIL import Image
    im = Image.open(plate_path).convert("RGB"); w = 320; f = np.asarray(im.resize((w, int(im.height * w / im.width))))
    H, S, V = hsv(f); ok, msgs = [], []
    for r in roles:
        h0, h1, s0, s1, v0, v1 = r["hsv"]
        cov = float(((H >= h0) & (H <= h1) & (S >= s0) & (S <= s1) & (V >= v0) & (V <= v1)).mean())
        if cov > limit: msgs.append(f"roles: {r['name']} DISABLED, its colour covers {cov:.1%} of the empty set plate")
        else: ok.append(r)
    return ok, msgs

def extract(p, idx, out_dir, prefix):
    """Export the given frame numbers of video p at full native resolution, one PNG each."""
    os.makedirs(out_dir, exist_ok=True); paths = {}
    for c in range(0, len(idx), 60):
        chunk = idx[c:c + 60]
        sel = "+".join(f"eq(n\\,{i})" for i in chunk)
        tmp = os.path.join(out_dir, f"_{prefix}_%04d.png")
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", p, "-vf", f"select='{sel}'"]
        r = subprocess.run(cmd + ["-fps_mode", "passthrough", tmp], capture_output=True)
        if r.returncode != 0:                      # ffmpeg older than 5.1 has no -fps_mode
            subprocess.run(cmd + ["-vsync", "0", tmp], check=True)
        for k, i in enumerate(chunk):
            src = tmp.replace("%04d", f"{k + 1:04d}"); dst = os.path.join(out_dir, f"{prefix}_f{i:05d}.png")
            if os.path.exists(src): os.replace(src, dst); paths[i] = os.path.basename(dst)
    return paths

# ---------------------------------------------------------------- set-plate comparison
def plate_compare(img, plate_path, overlay_path=None):
    """Compare an image (path or RGB array) with its set plate.
    Matches fixed features (ORB + RANSAC), then reports how the room is scaled, shifted and
    rotated relative to the plate, how much of the plate's structure is found, and which grid
    cells of the plate's fixtures are missing in the image. Requires OpenCV.
    Characters standing in front of fixtures also show as 'missing' cells: these are review
    pointers, not verdicts."""
    import cv2
    P = cv2.imread(plate_path, cv2.IMREAD_GRAYSCALE)
    I = cv2.imread(img, cv2.IMREAD_GRAYSCALE) if isinstance(img, str) else cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    W = 960
    P = cv2.resize(P, (W, int(P.shape[0] * W / P.shape[1]))); I = cv2.resize(I, (W, int(I.shape[0] * W / I.shape[1])))
    orb = cv2.ORB_create(5000)
    k1, d1 = orb.detectAndCompute(P, None); k2, d2 = orb.detectAndCompute(I, None)
    if d1 is None or d2 is None: return {"ok": False, "why": ["no features found"]}
    good = []
    for m in cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(d2, d1, k=2):
        if len(m) == 2 and m[0].distance < 0.75 * m[1].distance: good.append(m[0])
    if len(good) < 15: return {"ok": False, "matches": len(good), "why": ["layout does not match plate (too few matching features)"]}
    src = np.float32([k2[m.queryIdx].pt for m in good]); dst = np.float32([k1[m.trainIdx].pt for m in good])
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if M is None: return {"ok": False, "matches": len(good), "why": ["layout does not match plate (no consistent fit)"]}
    inl = int(inl.sum()); scale = float(np.hypot(M[0, 0], M[1, 0])); rot = float(np.degrees(np.arctan2(M[1, 0], M[0, 0])))
    tx, ty = float(M[0, 2] / W), float(M[1, 2] / P.shape[0])
    warped = cv2.warpAffine(I, M, (P.shape[1], P.shape[0]))
    valid = cv2.warpAffine(np.full_like(I, 255), M, (P.shape[1], P.shape[0])) > 0
    eP = cv2.Canny(P, 60, 160) > 0; eI = cv2.Canny(warped, 60, 160) > 0
    eI = cv2.dilate(eI.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    gy, gx = 6, 8; ch, cw = P.shape[0] // gy, W // gx; missing = []
    for r in range(gy):
        for c in range(gx):
            sl = (slice(r * ch, (r + 1) * ch), slice(c * cw, (c + 1) * cw))
            n = eP[sl].sum()
            if n < 120 or valid[sl].mean() < 0.9: continue
            found = (eP[sl] & eI[sl]).sum() / n
            if found < 0.35: missing.append((r, c, round(float(found), 2)))
    total = eP & valid; found_all = float((total & eI).sum() / max(1, total.sum()))
    why = []
    # M maps image -> plate; scale_room = 1/scale = how big the room looks vs the plate (1.15 = 15% bigger)
    if abs(1 / scale - 1) > 0.05: why.append(f"room scale differs from plate by {100 * (1 / scale - 1):+.0f}%")
    if abs(rot) > 2: why.append(f"camera rotated {rot:+.1f} deg vs plate")
    if abs(tx) > 0.08 or abs(ty) > 0.08: why.append(f"camera shifted vs plate ({tx:+.2f}, {ty:+.2f} of frame)")
    if inl / len(good) < 0.25 or found_all < 0.45: why.append(f"layout differs from plate (structure found {found_all:.0%})")
    gone = [m for m in missing if m[2] < 0.10]
    if gone: why.append(f"{len(gone)} plate areas with NO plate structure left (fixture removed, moved or redrawn)")
    if len(missing) > len(gone):
        why.append(f"{len(missing) - len(gone)} plate areas partly hidden (person in front, or fixture changed)")
    if overlay_path:
        import cv2 as _c
        base = _c.imread(img) if isinstance(img, str) else _c.cvtColor(img, _c.COLOR_RGB2BGR)
        Hh, Ww = base.shape[:2]; Minv = _c.invertAffineTransform(M); sx = Ww / W
        for r, c, f in missing:
            pts = np.float32([[c * cw, r * ch], [(c + 1) * cw, r * ch], [(c + 1) * cw, (r + 1) * ch], [c * cw, (r + 1) * ch]])
            q = (_c.transform(pts[None], Minv)[0] * sx).astype(np.int32)
            _c.polylines(base, [q], True, (0, 0, 255), max(2, Ww // 400))
        _c.imwrite(overlay_path, base)
    return {"ok": True, "scale_room": round(1 / scale, 3), "rotation_deg": round(rot, 2), "shift": [round(tx, 3), round(ty, 3)],
            "matches": len(good), "inliers": inl, "structure_found": round(found_all, 2), "missing_cells": missing, "why": why}

# ---------------------------------------------------------------- viewer
VIEWER = r"""<!doctype html><html><head><meta charset="utf-8"><title>Frame review</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--bg:#111;--fg:#eee;--mut:#999;--acc:#f5c518;--bad:#ff5b5b;--ok:#4caf50}
body{margin:0;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}
header{display:flex;gap:10px 14px;align-items:center;padding:8px 16px;position:sticky;top:0;background:#000;z-index:3;flex-wrap:wrap}
#imgs{display:flex;gap:8px;padding:8px;justify-content:center;flex-wrap:wrap}
#imgs figure{margin:0;flex:1 1 420px;min-width:0} #imgs img{width:100%;height:auto;display:block}
.wrap{position:relative;line-height:0} .wrap svg{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
body.measuring .wrap{cursor:crosshair} body.measuring #outimg{outline:2px solid var(--acc)}
body.actual #imgs{display:block;overflow:auto} body.actual #imgs figure{margin-bottom:8px} body.actual #imgs img{width:auto;max-width:none}
body.actual .wrap{display:inline-block}
figcaption{color:var(--mut);padding:4px 0;line-height:1.3} .r{color:var(--acc)} .flag{color:var(--bad);font-weight:600}
#ai,#meas{padding:4px 16px 8px;color:var(--fg)} #ai .FAIL{color:var(--bad);font-weight:600} #ai .PASS{color:var(--ok);font-weight:600} #ai .UNSURE{color:var(--acc);font-weight:600} #ai .INCOMPLETE{color:var(--acc);font-weight:600}
button,input,select{font:inherit} #note{width:20em;max-width:100%} .mut{color:var(--mut)}
</style></head><body><header>
<b id="pos"></b><span id="time"></span><span id="why" class="r"></span><span id="mark" class="flag"></span>
<span class="mut">&larr;/&rarr; frame &middot; N next flagged &middot; Z actual size &middot; F flag &middot; M measure</span>
<input id="note" placeholder="note for this frame"><button id="save">Flag frame</button>
<span>Measure: <input id="who" list="whos" placeholder="character" style="width:9em"><datalist id="whos"></datalist>
<label class="mut"><input type="checkbox" id="baseline"> base is a shared line</label>
<button id="mbtn">Measure (M)</button><button id="mclr">Clear this character</button></span>
<button id="dl">Download flags + measures</button>
</header><div id="ai"></div><div id="meas"></div><div id="imgs"></div><script>
const M=__MANIFEST__;let k=0,flags={},meas={},mode=null;
const STEPS=['head','base','sl','sr','chin'],NAMES={head:'head-top',base:'base (feet or shared line)',sl:'left shoulder edge',sr:'right shoulder edge',chin:'chin (bottom of the face, for prop scale)'};
const isProp=w=>w.startsWith('prop:');const stepName=s=>mode&&isProp(mode.who)?({head:'TOP of the prop',base:'BOTTOM of the prop'}[s]):NAMES[s];
const COLS=['#ff5b5b','#4fc3f7','#f5c518','#81c784','#ba68c8','#ff9800'];
try{flags=JSON.parse(localStorage.getItem('fc_'+M.clip)||'{}')}catch(e){}
try{meas=JSON.parse(localStorage.getItem('fcm_'+M.clip)||'{}')}catch(e){}
for(const f of M.frames){if(f.measures)for(const c in f.measures){const id=f.key||f.i;meas[id]=meas[id]||{};if(!meas[id][c])meas[id][c]=f.measures[c]}}
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const dl=document.getElementById('whos');for(const n of Object.keys((M.lineup||{}).characters||{}))dl.insertAdjacentHTML('beforeend',`<option value="${esc(n)}">`);
for(const n of Object.keys((M.lineup||{}).props||{}))dl.insertAdjacentHTML('beforeend',`<option value="prop:${esc(n)}">`);
function persist(){try{localStorage.setItem('fc_'+M.clip,JSON.stringify(flags));localStorage.setItem('fcm_'+M.clip,JSON.stringify(meas))}catch(e){}}
function colour(c){const names=Object.keys(meas[cur()]||{});return COLS[Math.max(0,names.indexOf(c))%COLS.length]}
function cur(){const f=M.frames[k];return f.key||f.i}
function drawOverlay(){const svg=document.getElementById('ov');if(!svg)return;const img=document.getElementById('outimg');
const W=img.naturalWidth||1,H=img.naturalHeight||1;svg.setAttribute('viewBox',`0 0 ${W} ${H}`);let h='';const m=meas[cur()]||{};const r=Math.max(4,W/250);
for(const c in m){const p=m[c],col=colour(c);
 if(p.head&&p.base)h+=`<line x1="${p.head[0]*W}" y1="${p.head[1]*H}" x2="${p.head[0]*W}" y2="${p.base[1]*H}" stroke="${col}" stroke-width="${r/2}"/>`;
 if(p.base&&p.baseline)h+=`<line x1="${(p.base[0]-0.06)*W}" y1="${p.base[1]*H}" x2="${(p.base[0]+0.06)*W}" y2="${p.base[1]*H}" stroke="${col}" stroke-width="${r/2}" stroke-dasharray="${r*2}"/>`;
 if(p.sl&&p.sr)h+=`<line x1="${p.sl[0]*W}" y1="${p.sl[1]*H}" x2="${p.sr[0]*W}" y2="${p.sr[1]*H}" stroke="${col}" stroke-width="${r/2}"/>`;
 for(const s of STEPS)if(p[s])h+=`<circle cx="${p[s][0]*W}" cy="${p[s][1]*H}" r="${r}" fill="${col}" stroke="#000" stroke-width="${r/4}"/>`;
 if(p.head)h+=`<text x="${p.head[0]*W+r*1.5}" y="${p.head[1]*H-r}" fill="${col}" stroke="#000" stroke-width="${r/5}" font-size="${r*4}" font-weight="700">${esc(c)}</text>`;}
svg.innerHTML=h;
const lines=[];for(const c in m){const p=m[c];if(p.head&&p.base){const hp=Math.abs(p.base[1]-p.head[1])*H;let s=`${esc(c)}: ${hp.toFixed(0)} px ${p.baseline?'above shared line':'tall'}`;
 if(p.sl&&p.sr){const sw=Math.hypot((p.sr[0]-p.sl[0])*W,(p.sr[1]-p.sl[1])*H);s+=` &middot; shoulders ${sw.toFixed(0)} px`+(p.baseline?'':` (build ${(sw/hp).toFixed(3)})`)}lines.push(s)}}
const st=mode?`<span class="r">Measuring ${esc(mode.who)}: click the ${stepName(STEPS[mode.step])}${mode.step>=2&&mode.step<4?' (Enter to skip shoulders)':''}${mode.step===4?' (Enter to skip the chin)':''} &middot; Backspace undo &middot; Esc stop</span><br>`:'';
document.getElementById('meas').innerHTML=st+(lines.length?lines.join('<br>'):(mode?'':'<span class="mut">no measurements on this frame</span>'))}
function show(){const f=M.frames[k];const id=cur();
document.getElementById('pos').textContent=`${k+1}/${M.frames.length}  ${f.label||('frame '+f.i)}`;
document.getElementById('time').textContent=(f.t!=null)?f.t.toFixed(3)+' s':'';
document.getElementById('why').textContent=(f.why||[]).join(' | ');
document.getElementById('mark').textContent=flags[id]?'FLAGGED: '+flags[id]:'';document.getElementById('note').value=flags[id]||'';
const a=f.ai;document.getElementById('ai').innerHTML=a?`AI review: <span class="${esc(a.verdict)}">${esc(a.verdict)}</span> &middot; <span class="mut">${esc(a.description||'')}</span>`+
((a.issues||[]).length?'<ul>'+a.issues.map(x=>`<li>${esc(x.rule||'')}: ${esc(x.note||'')} <span class="mut">${esc(x.region||'')}</span></li>`).join('')+'</ul>':''):'<span class="mut">no AI review yet</span>';
const box=document.getElementById('imgs');box.innerHTML='';
for(const r of (f.refs||[])){box.insertAdjacentHTML('beforeend',`<figure><img src="${r.src}"><figcaption>${esc(r.label)}</figcaption></figure>`)}
box.insertAdjacentHTML('beforeend',`<figure><div class="wrap"><img id="outimg" src="${f.out}"><svg id="ov"></svg></div><figcaption>output</figcaption></figure>`);
if(f.overlay)box.insertAdjacentHTML('beforeend',`<figure><img src="${f.overlay}"><figcaption>plate check: red = plate structure not found</figcaption></figure>`);
const img=document.getElementById('outimg');img.onload=drawOverlay;img.onclick=clickImg;drawOverlay()}
function clickImg(e){if(!mode)return;const r=e.target.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
const id=cur();meas[id]=meas[id]||{};const p=meas[id][mode.who]=meas[id][mode.who]||{};p[STEPS[mode.step]]=[+x.toFixed(5),+y.toFixed(5)];
if(STEPS[mode.step]==='base')p.baseline=document.getElementById('baseline').checked;
mode.step++;if(mode.step>=STEPS.length||(isProp(mode.who)&&mode.step>=2))stopMeasure();persist();drawOverlay()}
function startMeasure(){const who=document.getElementById('who').value.trim();if(!who){document.getElementById('who').focus();return}
const id=cur();meas[id]=meas[id]||{};meas[id][who]={};mode={who,step:0};document.body.classList.add('measuring');persist();drawOverlay()}
function stopMeasure(){mode=null;document.body.classList.remove('measuring');drawOverlay()}
function save(){const id=cur();const v=document.getElementById('note').value.trim()||'flagged';flags[id]=v;persist();show()}
document.getElementById('save').onclick=save;document.getElementById('mbtn').onclick=startMeasure;
document.getElementById('mclr').onclick=()=>{const who=document.getElementById('who').value.trim();const id=cur();if(meas[id]&&who){delete meas[id][who];persist();drawOverlay()}};
document.getElementById('dl').onclick=()=>{const a=document.createElement('a');
a.href=URL.createObjectURL(new Blob([JSON.stringify({clip:M.clip,fps:M.fps||null,flags,measures:meas},null,1)],{type:'application/json'}));
a.download='flags_'+M.clip.replace(/\W+/g,'_')+'.json';a.click()};
const flagged=f=>(f.why||[]).some(w=>w!=='sweep')||(f.ai&&f.ai.verdict!=='PASS');
document.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT'){if(e.key==='Enter'&&e.target.id==='note')save();if(e.key==='Enter'&&e.target.id==='who')startMeasure();return}
if(mode){if(e.key==='Escape'){stopMeasure();return}if(e.key==='Backspace'){if(mode.step>0){mode.step--;delete meas[cur()][mode.who][STEPS[mode.step]];persist();drawOverlay()}e.preventDefault();return}
 if(e.key==='Enter'&&mode.step>=2&&mode.step<4){mode.step=4;drawOverlay();return}if(e.key==='Enter'&&mode.step>=4){stopMeasure();return}}
if(e.key==='ArrowRight'){stopMeasure();k=Math.min(k+1,M.frames.length-1)}else if(e.key==='ArrowLeft'){stopMeasure();k=Math.max(k-1,0)}
else if(e.key==='z'||e.key==='Z')document.body.classList.toggle('actual');else if(e.key==='f'||e.key==='F')save();
else if(e.key==='m'||e.key==='M'){startMeasure();return}
else if(e.key==='n'||e.key==='N'){stopMeasure();for(let j=k+1;j<M.frames.length;j++){if(flagged(M.frames[j])){k=j;break}}}else return;show()});
show();</script></body></html>"""

def write_viewer(man, out_dir):
    json.dump(man, open(os.path.join(out_dir, "manifest.json"), "w"), indent=1)
    open(os.path.join(out_dir, "review.html"), "w", encoding="utf-8").write(VIEWER.replace("__MANIFEST__", json.dumps(man)))

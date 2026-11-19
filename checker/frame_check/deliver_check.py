"""deliver_check.py - checks a delivered video before upload. @anlim

From the music-video lessons: "Music master unchanged", the delivered file must be the approved
cut, and size / frame rate / length must match the spec.

  python deliver_check.py DELIVERED.mp4 [--master-audio MASTER.wav|.mp3] [--approved APPROVED.mp4]
                          [--size 1920x1080] [--fps 24] [--every 2] [--out DIR]

  --master-audio  decodes both sound tracks, lines them up, and reports the offset, the level change
                  and how closely the delivered sound matches the master, second by second. A drop in
                  a stretch of seconds means something else is in the mix there (model audio, a
                  re-cut, a fade) - listen to those times.
  --approved      compares pictures at the same times (every N seconds) and lists times where the
                  delivered picture is not the approved one.
Writes DIR/deliver_report.json (DIR defaults to a deliver_check folder next to the delivered file).
"""
import argparse, json, os, subprocess, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fc_common import probe

SR = 16000

def streams(p):
    o = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels",
                        "-show_entries", "format=duration", "-of", "json", p], capture_output=True, text=True, check=True).stdout
    return json.loads(o)

def pcm(p):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768

def best_offset(a, b, max_s=10):
    """Lag (in samples) of b relative to a (positive: the master starts that late in the delivered
    file), from the loudness envelopes (10 ms) of both whole tracks."""
    def env(x):
        n = len(x) // 160 * 160; return np.abs(x[:n]).reshape(-1, 160).mean(1)
    ea, eb = env(a), env(b)
    ea = ea - ea.mean(); eb = eb - eb.mean()
    n = 1 << int(np.ceil(np.log2(len(ea) + len(eb))))
    c = np.fft.irfft(np.fft.rfft(eb, n) * np.conj(np.fft.rfft(ea, n)), n)
    lim = int(max_s * 100); cand = np.concatenate([c[:lim], c[-lim:]]); idx = np.argmax(cand)
    lag = idx if idx < lim else idx - 2 * lim
    # refine to the sample around the coarse lag
    base = lag * 160; seg = SR * 20; best, bl = -1, base
    a0 = a[SR * 5: SR * 5 + seg]
    for d in range(-200, 201, 2):
        s = SR * 5 + base + d
        if s < 0 or s + seg > len(b): continue
        v = float(np.dot(a0, b[s:s + seg]))
        if v > best: best, bl = v, base + d
    return bl

def snr_db(ref, x):
    g = float(np.dot(ref, x) / (np.dot(ref, ref) + 1e-12))
    err = x - g * ref
    return 10 * np.log10((np.dot(g * ref, g * ref) + 1e-12) / (np.dot(err, err) + 1e-12)), g

def frame_at(p, t, w=480):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", p, "-frames:v", "1", "-vf", f"scale={w}:-2",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8)

def analyze(delivered, master_audio=None, approved=None, size=None, fps=None, every=1.0, out=None, log=print):
    """Library entry point (for the app): returns the report dict ("problems" empty = passed). Writes
    deliver_report.json into `out` when given. `log` gets the human-readable lines (None = silent)."""
    log = log or (lambda *x: None)
    a = argparse.Namespace(delivered=delivered, master_audio=master_audio, approved=approved, size=size, fps=fps, every=every, out=out)
    rep = {"delivered": a.delivered, "problems": [], "notes": []}
    w, h, fps, dur = probe(a.delivered); st = streams(a.delivered)
    aud = [s for s in st["streams"] if s["codec_type"] == "audio"]
    rep.update(width=w, height=h, fps=round(fps, 3), duration=round(dur, 3), audio_streams=len(aud))
    log(f"{a.delivered}: {w}x{h}, {fps:.3f} fps, {dur:.2f} s, {len(aud)} audio stream(s)")
    if a.size:
        W, H = map(int, a.size.lower().split("x"))
        if (w, h) != (W, H): rep["problems"].append(f"size {w}x{h}, spec {W}x{H}")
    if a.fps and abs(fps - a.fps) > 0.01: rep["problems"].append(f"frame rate {fps:.3f}, spec {a.fps}")
    if not aud: rep["problems"].append("no audio stream")

    if a.master_audio and aud:
        m = pcm(a.master_audio); d = pcm(a.delivered)
        lag = best_offset(m, d, max_s=abs(len(d) - len(m)) / SR + 10)
        if lag >= 0: d2, m2 = d[lag:], m
        else: d2, m2 = d, m[-lag:]
        n = min(len(d2), len(m2)); d2, m2 = d2[:n], m2[:n]
        tot, g = snr_db(m2, d2)
        secs = []; quiet = set()
        for i in range(n // SR):
            r = m2[i * SR:(i + 1) * SR]; x = d2[i * SR:(i + 1) * SR]
            if np.sqrt(np.mean(r ** 2)) < 1e-3 and np.sqrt(np.mean(x ** 2)) < 1e-3: secs.append(None); continue
            if np.sqrt(np.mean(r ** 2)) < 0.01: quiet.add(i)       # master below -40 dBFS: fade tail / silence
            e = x - g * r                                         # same gain as the whole track
            secs.append(float(10 * np.log10((np.dot(g * r, g * r) + 1e-9) / (np.dot(e, e) + 1e-9))))
        vals = np.array([s for s in secs if s is not None]); med = float(np.median(vals)) if len(vals) else 0
        low = [i for i, s in enumerate(secs) if s is not None and s < min(med - 10, 15)]
        qlow = [i for i in low if i in quiet]; low = [i for i in low if i not in quiet]
        runs = []
        for i in low:
            if runs and i - runs[-1][1] <= 1: runs[-1][1] = i
            else: runs.append([i, i])
        mlen = len(m) / SR; dlen = len(d) / SR
        rep["audio"] = {"master": a.master_audio, "offset_ms": round(lag / SR * 1000, 1),
                        "level_change_db": round(20 * np.log10(abs(g) + 1e-12), 2), "match_snr_db": round(float(tot), 1),
                        "median_second_snr_db": round(med, 1), "master_s": round(mlen, 2), "delivered_audio_s": round(dlen, 2),
                        "low_match_seconds": [f"{r0 + max(lag, 0) / SR:.0f}-{r1 + 1 + max(lag, 0) / SR:.0f} s" for r0, r1 in runs]}
        A = rep["audio"]
        log(f"audio vs master: offset {A['offset_ms']} ms, level {A['level_change_db']:+.2f} dB, match {A['match_snr_db']} dB "
              f"(median second {A['median_second_snr_db']} dB); master {mlen:.2f} s, delivered audio {dlen:.2f} s")
        if tot < 20: rep["problems"].append(f"sound does not match the master (match {tot:.1f} dB; a re-encode of the same master scores well above 20)")
        if abs(A["level_change_db"]) > 1: rep["problems"].append(f"level changed by {A['level_change_db']:+.2f} dB")
        if abs(lag) / SR > 0.05: rep["problems"].append(f"sound starts {lag / SR * 1000:+.0f} ms off the master")
        if runs: rep["problems"].append("sound differs from the master at " + ", ".join(A["low_match_seconds"][:12]) + " (listen there)")
        if qlow: rep["notes"].append(f"{len(qlow)} very quiet second(s) differ (master below -40 dBFS, e.g. a fade tail) at "
                                     + ", ".join(f"{i + max(lag, 0) / SR:.0f} s" for i in qlow[:8]) + " - usually inaudible")
        if dlen < mlen - 0.5: rep["problems"].append(f"delivered sound is {mlen - dlen:.1f} s shorter than the master (ending cut?)")
        if dlen > mlen + 2: rep["notes"].append(f"delivered sound runs {dlen - mlen:.1f} s past the master (tail/outro?)")

    if a.approved:
        aw, ah, afps, adur = probe(a.approved)
        rep["approved_duration"] = round(adur, 3)
        if abs(adur - dur) > 1 / fps + 0.01: rep["problems"].append(f"length {dur:.2f} s, approved cut {adur:.2f} s")
        diffs = []; t = 0.5
        while t < min(dur, adur) - 0.2:
            x = frame_at(a.delivered, t).astype(np.float32); y = frame_at(a.approved, t).astype(np.float32)
            if len(x) and len(x) == len(y):
                # local test, not a whole-frame average: a changed patch (a re-rendered hand, a box, a
                # different shot) must not be averaged away by the unchanged rest of the frame
                g = np.abs(x - y).reshape(-1, 480)
                hh = g.shape[0] // 16 * 16; b = g[:hh].reshape(hh // 16, 16, 30, 16).mean((1, 3))
                diffs.append((round(t, 2), round(float((b > 20).mean()) * 100, 2)))
            t += a.every
        bad = [d for d in diffs if d[1] > 0.5]
        rep["picture"] = {"approved": a.approved, "times_checked": len(diffs), "different_times": bad}
        log(f"picture vs approved: {len(diffs)} times checked, {len(bad)} different" +
              (" (" + ", ".join(f"{t:.1f} s: {p}% of the frame" for t, p in bad[:8]) + ")" if bad else ""))
        if bad: rep["problems"].append("picture differs from the approved cut at " + ", ".join(f"{t:.1f} s" for t, _ in bad[:15]))

    if out:
        os.makedirs(out, exist_ok=True); json.dump(rep, open(os.path.join(out, "deliver_report.json"), "w"), indent=1)
    log("PROBLEMS:" if rep["problems"] else "no problems found by these checks")
    for p in rep["problems"]: log("  - " + p)
    for p in rep["notes"]: log("  note: " + p)
    if out: log(f"report: {os.path.join(out, 'deliver_report.json')}")
    return rep

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("delivered"); ap.add_argument("--master-audio"); ap.add_argument("--approved")
    ap.add_argument("--size"); ap.add_argument("--fps", type=float); ap.add_argument("--every", type=float, default=1.0)
    ap.add_argument("--out")
    a = ap.parse_args()
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.delivered)), "deliver_check")
    analyze(a.delivered, a.master_audio, a.approved, a.size, a.fps, a.every, out)

if __name__ == "__main__":
    main()

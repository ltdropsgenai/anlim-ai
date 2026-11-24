"""lipsync_check.py - does the mouth follow the voice? Free, no API. @anlim

Built 2026-11-23 after Londi's live test: a Kling lip sync "moves her lips but the movements do not match the words".
Measured on one clip and one voice (scratchpad comparison, 2026-11-23): mouth opening while speaking / in pauses, and
how closely the opening follows the voice's loudness (Pearson r, best of -6..+6 frames):
    original, no sync   0.001 / 0.001   r 0.18
    Kling LipSync       0.016 / 0.005   r 0.28   (Londi: does not land)
    VEED Lipsync v2     0.061 / 0.029   r 0.46   (Londi: "worked perfectly")
    Sync lipsync-2      0.003 / 0.001   r 0.30
    LatentSync          0.059 / 0.038   r 0.35
The thresholds below sit between the take Londi rejected and the one he accepted. They come from ONE test, so they
only FLAG a take for the creator to look at; they never pass or reject one on their own.

  python lipsync_check.py face  VIDEO VOICE [--from S]   before paying: is a face big enough to sync, while the voice plays?
  python lipsync_check.py sync  VIDEO VOICE              after: does the synced mouth follow the voice?
  VOICE is the audio exactly as sent to the lip sync model (already delayed and padded to the clip's length).

How: YuNet (OpenCV Zoo, already in models/) finds the largest face in each frame at 25 fps; that face is cropped with
a margin and enlarged, and MediaPipe Face Landmarker (models/face_landmarker.task, Apache-2.0) measures the gap between
the inner lips (landmarks 13 and 14) divided by the face height (10 to 152). Cropping first matters: run on the whole
frame, the landmarker missed a medium-size face in most frames.

LIMITS - read before trusting it:
- Tested on photoreal faces only. Cartoon faces may not be found; then it says NOT_CHECKED, never PASS.
- Loudness is not the same as mouth shape ("m" and "b" are loud with closed lips), so even a perfect sync scores
  well below 1. It catches a mouth that barely moves or moves at the wrong times, not a wrong vowel.
- One face only: the largest one in each frame. In a two-shot it measures whoever is biggest.
"""
import json, os, subprocess, sys
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
DET = os.path.join(HERE, "models", "face_detection_yunet_2023mar.onnx")
LMK = os.path.join(HERE, "models", "face_landmarker.task")
FPS = 25.0

# Provisional thresholds (see the table above).
FACE_FOUND_MIN = 0.6      # share of voiced frames where a face is measured; below it a sync cannot be judged or made
FACE_PX_MIN = 70          # face height in the clip's own pixels; the push-in take that failed had a face ~ this small
OPEN_MIN = 0.03           # mean inner-lip gap while speaking (VEED 0.061, Kling 0.016)
CORR_MIN = 0.38           # best r between mouth and loudness (VEED 0.46, Kling 0.28, unsynced 0.18)
RATIO_MIN = 1.4           # speaking gap / pause gap (VEED 2.1, LatentSync 1.55; the original "talked" through pauses)


def _frames(path, start_s=0.0):
    W, H = map(int, subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height", "-of", "csv=p=0", path]).decode().strip().split(",")[:2])
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{start_s:.3f}", "-i", path, "-vf", f"fps={FPS}", "-f", "rawvideo",
                          "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    n = W * H * 3
    try:
        while True:
            b = p.stdout.read(n)
            if len(b) < n: break
            yield np.frombuffer(b, np.uint8).reshape(H, W, 3)
    finally:
        p.stdout.close(); p.wait()


def _voice_rms(path, frames):
    pcm = np.frombuffer(subprocess.check_output(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000",
                                                 "-f", "s16le", "-"]), np.int16).astype(np.float32)
    hop = int(16000 / FPS)
    return np.array([np.sqrt(np.mean(pcm[k * hop:(k + 1) * hop] ** 2)) if (k + 1) * hop <= len(pcm) else 0.0
                     for k in range(frames)])


class Mouths:
    def __init__(self):
        import mediapipe as mp
        from mediapipe.tasks import python as mpt
        from mediapipe.tasks.python import vision
        self.mp = mp
        self.det = cv2.FaceDetectorYN.create(DET, "", (320, 320), 0.6, 0.3, 50)
        self.lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=mpt.BaseOptions(model_asset_path=LMK), running_mode=vision.RunningMode.IMAGE, num_faces=1))

    def measure(self, img):
        """(mouth gap / face height, face height in px) of the largest face, or (nan, nan)."""
        h, w = img.shape[:2]
        s = min(1.0, 1280 / max(h, w))
        im = cv2.resize(img, (int(w * s), int(h * s))) if s < 1 else img
        self.det.setInputSize((im.shape[1], im.shape[0]))
        _, faces = self.det.detect(im)
        if faces is None or len(faces) == 0: return float("nan"), float("nan")
        x, y, fw, fh = (max(faces, key=lambda f: f[2] * f[3])[:4] / s)
        side = max(fw, fh) * 1.8                                    # the whole head with a margin, as a square
        cx, cy = x + fw / 2, y + fh / 2
        x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
        x1, y1 = int(min(w, cx + side / 2)), int(min(h, cy + side / 2))
        crop = img[y0:y1, x0:x1]
        if crop.size == 0: return float("nan"), float("nan")
        crop = cv2.resize(crop, (384, int(384 * crop.shape[0] / crop.shape[1])), interpolation=cv2.INTER_LANCZOS4)
        rgb = np.ascontiguousarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        r = self.lm.detect(self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb))
        if not r.face_landmarks: return float("nan"), float(fh)
        L = r.face_landmarks[0]
        face = abs(L[152].y - L[10].y)
        if face <= 0: return float("nan"), float(fh)
        return abs(L[14].y - L[13].y) / face, float(fh)


def _corr(a, b):
    m = ~np.isnan(a) & ~np.isnan(b)
    if m.sum() < 10 or np.std(a[m]) == 0 or np.std(b[m]) == 0: return float("nan")
    return float(np.corrcoef(a[m], b[m])[0, 1])


def _shift(a, lag):
    out = np.full_like(a, np.nan)
    if lag > 0: out[:-lag] = a[lag:]
    elif lag < 0: out[-lag:] = a[:lag]
    else: out[:] = a
    return out


def _measure(video, voice, start_s=0.0):
    m = Mouths()
    mouth, faceh = [], []
    for f in _frames(video, start_s):
        g, fh = m.measure(f)
        mouth.append(g); faceh.append(fh)
    mouth, faceh = np.array(mouth), np.array(faceh)
    rms = _voice_rms(voice, len(mouth)) if len(mouth) else np.array([])
    speech = rms > 0.15 * rms.max() if len(rms) and rms.max() > 0 else np.zeros(len(mouth), bool)
    return mouth, faceh, rms, speech


def _r(v, n=4): return None if v is None or v != v else round(float(v), n)


def check_face(video, voice, start_s=0.0):
    """Before paying for a lip sync: while the voice plays, is there a face big enough to move?"""
    mouth, faceh, _, speech = _measure(video, voice, start_s)
    if not len(mouth) or not speech.any():
        return {"verdict": "NOT_CHECKED", "why": "the clip or the voice could not be read"}
    found = float(np.mean(~np.isnan(mouth[speech])))
    px = float(np.nanmedian(faceh[speech])) if (~np.isnan(faceh[speech])).any() else float("nan")
    ok = found >= FACE_FOUND_MIN and px == px and px >= FACE_PX_MIN
    why = None if ok else (
        "No face was found in this clip while the voice plays." if found == 0 else
        f"A face was found in only {round(100 * found)}% of the frames while the voice plays"
        + (f", and it is about {round(px)} px tall" if px == px else "") + ". Lip sync needs a face that is clearly "
        "visible and large enough (a close or medium shot, facing the camera).")
    return {"verdict": "OK" if ok else "TOO_SMALL", "why": why, "face_found_pct": round(100 * found, 1),
            "face_px": _r(px, 1), "frames": int(len(mouth))}


def check_sync(video, voice):
    """After a lip sync: does the mouth open when the voice speaks, and follow its loudness?"""
    mouth, faceh, rms, speech = _measure(video, voice)
    if not len(mouth) or not speech.any():
        return {"verdict": "NOT_CHECKED", "reasons": ["the clip or the voice could not be read"]}
    found = float(np.mean(~np.isnan(mouth[speech])))
    if found < FACE_FOUND_MIN:
        return {"verdict": "NOT_CHECKED", "face_found_pct": round(100 * found, 1),
                "reasons": [f"the face was measured in only {round(100 * found)}% of the speaking frames, too few to judge the sync"]}
    open_s, open_p = float(np.nanmean(mouth[speech])), float(np.nanmean(mouth[~speech])) if (~speech).any() else float("nan")
    lags = [(_corr(_shift(mouth, lag), rms), lag) for lag in range(-6, 7)]
    best, lag = max(lags, key=lambda t: t[0] if t[0] == t[0] else -9)
    reasons = []
    if open_s < OPEN_MIN: reasons.append(f"the mouth barely opens while the voice speaks (gap {open_s:.3f}; a good sync measured about 0.06)")
    if not (best >= CORR_MIN): reasons.append(f"the mouth does not follow the voice closely (score {best:.2f}; a good sync measured about 0.46)")
    if open_p == open_p and open_p > 0 and open_s / open_p < RATIO_MIN:
        reasons.append("the mouth moves as much in the pauses as while the voice speaks")
    if abs(lag) >= 4: reasons.append(f"the mouth runs {abs(lag) / FPS:.2f} s {'behind' if lag > 0 else 'ahead of'} the voice")
    return {"verdict": "FLAG" if reasons else "PASS", "reasons": reasons, "face_found_pct": round(100 * found, 1),
            "face_px": _r(np.nanmedian(faceh[speech]), 1), "mouth_open_speech": _r(open_s), "mouth_open_pause": _r(open_p),
            "corr": _r(best, 3), "lag_frames": int(lag), "frames": int(len(mouth))}


if __name__ == "__main__":
    if len(sys.argv) < 4 or sys.argv[1] not in ("face", "sync"): sys.exit(__doc__)
    start = float(sys.argv[sys.argv.index("--from") + 1]) if "--from" in sys.argv else 0.0
    res = check_face(sys.argv[2], sys.argv[3], start) if sys.argv[1] == "face" else check_sync(sys.argv[2], sys.argv[3])
    print(json.dumps(res))

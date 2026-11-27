# The people in a clip, cut out frame by frame (2026-11-27, for the cut-out effects: ghost, trails, clone, words
# behind the person, stepping out of a phone). MediaPipe's pose landmarker gives a soft mask of each person it finds
# (up to 4) on the CPU; the masks are joined, firmed up (the soft edge of a pose mask turns objects and the floor
# around the feet half see-through) and written as a grey video the size and frame rate of the clip, white = person.
# On the 2026-11-27 test (720x1280, 5 s, 2 cores) it took 5.3 s. The model file is the checker's own (models/). @anlim
#
# usage: python matte.py <clip> <out.mp4> <pose_landmarker_full.task>      prints {"frames": n, "found": n_with_people}
import json
import subprocess
import sys

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mpp
from mediapipe.tasks.python import vision


def main():
    src, dst, model = sys.argv[1:4]
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    opts = vision.PoseLandmarkerOptions(base_options=mpp.BaseOptions(model_asset_path=model),
                                        running_mode=vision.RunningMode.VIDEO, num_poses=4,
                                        output_segmentation_masks=True,
                                        min_pose_detection_confidence=0.4, min_tracking_confidence=0.4)
    lm = vision.PoseLandmarker.create_from_options(opts)
    enc = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray",
                            "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "-", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-crf", "10",
                            "-preset", "veryfast", "-pix_fmt", "yuv420p", dst], stdin=subprocess.PIPE)
    n = found = 0
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    try:
        while True:
            ok, f = cap.read()
            if not ok:
                break
            r = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(f, cv2.COLOR_BGR2RGB)),
                                    int(n * 1000 / fps))
            m = np.zeros((h, w), np.float32)
            for s in r.segmentation_masks or []:
                m = np.maximum(m, s.numpy_view().astype(np.float32).reshape(h, w))
            if m.max() > 0.5:
                found += 1
            # firm up: 0.35 and below is background, 0.65 and above person, a ramp between; then close small holes
            m = np.clip((m - 0.35) / 0.30, 0, 1)
            mu = (m * 255).astype(np.uint8)
            mu = cv2.morphologyEx(mu, cv2.MORPH_CLOSE, k)
            mu = cv2.GaussianBlur(mu, (3, 3), 0)
            enc.stdin.write(mu.tobytes())
            n += 1
    finally:
        enc.stdin.close()
        enc.wait()
        lm.close()
    if enc.returncode != 0:
        raise SystemExit("ffmpeg could not write the matte")
    print(json.dumps({"frames": n, "found": found}))


if __name__ == "__main__":
    main()

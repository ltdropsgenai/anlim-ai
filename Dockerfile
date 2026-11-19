# anlim.ai worker + checker in one Fly.io machine. @anlim
# Build from the repo root:  fly deploy   (fly.toml points here)
FROM node:22-bookworm-slim

# ffmpeg/ffprobe for the worker and the checker; Python for the checker.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Same versions as the machine the checker was benchmarked on (2026-11-19).
RUN python3 -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir \
      numpy==2.2.6 opencv-python-headless==5.0.0.93 pillow==12.3.0 onnxruntime==1.23.2 rembg==2.0.69
ENV PATH=/opt/py/bin:$PATH \
    U2NET_HOME=/opt/u2net
# rembg downloads its matting model on first use; fetch it at build time instead.
RUN python -c "from rembg import new_session; new_session('isnet-anime')" && chmod -R a+rX /opt/u2net

WORKDIR /app
COPY worker/package.json worker/package-lock.json* worker/
RUN cd worker && (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY worker/ worker/
COPY checker/ checker/
COPY deploy/start.sh /app/start.sh

ENV NODE_ENV=production \
    FRAME_CHECK_DIR=/app/checker/frame_check \
    CHECKER_HOST=127.0.0.1 \
    CHECKER_PORT=8787 \
    CHECKER_URL=http://127.0.0.1:8787 \
    STORAGE_MODE=function \
    WORK_DIR=/tmp/studio-work \
    PYTHONUNBUFFERED=1

RUN chmod +x /app/start.sh && useradd --create-home --uid 10001 app && chown -R app /app
USER app
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]

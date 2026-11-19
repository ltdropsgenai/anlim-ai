#!/usr/bin/env bash
# Starts the checker, waits for it, then the worker. If either stops, the machine exits and Fly restarts it. @anlim
set -euo pipefail
mkdir -p "${WORK_DIR:-/tmp/studio-work}"

# Tiny "ok" page on 8080 so Fly's health check has something to read; it serves nothing else.
mkdir -p /tmp/health && echo ok > /tmp/health/index.html
python -m http.server 8080 --bind 0.0.0.0 --directory /tmp/health >/dev/null 2>&1 &
HEALTH=$!

python /app/checker/service.py &
CHECKER=$!

for i in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/"${CHECKER_PORT:-8787}") 2>/dev/null; then break; fi
  if ! kill -0 "$CHECKER" 2>/dev/null; then echo "checker exited during start"; exit 1; fi
  sleep 1
done

node /app/worker/src/worker.js &
WORKER=$!

wait -n "$CHECKER" "$WORKER" "$HEALTH"
CODE=$?
echo "a process stopped (exit $CODE); stopping the other"
kill "$CHECKER" "$WORKER" "$HEALTH" 2>/dev/null || true
exit "$CODE"

#!/usr/bin/env bash
# Starts the checker, waits for it, then the worker. If either stops, the machine exits and Fly restarts it. @anlim
set -euo pipefail
mkdir -p "${WORK_DIR:-/tmp/studio-work}"

python /app/checker/service.py &
CHECKER=$!

for i in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/"${CHECKER_PORT:-8787}") 2>/dev/null; then break; fi
  if ! kill -0 "$CHECKER" 2>/dev/null; then echo "checker exited during start"; exit 1; fi
  sleep 1
done

node /app/worker/src/worker.js &
WORKER=$!

wait -n "$CHECKER" "$WORKER"
CODE=$?
echo "a process stopped (exit $CODE); stopping the other"
kill "$CHECKER" "$WORKER" 2>/dev/null || true
exit "$CODE"

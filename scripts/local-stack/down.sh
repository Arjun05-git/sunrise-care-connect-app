#!/usr/bin/env bash
# Stops the local stack started by up.sh.
cd "$(dirname "$0")/../.."
for s in gotrue postgrest storage gateway livekit; do
  f=.local-stack/$s.pid
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null && echo "stopped $s"
  rm -f "$f"
done
# setsid may fork, so also match the service command lines
for pat in "storage/dist/start/server.js" "gotrue serve" "local-stack/postgrest.conf" "local-stack/gateway.ts" "local-stack/livekit.yaml"; do pkill -f "$pat" 2>/dev/null || true; done
sleep 1

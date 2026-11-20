#!/usr/bin/env bash
# Rebuilds reports/dashboard.html every 15 minutes for the current session.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
while true; do
  if bash scripts/momo-node.sh src/cli.js dashboard >>logs/dashboard-refresh.log 2>&1; then
    printf '%s ok\n' "$(date -u +%FT%TZ)" >>logs/dashboard-refresh.log
  else
    echo "DASHBOARD_REFRESH_FAILED $(date -u +%FT%TZ)"
  fi
  sleep 900
done

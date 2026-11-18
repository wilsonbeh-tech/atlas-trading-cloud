#!/usr/bin/env bash
# Runs a JS file with system Node when available, otherwise with Qoder's embedded Node.
set -euo pipefail
if command -v node >/dev/null 2>&1; then
  exec node "$@"
fi
QODER_EXE="${QODER_EXE:-$LOCALAPPDATA/Programs/Qoder/Qoder.exe}"
if [ ! -f "$QODER_EXE" ]; then
  QODER_EXE="/c/Users/$USER/AppData/Local/Programs/Qoder/Qoder.exe"
fi
exec env ELECTRON_RUN_AS_NODE=1 "$QODER_EXE" "$@"

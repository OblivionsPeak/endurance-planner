#!/bin/bash
# Endurance Race Planner — Telemetry Bridge launcher (Mac / Linux)
# Usage: double-click or run  bash run_bridge.sh

DIR="$(cd "$(dirname "$0")" && pwd)"

# Prefer python3
if command -v python3 &>/dev/null; then
    PYTHON=python3
elif command -v python &>/dev/null; then
    PYTHON=python
else
    echo "Python is not installed."
    echo "Install it from https://www.python.org/downloads/"
    read -p "Press Enter to exit…"
    exit 1
fi

"$PYTHON" "$DIR/telemetry_bridge.py"

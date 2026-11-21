#!/bin/bash
# Golden-image check: renders fixed scenes in headless Chromium (software GL) and compares against test/golden/*.png.
#   scripts/golden.sh            compare (exit 1 on any scene above the tolerance)
#   scripts/golden.sh update     regenerate baselines
# Needs: chromium, ImageMagick (magick/compare). Output is deterministic only on the same GL implementation, so treat
# baselines as per-machine regression guards (SwiftShader), not cross-GPU truth.
set -u
cd "$(dirname "$0")/.."
MODE=${1:-check}
TOL=${GOLDEN_TOL:-0.06}            # normalised RMSE
PORT=5197
TMP=$(mktemp -d)
npx vite --port $PORT --strictPort >/dev/null 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null; rm -rf "$TMP"' EXIT
until curl -s localhost:$PORT >/dev/null; do sleep 0.5; done

declare -A SCENES=(
  [home]="seed=7&x=0&y=0&ff=0.02"
  [fleet]="seed=7&x=0&y=0&ff=0.02&hud=0&spawn=boss,sniper,tender,splitter,rammer"
  [shop]="seed=7&state=shop&ff=0.02"
  [map]="seed=7&state=map&ff=0.02"
  [gasgiant]="seed=1&x=560&y=-53&ff=0.02&hud=0"
)
fail=0
for name in "${!SCENES[@]}"; do
  raw="$TMP/$name.png"
  timeout 120 chromium --headless=new --no-sandbox --enable-unsafe-swiftshader --use-angle=swiftshader --ignore-gpu-blocklist \
    --window-size=1600,900 --virtual-time-budget=3000 --screenshot="$raw" "http://localhost:$PORT/?${SCENES[$name]}" >/dev/null 2>&1
  [ -s "$raw" ] || { echo "FAIL  $name: no screenshot"; fail=1; continue; }
  magick "$raw" -resize 800x450 "$TMP/$name.small.png"
  if [ "$MODE" = update ]; then cp "$TMP/$name.small.png" "test/golden/$name.png"; echo "updated $name"; continue; fi
  [ -f "test/golden/$name.png" ] || { echo "FAIL  $name: no baseline (run: scripts/golden.sh update)"; fail=1; continue; }
  out=$(compare -metric RMSE "test/golden/$name.png" "$TMP/$name.small.png" null: 2>&1)
  norm=$(echo "$out" | sed -n 's/.*(\(.*\)).*/\1/p')
  ok=$(awk -v n="${norm:-1}" -v t="$TOL" 'BEGIN{print (n<=t)?"ok":"bad"}')
  if [ "$ok" = ok ]; then echo "ok    $name  rmse=$norm"; else echo "FAIL  $name  rmse=$norm (tol $TOL)"; fail=1; fi
done
exit $fail

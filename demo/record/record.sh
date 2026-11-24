#!/usr/bin/env bash
# Records the README GIFs (demo/demo.gif, demo/kafka.gif, demo/themes.gif) from the dev UI with its fake backend.
# Needs Google Chrome, ffmpeg and gifski (brew install ffmpeg gifski). Starts bun run dev unless it already runs.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
work="${TMPDIR:-/tmp}/sauron-demo"
mkdir -p "$work"

for tool in ffmpeg gifski bun; do
  command -v "$tool" >/dev/null || { echo "missing $tool (brew install ffmpeg gifski)" >&2; exit 1; }
done

server=""
trap '[ -n "$server" ] && kill "$server" 2>/dev/null; pkill -f "remote-debugging-port=9333" 2>/dev/null || true' EXIT
if ! curl -s -o /dev/null http://localhost:1420/; then
  (cd "$root" && bun run dev >"$work/vite.log" 2>&1) &
  server=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null http://localhost:1420/ && break; sleep 0.5; done
fi

bun "$root/demo/record/scenes.ts" "$work"

# scenes.ts leaves a steady 30 fps sequence of the 2x frames; cut a 15 fps GIF per scene from it.
ffmpeg -nostdin -v error -y -framerate 30 -i "$work/seq/%05d.jpg" -vf "format=yuv420p" -c:v libx264 -crf 16 "$work/full.mp4"
while read -r name from to; do
  rm -rf "$work/png-$name" && mkdir -p "$work/png-$name"
  ffmpeg -nostdin -v error -y -ss "$from" -to "$to" -i "$work/full.mp4" -vf "fps=15,scale=1280:-1:flags=lanczos" "$work/png-$name/%04d.png"
  gifski --quiet --fps 15 --width 1280 --quality 95 -o "$root/demo/$name.gif" "$work/png-$name"/*.png
  echo "demo/$name.gif: $(du -h "$root/demo/$name.gif" | cut -f1)"
done <"$work/cuts.txt"

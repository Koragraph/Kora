#!/bin/bash
# A stand-in for a full-screen agent TUI: alt screen, every row drawn with cursor addressing at the PTY's current
# size, a "|" border on column 1 and the last column, the frame number and size in every row.
#   tui.sh TAG          redraws the whole screen every 50 ms (a spinner-heavy TUI)
#   tui.sh TAG lazy     redraws the whole screen only on start and on SIGWINCH, then touches one row a second (an idle agent)
TAG="${1:-T}"
MODE="${2:-busy}"
n=0
redraw=1
cleanup() { printf '\e[?25h\e[?1049l'; exit 0; }
trap cleanup INT TERM
trap 'redraw=1' WINCH
printf '\e[?1049h\e[?25l'
draw_row() {
  local r=$1 body
  body=$(printf '%s r%02d f%05d %dx%d' "$TAG" "$r" "$n" "$W" "$H")
  printf '\e[%d;1H|%-*s|' "$r" $((W - 2)) "$body"
}
while true; do
  # Clear the flag before reading the size: a SIGWINCH landing mid-iteration then forces another full redraw.
  full=0
  if [ "$MODE" = busy ] || [ "$redraw" = 1 ]; then full=1; redraw=0; fi
  W=$(tput cols); H=$(tput lines); n=$((n + 1))
  if [ "$full" = 1 ]; then
    for ((r = 1; r <= H; r++)); do draw_row "$r"; done
  elif [ $((n % 20)) = 0 ]; then
    draw_row 1
  fi
  sleep 0.05 & wait $!
done

#!/usr/bin/env bash
# Cold-start measurement for the shipped bundle. REPORT ONLY — per the Gate 1
# amendment there is no kill criterion and no threshold; "prefer good clean code
# first". This exists so the number is recorded next to its loadavg at each wave
# exit, because without the load figure the numbers are not comparable across
# sessions (the S2 spike measured the same command at 108ms and 323ms depending
# only on machine contention).
#
# Wall-clock via bash EPOCHREALTIME, so process spawn is included — that is what
# an agent loop actually feels. Cases are interleaved round-robin rather than run
# in blocks, so contention spreads across all cases instead of landing on
# whichever ran last.
set -uo pipefail
cd "$(dirname "$0")/.."

BUNDLE="dist/cli.mjs"
ROUNDS="${ROUNDS:-20}"
WARMUPS="${WARMUPS:-3}"

if [[ ! -f "$BUNDLE" ]]; then
  printf 'No %s — run `pnpm --filter symspec build` first.\n' "$BUNDLE" >&2
  exit 1
fi

loadavg() { cut -d' ' -f1-3 /proc/loadavg; }

printf 'node:     %s\n' "$(node --version)"
printf 'bundle:   %s bytes\n' "$(wc -c <"$BUNDLE")"
printf 'gzip:     %s bytes\n' "$(gzip -c "$BUNDLE" | wc -c)"
printf 'loadavg (start): %s\n' "$(loadavg)"
printf 'rounds:   %s (after %s warmups)\n\n' "$ROUNDS" "$WARMUPS"

# case label -> argv, plus a bare-node floor so a contended machine is detectable
# (if the floor is far above its quiet baseline, the run is not comparable).
declare -a LABELS=('bare node (floor)' 'manifest' 'version' 'explain' '--help')
declare -a ARGVS=('' 'manifest' 'version' 'explain --code ERR_IO' '--help')

declare -A SAMPLES
for label in "${LABELS[@]}"; do SAMPLES["$label"]=''; done

time_once() { # argv... -> milliseconds
  local start end
  start="${EPOCHREALTIME/./}"
  if [[ -z "$1" ]]; then
    node -e '' >/dev/null 2>&1
  else
    # shellcheck disable=SC2086
    node "$BUNDLE" $1 >/dev/null 2>&1
  fi
  end="${EPOCHREALTIME/./}"
  awk -v s="$start" -v e="$end" 'BEGIN { printf "%.1f", (e - s) / 1000 }'
}

for ((w = 0; w < WARMUPS; w++)); do
  for i in "${!LABELS[@]}"; do time_once "${ARGVS[$i]}" >/dev/null; done
done

for ((r = 0; r < ROUNDS; r++)); do
  for i in "${!LABELS[@]}"; do
    ms="$(time_once "${ARGVS[$i]}")"
    SAMPLES["${LABELS[$i]}"]+="$ms "
  done
done

printf '%-20s %9s %9s %9s %9s\n' case p50 p95 min max
printf '%-20s %9s %9s %9s %9s\n' -------------------- --------- --------- --------- ---------
for label in "${LABELS[@]}"; do
  echo "${SAMPLES[$label]}" | tr ' ' '\n' | grep -v '^$' | sort -n | awk -v label="$label" '
    { v[NR] = $1 }
    END {
      p50 = v[int(NR * 0.5) + (NR % 2 == 0 ? 0 : 1)]
      p95 = v[int(NR * 0.95) < 1 ? 1 : int(NR * 0.95)]
      printf "%-20s %8.1fms %8.1fms %8.1fms %8.1fms\n", label, p50, p95, v[1], v[NR]
    }'
done

printf '\nloadavg (end):   %s\n' "$(loadavg)"
printf 'Report only — no gate (Gate 1 amendment).\n'

#!/usr/bin/env bash
# Refreshes the tile data under the running gable-maps-tiles service, safe to run unattended (cron):
#
#   infra/refresh-tiles.sh [tiles-dir]      # default: infra/tiles; ~15 min on saman
#
# Order, each step only after the one before succeeded:
#   1. Guards, before anything is written: free space on the tiles filesystem at least
#      REFRESH_MIN_FREE_GB (20), the 1-minute load average under REFRESH_MAX_LOAD (8).
#   2. The lock <tiles-dir>/.refresh.lock (flock -n), shared with build-tiles.sh: a second run exits.
#   3. build-tiles.sh with TILES_STAGE_ONLY=1 builds <tiles-dir>/norway.mbtiles.new (the build's
#      own watchdog keeps all of <tiles-dir> under 9.5 GB, the live file included).
#   4. check-mbtiles.py on the new file (size against the live file, metadata, known tiles). A bad
#      file is deleted and the live file and service are not touched.
#   5. Swap: the live file is hard-linked to norway.mbtiles.prev, then the new file is renamed over
#      it (one atomic rename; the directory never lacks a norway.mbtiles).
#   6. martin keeps the file it opened at start (no reload or watch; infra/test-refresh-tiles.sh
#      proves it serves the replaced file until restarted), so the container is restarted: a few
#      seconds without tiles. Then /health, /catalog and the known tile on the service. If that
#      fails, .prev is renamed back and the service restarted on the old file.
#   7. .prev is deleted only once the new file is being served.
#
# Peak disk: during the build, the live file + cache + scratch (measured in build-tiles.sh); after
# it, live + new + .prev hard link = two files of ~2.2 GB beside the 0.9 GB water cache.
#
# The last line is always one of (for the lane-daemon catalog and the cron log):
#   refresh-tiles: OK <bytes of the new file> <seconds>
#   refresh-tiles: FAIL <reason>
# Exit codes: 0 OK, 2 low disk, 3 high load, 4 locked, 5 build failed, 6 new file failed its
# check (live untouched), 7 new file failed on the service (rolled back to the old file),
# 8 rollback did not bring the service back (tiles down: needs a human), 9 leftover
# norway.mbtiles.prev from an interrupted run (needs a human), 1 anything else.
#
# Overrides for tests (infra/test-refresh-tiles.sh), not for production use: REFRESH_BUILD_CMD (the
# builder; gets the tiles dir as $1 and must leave norway.mbtiles.new), TILES_CONTAINER (the martin
# container, default gable-maps-tiles), REFRESH_RESTART_CMD (default: docker restart it),
# TILES_HEALTH_URL (the host-side check, default http://127.0.0.1:8216/health; empty skips it),
# REFRESH_MIN_BYTES and the ratios (check-mbtiles.py).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
start_s=$(date +%s)
result=""
reason=""
rc_fail=1

finish() {
  local rc=$?
  if [[ -z "$result" ]]; then
    result="FAIL ${reason:-unexpected exit $rc}"
    (( rc == 0 )) && rc=$rc_fail
  fi
  echo "refresh-tiles: $result"
  exit "$rc"
}
trap finish EXIT
fail() { reason="$1"; rc_fail="$2"; exit "$2"; }
log() { echo "$(date -u +%FT%TZ) $*"; }

out="${1:-$here/tiles}"
[[ -d "$out" && -f "$out/norway.mbtiles" ]] \
  || fail "no live tiles at $out/norway.mbtiles (first build: infra/build-tiles.sh)" 1
out="$(cd "$out" && pwd)"
live="$out/norway.mbtiles"
new="$out/norway.mbtiles.new"
prev="$out/norway.mbtiles.prev"

# 1. Guards. Nothing has been written yet, and nothing is on a refusal.
min_free_gb="${REFRESH_MIN_FREE_GB:-20}"
max_load="${REFRESH_MAX_LOAD:-8}"
free_kb=$(df --output=avail -k "$out" | tail -n 1 | tr -d ' ')
need_kb=$(( min_free_gb * 1000 * 1000 * 1000 / 1024 ))
if (( free_kb < need_kb )); then
  fail "low disk: $(( free_kb * 1024 / 1000000000 )) GB free on the filesystem of $out, need $min_free_gb GB" 2
fi
read -r load1 _ < /proc/loadavg
if awk -v l="$load1" -v m="$max_load" 'BEGIN { exit !(l >= m) }'; then
  fail "high load: 1-minute load average $load1, limit $max_load" 3
fi

# 2. The lock (build-tiles.sh takes the same one when run by hand).
exec 9>"$out/.refresh.lock"
flock -n 9 || fail "locked: another refresh or build holds $out/.refresh.lock" 4

# A .prev means an earlier run died between the swap and its check: which file is good is not
# known here, so a human looks (the live file is whichever is at norway.mbtiles).
[[ ! -e "$prev" ]] || fail "leftover $prev from an interrupted run: check the service, then delete it" 9
# Ours to clear under the lock: a staged file nobody swapped in, and scratch a killed build left.
rm -f "$new"
for d in "$out"/.build-*; do [[ -d "$d" ]] && { log "removing leftover scratch $d"; rm -rf "$d"; }; done

container="${TILES_CONTAINER:-gable-maps-tiles}"
health_url="${TILES_HEALTH_URL-http://127.0.0.1:8216/health}"
restart() {
  if [[ -n "${REFRESH_RESTART_CMD:-}" ]]; then bash -c "$REFRESH_RESTART_CMD"; else docker restart -t 10 "$container" >/dev/null; fi
}
fetch() { docker exec "$container" wget -qO- "http://127.0.0.1:3000$1" 2>/dev/null; }
# The service answers health, lists the tiles and serves the known tile with street layers in it.
service_ok() {
  local i
  for (( i = 0; i < 60; i++ )); do
    fetch /health >/dev/null && break
    sleep 0.5
  done
  fetch /health >/dev/null || { log "service: no /health"; return 1; }
  # grep -c, not -q: -q exits at the first hit, the writer gets SIGPIPE and pipefail reads a hit as
  # a miss (gable CLAUDE.md, "Traps"). martin gunzips the tile for a client that sends no
  # Accept-Encoding, so the layer names are plain in it.
  (( $(fetch /catalog | grep -c '"norway"') > 0 )) || { log "service: norway not in /catalog"; return 1; }
  (( $(fetch /norway/14/8835/4118 | grep -ac transportation) > 0 )) \
    || { log "service: known tile 14/8835/4118 missing"; return 1; }
  if [[ -n "$health_url" ]]; then
    curl -fsS --max-time 5 -o /dev/null "$health_url" || { log "service: $health_url not answering"; return 1; }
  fi
}

# 3. Build into the staging name.
log "refresh starting in $out ($(( free_kb / 1024 / 1024 )) GiB free, load $load1)"
build_cmd="${REFRESH_BUILD_CMD:-$here/build-tiles.sh}"
if ! TILES_STAGE_ONLY=1 TILES_LOCK_HELD=1 "$build_cmd" "$out"; then
  rm -f "$new"
  fail "build failed (build-tiles.sh output above)" 5
fi
[[ -f "$new" ]] || fail "build finished without $new" 5

# 4. Check the new file before it goes near the service.
if ! verdict=$(python3 -I "$here/check-mbtiles.py" "$new" "$live"); then
  rm -f "$new"
  fail "new file failed its check, live file untouched: ${verdict#bad: }" 6
fi
log "new file: $verdict"
bytes=$(stat -c %s "$new")

# 5. Swap.
ln "$live" "$prev"
mv -f "$new" "$live"

# 6. Restart and check; roll back on failure.
t0=$(date +%s.%N)
restart || log "restart command failed"
if service_ok; then
  log "service back on the new file after $(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }') s"
else
  log "new file failed on the service: rolling back"
  mv -f "$prev" "$live"
  restart || log "restart command failed"
  if service_ok; then
    fail "new file failed on the service, rolled back to the old file" 7
  fi
  fail "rollback did not bring $container back: tiles are down" 8
fi

# 7. Done: the old file goes (its space was freed when martin let go of it in the restart).
rm -f "$prev"
result="OK $bytes $(( $(date +%s) - start_s ))"

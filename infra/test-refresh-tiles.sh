#!/usr/bin/env bash
# Tests for infra/refresh-tiles.sh (and check-mbtiles.py), against the real script, a real flock and
# a real martin (same image as the service) serving tiny fixture mbtiles in a throwaway container.
#
#   infra/test-refresh-tiles.sh                       # all cases
#   REFRESH_SCRIPT=path/to/copy infra/test-refresh-tiles.sh   # run them against another copy (red tests)
#
# Never touches the live service: every run sets TILES_CONTAINER, REFRESH_RESTART_CMD and
# REFRESH_BUILD_CMD to the test's own (run_refresh below), and the test container publishes no port.
# Temp files live in <repo>/.cache/refresh-test-* (gitignored, not /tmp) and are removed on any exit,
# with the test container; the last check asserts both are gone.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
script="${REFRESH_SCRIPT:-$here/refresh-tiles.sh}"
MARTIN_IMAGE="ghcr.io/maplibre/martin:1.16.1"
container="gable-maps-tiles-test-$$"

mkdir -p "$repo/.cache"
tmp="$(mktemp -d "$repo/.cache/refresh-test-XXXXXX")"
cleanup() {
  docker rm -f -v "$container" >/dev/null 2>&1 || true
  [[ -n "${holder:-}" ]] && kill "$holder" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

pass=0
failed=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; failed=$((failed + 1)); }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else no "$name"; fi; }

# A tiny mbtiles the checker accepts: the known tiles hold the street layers and a marker.
fixture() { # fixture <path> <marker> <replication time>
  python3 -I - "$@" <<'EOF'
import gzip, json, sqlite3, sys
path, marker, replication = sys.argv[1:4]
db = sqlite3.connect(path)
db.execute("create table metadata (name text, value text)")
db.execute("create table tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)")
layers = [{"id": i, "fields": {}} for i in
          ("transportation", "transportation_name", "building", "water", "place", "landcover")]
for k, v in {"name": "OpenMapTiles", "format": "pbf", "compression": "gzip", "minzoom": "0",
             "maxzoom": "14", "bounds": "4,57,32,72", "json": json.dumps({"vector_layers": layers}),
             "planetiler:osm:osmosisreplicationtime": replication}.items():
    db.execute("insert into metadata values (?, ?)", (k, v))
for x, y in ((8835, 4118), (8680, 4765)):
    data = gzip.compress(b"transportation building water " + marker.encode() + b" " * 4000)
    db.execute("insert into tiles values (14, ?, ?, ?)", (x, (1 << 14) - 1 - y, data))
db.commit()
EOF
  chmod 644 "$1"
}

# A fresh tiles dir with a live v1 file.
new_dir() {
  local d
  d="$(mktemp -d "$tmp/tiles-XXXXXX")"
  chmod 755 "$d"
  fixture "$d/norway.mbtiles" LIVE-V1 2026-11-01T00:00:00Z
  echo "$d"
}
fingerprint() { stat -c '%i' "$1/norway.mbtiles"; sha256sum < "$1/norway.mbtiles"; }

# Builders the refresh can be pointed at; each records that it ran.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/build-good" <<EOF
#!/usr/bin/env bash
touch "\$1/.built"
$(declare -f fixture)
fixture "\$1/norway.mbtiles.new" NEW-V2 2026-11-08T00:00:00Z
EOF
cat > "$tmp/bin/build-junk" <<'EOF'
#!/usr/bin/env bash
touch "$1/.built"; head -c 5000 /dev/urandom > "$1/norway.mbtiles.new"
EOF
cat > "$tmp/bin/build-older" <<EOF
#!/usr/bin/env bash
touch "\$1/.built"
$(declare -f fixture)
fixture "\$1/norway.mbtiles.new" OLD-V0 2026-10-01T00:00:00Z
EOF
cat > "$tmp/bin/build-fails" <<'EOF'
#!/usr/bin/env bash
touch "$1/.built"; echo "planetiler fell over" >&2; exit 1
EOF
chmod +x "$tmp/bin/"*

# run_refresh <dir> [VAR=value ...]: the script with safe test defaults; sets $rc and $last.
# The guards are opened by default so a case does not depend on the host's real load and disk
# (2026-11-08: five suites in parallel pushed the load past 8 and the rollback cases were refused);
# the guard cases set their own thresholds.
run_refresh() {
  local d="$1"; shift
  set +e
  env TILES_CONTAINER="$container" TILES_HEALTH_URL="" REFRESH_MAX_LOAD=1000 REFRESH_MIN_FREE_GB=0 \
    REFRESH_RESTART_CMD="touch '$d/.restarted'" REFRESH_BUILD_CMD="$tmp/bin/build-good" \
    REFRESH_MIN_BYTES=1 "$@" "$script" "$d" > "$d.log" 2>&1
  rc=$?
  set -e
  last="$(tail -n 1 "$d.log")"
}

start_martin() { # start_martin <dir>: the test martin on <dir>, ready to serve
  docker rm -f -v "$container" >/dev/null 2>&1 || true
  docker run -d --name "$container" --label com.gable.project=gable-maps-tiles \
    -v "$1:/data:ro" "$MARTIN_IMAGE" /data/norway.mbtiles >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$container" wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "test martin did not start" >&2; docker logs "$container" >&2; return 1
}
served() { docker exec "$container" wget -qO- http://127.0.0.1:3000/norway/14/8835/4118 2>/dev/null | grep -ac "$1" || true; }

echo "refresh-tiles tests against $script"

echo "guard: low disk"
d=$(new_dir); fp=$(fingerprint "$d")
run_refresh "$d" REFRESH_MIN_FREE_GB=999999
check "exits 2" test "$rc" = 2
check "last line is the FAIL line" grep -q '^refresh-tiles: FAIL low disk' <<< "$last"
check "no lock file, no build, no scratch" test ! -e "$d/.refresh.lock" -a ! -e "$d/.built" -a -z "$(ls -A "$d" | grep -v '^norway.mbtiles$')"
check "live file untouched" test "$fp" = "$(fingerprint "$d")"

echo "guard: high load"
d=$(new_dir); fp=$(fingerprint "$d")
run_refresh "$d" REFRESH_MAX_LOAD=0
check "exits 3" test "$rc" = 3
check "last line is the FAIL line" grep -q '^refresh-tiles: FAIL high load' <<< "$last"
check "no lock file, no build, no scratch" test ! -e "$d/.refresh.lock" -a ! -e "$d/.built" -a -z "$(ls -A "$d" | grep -v '^norway.mbtiles$')"
check "live file untouched" test "$fp" = "$(fingerprint "$d")"

echo "lock: a second run while one holds the lock"
d=$(new_dir); fp=$(fingerprint "$d")
flock "$d/.refresh.lock" sleep 30 & holder=$!
for _ in $(seq 1 50); do flock -n "$d/.refresh.lock" true 2>/dev/null || break; sleep 0.1; done
run_refresh "$d"
kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true; holder=""
check "exits 4" test "$rc" = 4
check "last line is the FAIL line" grep -q '^refresh-tiles: FAIL locked' <<< "$last"
check "did not build" test ! -e "$d/.built"
check "live file untouched" test "$fp" = "$(fingerprint "$d")"

echo "check: a junk new file"
d=$(new_dir); fp=$(fingerprint "$d")
run_refresh "$d" REFRESH_BUILD_CMD="$tmp/bin/build-junk"
check "exits 6" test "$rc" = 6
check "last line is the FAIL line" grep -q '^refresh-tiles: FAIL new file failed its check' <<< "$last"
check "built, then the new file is deleted" test -e "$d/.built" -a ! -e "$d/norway.mbtiles.new" -a ! -e "$d/norway.mbtiles.prev"
check "no restart" test ! -e "$d/.restarted"
check "live file untouched (inode and bytes)" test "$fp" = "$(fingerprint "$d")"

echo "check: a new file older than the live one"
d=$(new_dir); fp=$(fingerprint "$d")
run_refresh "$d" REFRESH_BUILD_CMD="$tmp/bin/build-older"
check "exits 6" test "$rc" = 6
check "names the reason" grep -q 'older than the live' <<< "$last"
check "no restart, live untouched" test ! -e "$d/.restarted" -a "$fp" = "$(fingerprint "$d")"

echo "check: under the size floor"
d=$(new_dir); fp=$(fingerprint "$d")
run_refresh "$d" REFRESH_MIN_BYTES=1000000000
check "exits 6" test "$rc" = 6
check "no restart, live untouched" test ! -e "$d/.restarted" -a "$fp" = "$(fingerprint "$d")"

echo "build: fails"
d=$(new_dir); fp=$(fingerprint "$d")
run_refresh "$d" REFRESH_BUILD_CMD="$tmp/bin/build-fails"
check "exits 5" test "$rc" = 5
check "no restart, live untouched" test ! -e "$d/.restarted" -a "$fp" = "$(fingerprint "$d")"

echo "leftover .prev from an interrupted run"
d=$(new_dir); fp=$(fingerprint "$d"); ln "$d/norway.mbtiles" "$d/norway.mbtiles.prev"
run_refresh "$d"
check "exits 9 without building" test "$rc" = 9 -a ! -e "$d/.built"

echo "martin: keeps serving a file renamed over until it restarts (why the refresh restarts it)"
d=$(new_dir); start_martin "$d"
check "serves v1" test "$(served LIVE-V1)" -gt 0
fixture "$d/next.mbtiles" NEW-V2 2026-11-08T00:00:00Z; mv -f "$d/next.mbtiles" "$d/norway.mbtiles"
check "still v1 after the rename" test "$(served LIVE-V1)" -gt 0
docker restart -t 1 "$container" >/dev/null; start_martin "$d"
check "v2 after a restart" test "$(served NEW-V2)" -gt 0

echo "green: swap, restart, the new file is served, .prev removed"
d=$(new_dir); start_martin "$d"
run_refresh "$d" REFRESH_RESTART_CMD="docker restart -t 1 $container >/dev/null"
check "exits 0" test "$rc" = 0
check "last line is OK <bytes> <seconds>" grep -Eq "^refresh-tiles: OK $(stat -c %s "$d/norway.mbtiles") [0-9]+$" <<< "$last"
check "the service serves the new tile" test "$(served NEW-V2)" -gt 0
check "no .prev, no .new left" test ! -e "$d/norway.mbtiles.prev" -a ! -e "$d/norway.mbtiles.new"

echo "rollback: the new file does not come up on the service"
d=$(new_dir); fp=$(fingerprint "$d"); start_martin "$d"
cat > "$tmp/bin/restart-once-broken" <<EOF
#!/usr/bin/env bash
# first restart leaves the service down, the second brings it back
if [[ ! -e "$d/.restarted" ]]; then touch "$d/.restarted"; docker stop -t 1 "$container" >/dev/null
else docker start "$container" >/dev/null; fi
EOF
chmod +x "$tmp/bin/restart-once-broken"
run_refresh "$d" REFRESH_RESTART_CMD="$tmp/bin/restart-once-broken"
check "exits 7" test "$rc" = 7
check "says it rolled back" grep -q '^refresh-tiles: FAIL new file failed on the service, rolled back' <<< "$last"
check "the old file is live again (inode and bytes)" test "$fp" = "$(fingerprint "$d")"
check "the service serves the old tile" test "$(served LIVE-V1)" -gt 0
check "no .prev, no .new left" test ! -e "$d/norway.mbtiles.prev" -a ! -e "$d/norway.mbtiles.new"

echo "rollback fails: the service stays down"
d=$(new_dir); start_martin "$d"
run_refresh "$d" REFRESH_RESTART_CMD="docker stop -t 1 $container >/dev/null"
check "exits 8" test "$rc" = 8
check "says tiles are down" grep -q 'tiles are down' <<< "$last"

echo "cleanup"
cleanup; trap - EXIT
check "temp dir removed" test ! -e "$tmp"
check "test container removed" test -z "$(docker ps -aq --filter "name=^$container$")"

echo "$pass passed, $failed failed"
(( failed == 0 ))

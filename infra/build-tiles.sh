#!/usr/bin/env bash
# Builds the self-hosted tile data the gable-maps-tiles service (infra/compose.yml) serves:
#   <out>/norway.mbtiles  OpenMapTiles-schema vector tiles of Norway (planetiler, openmaptiles profile)
#   <out>/fonts/          Noto Sans Regular, Bold, Italic (TTF; martin cuts the glyph PBFs from them)
#
#   infra/build-tiles.sh [out-dir]        # default: infra/tiles (gitignored, dockerignored)
#
# Decided by Morten 2026-11-07 (gable DECISIONS.md): our own tiles, not OpenFreeMap's public planet.
# This script is the first build. Refreshing a running service is infra/refresh-tiles.sh, which runs
# this with TILES_STAGE_ONLY=1: the result is left at <out>/norway.mbtiles.new and the live file and
# fonts are not touched (the fonts are pinned by hash, so a refresh only checks them); the refresh
# checks the new file, swaps it in and restarts the service. Both take the lock <out>/.refresh.lock
# (the refresh passes TILES_LOCK_HELD=1), so two builds never share <out>.
#
# Disk: the budget is 10 GB in all (ashguard's hosting go, 2026-11-08), the tiles being replaced
# included. The build scratch lives in <out>/.build-*; the whole of <out> is watched while planetiler
# runs (planetiler is killed above BUDGET_KB) and the scratch is removed on any exit, green or red.
# Measured 2026-11-08 with planetiler's defaults: the scratch peaked at 9.1 GiB (node map 2.0 GB and
# multipolygons 0.9 GB on disk, temp features 4.8 GB, the four inputs 2.8 GB kept to the end), over
# budget beside a 2.1 GB old output. Hence --storage=ram (node map and multipolygons in the heap,
# -Xmx10g) and --compress_temp. Planetiler runs as the calling user so everything it writes can be
# removed without root. The planetiler image is removed at the end (KEEP_PLANETILER_IMAGE=1 keeps it).
set -euo pipefail

PLANETILER_IMAGE="ghcr.io/onthegomap/planetiler:0.10.2"
# Noto Sans, OFL 1.1. Pinned commit of notofonts.github.io (2024-11-21) and the files' sha256.
NOTO_COMMIT="28b15b4b43b7bed62b5cf6e6b0b5ff5846270535"
NOTO_BASE="https://raw.githubusercontent.com/notofonts/notofonts.github.io/${NOTO_COMMIT}/fonts/NotoSans/unhinted/ttf"
declare -A NOTO_SHA256=(
  [NotoSans-Regular.ttf]=f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8
  [NotoSans-Bold.ttf]=87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9
  [NotoSans-Italic.ttf]=678288f868807d4d64a6f3b51466871d117d915780381ce9d0ed4b3bcbd06d37
)
OFL_URL="https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/4bc63d7ebca1faed49c6c685f380ba0abc2c1941/OFL.txt"
OFL_SHA256=cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a

BUDGET_KB=$((9500 * 1000 * 1000 / 1024)) # 9.5 GB for all of <out>: 10 GB less a margin for the 5 s sampling
BUILD_NAME="gable-maps-tiles-build"

here="$(cd "$(dirname "$0")" && pwd)"
out="$(mkdir -p "${1:-$here/tiles}" && cd "${1:-$here/tiles}" && pwd)"
stage_only="${TILES_STAGE_ONLY:-0}"
if [[ "${TILES_LOCK_HELD:-0}" != 1 ]]; then
  exec 9>"$out/.refresh.lock"
  flock -n 9 || { echo "build-tiles: another build or refresh holds $out/.refresh.lock" >&2; exit 4; }
fi
scratch="$(mktemp -d "$out/.build-XXXXXX")"
watch_pid=""

cleanup() {
  [[ -n "$watch_pid" ]] && kill "$watch_pid" 2>/dev/null || true
  docker rm -f -v "$BUILD_NAME" >/dev/null 2>&1 || true
  rm -rf "$scratch"
  if [[ "${KEEP_PLANETILER_IMAGE:-0}" != 1 ]]; then docker rmi "$PLANETILER_IMAGE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "disk before: $(df -h / | awk 'NR==2 {print $4 " free of " $2}')"
mkdir -p "$scratch/sources" "$scratch/tmp" "$scratch/fonts"

# Fonts first: cheap, and a hash mismatch should stop the run before the long part. A staged
# refresh does not replace them (pinned, so a new download would be the same bytes): it checks the
# live ones and stops if they are not the pinned files.
if [[ "$stage_only" == 1 ]]; then
  for f in "${!NOTO_SHA256[@]}"; do
    echo "${NOTO_SHA256[$f]}  $out/fonts/$f" | sha256sum -c --quiet - \
      || { echo "build-tiles: $out/fonts/$f is not the pinned font; run a full build-tiles.sh first" >&2; exit 1; }
  done
else
  for f in "${!NOTO_SHA256[@]}"; do
    curl -fsSL --retry 3 -o "$scratch/fonts/$f" "$NOTO_BASE/$f"
    echo "${NOTO_SHA256[$f]}  $scratch/fonts/$f" | sha256sum -c --quiet -
  done
  curl -fsSL --retry 3 -o "$scratch/fonts/OFL.txt" "$OFL_URL"
  echo "$OFL_SHA256  $scratch/fonts/OFL.txt" | sha256sum -c --quiet -
fi

# The ocean: planetiler's own download of water polygons fails when osmdata.openstreetmap.de is
# unreachable (it was from saman on 2026-11-08: "No route to host"). Fetched here first so a
# fallback can be named: WATER_POLYGONS_URL overrides the official file (an archived copy is
# acceptable; coastlines change slowly), or WATER_POLYGONS_FILE names a copy already on disk, which
# is moved in (not copied: it would count twice). Planetiler skips a download whose file is there.
# The last good zip is kept in <out>/cache/ (0.9 GB, inside the budget) and used when the download
# fails, so an unattended refresh does not depend on that host (2026-11-08: unreachable all day, and
# the only copy was the Wayback Machine's at ~200 KB/s). It goes into the scratch as a hard link, so
# planetiler's free-after-read drops the link, not the data, and du counts it once.
water="$scratch/sources/water-polygons-split-3857.zip"
water_cache="$out/cache/water-polygons-split-3857.zip"
zip_ok() { python3 -I -c 'import sys, zipfile; bad = zipfile.ZipFile(sys.argv[1]).testzip(); sys.exit(f"corrupt member {bad}" if bad else 0)' "$1"; }
if [[ -n "${WATER_POLYGONS_FILE:-}" ]]; then
  echo "water polygons from $WATER_POLYGONS_FILE (moved in)"
  mv "$WATER_POLYGONS_FILE" "$water"
else
  WATER_POLYGONS_URL="${WATER_POLYGONS_URL:-https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip}"
  echo "water polygons from $WATER_POLYGONS_URL"
  if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$water" "$WATER_POLYGONS_URL" || ! zip_ok "$water"; then
    rm -f "$water"
    [[ -f "$water_cache" ]] || { echo "build-tiles: water polygons download failed and there is no $water_cache" >&2; exit 1; }
    echo "water polygons download failed: using the kept copy $water_cache (saved $(date -u -r "$water_cache" +%F); the data can be older)"
    ln "$water_cache" "$water"
  fi
fi
zip_ok "$water"
if [[ ! "$water" -ef "$water_cache" ]]; then
  mkdir -p "$out/cache"
  ln -f "$water" "$out/cache/.water.tmp" && mv -f "$out/cache/.water.tmp" "$water_cache"
fi

# Watchdog: <out> (old output + scratch) must never grow past the budget. The peak is kept for the log.
peak_file="$scratch/.peak-kb"
echo 0 > "$peak_file"
(
  while sleep 5; do
    kb=$(du -sk "$out" 2>/dev/null | cut -f1)
    (( kb > $(cat "$peak_file") )) && echo "$kb" > "$peak_file"
    if (( kb > BUDGET_KB )); then
      echo "build-tiles: $out at ${kb} KB, over ${BUDGET_KB} KB: stopping planetiler" >&2
      docker kill "$BUILD_NAME" >/dev/null 2>&1 || true
      exit 1
    fi
  done
) &
watch_pid=$!

docker run --rm --name "$BUILD_NAME" --label com.gable.project=gable-maps-tiles \
  --user "$(id -u):$(id -g)" \
  -e JAVA_TOOL_OPTIONS="-Xmx10g" \
  -v "$scratch:/work" \
  "$PLANETILER_IMAGE" \
  --area=norway --download --download_dir=/work/sources --tmpdir=/work/tmp \
  --output=/work/norway.mbtiles --force --storage=ram --compress_temp=true \
  --free_water_polygons_after_read=true --free_natural_earth_after_read=true \
  --free_lake_centerlines_after_read=true --free_osm_after_read=true

kill "$watch_pid" 2>/dev/null || true
watch_pid=""
echo "peak of $out during the build: $(( $(cat "$peak_file") * 1024 / 1000000 )) MB (sampled every 5 s; budget $(( BUDGET_KB * 1024 / 1000000 )) MB)"

# Swap in: same filesystem, so each rename is atomic. A staged refresh stops at norway.mbtiles.new.
chmod a+r "$scratch/norway.mbtiles"
if [[ "$stage_only" == 1 ]]; then
  mv -f "$scratch/norway.mbtiles" "$out/norway.mbtiles.new"
  rm -rf "$scratch"
  echo "staged: $(du -sh "$out/norway.mbtiles.new" | cut -f1) at $out/norway.mbtiles.new; $(du -sh "$out" | cut -f1) in $out"
  exit 0
fi
rm -rf "$out/fonts.new" && mv "$scratch/fonts" "$out/fonts.new"
rm -rf "$out/fonts" && mv "$out/fonts.new" "$out/fonts"
mv -f "$scratch/norway.mbtiles" "$out/norway.mbtiles"
chmod -R a+rX "$out/fonts" "$out/norway.mbtiles"
rm -rf "$scratch"

echo "built: $(du -sh "$out/norway.mbtiles" | cut -f1) tiles, $(du -sh "$out/fonts" | cut -f1) fonts; $(du -sh "$out" | cut -f1) in $out"

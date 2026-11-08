#!/usr/bin/env bash
# Builds the self-hosted tile data the gable-maps-tiles service (infra/compose.yml) serves:
#   <out>/norway.mbtiles  OpenMapTiles-schema vector tiles of Norway (planetiler, openmaptiles profile)
#   <out>/fonts/          Noto Sans Regular, Bold, Italic (TTF; martin cuts the glyph PBFs from them)
#
#   infra/build-tiles.sh [out-dir]        # default: infra/tiles (gitignored, dockerignored)
#
# Decided by Morten 2026-11-07 (gable DECISIONS.md): our own tiles, not OpenFreeMap's public planet.
# Refreshing: run this again, then `docker compose -f infra/compose.yml restart tiles`. The old file is
# replaced only after a whole build succeeded (rename on the same disk), so a failed build serves the
# last good data. Cadence is not decided; the OSM extract changes daily, a map of streets and places
# needs it rarely (judgement: monthly is plenty).
#
# Disk: the budget is 10 GB in all (ashguard's hosting go, 2026-11-08). The build scratch lives in
# <out>/.build-*, is watched while planetiler runs (killed above BUILD_LIMIT_KB) and is removed on any
# exit, green or red. Planetiler runs as the calling user so everything it writes can be removed
# without root. The planetiler image is removed at the end (KEEP_PLANETILER_IMAGE=1 keeps it).
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

BUILD_LIMIT_KB=$((9 * 1024 * 1024)) # 9 GiB of scratch: the 10 GB budget less the output being replaced
BUILD_NAME="gable-maps-tiles-build"

here="$(cd "$(dirname "$0")" && pwd)"
out="$(mkdir -p "${1:-$here/tiles}" && cd "${1:-$here/tiles}" && pwd)"
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

# Fonts first: cheap, and a hash mismatch should stop the run before the long part.
for f in "${!NOTO_SHA256[@]}"; do
  curl -fsSL --retry 3 -o "$scratch/fonts/$f" "$NOTO_BASE/$f"
  echo "${NOTO_SHA256[$f]}  $scratch/fonts/$f" | sha256sum -c --quiet -
done
curl -fsSL --retry 3 -o "$scratch/fonts/OFL.txt" "$OFL_URL"
echo "$OFL_SHA256  $scratch/fonts/OFL.txt" | sha256sum -c --quiet -

# The ocean: planetiler's own download of water polygons fails when osmdata.openstreetmap.de is
# unreachable (it was from saman on 2026-11-08: "No route to host"). Fetched here first so a
# fallback can be named: WATER_POLYGONS_URL overrides the official file (an archived copy is
# acceptable; coastlines change slowly). Planetiler skips a download whose file is already there.
WATER_POLYGONS_URL="${WATER_POLYGONS_URL:-https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip}"
echo "water polygons from $WATER_POLYGONS_URL"
curl -fsSL --retry 3 --connect-timeout 20 -o "$scratch/sources/water-polygons-split-3857.zip" "$WATER_POLYGONS_URL"

# Watchdog: the scratch must never grow past the budget. The peak is kept for the log.
peak_file="$scratch/.peak-kb"
echo 0 > "$peak_file"
(
  while sleep 5; do
    kb=$(du -sk "$scratch" 2>/dev/null | cut -f1)
    (( kb > $(cat "$peak_file") )) && echo "$kb" > "$peak_file"
    if (( kb > BUILD_LIMIT_KB )); then
      echo "build-tiles: scratch at ${kb} KB, over ${BUILD_LIMIT_KB} KB: stopping planetiler" >&2
      docker kill "$BUILD_NAME" >/dev/null 2>&1 || true
      exit 1
    fi
  done
) &
watch_pid=$!

docker run --rm --name "$BUILD_NAME" --label com.gable.project=gable-maps-tiles \
  --user "$(id -u):$(id -g)" \
  -e JAVA_TOOL_OPTIONS="-Xmx6g" \
  -v "$scratch:/work" \
  "$PLANETILER_IMAGE" \
  --area=norway --download --download_dir=/work/sources --tmpdir=/work/tmp \
  --output=/work/norway.mbtiles --force \
  --free_water_polygons_after_read=true --free_natural_earth_after_read=true \
  --free_lake_centerlines_after_read=true --free_osm_after_read=true

kill "$watch_pid" 2>/dev/null || true
watch_pid=""
echo "scratch peak: $(( $(cat "$peak_file") / 1024 )) MB (sampled every 5 s)"

# Swap in: same filesystem, so each rename is atomic.
rm -rf "$out/fonts.new" && mv "$scratch/fonts" "$out/fonts.new"
rm -rf "$out/fonts" && mv "$out/fonts.new" "$out/fonts"
mv -f "$scratch/norway.mbtiles" "$out/norway.mbtiles"
chmod -R a+rX "$out/fonts" "$out/norway.mbtiles"
rm -rf "$scratch"

echo "built: $(du -sh "$out/norway.mbtiles" | cut -f1) tiles, $(du -sh "$out/fonts" | cut -f1) fonts; $(du -sh "$out" | cut -f1) in $out"

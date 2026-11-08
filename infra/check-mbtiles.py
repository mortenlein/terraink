#!/usr/bin/env python3
"""Sanity check of a freshly built norway.mbtiles before infra/refresh-tiles.sh swaps it in.

    python3 -I infra/check-mbtiles.py NEW [OLD]

Exit 0 and one line "ok ..." when NEW is plausible; exit 1 and "bad: <reason>" otherwise. Read-only
(the file is opened immutable). PRAGMA quick_check is not run: it took over two minutes on the
2.2 GB file (2026-11-08), and the checks below catch what a broken build actually leaves behind
(no file, a truncated or empty database, the wrong profile, an area that never rendered).

  - size at least REFRESH_MIN_BYTES (default 1 GB; the 2026-11-08 build is 2.2 GB) and, beside
    OLD, between REFRESH_MIN_RATIO and REFRESH_MAX_RATIO of it (default 0.6 and 1.6; judgement:
    a month of OSM edits moves Norway by a few percent, not by a third)
  - metadata format pbf, gzip compression, maxzoom 14, the OpenMapTiles vector_layers
  - the OSM replication time is not older than OLD's (a refresh must not go back in time)
  - the known tiles below exist, are gzip, and hold the layers a street map draws
"""
import gzip
import json
import os
import sqlite3
import sys

# z14 tiles (x, y in XYZ) the renderer has drawn: Mo i Rana (server/fixtures) and Oslo sentrum.
KNOWN_TILES = [
    ("Mo i Rana", 14, 8835, 4118, (b"transportation", b"building", b"water")),
    ("Oslo", 14, 8680, 4765, (b"transportation", b"building", b"water")),
]
REQUIRED_LAYERS = {"transportation", "transportation_name", "building", "water", "place", "landcover"}


def bad(reason: str) -> None:
    print(f"bad: {reason}")
    sys.exit(1)


def open_ro(path: str) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)


def metadata(db: sqlite3.Connection) -> dict:
    return dict(db.execute("select name, value from metadata").fetchall())


def main() -> None:
    if len(sys.argv) not in (2, 3):
        bad("usage: check-mbtiles.py NEW [OLD]")
    new = sys.argv[1]
    old = sys.argv[2] if len(sys.argv) == 3 and os.path.exists(sys.argv[2]) else None
    if not os.path.isfile(new):
        bad(f"{new} does not exist")

    size = os.path.getsize(new)
    min_bytes = int(os.environ.get("REFRESH_MIN_BYTES", 1_000_000_000))
    if size < min_bytes:
        bad(f"{size} bytes, under the floor of {min_bytes}")
    if old:
        old_size = os.path.getsize(old)
        lo = float(os.environ.get("REFRESH_MIN_RATIO", 0.6))
        hi = float(os.environ.get("REFRESH_MAX_RATIO", 1.6))
        if not lo * old_size <= size <= hi * old_size:
            bad(f"{size} bytes against {old_size} for the live file, outside {lo}..{hi}")

    try:
        db = open_ro(new)
        meta = metadata(db)
    except sqlite3.Error as e:
        bad(f"not a readable mbtiles: {e}")
    if meta.get("format") != "pbf" or meta.get("compression", "gzip") != "gzip":
        bad(f"format {meta.get('format')!r}, compression {meta.get('compression')!r}")
    if meta.get("maxzoom") != "14":
        bad(f"maxzoom {meta.get('maxzoom')!r}, not 14")
    try:
        layers = {layer["id"] for layer in json.loads(meta.get("json", "{}"))["vector_layers"]}
    except (ValueError, KeyError, TypeError):
        bad("metadata json has no vector_layers")
    missing = REQUIRED_LAYERS - layers
    if missing:
        bad(f"vector_layers missing {sorted(missing)}")

    replication = meta.get("planetiler:osm:osmosisreplicationtime", "")
    if old:
        try:
            old_replication = metadata(open_ro(old)).get("planetiler:osm:osmosisreplicationtime", "")
        except sqlite3.Error:
            old_replication = ""
        if old_replication and replication < old_replication:
            bad(f"OSM data from {replication or 'unknown'}, older than the live file's {old_replication}")

    for name, z, x, y, words in KNOWN_TILES:
        row = (1 << z) - 1 - y  # mbtiles rows are TMS: y counts from the south
        try:
            hit = db.execute(
                "select tile_data from tiles where zoom_level=? and tile_column=? and tile_row=?", (z, x, row)
            ).fetchone()
        except sqlite3.Error as e:
            bad(f"tiles not readable: {e}")
        if not hit or not hit[0]:
            bad(f"no tile for {name} ({z}/{x}/{y})")
        try:
            data = gzip.decompress(hit[0])
        except (OSError, EOFError):
            bad(f"tile for {name} ({z}/{x}/{y}) is not gzip")
        absent = [w.decode() for w in words if w not in data]
        if absent:
            bad(f"tile for {name} ({z}/{x}/{y}) has no {', '.join(absent)}")

    print(f"ok {size} bytes, OSM {replication or 'unknown'}, {len(KNOWN_TILES)} known tiles")


if __name__ == "__main__":
    main()

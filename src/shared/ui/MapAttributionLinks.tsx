/**
 * The tiles/data attribution links, shared by the inline mobile footer and the
 * desktop attribution modal so the text lives in one place. Tiles are self-hosted
 * (OpenMapTiles schema from OpenStreetMap data); addresses come from Kartverket
 * (CC BY 4.0, server/geocode.ts).
 */
export default function MapAttributionLinks() {
  return (
    <>
      Map data &copy;{" "}
      <a
        className="source-link"
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
      >
        OpenStreetMap contributors
      </a>
      {", tiles "}&copy;{" "}
      <a
        className="source-link"
        href="https://openmaptiles.org/"
        target="_blank"
        rel="noreferrer"
      >
        OpenMapTiles
      </a>
      {", addresses "}&copy;{" "}
      <a
        className="source-link"
        href="https://www.kartverket.no/"
        target="_blank"
        rel="noreferrer"
      >
        Kartverket
      </a>
      {" (CC BY 4.0) | Rendered with "}
      <a
        className="source-link"
        href="https://maplibre.org/"
        target="_blank"
        rel="noreferrer"
      >
        MapLibre
      </a>
      .
    </>
  );
}

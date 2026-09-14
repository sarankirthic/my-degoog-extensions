// OSM raster tile provider (ARCHITECTURE.md §1) — default dev/light-usage
// tiles, subject to the OSM tile usage policy (capacity-limited, best-effort):
// https://operations.osmfoundation.org/policies/tiles/

export function createOsmTileProvider() {
  return {
    id: "osm",
    isConfigured: () => true,
    tileUrl(z, x, y) {
      const sub = "abc"[(x + y) % 3];
      return `https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
    },
  };
}

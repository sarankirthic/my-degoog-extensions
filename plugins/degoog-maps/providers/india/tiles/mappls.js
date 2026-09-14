// Mappls static tile provider (ARCHITECTURE.md §1) — optional India-styled
// tiles, only available once a Mappls API key is configured.

const TILE_BASE = "https://apis.mappls.com/advancedmaps/v1";

export function createMapplsTileProvider({ apiKey } = {}) {
  const key = String(apiKey || "").trim();
  return {
    id: "mappls",
    isConfigured: () => Boolean(key),
    tileUrl(z, x, y) {
      return `${TILE_BASE}/${key}/still_map/standard/${z}/${x}/${y}.png`;
    },
  };
}

// Mappls (MapmyIndia) routing provider (ARCHITECTURE.md §1, §3) — the
// primary, India-accurate, traffic-aware provider. Uses REST-key auth
// (key embedded in the URL path) since the settings schema (§6) exposes a
// single API key field, not an OAuth2 client id/secret pair.
//
// Endpoint shapes below follow Mappls' public API docs (atlas.mappls.com,
// apis.mappls.com/advancedmaps). Verify against a live key and current
// Mappls docs before production use — this could not be tested end-to-end
// without a registered key.

import { providerError, normalizeOsrmStyleRoute } from "../../shared.js";

const GEOCODE_URL = "https://atlas.mappls.com/api/places/geocode";
const ROUTE_BASE = "https://apis.mappls.com/advancedmaps/v1";

export function createMapplsProvider({ apiKey } = {}) {
  const key = String(apiKey || "").trim();

  return {
    id: "mappls",
    isConfigured: () => Boolean(key),

    async geocode(query, { fetch: doFetch }) {
      if (!key) throw providerError("unavailable", "Mappls API key not configured");
      const url = `${GEOCODE_URL}?${new URLSearchParams({ address: query })}`;
      const res = await doFetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
      if (res.status === 429) throw providerError("rate-limit", "Mappls rate-limited", res.headers.get("retry-after"));
      if (!res.ok) throw providerError("transport", `Mappls geocode HTTP ${res.status}`);
      const data = await res.json();
      const results = Array.isArray(data?.results) ? data.results : null;
      if (!results) throw providerError("schema", "Mappls geocode response missing results[]");
      return results
        .map((r) => {
          const [lat, lon] = String(r.geoLocation || "").split(",").map(Number);
          return { label: r.formatted_address || r.poi || query, point: { lat, lon }, raw: r };
        })
        .filter((r) => Number.isFinite(r.point.lat) && Number.isFinite(r.point.lon));
    },

    async route(from, to, mode, { fetch: doFetch }) {
      if (!key) throw providerError("unavailable", "Mappls API key not configured");
      const profile = mode === "walk" ? "foot" : mode === "bike" ? "bike" : "driving";
      const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
      const url = `${ROUTE_BASE}/${key}/route_adv/${profile}/${coords}?${new URLSearchParams({ geometries: "geojson", steps: "true", overview: "full" })}`;
      const res = await doFetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 429) throw providerError("rate-limit", "Mappls rate-limited", res.headers.get("retry-after"));
      if (!res.ok) throw providerError("transport", `Mappls route HTTP ${res.status}`);
      const data = await res.json();
      if (data.code === "NoRoute" || data.code === "NoSegment") return []; // authoritative "no route", not a failure
      if (data.code !== "Ok" || !Array.isArray(data.routes)) throw providerError("schema", `Mappls route returned code=${data.code}`);
      return data.routes.map((r) => normalizeOsrmStyleRoute(r, mode, "mappls"));
    },
  };
}

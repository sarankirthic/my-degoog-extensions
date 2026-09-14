// OSRM routing provider (ARCHITECTURE.md §1, §3) — the no-API-key fallback
// behind Mappls. Paired with Nominatim for geocoding since OSRM itself has
// no geocoder. Defaults to the public demo server, which the OSRM project
// explicitly says is best-effort and not production infrastructure
// (https://operations.osmfoundation.org/policies/nominatim/).

import { providerError, normalizeOsrmStyleRoute } from "../../shared.js";

const DEFAULT_PUBLIC_BASE = "https://router.project-osrm.org";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "degoog-maps-plugin/1.0";

export function createOsrmProvider({ baseUrl } = {}) {
  const base = String(baseUrl || DEFAULT_PUBLIC_BASE).replace(/\/+$/, "");
  const usingPublicDemo = base === DEFAULT_PUBLIC_BASE;

  return {
    id: "osrm",
    usingPublicDemo,
    isConfigured: () => true,

    async geocode(query, { fetch: doFetch }) {
      const url = `${NOMINATIM_URL}?${new URLSearchParams({ q: query, format: "jsonv2", limit: "5", countrycodes: "in" })}`;
      const res = await doFetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (res.status === 429) throw providerError("rate-limit", "Nominatim rate-limited", res.headers.get("retry-after"));
      if (!res.ok) throw providerError("transport", `Nominatim HTTP ${res.status}`);
      const rows = await res.json();
      if (!Array.isArray(rows)) throw providerError("schema", "Nominatim returned a non-array body");
      return rows
        .map((r) => ({ label: r.display_name, point: { lat: Number(r.lat), lon: Number(r.lon) }, raw: r }))
        .filter((r) => Number.isFinite(r.point.lat) && Number.isFinite(r.point.lon));
    },

    async route(from, to, mode, { fetch: doFetch }) {
      const profile = mode === "walk" ? "foot" : mode === "bike" ? "bike" : "driving";
      const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
      const url = `${base}/route/v1/${profile}/${coords}?${new URLSearchParams({ overview: "full", geometries: "geojson", steps: "true" })}`;
      const res = await doFetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (res.status === 429) throw providerError("rate-limit", "OSRM rate-limited", res.headers.get("retry-after"));
      if (!res.ok) throw providerError("transport", `OSRM HTTP ${res.status}`);
      const data = await res.json();
      if (data.code === "NoRoute" || data.code === "NoSegment") return []; // authoritative "no route", not a failure
      if (data.code !== "Ok" || !Array.isArray(data.routes)) throw providerError("schema", `OSRM returned code=${data.code}`);
      return data.routes.map((r) => normalizeOsrmStyleRoute(r, mode, "osrm"));
    },
  };
}

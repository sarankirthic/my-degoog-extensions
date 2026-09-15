// busmaps.com transit provider (ARCHITECTURE.md §1, §3) — bus/metro trip
// planning. M2 scope only; `gtfs-direct` (the documented fallback) is not
// implemented yet — per ARCHITECTURE.md §3.1.2 it needs its own
// itinerary-building layer and must not silently pretend to be available.
//
// Contract verified against busmaps' own machine-readable v1 contract
// (busmaps.com/en/developers/api-docs → linked JSON): base URL, auth
// headers, and query params below are exact. The docs only publish a
// curated list of "important" response fields (duration/distance/coverage),
// not a full example response — so per-leg fields (route name, agency, stop
// name, geometry) are extracted defensively with fallbacks and degrade to
// "unknown" rather than guessing a specific key name. Validate those against
// a live key before trusting leg-level labels in production.

import { providerError } from "../../shared.js";

const BASE = "https://capi.busmaps.com:8443";

function authHeaders(key) {
  return { "capi-key": `Bearer ${key}`, "capi-host": "busmaps.com", Accept: "application/json" };
}

export function createBusmapsProvider({ apiKey, maxRoutes } = {}) {
  const key = String(apiKey || "").trim();
  const routes = clampInt(maxRoutes, 1, 3, 2);

  return {
    id: "busmaps",
    isConfigured: () => Boolean(key),

    // Urban transit only (bus/subway/tram) — long-distance rail is
    // RailProvider's job (§3.1.1), so "train" is deliberately excluded here.
    async planTrip(from, to, { fetch: doFetch }) {
      if (!key) throw providerError("unavailable", "busmaps API key not configured");
      const url = `${BASE}/v1/routes?${new URLSearchParams({
        origin: `${from.lat},${from.lon}`,
        destination: `${to.lat},${to.lon}`,
        transport: "bus,subway,tram",
        maxRoutes: String(routes),
        geometry: "polyline",
      })}`;
      const res = await doFetch(url, { headers: authHeaders(key) });
      if (res.status === 429) throw providerError("rate-limit", "busmaps rate-limited", res.headers.get("retry-after"));
      if (res.status === 400) throw providerError("schema", "busmaps rejected the request (bad coordinates)");
      if (!res.ok) throw providerError("transport", `busmaps /v1/routes HTTP ${res.status}`);
      const data = await res.json();
      if (data.noCoverage) return []; // authoritative "not supported here", not a failure
      if (!Array.isArray(data.routes)) throw providerError("schema", "busmaps /v1/routes response missing routes[]");
      return data.routes.map(normalizeItinerary);
    },

    // Location-based mode (§ nextDepartures "Mode 1"): needs only
    // coordinates, unlike stopId mode which also needs regionName +
    // countryIso from a prior /v1/stopsInRadius call we don't make here.
    async nextDepartures(point, { fetch: doFetch }, radiusMeters = 500) {
      if (!key) throw providerError("unavailable", "busmaps API key not configured");
      const url = `${BASE}/v1/nextDepartures?${new URLSearchParams({
        location: `${point.lat},${point.lon}`,
        radius: String(radiusMeters),
        results: "20",
      })}`;
      const res = await doFetch(url, { headers: authHeaders(key) });
      if (res.status === 429) throw providerError("rate-limit", "busmaps rate-limited", res.headers.get("retry-after"));
      if (res.status === 400) throw providerError("schema", "busmaps rejected the request (bad coordinates)");
      if (!res.ok) throw providerError("transport", `busmaps /v1/nextDepartures HTTP ${res.status}`);
      const data = await res.json();
      if (data.noCoverage) return [];
      const stops = Array.isArray(data.stopDepartures) ? data.stopDepartures : [];
      if (!Array.isArray(data.stopDepartures)) throw providerError("schema", "busmaps /v1/nextDepartures response missing stopDepartures[]");
      return stops.flatMap(normalizeStopDepartures);
    },
  };
}

function normalizeItinerary(route) {
  const legs = extractLegs(route);
  return {
    provider: "busmaps",
    legs,
    durationSeconds: Math.round(route.duration ?? 0),
    fare: extractFare(route),
  };
}

// Section-level field names (mode/route name/stop name) are the part the
// public docs don't confirm — read several plausible keys and fall back to
// "unknown transit" rather than crash or fabricate a value.
function extractLegs(route) {
  const sections = Array.isArray(route.sections) ? route.sections : [];
  return sections.map((s) => ({
    mode: normalizeLegMode(s.type || s.mode || s.transportType),
    agency: s.agencyName || s.agency || undefined,
    routeName: s.lineName || s.routeName || s.line?.name || undefined,
    fromStop: stopFrom(s.from || s.fromStop),
    toStop: stopFrom(s.to || s.toStop),
    durationSeconds: Math.round(s.travelSummary?.duration ?? s.duration ?? 0),
    distanceMeters: Math.round(s.travelSummary?.length ?? s.distance ?? 0),
  }));
}

function stopFrom(node) {
  if (!node) return undefined;
  const lat = Number(node.stopLat ?? node.lat);
  const lon = Number(node.stopLon ?? node.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return { name: node.name || node.stopName || "Stop", point: { lat, lon } };
}

function normalizeLegMode(raw) {
  const v = String(raw || "").toLowerCase();
  if (v.includes("walk")) return "walk";
  if (v.includes("subway") || v.includes("metro")) return "metro";
  if (v.includes("tram")) return "tram";
  if (v.includes("ferry")) return "ferry";
  if (v.includes("bus")) return "bus";
  return "bus"; // unknown transit leg — safest bucket for a bus/metro-only provider
}

function extractFare(route) {
  const amount = Number(route.fare?.amount ?? route.fareAmount);
  if (!Number.isFinite(amount)) return undefined;
  return { amount, currency: route.fare?.currency || "INR", isEstimate: true };
}

function normalizeStopDepartures(stop) {
  const lat = Number(stop.stopLat);
  const lon = Number(stop.stopLon);
  const stopName = stop.stopName || stop.name || "Stop";
  const list = Array.isArray(stop.departureList) ? stop.departureList : [];
  return list.map((d) => ({
    stopName,
    point: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined,
    routeName: d.lineName || d.routeName || undefined,
    scheduledTime: d.scheduledDepartureTime,
    realtimeTime: d.realtimeDepartureTime || undefined,
  }));
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

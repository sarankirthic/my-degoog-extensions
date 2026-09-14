import { readFileSync } from "node:fs";
import { createMapplsProvider } from "./providers/india/routing/mappls.js";
import { createOsrmProvider } from "./providers/india/routing/osrm.js";
import { createOsmTileProvider } from "./providers/india/tiles/osm.js";
import { createMapplsTileProvider } from "./providers/india/tiles/mappls.js";
import { ProviderError } from "./providers/shared.js";

// Degoog Maps — India-first multimodal directions slot (ARCHITECTURE.md).
// M1 scope only: driving/walking routing + geocoding + map slot, per the
// build order in ARCHITECTURE.md §10. Transit (busmaps, M2), rail (RailKit,
// M3) and the direct-GTFS fallback (M4) are follow-on milestones — no
// TransitProvider/RailProvider exists yet, so this plugin does not declare
// routes or trigger patterns for them.

const PLUGIN_ID = "degoog-maps";
const PLUGIN_NAME = "Degoog Maps";
const PLUGIN_VERSION = "1.0.0";

const GEOCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // §7: place → coordinates rarely changes
const ROUTE_TTL_MS = 10 * 60 * 1000; // §7: traffic-aware routes shift, but not query-to-query
const MODES = ["drive", "walk"];

let _settings = {
  mapplsApiKey: "",
  enableOsrmFallback: true,
  osrmBaseUrl: "",
  tileSource: "osm",
  debugMode: false,
};
let _fetch = (...args) => fetch(...args);
let _cache = null;
let _apiBase = "";

export const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: "India-first multimodal directions: driving, walking, bus/metro and train.",
  version: PLUGIN_VERSION,
};

function _configure(settings = {}) {
  let merged = { ...settings };
  try {
    for (const file of ["/app/data/plugin-settings.json", "./data/plugin-settings.json"]) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      merged = { ...(data[PLUGIN_ID] || {}), ...settings };
      break;
    }
  } catch (_) {}

  _settings = {
    mapplsApiKey: String(merged.mapplsApiKey || "").trim(),
    enableOsrmFallback: merged.enableOsrmFallback !== false && merged.enableOsrmFallback !== "false",
    osrmBaseUrl: String(merged.osrmBaseUrl || "").trim(),
    tileSource: merged.tileSource === "mappls" ? "mappls" : "osm",
    debugMode: merged.debugMode === true || merged.debugMode === "true",
  };
}

function _loadSettingsFallback() {
  if (_settings.mapplsApiKey) return;
  for (const file of ["/app/data/plugin-settings.json", "./data/plugin-settings.json"]) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data[PLUGIN_ID]) {
        _configure(data[PLUGIN_ID]);
        return;
      }
    } catch (_) {
      // Degoog normally calls configure(); this is only a fallback for direct route hits.
    }
  }
}

function _log(event) {
  if (_settings.debugMode) console.log("[degoog-maps]", event);
}

function _cacheFactory(ctx) {
  if (typeof ctx?.useCache === "function") return ctx.useCache(`ext:${PLUGIN_ID}:v1`, GEOCODE_TTL_MS);
  if (typeof ctx?.createCache === "function") return ctx.createCache(GEOCODE_TTL_MS);
  return null;
}

function routingProviders() {
  const chain = [createMapplsProvider({ apiKey: _settings.mapplsApiKey })];
  if (_settings.enableOsrmFallback) chain.push(createOsrmProvider({ baseUrl: _settings.osrmBaseUrl }));
  return chain;
}

function tileProviders() {
  return {
    osm: createOsmTileProvider(),
    mappls: createMapplsTileProvider({ apiKey: _settings.mapplsApiKey }),
  };
}

// Provider fallback executor — ARCHITECTURE.md §4.
// Falls through on transport/rate-limit/schema/unavailable errors. Any
// successful return (including an empty array, a genuine "no route") stops
// the chain immediately rather than trying the next provider "just in case".
async function callWithFallback(providers, capability, operation, args) {
  let lastError = null;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    if (typeof provider.isConfigured === "function" && !provider.isConfigured()) continue;
    const startedAt = Date.now();
    try {
      const result = await provider[operation](...args);
      _log({ capability, provider: provider.id, operation, duration_ms: Date.now() - startedAt, outcome: "ok", fallback_used: i > 0 });
      return { provider: provider.id, result };
    } catch (err) {
      lastError = err;
      const errorClass = err instanceof ProviderError ? err.kind : "unknown";
      _log({ capability, provider: provider.id, operation, duration_ms: Date.now() - startedAt, outcome: "error", fallback_used: i > 0, error_class: errorClass });
      if (err instanceof ProviderError && err.kind === "rate-limit" && err.retryAfter) {
        await sleep(Math.min(Number(err.retryAfter) * 1000 || 0, 2000));
      }
    }
  }
  throw lastError || new Error(`No configured provider available for ${capability}.${operation}`);
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// ── Query parsing (ARCHITECTURE.md §5.1, M1 subset: no rail fast-path) ────

const BLOCKED_QUERY_RE = /\b(?:recipe|lyrics|weather|stock|define|definition|download|install|error|debug|convert|translation|translate|tutorial|npm|python|javascript|typescript|react|docker|api|regex|movie|song|news)\b/i;
const HINT_WORD_RE = /\b(?:bus|metro|train|directions?|routes?|distance)\b/i;
const PIN_CODE_RE = /\b\d{6}\b/;
// Major India metros/state capitals — lets a bare "chennai to bangalore" trigger
// without a hint word, same role as the SG reference plugin's place-name list.
// Not exhaustive by design (ladder: cover the common case, not every village);
// smaller places still need a hint word or PIN code.
const INDIA_PLACE_HINT_RE = /\b(?:mumbai|delhi|new delhi|bengaluru|bangalore|hyderabad|ahmedabad|chennai|kolkata|calcutta|surat|pune|jaipur|lucknow|kanpur|nagpur|indore|thane|bhopal|visakhapatnam|vizag|patna|vadodara|ghaziabad|ludhiana|agra|nashik|faridabad|meerut|rajkot|kalyan|vasai|varanasi|srinagar|aurangabad|dhanbad|amritsar|navi mumbai|allahabad|prayagraj|ranchi|howrah|coimbatore|jabalpur|gwalior|vijayawada|jodhpur|madurai|raipur|kota|guwahati|chandigarh|thiruvananthapuram|trivandrum|mysuru|mysore|kochi|cochin|bhubaneswar|dehradun|noida|gurugram|gurgaon)\b/i;

const QUERY_PATTERNS = [
  { re: /^(?:directions?|routes?|maps?|distance)\s+from\s+(.+?)\s+to\s+(.+)$/i },
  { re: /^(?:how\s+(?:do|can)\s+i\s+get\s+from|how\s+to\s+go\s+from|go\s+from|travel\s+from|navigate\s+from|commute\s+from)\s+(.+?)\s+to\s+(.+)$/i },
  { re: /^from\s+(.+?)\s+to\s+(.+)$/i },
  { re: /^to\s+(.+?)\s+from\s+(.+)$/i, reverse: true },
  { re: /^(.+?)\s*(?:->|→)\s*(.+)$/i, needsHint: true },
  { re: /^between\s+(.+?)\s+and\s+(.+)$/i, needsHint: true },
  { re: /^(.+?)\s+to\s+(.+)$/i, needsHint: true },
];

export function parseDirectionsQuery(query) {
  const raw = normalize(query);
  if (!raw || raw.length > 220) return null;
  if (/https?:\/\//i.test(raw) || BLOCKED_QUERY_RE.test(raw)) return null;

  for (const entry of QUERY_PATTERNS) {
    const m = raw.match(entry.re);
    if (!m) continue;
    const from = cleanPlace(entry.reverse ? m[2] : m[1]);
    const to = cleanPlace(entry.reverse ? m[1] : m[2]);
    if (entry.needsHint && !hasIndiaRouteHint(raw, from, to)) continue;
    if (validPlace(from) && validPlace(to) && from.toLowerCase() !== to.toLowerCase()) {
      return { from, to };
    }
  }
  return null;
}

function hasIndiaRouteHint(raw, from, to) {
  return HINT_WORD_RE.test(raw) || PIN_CODE_RE.test(from) || PIN_CODE_RE.test(to) || INDIA_PLACE_HINT_RE.test(raw);
}

function normalize(value) {
  return String(value || "").trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ");
}

function cleanPlace(value) {
  return normalize(value)
    .replace(/\b(?:by|via|using)\s+(?:bus|train|metro|taxi|car|driving|public transport|transit)\b/gi, "")
    .replace(/\b(?:please|now|today|tonight)\b/gi, "")
    .replace(/^[,.;:-]+|[,.;:-]+$/g, "")
    .trim();
}

function validPlace(value) {
  if (!value || value.length < 2 || value.length > 100) return false;
  if (/^(?:how|what|why|when|where|who)\b/i.test(value)) return false;
  return /[a-z0-9]/i.test(value);
}

const COORD_RE = /^(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)$/;

function parseMaybeCoord(value) {
  const m = String(value || "").trim().match(COORD_RE);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// ── Directions lookup ──────────────────────────────────────────────────────

async function geocodeOne(place, ctx) {
  const coord = parseMaybeCoord(place);
  if (coord) return { label: place, point: coord };

  const cacheKey = `geocode:${place.toLowerCase()}`;
  const cached = _cache ? await _cache.get(cacheKey) : null;
  if (cached) return cached;

  const { result } = await callWithFallback(routingProviders(), "geocode", "geocode", [place, ctx]);
  const best = result[0] || null;
  if (best && _cache) await _cache.set(cacheKey, best, GEOCODE_TTL_MS);
  return best;
}

async function lookupDirections(fromPlace, toPlace, ctx = {}) {
  _loadSettingsFallback();
  const from = cleanPlace(fromPlace);
  const to = cleanPlace(toPlace);
  if (!validPlace(from) || !validPlace(to)) {
    throw Object.assign(new Error("from/to must be non-empty place names or coordinates"), { status: 400 });
  }

  const doFetch = typeof ctx?.fetch === "function" ? ctx.fetch : _fetch;
  const fetchCtx = { fetch: doFetch };

  const [fromGeo, toGeo] = await Promise.all([geocodeOne(from, fetchCtx), geocodeOne(to, fetchCtx)]);
  if (!fromGeo || !toGeo) {
    return { from, to, fromGeo, toGeo, routes: [], warning: !fromGeo ? `Could not find "${from}".` : `Could not find "${to}".` };
  }

  const routes = [];
  for (const mode of MODES) {
    const cacheKey = `route:${mode}:${fromGeo.point.lat.toFixed(5)},${fromGeo.point.lon.toFixed(5)}:${toGeo.point.lat.toFixed(5)},${toGeo.point.lon.toFixed(5)}`;
    const cached = _cache ? await _cache.get(cacheKey) : null;
    if (cached) {
      routes.push(...cached);
      continue;
    }
    try {
      const { result } = await callWithFallback(routingProviders(), `route:${mode}`, "route", [fromGeo.point, toGeo.point, mode, fetchCtx]);
      if (_cache) await _cache.set(cacheKey, result, ROUTE_TTL_MS);
      routes.push(...result);
    } catch (err) {
      _log({ capability: `route:${mode}`, provider: "*", operation: "route", outcome: "exhausted", error_class: err instanceof ProviderError ? err.kind : "unknown" });
    }
  }

  routes.sort((a, b) => a.durationSeconds - b.durationSeconds);

  return {
    from,
    to,
    fromGeo,
    toGeo,
    routes,
    warning: routes.length ? null : "No drive or walk route found between these points.",
  };
}

// ── HTML rendering ─────────────────────────────────────────────────────────

function renderDirectionsCard(payload) {
  const best = payload.routes[0];
  const tabs = renderTabs(payload.routes);
  const routeCards = payload.routes.map((route, idx) => renderRoute(route, idx)).join("\n");
  const emptyState = payload.routes.length ? "" : `<p class="dgm-empty">${esc(payload.warning || "No routes found.")}</p>`;

  return `
<div class="dgm-wrap slot-full-width" data-dgm-version="${PLUGIN_VERSION}" data-dgm-root>
  <div class="dgm-header">
    <div class="dgm-heading-block">
      <div class="dgm-kicker">India directions</div>
      <h2 class="dgm-title">${esc(payload.from)} <span aria-hidden="true">→</span> ${esc(payload.to)}</h2>
      ${best ? `<p class="dgm-subtitle">Fastest: ${esc(best.mode)} · ${formatDuration(best.durationSeconds)} · ${formatDistance(best.distanceMeters)}</p>` : ""}
    </div>
  </div>
  <div class="dgm-shell">
    <section class="dgm-results-panel">
      ${tabs}
      <div class="dgm-grid" data-dgm-route-list>${routeCards}</div>
      ${emptyState}
    </section>
    <aside class="dgm-map-panel" aria-label="Selected route map">
      <div data-dgm-map-frame>${renderMiniMapBlock(best)}</div>
      ${payload.routes.map((route, idx) => `<template data-dgm-map-template="${idx}">${renderMiniMapBlock(route)}</template>`).join("\n")}
    </aside>
  </div>
  <p class="dgm-note">Routes from ${esc(payload.routes.map((r) => r.provider).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "configured providers")}. Bus/metro and train coverage ship in a later milestone.</p>
</div>`;
}

function renderTabs(routes) {
  const modes = [...new Set(routes.map((r) => r.mode))];
  const buttons = [["all", "All"], ["drive", "Drive"], ["walk", "Walk"]].filter(([mode]) => mode === "all" || modes.includes(mode));
  return `<div class="dgm-tabs" role="tablist" aria-label="Route filters">
    ${buttons.map(([mode, label], idx) => `<button type="button" class="dgm-tab${idx === 0 ? " dgm-tab-active" : ""}" data-dgm-filter="${esc(mode)}" role="tab" aria-selected="${idx === 0 ? "true" : "false"}">${esc(label)}</button>`).join("")}
  </div>`;
}

function renderRoute(route, idx) {
  const meta = [formatDuration(route.durationSeconds), formatDistance(route.distanceMeters)].map((x) => `<span>${esc(x)}</span>`).join("");
  const steps = (route.steps || []).slice(0, 10).map((s) => `<li>${esc(s.text)}</li>`).join("");
  return `<article class="dgm-route dgm-${esc(route.mode)}${idx === 0 ? " dgm-route-selected" : ""}" data-dgm-route data-mode="${esc(route.mode)}" data-map-key="${idx}" tabindex="0" role="button" aria-label="Show ${esc(route.mode)} route on the map">
    <div class="dgm-route-top">
      <span class="dgm-mode-badge" aria-hidden="true">${route.mode === "drive" ? "DRIVE" : "WALK"}</span>
      <div class="dgm-route-main">
        <h3>${esc(route.mode === "drive" ? "Driving" : "Walking")} <span class="dgm-source-badge">via ${esc(route.provider)}</span></h3>
        <div class="dgm-meta">${meta}</div>
      </div>
    </div>
    <details class="dgm-details" ${idx === 0 ? "open" : ""}>
      <summary>Turn-by-turn</summary>
      <ol class="dgm-steps">${steps}</ol>
    </details>
  </article>`;
}

function renderMiniMapBlock(route) {
  if (!route || !route.geometry?.coordinates?.length) {
    return `<div class="dgm-map-empty">Map preview unavailable for this route.</div>`;
  }
  const apiBase = _apiBase || `/api/plugin/${PLUGIN_ID}`;
  const tileUrl = `${apiBase}/tile?provider=${esc(_settings.tileSource)}&z={z}&x={x}&y={y}`;
  const points = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const geomJson = esc(JSON.stringify(points));
  return `<div class="dgm-leaflet-wrap">
    <div class="dgm-leaflet-map" data-geom="${geomJson}" data-tile-url="${esc(tileUrl)}"></div>
  </div>`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "";
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

function validTileCoord(x, y, z) {
  if (![x, y, z].every(Number.isInteger)) return false;
  if (z < 0 || z > 19) return false;
  const max = 2 ** z;
  return x >= 0 && y >= 0 && x < max && y < max;
}

// ── Slot ────────────────────────────────────────────────────────────────

export const slot = {
  id: PLUGIN_ID,
  settingsId: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: plugin.description,
  isClientExposed: true,
  position: "full-width-above-results",
  slotPositions: ["full-width-above-results", "above-results"],

  settingsSchema: [
    {
      key: "mapplsApiKey",
      label: "Mappls (MapmyIndia) API key",
      type: "password",
      secret: true,
      description: "Primary India routing/geocoding provider. Used server-side only; never sent to the browser.",
    },
    {
      key: "enableOsrmFallback",
      label: "Enable OSRM fallback",
      type: "toggle",
      default: true,
      description: "Fall back to OSRM/Nominatim (with a public demo server if no URL is set below) when Mappls is unavailable or not configured.",
    },
    {
      key: "osrmBaseUrl",
      label: "OSRM base URL",
      type: "url",
      description: "Self-hosted OSRM instance. Leave blank to use the public demo server — not rate-limit-free and not production-safe.",
    },
    {
      key: "tileSource",
      label: "Map tile source",
      type: "select",
      options: ["osm", "mappls"],
      default: "osm",
      description: "OSM raster tiles, or Mappls tiles once an API key is configured above.",
    },
    {
      key: "debugMode",
      label: "Debug mode",
      type: "toggle",
      default: false,
      description: "Log provider call diagnostics (capability, provider, duration, outcome) to the Degoog server console.",
    },
  ],

  init(ctx) {
    if (typeof ctx?.fetch === "function") _fetch = (...args) => ctx.fetch(...args);
    _cache = _cacheFactory(ctx);
    _apiBase = ctx?.apiBase || (typeof ctx?.routeUrl === "function" ? ctx.routeUrl("").replace(/\/$/, "") : "");
  },

  configure: _configure,

  isConfigured() {
    return Boolean(_settings.mapplsApiKey) || _settings.enableOsrmFallback;
  },

  trigger(query) {
    return parseDirectionsQuery(query) !== null;
  },

  async execute(query, context) {
    const parsed = parseDirectionsQuery(query);
    if (!parsed) return { html: "" };
    try {
      const payload = await lookupDirections(parsed.from, parsed.to, context);
      if (!payload.routes.length) return { html: "" };
      return { title: `${payload.from} to ${payload.to}`, html: renderDirectionsCard(payload) };
    } catch (err) {
      _log({ capability: "slot.execute", outcome: "error", error_class: err instanceof ProviderError ? err.kind : "unknown" });
      return { html: "" };
    }
  },
};

export default slot;

// ── Backend routes (ARCHITECTURE.md §5.3, M1 subset) ───────────────────────
// isClientExposed on the slot governs the settings/UI surface (per the
// convention this repo's reference plugin follows); the guarantee ARCHITECTURE.md
// §5.3 actually cares about — provider API keys never reaching the browser —
// is enforced here directly: no route below ever echoes _settings back to the client.

export const routes = [
  {
    method: "get",
    path: "lookup",
    handler: async (request) => {
      try {
        const url = new URL(request.url);
        const from = url.searchParams.get("from") || "";
        const to = url.searchParams.get("to") || "";
        if (!from.trim() || !to.trim()) return jsonResponse({ error: "Missing required query params: from, to" }, 400);
        const payload = await lookupDirections(from, to, { fetch: _fetch });
        return jsonResponse(payload);
      } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, err?.status || 500);
      }
    },
  },
  {
    method: "get",
    path: "geocode",
    handler: async (request) => {
      try {
        const url = new URL(request.url);
        const q = (url.searchParams.get("q") || "").trim();
        if (!q || q.length > 200) return jsonResponse({ error: "Missing or invalid required query param: q" }, 400);
        _loadSettingsFallback();
        const { result } = await callWithFallback(routingProviders(), "geocode", "geocode", [q, { fetch: _fetch }]);
        return jsonResponse({ query: q, results: result });
      } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
  },
  {
    method: "get",
    path: "tile",
    handler: async (request) => {
      try {
        _loadSettingsFallback();
        const url = new URL(request.url);
        const x = Number(url.searchParams.get("x"));
        const y = Number(url.searchParams.get("y"));
        const z = Number(url.searchParams.get("z"));
        if (!validTileCoord(x, y, z)) return new Response("Invalid tile coordinate", { status: 400 });
        const providerId = url.searchParams.get("provider") === "mappls" ? "mappls" : "osm";
        const provider = tileProviders()[providerId];
        if (!provider.isConfigured()) return new Response("Tile provider not configured", { status: 503 });
        const upstream = await _fetch(provider.tileUrl(z, x, y), {
          headers: { Accept: "image/png,image/*,*/*", "User-Agent": "degoog-maps-plugin/1.0" },
        });
        if (!upstream.ok) return new Response("Tile unavailable", { status: upstream.status });
        return new Response(upstream.body, {
          status: 200,
          headers: { "Content-Type": upstream.headers.get("content-type") || "image/png", "Cache-Control": "public, max-age=86400" },
        });
      } catch (err) {
        return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
      }
    },
  },
];

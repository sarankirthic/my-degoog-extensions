import { readFileSync } from "node:fs";
import { createMapplsProvider } from "./providers/india/routing/mappls.js";
import { createOsrmProvider } from "./providers/india/routing/osrm.js";
import { createBusmapsProvider } from "./providers/india/transit/busmaps.js";
import { createOsmTileProvider } from "./providers/india/tiles/osm.js";
import { createMapplsTileProvider } from "./providers/india/tiles/mappls.js";
import { ProviderError } from "./providers/shared.js";

// Degoog Maps — India-first multimodal directions slot (ARCHITECTURE.md).
// M1+M2 scope: driving/walking routing + geocoding + map slot (M1), plus
// bus/metro trip planning via busmaps (M2), per the build order in
// ARCHITECTURE.md §10. Rail (RailKit, M3) and the direct-GTFS fallback (M4)
// remain follow-on milestones — no RailProvider exists yet, so this plugin
// does not declare routes or trigger patterns for it.
//
// Temporarily narrowed to Drive only (walk + bus/metro paused, not removed):
// get one mode fully correct end to end before re-widening. Flip MODES and
// TRANSIT_ENABLED below to bring walk/transit back — the busmaps provider,
// transit/departures route and rendering all still work, they're just not
// being called right now.

const PLUGIN_ID = "degoog-maps";
const PLUGIN_NAME = "Degoog Maps";
const PLUGIN_VERSION = "1.0.0";

const GEOCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // §7: place → coordinates rarely changes
const ROUTE_TTL_MS = 10 * 60 * 1000; // §7: traffic-aware routes shift, but not query-to-query
// §7 labels this namespace "transit:static" (~24h, "GTFS static schedules")
// but busmaps' planTrip is a live, time-bound itinerary for "now" (no
// departureTime param sent), not a static timetable — caching that for 24h
// would silently serve a stale trip plan. Using route:drive/walk's shorter
// reasoning instead: itinerary options shift, but not query-to-query.
const TRANSIT_PLANTRIP_TTL_MS = 10 * 60 * 1000;
const TRANSIT_DEPARTURES_TTL_MS = 25 * 1000; // §7 transit:realtime, matches the SG reference plugin's LTA cadence
const MODES = ["drive"]; // walk paused — see header note
const TRANSIT_ENABLED = false; // bus/metro paused — see header note

let _settings = {
  mapplsApiKey: "",
  enableOsrmFallback: true,
  osrmBaseUrl: "",
  busmapsApiKey: "",
  transitMaxRoutes: "2",
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
    busmapsApiKey: String(merged.busmapsApiKey || "").trim(),
    transitMaxRoutes: ["1", "2", "3"].includes(String(merged.transitMaxRoutes)) ? String(merged.transitMaxRoutes) : "2",
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

function transitProviders() {
  // Just busmaps for now — gtfs-direct is M4 (§3.1.2: needs its own
  // itinerary-building layer, not a one-line adapter).
  return [createBusmapsProvider({ apiKey: _settings.busmapsApiKey, maxRoutes: _settings.transitMaxRoutes })];
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
    return { from, to, fromGeo, toGeo, routes: [], transit: [], warning: !fromGeo ? `Could not find "${from}".` : `Could not find "${to}".` };
  }

  const originKey = `${fromGeo.point.lat.toFixed(5)},${fromGeo.point.lon.toFixed(5)}`;
  const destKey = `${toGeo.point.lat.toFixed(5)},${toGeo.point.lon.toFixed(5)}`;

  const routes = [];
  for (const mode of MODES) {
    const cacheKey = `route:${mode}:${originKey}:${destKey}`;
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

  const transit = [];
  if (TRANSIT_ENABLED) {
    const transitCacheKey = `transit:busmaps:${originKey}:${destKey}`;
    const cachedTransit = _cache ? await _cache.get(transitCacheKey) : null;
    if (cachedTransit) {
      transit.push(...cachedTransit);
    } else {
      try {
        const { result } = await callWithFallback(transitProviders(), "transit:planTrip", "planTrip", [fromGeo.point, toGeo.point, fetchCtx]);
        if (_cache) await _cache.set(transitCacheKey, result, TRANSIT_PLANTRIP_TTL_MS);
        transit.push(...result);
      } catch (err) {
        _log({ capability: "transit:planTrip", provider: "*", operation: "planTrip", outcome: "exhausted", error_class: err instanceof ProviderError ? err.kind : "unknown" });
      }
    }
    transit.sort((a, b) => a.durationSeconds - b.durationSeconds);
  }

  return {
    from,
    to,
    fromGeo,
    toGeo,
    routes,
    transit,
    warning: routes.length || transit.length ? null : "No drive route found between these points.",
  };
}

// ── HTML rendering ─────────────────────────────────────────────────────────
// RouteResult and TransitItinerary (§3.1) are different shapes; this is the
// one place they get flattened into a common "card" for the tab/list/map UI.

const MODE_BADGES = { drive: "DRIVE", walk: "WALK", bus: "BUS", metro: "METRO" };
const MODE_TITLES = { drive: "Driving", walk: "Walking", bus: "Bus", metro: "Metro" };

function buildCards(payload) {
  const routeCards = payload.routes.map((r) => ({
    kind: "route",
    mode: r.mode,
    provider: r.provider,
    durationSeconds: r.durationSeconds,
    distanceMeters: r.distanceMeters,
    geometry: r.geometry,
    steps: r.steps,
  }));
  const transitCards = payload.transit.map((t) => ({
    kind: "transit",
    mode: classifyTransitMode(t),
    provider: t.provider,
    durationSeconds: t.durationSeconds,
    legs: t.legs,
    fare: t.fare,
  }));
  return [...routeCards, ...transitCards].sort((a, b) => a.durationSeconds - b.durationSeconds);
}

// Tabs only go up to Bus/Metro (no dedicated Tram tab yet); a tram-only
// itinerary is bucketed under Bus rather than dropped.
function classifyTransitMode(itinerary) {
  return (itinerary.legs || []).some((leg) => leg.mode === "metro") ? "metro" : "bus";
}

const TAB_ORDER = ["drive", "walk", "bus", "metro"];

function groupByMode(cards) {
  const map = new Map();
  for (const card of cards) {
    if (!map.has(card.mode)) map.set(card.mode, []);
    map.get(card.mode).push(card);
  }
  return map;
}

function renderDirectionsCard(payload) {
  const cards = buildCards(payload);
  const best = cards[0];
  const byMode = groupByMode(cards);
  const modesPresent = TAB_ORDER.filter((m) => byMode.has(m));
  const activeMode = best ? best.mode : modesPresent[0];
  const bestMeta = best ? [MODE_TITLES[best.mode] || best.mode, formatDuration(best.durationSeconds), formatDistance(best.distanceMeters)].filter(Boolean).join(" · ") : "";
  const providers = [...new Set(cards.map((c) => c.provider))];
  const emptyState = cards.length ? "" : `<p class="dgm-empty">${esc(payload.warning || "No routes found.")}</p>`;

  return `
<div class="dgm-wrap slot-full-width" data-dgm-version="${PLUGIN_VERSION}" data-dgm-root>
  <div class="dgm-header">
    <div class="dgm-heading-block">
      <h2 class="dgm-title">Maps</h2>
      <p class="dgm-subtitle">${esc(payload.from)} <span aria-hidden="true">→</span> ${esc(payload.to)}${best ? ` · Fastest: ${esc(bestMeta)}` : ""}</p>
    </div>
  </div>
  <div class="dgm-shell">
    <section class="dgm-results-panel">
      ${renderTabs(modesPresent, activeMode)}
      ${modesPresent.map((mode) => renderPanel(mode, byMode.get(mode), cards, mode === activeMode)).join("\n")}
      ${emptyState}
    </section>
    <aside class="dgm-map-panel" aria-label="Selected route map">
      <div data-dgm-map-frame>${renderMiniMapBlock(best)}</div>
      ${cards.map((card, idx) => `<template data-dgm-map-template="${idx}">${renderMiniMapBlock(card)}</template>`).join("\n")}
    </aside>
  </div>
  <p class="dgm-note">Routes from ${esc(providers.join(", ") || "configured providers")}. Walk, bus/metro and train coverage are temporarily paused while driving directions are perfected first.</p>
</div>`;
}

function renderTabs(modesPresent, activeMode) {
  return `<div class="dgm-tabs" role="tablist" aria-label="Route mode">
    ${modesPresent.map((mode) => `<button type="button" class="dgm-tab${mode === activeMode ? " dgm-tab-active" : ""}" data-dgm-filter="${esc(mode)}" role="tab" aria-selected="${mode === activeMode ? "true" : "false"}" id="dgm-tab-${esc(mode)}" aria-controls="dgm-panel-${esc(mode)}">${esc(MODE_TITLES[mode] || mode)}</button>`).join("")}
  </div>`;
}

// Each mode gets its own tabpanel (only the active one is visible) instead
// of one flat list filtered by hiding non-matching cards.
function renderPanel(mode, modeCards, allCards, isActive) {
  const cardsHtml = modeCards.map((card) => renderRoute(card, allCards.indexOf(card), card === modeCards[0])).join("\n");
  return `<div class="dgm-grid" id="dgm-panel-${esc(mode)}" role="tabpanel" aria-labelledby="dgm-tab-${esc(mode)}" data-dgm-panel="${esc(mode)}" ${isActive ? "" : "hidden"}>${cardsHtml}</div>`;
}

function renderRoute(card, mapKey, isFirstInPanel) {
  const fareText = card.fare ? formatFare(card.fare) : "";
  const meta = [formatDuration(card.durationSeconds), formatDistance(card.distanceMeters), fareText].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("");
  const badge = MODE_BADGES[card.mode] || card.mode.toUpperCase();
  const title = MODE_TITLES[card.mode] || card.mode;
  const detailLabel = card.kind === "transit" ? "Legs" : "Turn-by-turn";
  const detail = card.kind === "transit" ? renderTransitLegs(card.legs) : renderSteps(card.steps);
  return `<article class="dgm-route dgm-${esc(card.mode)}${isFirstInPanel ? " dgm-route-selected" : ""}" data-dgm-route data-mode="${esc(card.mode)}" data-map-key="${mapKey}" tabindex="0" role="button" aria-label="Show ${esc(title)} route on the map">
    <div class="dgm-route-top">
      <span class="dgm-mode-badge" aria-hidden="true">${esc(badge)}</span>
      <div class="dgm-route-main">
        <h3>${esc(title)} <span class="dgm-source-badge">via ${esc(card.provider)}</span></h3>
        <div class="dgm-meta">${meta}</div>
      </div>
    </div>
    <details class="dgm-details" ${isFirstInPanel ? "open" : ""}>
      <summary>${esc(detailLabel)}</summary>
      ${detail}
    </details>
  </article>`;
}

function renderSteps(steps) {
  const items = (steps || []).slice(0, 10).map((s) => `<li>${esc(s.text)}</li>`).join("");
  return `<ol class="dgm-steps">${items}</ol>`;
}

// Leg-level route/agency/stop names are best-effort (providers/india/transit/busmaps.js
// extracts them defensively — the public busmaps docs don't confirm exact field names).
function renderTransitLegs(legs) {
  const items = (legs || []).map((leg) => {
    const label = [MODE_TITLES[leg.mode] || leg.mode, leg.routeName, leg.agency].filter(Boolean).join(" · ");
    const stops = leg.fromStop && leg.toStop ? `${esc(leg.fromStop.name)} → ${esc(leg.toStop.name)}` : "";
    const dur = formatDuration(leg.durationSeconds);
    return `<li>${esc(label)}${stops ? ` — ${stops}` : ""}${dur ? ` (${esc(dur)})` : ""}</li>`;
  }).join("");
  return `<ol class="dgm-steps">${items}</ol>`;
}

function formatFare(fare) {
  if (!fare || !Number.isFinite(fare.amount)) return "";
  return `${fare.isEstimate ? "~" : ""}${fare.currency} ${fare.amount % 1 ? fare.amount.toFixed(2) : fare.amount}`;
}

function renderMiniMapBlock(card) {
  if (!card || !card.geometry?.coordinates?.length) {
    return `<div class="dgm-map-empty">Map preview unavailable for this route.</div>`;
  }
  const apiBase = _apiBase || `/api/plugin/${PLUGIN_ID}`;
  const tileUrl = `${apiBase}/tile?provider=${esc(_settings.tileSource)}&z={z}&x={x}&y={y}`;
  const points = card.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
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
      key: "busmapsApiKey",
      label: "busmaps API key",
      type: "password",
      secret: true,
      description: "Bus/metro trip planning and next departures (busmaps.com/en/developers). Used server-side only. Without a key, the Bus/Metro tabs simply don't appear.",
    },
    {
      key: "transitMaxRoutes",
      label: "Transit routes per query",
      type: "select",
      options: ["1", "2", "3"],
      default: "2",
      description: "Maximum bus/metro itineraries requested per lookup.",
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
      if (!payload.routes.length && !payload.transit.length) return { html: "" };
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
  {
    method: "get",
    path: "transit/departures",
    handler: async (request) => {
      try {
        _loadSettingsFallback();
        const url = new URL(request.url);
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        const radius = Number(url.searchParams.get("radius")) || 500;
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          return jsonResponse({ error: "Missing or invalid required query params: lat, lon" }, 400);
        }
        if (!transitProviders().some((p) => p.isConfigured())) {
          return jsonResponse({ error: "No transit provider configured" }, 503);
        }
        const cacheKey = `transit:busmaps:departures:${lat.toFixed(5)},${lon.toFixed(5)}:${radius}`;
        const cached = _cache ? await _cache.get(cacheKey) : null;
        if (cached) return jsonResponse({ lat, lon, departures: cached, cached: true });
        const { result } = await callWithFallback(transitProviders(), "transit:nextDepartures", "nextDepartures", [{ lat, lon }, { fetch: _fetch }, radius]);
        if (_cache) await _cache.set(cacheKey, result, TRANSIT_DEPARTURES_TTL_MS);
        return jsonResponse({ lat, lon, departures: result });
      } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
  },
];

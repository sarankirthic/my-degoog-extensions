# Degoog Directions Plugin — Architecture v0.3
**Plugin ID:** `degoog-maps` (internal folder/settings key — settled)
**Display name:** Degoog Maps
**Scope:** India-first, designed from day one to generalize to global coverage.
**Reference prior art:** [`degoog-gothere-directions`](https://github.com/siva-sub/degoog-gothere-directions) — a Singapore-only slot that merges Gothere + OneMap (SLA) + LTA DataMall into one directions panel. That plugin works because Singapore has exactly one government geocoder/router and one realtime transit authority. **India has neither** — no single national geocoder, and transit data is fragmented per city/state. So instead of hard-wiring 2-3 named sources like the SG plugin does, this design puts a **provider abstraction layer** in front of each capability, with concrete India providers plugged in for v1 and a documented path to add other countries later without touching core logic.

---

## 1. Decisions

Two different kinds of decision are mixed together on purpose below, but worth telling apart: the **architectural** choices (provider abstraction, ordered fallback chains, caching, plugin structure) are what's actually locked in. The **provider** choices (Mappls, busmaps, RailKit) are today's best pick given what's documented and available — swappable later without touching plugin logic, precisely because of the abstraction in §3.

| Capability | Current preferred provider (v1) |
|---|---|
| Driving / walking routing + geocoding | **Mappls (MapmyIndia)** primary (official API key, India-accurate, traffic-aware) → **OSRM** fallback (self-hosted or configurable instance) |
| Bus / Metro transit | **busmaps.com** API primary (GTFS aggregator, 90+ countries, single key) → raw **GTFS/GTFS-RT** ingestion (per the `google/transit` spec) as fallback for any agency feed supplied directly (e.g. Kochi Metro's own open feed) |
| Long-distance rail | **RailKit** (`railkit` npm package, [RAJIV81205/RailKit](https://github.com/RAJIV81205/RailKit)) for PNR status, train search, live tracking, seat availability, fares |
| Map tiles | OSM raster tiles by default for development/light usage (subject to the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) — capacity-limited and best-effort, not free production infrastructure) with an optional Mappls tile style for India |

### Why busmaps.com over a hand-rolled GTFS pipeline
It turned out to solve more than just "bus/metro." Its Pro tier ($20/mo) wraps **OSRM car/pedestrian routing** and **Nominatim/Photon geocoding** behind the same key, across 90+ countries. That means it can double as the OSRM/geocoding fallback layer too, so you may not need to run and maintain your own OSRM/Nominatim instance at all. OSRM is kept as a separate, literal self-hosted fallback per your earlier answer (so there's a free/no-API-key path), but this is a place to simplify later — see §9.

### Why RailKit over scraping IRCTC directly
There's no official public IRCTC/Indian Railways API. RailKit isn't government data — it's a **third-party service with its own API key, dashboard, rate limits and ToS** (`railkit.rajivdubey.dev`), which is a meaningfully different (and safer) posture than a plugin hitting undocumented IRCTC endpoints directly. Its docs are clean and its response shapes (PNR, train info, live tracking, station board, fare/availability) map directly onto plugin needs. Same category of decision the reference plugin made when it used LTA DataMall (documented, key-based) instead of scraping — worth being deliberate that we're doing the "documented API" version of that pattern, not the "private API discovery" version OneMap forced them into.

---

## 2. Architecture at a glance

```text
                                USER
                                  │
                     ┌────────────┴────────────┐
                     │                          │
                 Search query               !command
                     │                          │
                     └────────────┬─────────────┘
                                  ↓
                     ┌────────────────────────┐
                     │   Directions Plugin     │
                     │  Trigger detection      │
                     │  Query normalizer       │
                     │  Provider registry      │
                     │  (per-capability chain) │
                     └────────────┬────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         ↓                        ↓                         ↓
  RoutingProvider           TransitProvider             RailProvider
    ┌───┴───┐               ┌─────┴──────┐                  │
    ↓       ↓               ↓            ↓                  ↓
  Mappls   OSRM         busmaps      GTFS-direct         RailKit
         │                        │                        │
         └────────────────────────┴────────────────────────┘
                                  ↓
                     Normalized domain results
                       (RouteResult / TransitItinerary /
                        TrainSummary / PnrResult)
                                  │
                     ┌────────────┴────────────┐
                     ↓                         ↓
              TileProvider                 Slot panel
             (OSM / Mappls, proxied)     (map + mode tabs)
```

Everything below the "Directions Plugin" box only ever talks through the four interfaces in §3 — never directly to a named vendor. That's what makes M5 (globalization) an addition rather than a rewrite.

---

## 3. Provider abstraction layer

Four capabilities, each with a small interface. Concrete providers implement the interface; a per-capability **registry** picks which provider(s) to call and in what order (primary → fallback), based on settings and region.

```ts
// Conceptual shapes — not final code, just the contract each provider must satisfy.

interface GeoPoint { lat: number; lon: number; }

interface RoutingProvider {
  id: string;                       // "mappls" | "osrm" | ...
  geocode(query: string, ctx): Promise<Array<{ label: string; point: GeoPoint; raw?: any }>>;
  route(from: GeoPoint, to: GeoPoint, mode: "drive"|"walk"|"bike", ctx): Promise<RouteResult[]>;
}

interface TransitProvider {
  id: string;                       // "busmaps" | "gtfs-direct" | ...
  planTrip(from: GeoPoint, to: GeoPoint, ctx): Promise<TransitItinerary[]>;
  nextDepartures(stopId: string, ctx): Promise<Departure[]>;
}

interface RailProvider {
  id: string;                       // "railkit"
  searchTrains(fromStnCode: string, toStnCode: string, ctx): Promise<TrainSummary[]>;
  pnrStatus(pnr: string, ctx): Promise<PnrResult>;
  liveTrain(trainNo: string, date: string | undefined, ctx): Promise<LiveTrainResult>;
}

interface TileProvider {
  id: string;                       // "osm" | "mappls"
  tileUrl(z: number, x: number, y: number, style?: string): string; // resolved server-side, proxied to client
}
```

A tiny registry per capability, keyed by provider id, with an ordered fallback chain read from settings:

```ts
const routingChain = ["mappls", "osrm"];       // from settings
const transitChain = ["busmaps", "gtfs-direct"];
```

Every provider call goes through `ctx.useCache` with a TTL appropriate to that capability (see §7), and every outgoing call uses `ctx.fetch` so it respects the instance's configured outbound proxy.

### 3.1 Normalized domain models

Provider-specific response shapes stop at the provider module — everything above the registry (the slot, the routes, the frontend) only ever sees these:

```ts
interface RouteResult {
  provider: string;                 // which provider actually served this
  mode: "drive" | "walk" | "bike";
  durationSeconds: number;
  distanceMeters: number;
  geometry: GeoJSON.LineString;
  steps: RouteStep[];
  fare?: Fare;
  warnings?: string[];
}

interface TransitItinerary {
  provider: string;
  legs: TransitLeg[];
  durationSeconds: number;
  departureTime?: string;           // ISO 8601
  arrivalTime?: string;
  fare?: Fare;
}

interface TransitLeg {
  mode: "walk" | "bus" | "metro" | "tram" | "rail" | "ferry"; // GTFS covers more than bus/metro — don't let the UI's tab list define this
  agency?: string;
  routeName?: string;               // e.g. bus number / metro line
  fromStop?: { name: string; point: GeoPoint };
  toStop?: { name: string; point: GeoPoint };
  departureTime?: string;
  arrivalTime?: string;
  realtime?: { etaSeconds: number; status?: string };
  geometry?: GeoJSON.LineString;
}

interface Fare { amount: number; currency: string; isEstimate: boolean; }

interface TrainSummary {
  trainNo: string; trainName: string;
  from: { code: string; name: string; time: string };
  to: { code: string; name: string; time: string };
  durationText: string; distanceKm?: number; runningDays?: string;
}

interface PnrResult { pnr: string; train: { number: string; name: string }; chartStatus: string; passengers: PnrPassenger[]; }
interface PnrPassenger { status: string; coach?: string; berth?: string; }

interface LiveTrainResult {
  trainNo: string; statusNote: string; currentStationCode?: string;
  timeline: Array<{ stationCode: string; stationName: string; status: "passed"|"current"|"upcoming"; delayMinutes?: number }>;
}
```

`RouteStep` and `Departure` follow the same idea (turn-by-turn text / single next-arrival record) — sketch these when M1/M2 actually start, once real provider payloads are in hand to normalize from.

### 3.1.1 Why rail is a separate provider from transit

`TransitLeg.mode` includes `"rail"`, so it's worth writing down once: urban/public transit (city buses, metro, trams — bounded by a city's transit authority) is `TransitProvider`; long-distance Indian Railways (intercity trains, PNRs, seat availability) is its own `RailProvider` because it needs IRCTC-specific concepts (PNR, quota, coach class) that don't fit the generic transit-leg model and comes from a completely different provider (RailKit) than any GTFS source.

### 3.1.2 `gtfs-direct` is a data source, not a routing engine

Worth being precise about this before M4: raw GTFS/GTFS-RT feeds (whether hand-supplied via the settings `list` or pulled from an agency directly) give you stops, routes, timetables and vehicle positions — they don't give you an A-to-B itinerary on their own. `busmaps` bundles trip-planning on top of the feeds it aggregates; a direct-GTFS fallback needs the same kind of layer built in-house (ingest → build a stop/route graph → compute itineraries) to actually produce a `TransitItinerary`, not just a passthrough of the raw feed. That itinerary-building layer is real scope, not a one-line adapter — it belongs in M4, and `isConfigured()`/the fallback chain should treat `gtfs-direct` as unavailable until that layer exists, rather than silently falling through to it and returning nothing.

### 3.2 Provider module layout

```text
providers/
  india/
    routing/mappls.ts
    routing/osrm.ts
    transit/busmaps.ts
    transit/gtfs-direct.ts
    rail/railkit.ts
    tiles/osm.ts
    tiles/mappls.ts
```

A second region later gets its own `providers/<region>/` folder implementing the same four interfaces; nothing under §2's "Directions Plugin" box needs to change. This is a folder-naming decision worth fixing now (since scaffolding will create these paths), not a commitment to build other regions before M5.

---

## 4. Provider failure & fallback policy

The chain in §3 says *which order* providers are tried; this says *when* the next one gets a turn.

**Falls through to the next provider on:**
- timeout or network/transport failure
- 5xx response
- 429 — respect `Retry-After` if present, then fall through
- a response that fails schema validation (better a fallback call than a broken card)
- a provider-specific "unknown / temporarily unavailable" response (as distinct from a considered "no route" answer, below)

**Does NOT fall through / does NOT retry other providers on:**
- a query that's malformed at the input stage (bad coordinates, empty string) — reject before calling any provider, not after burning three calls
- a **valid, well-formed response that says there's genuinely no route** (e.g. no transit exists between two points, or a provider explicitly reports the area as out of its coverage) — that's a real, authoritative answer, not a failure, and should be shown to the user as "no route found" rather than silently trying the next provider
- a first provider returning a valid, complete response — don't call the fallback "just in case"; that doubles latency and cost for no benefit

The distinguishing question for "empty result": did the provider *fail to answer* (falls through) or did it *answer with nothing* (doesn't fall through)? That distinction has to be read from each provider's actual response shape — an empty array isn't automatically the same thing as an explicit "no route" flag, so this needs a concrete check per provider when M1/M2 implement it, not just a generic "if empty, fallback."

**Minimal logging event** — enough to make the debug-mode toggle (§6) useful without building an observability subsystem:

```text
provider_call: { capability, provider, operation, duration_ms, outcome, fallback_used, error_class }
```

Never put API keys, PNRs, or raw query text containing potentially sensitive input into this event.

---

## 5. Plugin shape (single multi-hook plugin)

One plugin folder, using the `plugin` manifest pattern so everything shares one settings card:

```js
export const plugin = {
  id: "degoog-maps",
  name: "Degoog Maps",
  description: "India-first multimodal directions: driving, walking, bus/metro and train.",
  settingsSchema: [ /* fieldsets — see §6 */ ],
};

export const slot = { /* the directions panel — see §5.1 */ };
export const command = { /* optional !directions / !gothere bang — see §5.2 */ };
export const routes = [ /* backend endpoints — see §5.3 */ ];
```

### 5.1 Slot (primary UX)
- **Trigger:** same spirit as the reference plugin's `X to Y` heuristic, but with India-shaped hints instead of Singapore's (postal code / bus stop code):
    - `<place> to <place>` / `from <place> to <place>` / `between <place> and <place>`
    - hint words: `bus`, `metro`, `train`, `directions`, `route`, `distance`
    - **6-digit PIN code** anywhere in the query (India's postal code format)
    - **station code** pattern (2-5 uppercase letters, e.g. `NDLS`, `BCT`) or a **5-digit train number** or **10-digit PNR** → routes straight to the Rail provider instead of doing a full multi-modal lookup
    - Bare `X to Y` without any of the above hints should probably **not** trigger (same reasoning as the SG plugin: avoids false-positiving on unrelated queries like "translate hello to french"). Worth a settings toggle to loosen/tighten this.
- **Position:** recommend `full-width-above-results` — the SG reference plugin is dense (5 route type cards + interactive Leaflet map + live arrivals), and the full-width slot is explicitly meant for "large media-style panels that need more room than the results column." Alternative is `above-results` if a more compact layout is preferred — worth deciding once you see a mockup.
- **Composition:** mode tabs (Drive / Walk / Bus / Metro / Train — only show tabs a provider actually returned results for), Leaflet map with tile switcher (OSM / Mappls), fare + duration summary per option, live-departure sub-panel when a transit itinerary uses a stop busmaps has realtime for, deep links out to Mappls / busmaps / IRCTC for booking.
- **`waitForResults`:** not needed — this plugin doesn't care about the underlying web search results, only the query text.

### 5.2 Bang command (explicit trigger)
Optional but cheap to add: `!directions from X to Y` or `!train NDLS to BCT` as a guaranteed, unambiguous trigger alongside the ambient slot heuristic — mirrors how Weather/Custom Bangs give people a way to force it.

### 5.3 Backend routes (`/api/plugin/degoog-maps/...`)

Tiles and rail lookups are proxied server-side rather than called from the browser directly, for the same reasons the settings system already cares about (`isClientExposed`): it keeps Mappls/RailKit/busmaps API keys off the client, lets the provider be swapped without a frontend change, and lets the backend enforce caching/rate limits in one place instead of trusting every browser tab to behave. This plugin should declare `isClientExposed: false` on all its exports.

| Method | Path | Purpose |
|---|---|---|
| GET | `/lookup?from=X&to=Y` | Normalized multi-modal directions (routing + transit providers merged) |
| GET | `/rail/search?from=NDLS&to=BCT` | Train search between stations (RailKit) |
| POST | `/rail/pnr` (body: `{ pnr }`) | PNR status (RailKit) — POST, not a query param, so a PNR never ends up in access/proxy logs or browser history; see §8 |
| GET | `/rail/live?train=X&date=Y` | Live train tracking (RailKit) |
| GET | `/transit/departures?stopId=X` | Next departures at a stop (busmaps / GTFS-RT) |
| GET | `/tile?provider=osm\|mappls&z=&x=&y=&style=` | Tile proxy (keeps `isClientExposed: false`) |
| GET | `/geocode?q=` | Geocode a free-text place name (Mappls → OSRM/Nominatim fallback) |

`script.js` calls all of these via `` `/api/plugin/${__PLUGIN_ID__}/...` `` — never a hardcoded folder name, per the plugin system's rules, since the Store install path is `<author>-<repo>-<plugin-name>`.

---

## 6. Settings schema (fieldsets)

- **Routing sources**
    - Mappls API key (`password`, secret)
    - Enable OSRM fallback (`toggle`)
    - OSRM base URL (`url`) — self-hosted instance; leave blank to fall back to a public demo instance *with a visible warning that it's not production-safe / rate-limited*
- **Transit sources**
    - busmaps API key (`password`, secret)
    - Custom GTFS feed URLs (`list` type — one row per agency: name, static feed URL, optional GTFS-RT URL) for direct ingestion outside busmaps' catalog
    - Routes per mode (`select`: 1-3)
- **Rail**
    - RailKit API key (`password`, secret)
    - Enable rail lookups (`toggle`)
- **Map**
    - Tile source (`select`: OSM / Mappls)
    - Mappls tile style, if applicable (`select`)
- **Other**
    - Debug mode (`toggle`)

Provider *order* within each chain defaults to what's coded in §3 (Mappls→OSRM, busmaps→GTFS-direct) rather than being a user-facing setting — expose it as one if there's ever a real reason for someone to reorder it, but it's not needed for v1.

`isConfigured()` should return `true` as long as *at least one* routing provider is usable (even just OSRM-fallback-with-no-key) — don't hide the whole plugin from `!help` just because someone hasn't added a Mappls or RailKit key yet. Missing keys should just mean fewer tabs show up in the panel (Rail tab hidden without a RailKit key, etc.).

---

## 7. Caching (`ctx.useCache` / `context.useCache`)

| Namespace | TTL | Why |
|---|---|---|
| `geocode` | ~7 days | Place → coordinates rarely changes |
| `route:drive`, `route:walk` | ~10 min | Traffic-aware routes shift, but not query-to-query |
| `transit:static` | ~24 h | GTFS static schedules |
| `transit:realtime` | ~20-30 s | Matches the SG plugin's LTA arrival refresh cadence |
| `rail:trainInfo` | ~24 h | Route/timetable is static |
| `rail:live` | ~30-60 s | Position/delay changes frequently |
| `rail:pnr` | not cached | Status can change; don't serve stale booking state — see §8 |

**Cache key format**, so this stays consistent across providers instead of every provider inventing its own scheme:

```text
geocode:{provider}:{normalized_query}
route:{provider}:{mode}:{fromLat},{fromLon}:{toLat},{toLon}
transit:{provider}:{fromLat},{fromLon}:{toLat},{toLon}
rail:trainInfo:{trainNo}
rail:live:{trainNo}:{date}
```

Origin+destination is enough for M1 (drive/walk only, no options yet). Once routing options exist (avoid tolls, departure time, vehicle type), fold a normalized options string into the key — `route:{provider}:{mode}:{normalizedOptions}:{from}:{to}` — rather than assuming from/to alone will always determine the result.

---

## 8. Rail security & privacy (PNR handling)

A PNR is booking-identifying information, not just another search string. Rules for `/rail/pnr` specifically:

- never log a raw PNR (mask it in any debug-mode logging, e.g. `58****4603`)
- don't cache PNR responses (already the case per §7) and don't send them to any analytics/telemetry path
- rate-limit the PNR route more tightly than the other rail routes — there's no legitimate reason for a single client to burst PNR lookups
- sanitize error messages before they reach the client/logs (don't echo the PNR back inside an error string)
- this route calls a third-party service (RailKit) with the PNR — that's worth surfacing to the instance owner in the plugin's settings description, same spirit as declaring `isClientExposed`, since it's data leaving the instance to a processor they should know about

---

## 9. Open items to settle before scaffolding

1. **Plugin folder name** — settled as `degoog-maps`.
2. **Slot position** — `full-width-above-results` vs `above-results` (see §5.1).
3. **OSRM fallback**: self-host now, or start with a public demo instance and defer hosting? (Public demo instances explicitly aren't meant for production traffic.)
4. **busmaps plan**: Free tier only unlocks next-departures/stops-in-radius/GTFS catalog — no OSRM routing or geocoding on Free, and trip planning capped at 1,000/month. If transit is going to be used often, Pro ($20/mo) is probably needed fairly quickly; worth deciding whether that's in scope for v1 or a "works on Free tier with visible limits" launch first.
5. **City prioritization** for direct-GTFS fallback feeds (Kochi Metro is the clean official one; which 2-3 others do you want wired in first via the `list` setting?).
6. **Rate-limit / attribution handling**: OSM tile usage policy, Mappls ToS, busmaps ToS on caching/redistributing responses — worth a quick pass before shipping publicly, not blocking for local dev.

---

## 10. Build order (proposed milestones)

1. **M1** — Provider abstraction + Mappls/OSRM routing + geocoding + map slot (drive/walk only, no transit/rail yet). Gets the core panel + Leaflet map + tile proxy working end to end.
2. **M2** — busmaps transit integration (planTrip + nextDepartures) added as a mode tab.
3. **M3** — RailKit integration (train search / PNR / live tracking) added as a mode tab + explicit `!rail`-style triggers for PNR/train-number patterns, plus the §8 handling rules.
4. **M4** — Settings polish, direct-GTFS fallback for feeds outside busmaps' catalog, isClientExposed audit.
5. **M5** — Generalize: extract a second `providers/<region>/` pack from what India-specific code exists, so a second region can be added as a self-contained provider set.

---

## Next step
Once you've settled the open items in §9 (or want to just go with the defaults suggested there), I'll turn this into the actual `degoog-cli`-scaffolded plugin — starting with M1.
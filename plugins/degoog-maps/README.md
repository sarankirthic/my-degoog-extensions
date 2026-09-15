# Degoog Maps

India-first multimodal directions slot for Degoog. See `ARCHITECTURE.md` at the
repo root for the full design.

## Scope (this build)

Implements **M1 + M2** of the architecture's build order (§10): a provider
abstraction layer with driving/walking routing + geocoding + the map slot
(M1), plus bus/metro trip planning and next-departures via busmaps (M2).
Rail (RailKit, M3), direct-GTFS fallback (M4), and a second
`providers/<region>/` pack (M5) are later milestones and are not built here —
no `RailProvider` exists yet, so no route, setting, or trigger pattern for it
is declared. Route/setting/trigger scaffolding for features that don't work
yet is worse than not having it.

The optional `!directions` bang command (§5.2) is also skipped: the
architecture doesn't specify degoog's `command` export contract, there's no
working example of one in this ecosystem to confirm the shape against, and
the doc marks it "optional." The slot heuristic and `/lookup` route already
cover explicit triggering.

## Providers (§3)

| Capability | Chain |
|---|---|
| Routing + geocoding | `mappls` → `osrm` (Nominatim for geocoding, no key needed) |
| Transit (bus/metro) | `busmaps` only — `gtfs-direct` is M4 (§3.1.2: needs its own itinerary-building layer) |
| Tiles | `osm` (default) or `mappls` (needs an API key) |

Works with zero configuration for driving/walking: OSRM's public demo server
+ Nominatim need no API key. Add a Mappls key to make it the primary,
traffic-aware provider. Bus/Metro tabs only appear once a busmaps key is
configured (busmaps.com/en/developers) — no key means those tabs simply don't
render, same as any other missing-provider case. Provider fallback follows
ARCHITECTURE.md §4 exactly: falls through on transport/rate-limit/schema
errors, never on a genuine "no route" answer or a first successful response.

**busmaps integration note:** the endpoint contract (base URL, auth headers,
query params) is verified against busmaps' own machine-readable v1 contract.
The docs only publish a curated "important fields" list, not a full example
response, so per-leg fields (route name, agency, stop name) in
`providers/india/transit/busmaps.js` are extracted defensively with
fallbacks rather than assumed — validate against a live key before trusting
leg-level labels in production. Trip-planning legs currently render without
map geometry for the same reason (the polyline field name isn't confirmed).

## Triggering

```text
from koramangala to indiranagar
mg road to cubbon park bus
directions from 560034 to 560001
between hauz khas and connaught place
```

Bare `X to Y` needs a hint word (bus/metro/train/directions/route/distance)
or a 6-digit PIN code, same reasoning as the SG reference plugin this design
is adapted from: avoid false-positiving on unrelated queries.

## Routes (`/api/plugin/degoog-maps/...`)

| Method | Path | Purpose |
|---|---|---|
| GET | `lookup?from=X&to=Y` | Normalized drive/walk directions + bus/metro itineraries |
| GET | `geocode?q=` | Geocode a place name |
| GET | `tile?provider=osm\|mappls&z=&x=&y=` | Tile proxy |
| GET | `transit/departures?lat=&lon=&radius=` | Next bus/metro departures near a point (busmaps, location-based mode) — 503 if no busmaps key is configured |

`transit/departures` takes `lat`/`lon` rather than the `stopId` shape
ARCHITECTURE.md's §5.3 table sketches: busmaps' stopId mode also needs
`regionName`/`countryIso` from a prior `/v1/stopsInRadius` call we don't make
here, while its location mode needs only coordinates — a cleaner fit for the
plugin's `GeoPoint` model, and the kind of refinement §3.1 explicitly invites
"once real provider payloads are in hand."

## Settings

Mappls API key (secret), enable OSRM fallback (default on), OSRM base URL
(blank = public demo, not production-safe), busmaps API key (secret),
transit routes per query (1-3), map tile source, debug mode.

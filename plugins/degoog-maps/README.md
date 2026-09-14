# Degoog Maps

India-first multimodal directions slot for Degoog. See `ARCHITECTURE.md` at the
repo root for the full design.

## Scope (this build)

Implements **M1** of the architecture's build order (§10): a provider
abstraction layer with driving/walking routing + geocoding + the map slot.
Bus/metro (busmaps, M2), rail (RailKit, M3), direct-GTFS fallback (M4), and a
second `providers/<region>/` pack (M5) are later milestones and are not built
here — no `TransitProvider` or `RailProvider` exists yet, so no route,
setting, or trigger pattern for them is declared. Route/setting/trigger
scaffolding for features that don't work yet is worse than not having it.

The optional `!directions` bang command (§5.2) is also skipped: the
architecture doesn't specify degoog's `command` export contract, there's no
working example of one in this ecosystem to confirm the shape against, and
the doc marks it "optional." The slot heuristic and `/lookup` route already
cover explicit triggering.

## Providers (§3)

| Capability | Chain |
|---|---|
| Routing + geocoding | `mappls` → `osrm` (Nominatim for geocoding, no key needed) |
| Tiles | `osm` (default) or `mappls` (needs an API key) |

Works with zero configuration: OSRM's public demo server + Nominatim need no
API key. Add a Mappls key in settings to make it the primary, traffic-aware
provider. Provider fallback follows ARCHITECTURE.md §4 exactly: falls through
on transport/rate-limit/schema errors, never on a genuine "no route" answer
or a first successful response.

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
| GET | `lookup?from=X&to=Y` | Normalized drive/walk directions |
| GET | `geocode?q=` | Geocode a place name |
| GET | `tile?provider=osm\|mappls&z=&x=&y=` | Tile proxy |

## Settings

Mappls API key (secret), enable OSRM fallback (default on), OSRM base URL
(blank = public demo, not production-safe), map tile source, debug mode.

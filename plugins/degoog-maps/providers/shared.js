// Shared helpers for India routing providers (ARCHITECTURE.md §3, §4).

export class ProviderError extends Error {
  constructor(kind, message, retryAfter = null) {
    super(message);
    this.kind = kind; // "transport" | "rate-limit" | "schema" | "unavailable"
    this.retryAfter = retryAfter;
  }
}

export function providerError(kind, message, retryAfter) {
  return new ProviderError(kind, message, retryAfter);
}

// Mappls' Route API mirrors OSRM's route response shape, so both providers
// normalize through this one function.
export function normalizeOsrmStyleRoute(route, mode, providerId) {
  return {
    provider: providerId,
    mode,
    durationSeconds: Math.round(route.duration),
    distanceMeters: Math.round(route.distance),
    geometry: { ...route.geometry, coordinates: samplePoints(route.geometry?.coordinates || [], 140) },
    steps: extractSteps(route),
  };
}

// Long-distance routes can come back with thousands of points; the map only
// needs enough to look smooth, not every raw coordinate.
function samplePoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => points[Math.round(i * step)]);
}

function extractSteps(route) {
  const steps = [];
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      const text = maneuverText(step.maneuver, step.name);
      if (text) steps.push({ text, distanceMeters: Math.round(step.distance || 0) });
    }
  }
  return steps;
}

function maneuverText(maneuver, roadName) {
  if (!maneuver) return "";
  const type = maneuver.type || "";
  const modifier = maneuver.modifier ? ` ${maneuver.modifier}` : "";
  const road = roadName ? ` onto ${roadName}` : "";
  if (type === "depart") return `Head out${road}`;
  if (type === "arrive") return "Arrive at destination";
  if (type === "roundabout") return `Take the roundabout${road}`;
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}${modifier}${road}`.trim();
}

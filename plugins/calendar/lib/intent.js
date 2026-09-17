import * as chrono from "chrono-node";
import { getTimeZoneOffsetMinutes, startOfDayInTz, toIsoWithOffset } from "./time.js";

const READ_KEYWORDS = new Set(["", "today", "tomorrow", "week", "agenda", "upcoming", "list"]);

/**
 * Returns { type: "read", range: { from, to } } for a recognized read
 * keyword, or null if `args` isn't one — callers should try create-intent
 * parsing next.
 */
export function tryParseReadIntent(args, { timezone, agendaWindowDays }) {
  const keyword = args.trim().toLowerCase();
  if (!READ_KEYWORDS.has(keyword)) return null;

  const now = new Date();
  if (keyword === "today") {
    return {
      type: "read",
      label: "Today",
      range: {
        from: startOfDayInTz(now, timezone, 0).toISOString(),
        to: startOfDayInTz(now, timezone, 1).toISOString(),
      },
    };
  }
  if (keyword === "tomorrow") {
    return {
      type: "read",
      label: "Tomorrow",
      range: {
        from: startOfDayInTz(now, timezone, 1).toISOString(),
        to: startOfDayInTz(now, timezone, 2).toISOString(),
      },
    };
  }
  // "", "week", "agenda", "upcoming", "list" all resolve to the configured window.
  return {
    type: "read",
    label: `Next ${agendaWindowDays} days`,
    range: {
      from: startOfDayInTz(now, timezone, 0).toISOString(),
      to: startOfDayInTz(now, timezone, agendaWindowDays).toISOString(),
    },
  };
}

/**
 * Attempts to parse `args` as a create-event instruction, e.g.
 * "tomorrow 3pm dentist". Returns { type: "create", title, start } or
 * null if chrono found no date/time in the text at all.
 */
export function tryParseCreateIntent(args, { timezone, rollForward }) {
  const now = new Date();
  const offsetMinutes = getTimeZoneOffsetMinutes(timezone, now);

  const results = chrono.parse(
    args,
    { instant: now, timezone: offsetMinutes },
    { forwardDate: rollForward }
  );

  if (!results.length) return null;

  // Use the first match; take the whole remaining text (with the matched
  // date phrase removed) as the title.
  const match = results[0];
  const start = match.start.date(); // already resolved to a real UTC instant
  const title = (args.slice(0, match.index) + args.slice(match.index + match.text.length))
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!title) return null; // date with no title isn't a usable event

  return {
    type: "create",
    title,
    // §2/§4: CalendarEvent.start is always stored with an explicit offset,
    // not a bare UTC "Z" timestamp — toIsoWithOffset() bakes in `timezone`.
    start: toIsoWithOffset(start.getTime(), timezone),
    allDay: !match.start.isCertain("hour"),
  };
}

export function parseIntent(args, settings) {
  return tryParseReadIntent(args, settings) ?? tryParseCreateIntent(args, settings) ?? { type: "unknown" };
}

// Timezone math using Intl only (no luxon/date-fns-tz dependency).
//
// Known limitation: offset math for a specific future date is computed by
// resolving the actual wall-clock offset for that date (so DST transitions
// are handled correctly for the *target* date), but "add N days" style
// arithmetic that crosses a DST boundary can land a few minutes off in rare
// cases. Fine for a personal agenda utility; revisit if it ever matters.

/**
 * Offset in minutes such that: localWallClock = utcInstant + offsetMinutes.
 * e.g. Asia/Kolkata (UTC+5:30) -> 330
 */
function getTimeZoneOffsetMinutes(timeZone, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  // Intl can report hour "24" for midnight in hour12:false mode on some engines.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** { year, month, day } of `date` as seen in `timeZone`. */
function zonedYMD(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/**
 * Build the UTC instant for a given wall-clock time in `timeZone`.
 * Resolves the offset in two passes so DST-transition dates land correctly.
 */
function zonedDateToUtc(year, month, day, hour, minute, second, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset1 = getTimeZoneOffsetMinutes(timeZone, guess);
  let utc = new Date(guess.getTime() - offset1 * 60000);
  const offset2 = getTimeZoneOffsetMinutes(timeZone, utc);
  if (offset2 !== offset1) {
    utc = new Date(guess.getTime() - offset2 * 60000);
  }
  return utc;
}

/** Start of the day (00:00:00) `dayDelta` days from `date`, in `timeZone`. */
function startOfDayInTz(date, timeZone, dayDelta = 0) {
  const { year, month, day } = zonedYMD(date, timeZone);
  const base = zonedDateToUtc(year, month, day, 0, 0, 0, timeZone);
  if (!dayDelta) return base;
  // Shift by whole days, then re-resolve against the timezone so a DST
  // transition inside the shifted range doesn't leave the boundary off by
  // an hour.
  const shiftedGuess = new Date(base.getTime() + dayDelta * 86400000);
  const shiftedYmd = zonedYMD(shiftedGuess, timeZone);
  return zonedDateToUtc(shiftedYmd.year, shiftedYmd.month, shiftedYmd.day, 0, 0, 0, timeZone);
}

/** Renders `isoInstant` as a human string in `timeZone`, e.g. "Wed, Sep 17 · 3:00 PM". */
function formatInTz(isoInstant, timeZone, { use24Hour = false, allDay = false } = {}) {
  const date = new Date(isoInstant);
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  if (allDay) return dateFmt;
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: !use24Hour,
  }).format(date);
  return `${dateFmt} · ${timeFmt}`;
}

/** ISO 8601 string with the explicit numeric offset for `timeZone` baked in. */
function toIsoWithOffset(utcInstant, timeZone) {
  const date = new Date(utcInstant);
  const offsetMin = getTimeZoneOffsetMinutes(timeZone, date);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  const local = new Date(date.getTime() + offsetMin * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${offH}:${offM}`
  );
}

export {
  getTimeZoneOffsetMinutes,
  zonedYMD,
  zonedDateToUtc,
  startOfDayInTz,
  formatInTz,
  toIsoWithOffset,
};

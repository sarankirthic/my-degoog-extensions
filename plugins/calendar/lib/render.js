import { formatInTz } from "./time.js";

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderAgenda({ label, events, timezone, use24Hour }) {
  if (!events.length) {
    return `
      <div class="calendar-plugin">
        <h3 class="calendar-plugin__title">${escapeHtml(label)}</h3>
        <p class="calendar-plugin__empty">Nothing on the calendar.</p>
      </div>`;
  }

  const items = events
    .map((e) => {
      const when = formatInTz(e.start, timezone, { use24Hour, allDay: e.allDay });
      return `
        <li class="calendar-plugin__item" data-event-id="${escapeHtml(e.id)}">
          <div class="calendar-plugin__item-main">
            <span class="calendar-plugin__item-time">${escapeHtml(when)}</span>
            <span class="calendar-plugin__item-title">${escapeHtml(e.title)}</span>
          </div>
          <button
            type="button"
            class="calendar-plugin__delete"
            data-event-id="${escapeHtml(e.id)}"
            aria-label="Delete ${escapeHtml(e.title)}"
          >&times;</button>
        </li>`;
    })
    .join("");

  return `
    <div class="calendar-plugin">
      <h3 class="calendar-plugin__title">${escapeHtml(label)}</h3>
      <ul class="calendar-plugin__list">${items}</ul>
    </div>`;
}

export function renderCreateConfirmation({ event, timezone, use24Hour }) {
  const when = formatInTz(event.start, timezone, { use24Hour, allDay: event.allDay });
  return `
    <div class="calendar-plugin">
      <h3 class="calendar-plugin__title">Added</h3>
      <ul class="calendar-plugin__list">
        <li class="calendar-plugin__item" data-event-id="${escapeHtml(event.id)}">
          <div class="calendar-plugin__item-main">
            <span class="calendar-plugin__item-time">${escapeHtml(when)}</span>
            <span class="calendar-plugin__item-title">${escapeHtml(event.title)}</span>
          </div>
          <button
            type="button"
            class="calendar-plugin__delete"
            data-event-id="${escapeHtml(event.id)}"
            aria-label="Delete ${escapeHtml(event.title)}"
          >&times;</button>
        </li>
      </ul>
    </div>`;
}

export function renderUnknown(args) {
  return `
    <div class="calendar-plugin">
      <h3 class="calendar-plugin__title">Not sure what you meant</h3>
      <p class="calendar-plugin__empty">
        Couldn't find a date/time in "${escapeHtml(args)}", and it isn't a recognized
        keyword (today, tomorrow, week, agenda, upcoming, list). Try
        <code>!calendar tomorrow 3pm dentist</code> or <code>!calendar today</code>.
      </p>
    </div>`;
}

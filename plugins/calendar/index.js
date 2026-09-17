import path from "node:path";
import { createLocalStore } from "./lib/store.js";
import { parseIntent, tryParseReadIntent } from "./lib/intent.js";
import { renderAgenda, renderCreateConfirmation, renderUnknown } from "./lib/render.js";

// ---------------------------------------------------------------------------
// Module state — populated in init() / configure(), read by execute() and
// the routes. Fine for a single-process plugin; see the store's write lock
// for the one place true concurrency actually matters.
// ---------------------------------------------------------------------------

let store = null;

let settings = {
  timezone: process.env.TZ || "UTC",
  use24Hour: false,
  rollForward: true,
  agendaWindowDays: 7,
};

function applySettings(saved) {
  settings = {
    timezone: saved?.timezone?.trim() || process.env.TZ || "UTC",
    use24Hour: saved?.use24Hour === "true" || saved?.use24Hour === true,
    rollForward: saved?.rollForward === undefined ? true : saved.rollForward === "true" || saved.rollForward === true,
    agendaWindowDays: Number(saved?.agendaWindowDays) || 7,
  };
}

// ---------------------------------------------------------------------------
// Plugin manifest (shared settings card for the command + routes below)
// ---------------------------------------------------------------------------

export const plugin = {
  id: "calendar",
  name: "Calendar",
  description: "Local date/agenda utility — !calendar today, !calendar tomorrow 3pm dentist.",
  isClientExposed: false, // everything (including deletes) goes through this plugin's own backend routes

  settingsSchema: [
    {
      key: "timezone",
      label: "Timezone",
      type: "text",
      fieldset: "Time & display",
      placeholder: "Asia/Kolkata",
      description: "IANA timezone name. Controls how natural-language times like \"3pm\" are interpreted for NEW events — changing this never rewrites already-created events.",
    },
    {
      key: "use24Hour",
      label: "Use 24-hour time",
      type: "toggle",
      fieldset: "Time & display",
    },
    {
      key: "rollForward",
      label: "Roll ambiguous times to the next occurrence",
      type: "toggle",
      fieldset: "Time & display",
      description: "\"3pm\" typed after 3pm today becomes tomorrow 3pm instead of a past time, when on.",
    },
    {
      key: "agendaWindowDays",
      label: "Agenda window (days)",
      type: "range",
      fieldset: "Agenda",
      min: 1,
      max: 30,
      step: 1,
      description: "How far ahead \"!calendar\", \"!calendar week\", \"!calendar upcoming\" etc. look.",
    },
  ],

  configure(saved) {
    applySettings(saved);
  },

  isConfigured() {
    return true; // local provider needs no credentials
  },

  async init(ctx) {
    // Per the plugin docs, configure(settings) is called automatically on
    // every server start if settings have already been saved — init() just
    // needs to make sure `settings` has sane defaults before that happens,
    // which the module-level initializer above already covers.
    const dataFilePath = path.join(ctx.dir, "data", "events.json");
    store = createLocalStore(dataFilePath);
    await store.init();
  },
};

// ---------------------------------------------------------------------------
// !calendar bang command
// ---------------------------------------------------------------------------

export const command = {
  name: "Calendar",
  description: "Local agenda: !calendar today / !calendar tomorrow 3pm dentist",
  trigger: "calendar",

  async execute(args) {
    const intent = parseIntent(args, settings);

    if (intent.type === "read") {
      const events = await store.listEvents(intent.range);
      return {
        title: intent.label,
        html: renderAgenda({
          label: intent.label,
          events,
          timezone: settings.timezone,
          use24Hour: settings.use24Hour,
        }),
      };
    }

    if (intent.type === "create") {
      const event = await store.createEvent({
        title: intent.title,
        start: intent.start,
        allDay: intent.allDay,
      });
      return {
        title: "Added",
        html: renderCreateConfirmation({ event, timezone: settings.timezone, use24Hour: settings.use24Hour }),
      };
    }

    return { title: "Calendar", html: renderUnknown(args) };
  },
};

// ---------------------------------------------------------------------------
// Backend routes — script.js calls these via /api/plugin/${__PLUGIN_ID__}/...
// ---------------------------------------------------------------------------

// NOTE: the plugin docs only show static route paths in their examples
// (e.g. "/thumb") — no ":id"-style dynamic segment is demonstrated, so this
// deliberately avoids assuming that syntax is supported and uses a query
// param instead. If Degoog's router does support path params, "/events/:id"
// would be the more RESTful choice — worth switching to once confirmed.
export const routes = [
  {
    method: "delete",
    path: "/events",
    async handler(req) {
      const id = new URL(req.url).searchParams.get("id");
      if (!id) {
        return new Response(JSON.stringify({ error: "missing id" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        await store.deleteEvent(id);
        return new Response(null, { status: 204 });
      } catch (err) {
        if (err.code === "NOT_FOUND") {
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "failed to delete event" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    },
  },
  {
    method: "get",
    path: "/events",
    async handler(req) {
      const url = new URL(req.url);
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      const range =
        fromParam && toParam
          ? { from: fromParam, to: toParam }
          : tryParseReadIntent("", settings).range;
      const events = await store.listEvents(range);
      return new Response(JSON.stringify({ events }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
];

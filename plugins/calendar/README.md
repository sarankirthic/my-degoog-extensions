# Calendar plugin — M1 (local agenda, no external accounts)

Implements §1-7 of the M1 scope from the architecture doc: local JSON store
with atomic writes and a write lock, chrono-node NL parsing with proper
IANA-timezone handling, the read/create/don't-guess intent tree, and the
delete + list routes.

## Install

1. Copy this whole folder into your server's plugins directory as
   `calendar/` (i.e. wherever `DEGOOG_PLUGINS_DIR` points — default
   `data/plugins/`).
2. From inside that folder, install the one dependency:
   ```
   npm install
   ```
   (This creates `calendar/node_modules/chrono-node`. Node's normal module
   resolution walks up from the importing file, so this should resolve
   correctly regardless of how the host loads the plugin file — but this
   is the first thing to check if the plugin fails to load. See
   "Things to verify" below.)
3. Restart/reload the server so it picks up the new plugin folder.
4. Settings → Plugins → Calendar → set your timezone (defaults to the
   container's `TZ` env var, or UTC if that's unset). The other three
   settings (24h time, roll-forward, agenda window) have sane defaults —
   only the timezone is worth setting deliberately.

## Try it

- `!calendar` or `!calendar agenda` / `!calendar upcoming` / `!calendar week` — next N days (agenda window setting)
- `!calendar today`
- `!calendar tomorrow`
- `!calendar tomorrow 3pm dentist` — creates an event
- `!calendar dentist 3pm friday` — same, order doesn't matter

## Things to verify against your actual server

These are the places where the plugin docs given to me didn't specify
something precisely enough to be 100% sure, so I made the safer/more
conservative choice rather than guess wrong silently:

1. **Per-plugin npm dependencies.** The plugin docs' example plugins
   (RSS, TMDb, Jellyfin, etc.) only ever call external HTTP APIs — none of
   them import a local computation library like chrono-node. If plugin
   loading resolves imports via plain Node module resolution (very likely,
   since it's just a server importing a JS file by path), `npm install`
   inside the plugin folder is enough. If the loader does something more
   restrictive (a sandboxed VM without filesystem module resolution, or a
   fixed allowlist of importable packages), this dependency won't resolve
   and the plugin will fail to load — check server logs on first restart.
2. **`ctx.dir` is writable and plugin-scoped.** The architecture assumes
   the plugin's own folder is durable (backed by the `data/` volume) and
   that creating `ctx.dir/data/events.json` is safe. Worth a quick
   `console.log(ctx.dir)` check the first time this runs if events don't
   seem to persist across a restart.
3. **Route path syntax.** The plugin docs only show static route paths
   (`"/thumb"`) — no example of a `:id`-style dynamic segment. Rather than
   assume that syntax works, the delete route uses a query param instead:
   `DELETE /events?id=<uuid>` rather than `DELETE /events/:id`. If your
   Degoog router does support path params, switching to `/events/:id`
   is more RESTful and a one-line change in both `index.js` and
   `script.js` — just not assumed here.
4. **Route authentication.** As flagged in the architecture doc: confirm
   the delete route sits behind whatever session/auth context the rest of
   Degoog uses, rather than being reachable unauthenticated. Nothing in
   this plugin adds its own auth — if the host doesn't already protect
   plugin routes, that's a host-level gap, not something to patch here.
5. **`author.json` schema.** Not documented anywhere I was given, so this
   is a reasonable guess (name/description/version) rather than a
   confirmed schema — adjust to match whatever other installed plugins'
   `author.json` files actually look like.
6. **CSS variable names** in `style.css` (`--text-primary`,
   `--bg-secondary`, etc.) are guessed against typical naming, with
   fallback values so it won't look broken either way — check the
   Styling page for the actual variable names and adjust for a closer
   match to the rest of the UI.

## Known limitations (intentional, per the architecture doc)

- `updateEvent` is defined on the store's shape conceptually but throws if
  called — delete-and-recreate is what M1 actually uses.
- No search, no recurring events, no ambient slot — all explicitly
  deferred (see architecture doc §8).
- Timezone offset math is resolved per-target-date (so DST is handled
  correctly for *that* date), but multi-day range shifts that cross a DST
  boundary could be off by up to an hour in rare edge cases. Not worth
  more complexity for a personal agenda tool.

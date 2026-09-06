# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with
     awk, matching "## [x.y.z]". Keep that heading shape exactly. -->
<!-- The docs site includes everything between these markers. Keep the end
     marker last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

### Added

- The server introduces itself in full. `title`, `description`, `websiteUrl` and
  `icons` now travel with `name` and `version`, so a client that shows a server
  to a person has something to show. All four were already in `server.json` for
  the registry and reached no client at all; a test compares the two so they
  cannot drift.
- An OpenSSF Scorecard run, weekly and on every push to `main`, reporting into
  the Security tab next to CodeQL and Trivy. The badge is the second in the row.
- The demo recording is embedded in the README and on the docs home page. It
  had been rendered and shipped since 0.1.0 and was linked from neither.

### Changed

- Source maps are no longer published in the npm tarball. Node reads them only
  under `--enable-source-maps`, which nothing here sets, and the maps pointed at
  a `src/` this package does not ship — so a stack trace under that flag named a
  file nobody could open. `dist/**/*.js` is unchanged; the package is about a
  fifth smaller.
- The docs workflow builds and deploys in two jobs, so `contents: write` is
  scoped to the deploy step rather than granted to the whole workflow.
- `oxlint` to 1.81.

[Unreleased]: https://github.com/ni-c/caldav-mcp/compare/v0.1.2...HEAD

## [0.1.2] - 2026-09-06

### Fixed

- **A cross-host `/.well-known/caldav` redirect ended discovery instead of
  degrading past it.** RFC 6764 §6 defines that route as a redirect and permits
  it to point at another host, which is how a hosted provider sends a client
  from the domain you typed to the one that serves DAV. Refusing to follow it is
  correct — following it would send the credentials somewhere you did not
  configure — but the refusal was thrown rather than returned, so discovery
  never reached its later steps or its home-set fallback. Because the principal
  is resolved once and memoised, that turned into the same error on **every**
  tool call for the life of the process. It is now a note naming the origin that
  was not followed, which is the address `CALDAV_URL` should have had.
- The tool reference generator built its server from seven of `Config`'s
  thirteen fields, under a comment claiming all of them. It now passes the whole
  record and asserts that every tool in the catalogue came back, so an
  incomplete literal fails the build instead of quietly producing a short page.

### Changed

- `npm run docs:tools:check` runs in CI, which it never had, so the generated
  tool reference can no longer drift from the code.

### Documentation

- **The guide's three unfinished pages are written.** `/guide/security` shipped
  as four empty headings — with the brief for writing one of them published as
  an HTML comment. `/guide/configuration` promised "Getting a token" and
  "Required scopes", which CalDAV does not have at all. `/guide/clients`
  documented one of five clients, with a command that passes no credentials.
- One authentication story everywhere: username and app-specific password, as
  the README always had it. Getting started, the clients page and the mcp-hub
  example had been describing a bearer token and scopes.
- `/reference/environment` lists all fourteen variables instead of eight, and no
  longer marks `CALDAV_TOKEN` as required.
- The Glama badge, and both asset markers now name `svg-asset-set` rather than a
  generator script deleted some releases ago.

[0.1.2]: https://github.com/ni-c/caldav-mcp/releases/tag/v0.1.2

## [0.1.0] - 2026-09-05

### Added

First release. An MCP server for CalDAV: 22 tools over events, tasks and
journal entries, on any server that speaks the standard.

- **22 tools**, 10 read and 12 write. `CALDAV_READ_ONLY=true` leaves the write
  tools unregistered rather than failing them, so they do not appear in
  `tools/list` at all.
- **Recurrence is expanded here, not by the server.** Servers disagree about
  `expand`, and several get overrides wrong. The expansion walks the rule and
  then sweeps the overrides the rule never reaches, so an occurrence moved
  outside its own series still appears. Three independent bounds — the result
  cap, a per-series iteration cap and a wall-clock deadline — because
  `FREQ=SECONDLY` with no `UNTIL` is legal iCalendar. A window wider than 366
  days is refused rather than quietly shortened: a truncated ten-year window
  looks exactly like "nothing more in the calendar".
- **Times carry their zone.** Every timestamp is reported as an ISO 8601
  instant, the original `TZID`, and an `all_day` flag. `TZID` names the
  platform does not know do not travel, and the document's own `VTIMEZONE` is
  never registered globally — a hostile entry that redefines `Europe/Berlin`
  affects only itself.
- **Writes are read-modify-write over the parsed tree**, never a document
  rebuilt from the fields this server models. Unknown `X-` properties, alarms,
  attachments, attendees and parameters survive because they are never touched.
  Guarded with `If-Match` from the same read; never `If-Match: *`; a weak ETag
  is refused; a 412 is **not** retried but answered with what the entry is now
  and the fact that nothing was written.
- **`CALDAV_CALENDARS` fences the server to named calendars**, enforced where
  an id is decoded rather than at the edge of each tool, so no tool can forget
  it. A listing reports how many collections it withheld instead of quietly
  being shorter. An entry matching two calendars is refused at startup rather
  than resolved to whichever matched first.
- **Ids are opaque and carry no origin.** The host is rebuilt from `CALDAV_URL`
  on every decode, so a forged id cannot point this server at another server.
  Every join of a calendar URL and a resource name is checked on the
  **resolved** path: checking the name for a literal `/` is not the same check,
  because the URL parser normalises `%2E%2E` and treats a backslash as a
  separator. Names that would address something the id does not say — carrying
  `?`, `#`, a control character — are refused, while percent-encoded names
  still work.
- **Calendar content is treated as content a stranger wrote**, because on a
  server with scheduling anyone who knows your address can put an event in your
  calendar. Summaries, descriptions, locations, attendee names and calendar
  display names are fenced with a per-call nonce and marked line by line;
  invisible and directional characters are removed; markdown image syntax is
  defused so a rendering client cannot be induced to fetch a URL carrying data.
  Injection shapes are reported as a **signal**, never used to drop an entry.
- **Nothing this server says quotes calendar content.** Not the approval
  dialogs, not the error messages. Every value an error repeats — an id, a
  calendar name, an href, a timestamp — is escaped, collapsed to one line and
  cut first, because an error message reaches the model in the server's own
  voice, outside any fence.
- **The dialogs describe what is actually there.** Deleting reads the entry
  first and says whether it is one event or a recurring one and how many
  occurrences — including a resource made only of detached occurrences, which
  has no master to read a rule from. A series id with `scope: this_occurrence`
  is refused before anyone is asked rather than being shown one sentence and
  performing another. An approval is bound to the change as well as to the
  target, and a field left out is not the same as a field passed as `null`, so
  a yes to "change the summary" cannot execute "change the summary and clear
  everything else".
- **It never fetches an address somebody else chose.** `ATTACH` URLs are
  reported and not retrieved; no tool takes a URL. Links returned by the server
  are pinned to the configured origin and refused if they carry credentials or
  a scheme this server does not speak — checked again at the point the
  credentials would leave the process.
- **`CALDAV_ALLOW_PLAINTEXT`.** A plain `http://` URL to a host that is not
  loopback refuses to start instead of printing a warning that a stdio
  deployment never shows. The switch lifts the refusal and is read strictly,
  like `CALDAV_INSECURE_TLS`.
- Bearer or Basic authentication, RFC 6764 discovery from a server root or a
  collection URL, `get_free_busy` with a client-side fallback where the server
  will not compute one, and full-text search per allowed calendar — never at
  the home set, which would reach every calendar underneath it.

[0.1.0]: https://github.com/ni-c/caldav-mcp/releases/tag/v0.1.0

<!-- #endregion changelog -->

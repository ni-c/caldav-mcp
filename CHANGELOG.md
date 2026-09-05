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

<!-- #endregion changelog -->

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

[Unreleased]: https://github.com/ni-c/caldav-mcp/compare/v0.1.4...HEAD

## [0.1.4] - 2026-09-08

### Fixed

- **A document wrapped in `<![CDATA[…]]>` is read instead of counted as
  unreadable.** `calendar-data` is a `stopNodes` entry, so the parser hands back
  its raw source rather than its text — and the XML packaging comes with it.
  Open-Xchange wraps the payload that way, which in the sibling server
  (carddav-mcp, against the same mailbox.org account) meant an address book of
  79 cards listing as empty. CalDAV there happens to serve the payload
  unwrapped, so this is the dialect this server has not met yet rather than one
  it can rule out. The sections are now taken off and joined, including the
  split a server has to make around a document containing `]]>`. Entity
  references **inside** a section are left alone, because that is what a CDATA
  section means.
- **An indented response is read too.** `trimValues` does not reach a stop node,
  so a server that pretty-prints its XML handed over
  `\n        BEGIN:VCALENDAR…`, and an iCalendar document has to start at
  `BEGIN:`.

### Changed

- **A CR or LF reference is decoded where a real newline follows it.** They used
  to be refused everywhere in `calendar-data`, to stop
  `SUMMARY:harmless&#13;&#10;ATTENDEE;PARTSTAT=ACCEPTED:mailto:x` becoming two
  properties. That still holds — a reference smuggled into a value has no real
  newline behind it and stays literal. What is new is the other shape: a server
  that encodes its line endings writes the reference immediately before the
  newline it stands for, because XML normalises a raw CR to LF on the way in and
  escaping it is the only way to keep it. sabre/dav does exactly that, and
  refusing it made every card unreadable in carddav-mcp until 0.1.0. The two
  servers disagreed about this node and only one of them could have been right;
  they now apply the same rule in the same words.
- `mcp-tool-allowlist` 0.2.2, `oxlint` 1.82.

[0.1.4]: https://github.com/ni-c/caldav-mcp/releases/tag/v0.1.4

## [0.1.3] - 2026-09-07

### Security

The second internal hardening pass, 2026-09-07. Every item below was a real
defect in a tree that had passed `npm audit`, Dependabot, CodeQL, Scorecard and
Trivy, and each ships with a test that asserts on the wire or on the result.

- **`mcp-approval` 0.8.1: a sealed dialog answer is single-use.** On protocol
  revision `2026-07-28` the dialog is a return value, and with 0.8.0 the same
  `requestState` and the same ticked box executed the edit again for as long as
  the state lived — fifteen minutes — and the key for changing a whole series is
  the same on every call, which is what made every replay land. A test drives
  the 2026 revision through the in-memory transport and pins that a replayed
  state asks again and writes nothing.
- **A stored value that is not an integer no longer fails the whole answer.**
  The output schema promises `int()` for `sequence`, `priority` and
  `percent_complete`, and the SDK fails the _whole call_ when a result breaks
  that promise. ical.js hands `PERCENT-COMPLETE;VALUE=FLOAT:1.5` over as 1.5, a
  twenty-digit `SEQUENCE` as 1e20, and an `ATTACH;SIZE=` of three hundred
  digits reaches `Number()` as Infinity — so one such line, written by anybody
  with access to a shared calendar, took every listing it appeared in down.
  `sequence` sits in every kind, so `list_events`, `list_tasks` and
  `list_journals` alike. The field is left out now; a `SEQUENCE` this server
  cannot read restarts at 1 on the next write. A property test over arbitrary
  property values pins the whole class, and its first run found two more: an
  alarm `TRIGGER:0`, which ical.js throws on when first read — after the
  per-entry guard, so the listing died — and `SEQUENCE:-0`, on which the two
  halves of a result disagreed.
- **An approval is keyed on a tuple, not a set.** The library's resource key
  sorts its parts, which is right for a set and wrong for (from, to): the key
  for moving `e.ics` from Work to Private was the key for moving the `e.ics`
  in Private to Work, so a token issued for the one authorised the other.
  Every part now carries its position: the keys are built with
  `orderedResourceKey`, which this release takes from mcp-approval 0.8.2.
- **The status is decided before the body is read, and a `401` is remembered.**
  Every verb read the body under the success ceiling and only then looked at
  the status, so a reverse proxy answering `401` with a two-megabyte login
  page surfaced as "larger than 1048576 bytes and was refused". An error body
  is now read up to 64 KiB and cut there. And because every request is a login
  and a hosted provider locks an account after a handful of failed ones, a
  `401` is repeated from memory for ten seconds — the repeated error says how
  old it is and what to check — so a model retrying a tool annotated cheap and
  read-only cannot lock the account.
- **A tool call has a budget as a whole.** One REPORT per calendar, thirty
  seconds allowed for each, over every calendar the credentials can see: a slow
  server with a hundred collections turned one call into an hour with no way to
  say so. A call now has a 30-second budget checked before each request, a
  ceiling of 5000 collected occurrences, and an answer that says after how
  many of how many calendars it stopped. Discovery has the same shape one level
  up — eight home sets, twenty addresses, 256 calendars, each overflow counted
  and reported — and a collection a home set lists is used only if it sits
  under that home set.
- **Every string walk is linear at its ceiling.** `/\/+$/` and `/[^/]*$/` are
  tried from every position of a run and consume the run each time: eighty
  thousand slashes followed by one character cost two seconds, from any href
  the server chose, and a segment filling the 16 MiB multistatus ceiling would
  have cost hours. A counted walk and `lastIndexOf` replace them, an href past
  8 KiB is refused before anything walks it, and `linear-time.test.ts` times
  every such function at its ceiling.
- **An ETag is held to the RFC 9110 grammar before it becomes an `If-Match`.**
  undici refuses a header value with a control character, which reached the
  model as `fetch failed` on every write to that resource for as long as the
  server kept sending it. An ETag that is not an entity-tag is treated like a
  weak one, which the write path already refuses with a sentence.
- **A recurrence rule and an alarm trigger are checked as values, not only
  parsed.** ical.js reads what it understands and drops the rest: `COUNT=1e9`
  became `COUNT=1`, `INTERVAL=0` and an unknown part vanished, the second of
  two `COUNT`s won, everything after a line break was gone; `PT-5M` was
  written verbatim, `P1W2D` as `P9D`, a hundred billion hours accepted. Each
  was then written into a shared calendar as if it were what the caller asked
  for. Both are held to their RFC 5545 grammar and the rule is compared part by
  part with what would be written. The test for the accepted triggers found
  that every absolute reminder went out with `VALUE=DATE-TIME` twice on one
  property, which is not iCalendar.
- **An untyped error is quoted like every other value an error repeats.**
  ical.js writes the offending value into its messages, and the last catch in
  `run()` repeated that text to the model whole, in this server's own voice,
  outside any fence.
- **The fenced text block of a single entry is measured as emitted**, with the
  datamark on every line, against the same ceiling as the JSON beside it; it
  used to go out unmeasured, so an entry just under the ceiling was answered
  three times over. The budget also descends one level, so an attendee list
  under `event` can be shortened instead of the whole answer refused.
- **An allowlist entry that matched nothing is no longer printed in full.**
  `CALDAV_CALENDARS` sits one line below `CALDAV_PASSWORD` in every compose
  file, and an entry that matches nothing is what a secret pasted into the
  wrong line looks like. Only a value shaped like a calendar reference is
  quoted; the rest is described by its length, to stderr and to the model
  alike, and so are the other three "got …" diagnostics.
- **The publish job installs with `--ignore-scripts`.** It is the job with
  `id-token: write` for npm Trusted Publishing, and every dependency's install
  hook ran while that token was available. `gh release create` verifies the
  tag; a `dependency-review` job checks what a pull request changes.
- **The runtime image no longer carries yarn, corepack or a lockfile.** npm and
  npx had been removed; the other two package managers stayed behind.

### Fixed

- A `404` or a `405` on a discovery guess — the origin root behind a `/dav.php`
  prefix is usually a plain web server — ended discovery one step before the
  home-set fallback written for exactly that case. Those two statuses now
  degrade like an HTML page; a `401`, a `403` and a `5xx` are still the answer.
- A calendar's id is printed byte for byte, and the same in every tool.
  `list_calendars` ran the path through the text cleaner, which rewrote
  `![a](b)`, normalised to NFKC and cut a long path — an id no tool could
  resolve — while `get_server_info` printed the raw path beside it. An
  identifier that has to round-trip is validated, not cleaned. The same sweep
  cleaned what `get_server_info` repeats from the server and the attendee
  `ROLE`, `PARTSTAT` and attachment `FMTTYPE` in a listing.
- `is_self` is decided the same way in every tool. `CALDAV_USER_EMAIL` was
  lower-cased for listings and not for `get_event` or `get_server_info`.
- A URL-form `CALDAV_CALENDARS` entry matches only on the configured origin;
  an entry for another account no longer stands in for the same path on this
  one.
- The id tag was looked up in an object literal, where `constructor` is a key
  too, and the sentence built from it said "the id of a undefined".
- `CALDAV_URL` is kept as the parsed origin and path rather than as the
  environment string, so the whitespace a copied line carries is no longer
  glued in front of every path.

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
- Four test suites: the discovery walk shape by shape, every approval outcome
  and every write-path refusal, the insecure-TLS switch with undici mocked, and
  the property tests above. The coverage floor rises to 97 / 88 / 99 / 98.

### Changed

- oxlint's `suspicious` category is on. Thirty of its thirty-nine findings were
  `sort()` on a fresh array in a test, which `toSorted()` says without the
  mutation; the TypeScript target moves to ES2023 for it.
- `docs/reference/tools.md` is written by hand again. It used to be generated
  from the registered tools, which kept it in step with the code at the price of
  a page nobody could edit: `--check` compared it byte for byte, so every line
  had to be derivable and a paragraph about how an endpoint really behaves had
  nowhere to go. A test now asserts what the generator guaranteed — the page
  documents exactly the tools that exist, marks exactly the `essential` preset,
  and marks exactly the tools that ask a person first — and leaves the prose to
  a person.
- Source maps are no longer published in the npm tarball. Node reads them only
  under `--enable-source-maps`, which nothing here sets, and the maps pointed at
  a `src/` this package does not ship — so a stack trace under that flag named a
  file nobody could open. `dist/**/*.js` is unchanged; the package is about a
  fifth smaller.
- The docs workflow builds and deploys in two jobs, so `contents: write` is
  scoped to the deploy step rather than granted to the whole workflow.
- `oxlint` to 1.81.

[0.1.3]: https://github.com/ni-c/caldav-mcp/releases/tag/v0.1.3

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

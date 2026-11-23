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

### Fixed

- A calendar whose `resourcetype` also names `schedule-outbox` was left out of
  the list (#61). SOGo marks the account's own calendar that way, so it never
  showed, not even with `CALDAV_URL` pointing straight at it. Per RFC 4791 a
  collection that reports `calendar` is a calendar; the scheduling inbox and
  outbox, address book and notification markers now keep out only a collection
  that does not. Servers that give the inbox and outbox collections of their
  own, as sabre/dav (Baikal, Nextcloud) and Cyrus do, see no change.
- With `CALDAV_URL` on a collection that is not used after all, `list_calendars`
  now says why instead of only calling it a calendar collection.

## [0.2.0] - 2026-11-18

### Added

- Subscribed calendars (#52). Open-Xchange, mailbox.org among them, lists a
  subscription as `CS:subscribed` instead of a calendar, and it was not found.
  It is now listed by `list_calendars` with `subscribed: true` and
  `read_only: true`. Every write tool refuses it. A tool that names no
  calendar leaves subscriptions out unless `CALDAV_CALENDARS` names them, or
  `CALDAV_URL` points at one. The feed's own address is never asked for,
  fetched or shown.
- `list_tasks` takes `undated: true` to list the tasks that have neither a
  start nor a due date (#51). A windowed listing cannot place such a task in
  time and leaves it out, although the server does return it there: RFC 4791
  matches it through CREATED or COMPLETED, or always. The option asks the
  server for exactly these tasks with `is-not-defined`, reads every task and
  keeps the undated ones where a server refuses that filter, and is refused
  together with `from`, `to` or `timezone`.
- A windowed `list_tasks` says how many tasks without a date the server
  returned, and how to list them.
- `update_task` takes null for `due` and `start` to remove that date. Removing a
  start that a recurrence rule, a date list or a duration depends on is refused
  before anything is written.

### Changed

- CI's `npm audit` checks the runtime dependencies only, the ones the package
  and the image ship. Advisories against development tools are still reported
  by Dependabot, but no longer block a merge.
- A collection a server marks as both a calendar and a subscription was treated
  as an own calendar. It is now read-only and read only when named.
- Discovering subscriptions can make an existing `CALDAV_CALENDARS` entry given
  as a final path segment match two collections. Discovery then refuses, as it
  does for any ambiguous entry; name the calendar by its path.
- Require Node.js 24 or newer. CI tests the latest 24 and 26 LTS releases; Node 22 is no longer supported.
- A listing is fitted to the size ceiling as it is emitted, indented, before it
  is counted. Pages that reach the ceiling hold fewer entries than before, and
  `count`, `truncated.returned` and `next_cursor` describe the page returned.
- One calendar that refuses a request — any status but 401 and 429, or an
  answer over the size ceiling — no longer fails `list_events`, `list_tasks`,
  `list_journals`, `search_events` or `get_free_busy`: the other calendars are
  listed and a note names the one that refused. When every calendar refuses,
  the call is still an error. At most twenty refusing calendars are named.
- When a window holds more than 5000 occurrences, the earliest 5000 across all
  entries and calendars are kept, and the answer names the instant from which
  nothing is listed. The ceiling used to fill in the order the server sent the
  entries and then stop asking further calendars. Every calendar is now asked.
- `get_free_busy`, when it works the periods out from the events, reads every
  event in the window rather than one page of them, keeps the 30-second call
  budget, and says when a calendar held more than it could read.

### Fixed

- `get_task` failed on a task without a date, and `update_task` and
  `complete_task` wrote the change and then reported an error (#51).
- One task with an unreadable CREATED, LAST-MODIFIED or COMPLETED value made
  every listing of its calendar fail. The field is now left out.
- A task with an unreadable DTSTART or DUE, or with a recurrence rule but no
  start or due date, vanished from the undated listing without a note.
- A windowed `list_tasks` left completed tasks out after the page was cut, so a
  page could hold fewer tasks than its limit while claiming more, and a STATUS
  in fullwidth letters counted as open in one mode and done in the other.
- Entries the size budget dropped were paged past for good.
- A recurring series was expanded to at most `limit` occurrences, so its later
  occurrences appeared on no page, with no note.
- `window_covered_until` was empty on a page that ended on a task with only a
  due date.
- The five seconds of expansion per call ran out while a slow server answered,
  so every series stopped at its first step.
- `truncated_fields` named a field that had only lost invisible characters.
- A spent expansion budget still gave every further series 256 steps.
- A completed recurring task could fill the occurrence ceiling of a listing
  that leaves it out.
- Two occurrences with the same start and id made paging loop.

### Security

- A calendar the account can only read was protected only on create and as the
  destination of a move. Updates, completions, responses, deletes, occurrence
  exclusions and moves out of it reached the server, and the deletes and
  `respond_to_event` asked for approval first. Every write tool now refuses it
  before anything is sent or asked.
- A recurrence rule whose parts never match, such as
  `FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30`, made ical.js loop for ever inside a
  single step, out of reach of every deadline: one invitation froze the
  server. A DAILY rule of the same kind ran for over a minute, an `INTERVAL` of
  fifteen nines froze it as well, and an impossible YEARLY rule cost two
  seconds per RRULE line. Each of these walks is now bounded from inside, and
  the series is reported as incomplete; a rule that repeats only every few
  hundred years is read as its first occurrence and refused when written.
- More of the same kind, all in every released version: an RDATE period of a
  billion weeks, and a VTIMEZONE whose own rule never matches, steps fifteen
  digits of minutes or days, or runs every second, froze the server or crashed
  it out of memory, because ical.js evaluates a zone's rules whenever it
  compares two times in it. A document is now refused before ical.js evaluates
  it when it is past limits no real calendar comes near: a timezone rule that is
  not yearly in one month, more than four rules, 64 weekdays in a rule or
  10,000 extra or excluded dates in one entry, or a content line with more than
  100 parameters. Behind that, ical.js's own steps, durations, normalisations
  and timezone expansions are bounded for the whole process.
- Behind both, evaluating a stored entry runs under a hard time limit that V8
  enforces, whichever loop it is in: three seconds per entry, after which the
  entry is skipped with a note. A listing stops evaluating after three such
  entries or twenty seconds of evaluation in all, and says how many it left
  out. A fifth Sunday every 48 months from a
  February that is never a leap year, and ten thousand RDATE periods just under
  the duration cap, were each found by review after the guards above.
- A note about an entry the parser refused quoted part of the refused line.
  It now says only that the entry is not readable.
- An image reference whose alt text was longer than 200 characters passed the
  defusing untouched.
- `get_free_busy` worked out from events joins overlapping and touching periods
  and stays under the size ceiling; FBTYPE is one of the four RFC 5545 values.
- Every Unicode format character and every other default-ignorable code point
  is removed from calendar text and escaped where the server quotes a value:
  the tag block (U+E0000–E007F), which spells ASCII invisibly, and the
  variation selectors, which carry a hidden byte each. The previous list of
  ranges stopped at U+FEFF. U+FE0E and U+FE0F stay, once and only straight
  after a pictographic emoji. Text is cut on code points, so a cut no longer
  leaves half a surrogate pair.
- A listing shaped every occurrence it collected, up to 5000, before cutting
  out a page, and each one cleaned its master's text again: one hourly series
  with a long description and many attendees took seconds and a gigabyte of
  memory for `limit: 1`. Only the page is shaped now, occurrences of one
  series share their cleaned fields, and a field's raw text is read only up to
  four times its cap.
- A note about an unreadable entry repeated the resource name uncut through the
  parser's message. The name is now quoted once, cut and escaped.
- `bounded_series` named UIDs taken raw from the iCalendar text. They are now
  cleaned like every other field, and at most twenty are named.
- Notes about individual entries are capped at twenty, so a calendar full of
  broken entries cannot crowd the entries out of an answer.

[0.2.0]: https://github.com/ni-c/caldav-mcp/releases/tag/v0.2.0

## [0.1.5] - 2026-10-13

### Fixed

- `get_free_busy` reported the whole queried window as busy, once per
  calendar, against Radicale 3.8.2 and later and any server answering in the
  RFC 4791 shape: the bounding DTSTART/DTEND of the VFREEBUSY component were
  read as a busy period. A component carrying FREEBUSY properties is now read
  for those alone, and an empty one spanning exactly the window means free.

### Changed

- The container image is built on newer digests of the same Node LTS base
  image, and the dependencies baked into it are refreshed. The npm package's
  declared dependency ranges are unchanged.

### Documentation

- The README's Socket badge uses Socket's current badge URL.

[0.1.5]: https://github.com/ni-c/caldav-mcp/releases/tag/v0.1.5

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

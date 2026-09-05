# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/caldav-mcp.git && cd caldav-mcp
npm install
npm test          # 280+ tests against an in-memory CalDAV fake, no network
npm run build
```

A minimal dev environment:

```sh
export CALDAV_URL=http://127.0.0.1:5232
export CALDAV_USERNAME=integration
export CALDAV_PASSWORD=integration-not-a-secret
export CALDAV_TIMEZONE=Europe/Berlin
export CALDAV_CALENDARS=work,private
```

## Running the integration suite

The unit tests replace `fetch`, so what they check is that this server speaks
CalDAV the way its author understood it — against a stub written to that same
understanding. Only a real server can disagree, and CalDAV servers disagree a
lot: namespace prefixes, href forms, which preconditions come back on an error,
whether `free-busy-query` expands recurrence for you.

```sh
npm run build     # the suites run dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

There are two suites against two servers, and they answer different questions.

**Radicale is the coverage pass.** One story in order — the event it creates is
the one the next test changes and the one after that deletes — with **every tool
in the catalogue** called once and the `skipped` list empty. Where an assertion
matters it reads the stored `.ics` back over plain HTTP rather than through this
server, because a test that only calls `get_event` proves the server agrees with
itself, which is not the question.

**Baikal is the portability pass**, and it is deliberately not a second copy:
running the same story twice would double the wall clock to re-prove the same
thing. It asserts only where two correct CalDAV servers legitimately differ,
which is where a server that has only ever met one of them is wrong without
knowing it — a `/dav.php` path prefix, lowercase `d:`/`cal:` prefixes, entity
decoding in `calendar-data`, ETag semantics across a different serialiser, the
`text-match` collation retry, and the `start/duration` shape of a free/busy
period. It found a real discovery bug on its first run, which is the argument
for having it. There is no `expectEveryToolExercised` there, on purpose.

Both bootstraps create their calendars with `MKCALENDAR` over the wire, which is
something this server deliberately cannot do — a suite must not lean on a
capability documented as absent. Baikal's _account_, by contrast, is seeded
straight into its SQLite database rather than installed through the web wizard:
that wizard is three CSRF-carrying form posts and a login, four chances to break
on a cosmetic change to an admin page nothing here tests.

Both then empty each collection before seeding it, so a run against a stack
somebody left up means the same as a run against a fresh one. That was a real
failure: a weekly series expanded into eleven occurrences instead of four and
six assertions went red at once, which reads like broken code and is actually
stale state. Run it twice before believing it.

The containers are throwaways and the compose file binds `127.0.0.1` only. Point
this at nothing whose data matters — the suite calls every delete the server
has, and the harness refuses any backend URL that is not on this machine.

For poking at one tool by hand, the inspector against the same stack:

```sh
docker compose -f test/integration/compose.yml up -d --wait radicale
CALDAV_URL=http://127.0.0.1:5232 CALDAV_USERNAME=integration \
CALDAV_PASSWORD=integration-not-a-secret CALDAV_TIMEZONE=Europe/Berlin \
npx @modelcontextprotocol/inspector node dist/index.js
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the full suite on Node 22 and 24, plus `npm audit`,
  CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, the approval flow, the calendar
  allowlist, anything that builds a request URL or an XML body): please describe the
  attack you are defending against, or the one your change might open, in the PR text.
- **Calendar content is untrusted input.** Anyone who can send an invitation can put
  text into a calendar. Anything that puts that content into a tool result has to keep
  it inside the nonce fencing, and anything that puts it into text a model treats as
  instruction — a confirmation prompt, an error message — is a bug.
- **The server must not gain the ability to fetch a URL somebody else chose.**
  `ATTACH` URLs are reported and never retrieved; no tool takes a URL. That absence is
  why `openWorldHint` is `false` everywhere and why there is no SSRF guard to get
  wrong.
- **Writes stay read-modify-write.** Rebuilding a component from the fields this
  server knows about silently discards the ones it does not — alarms, attachments,
  attendee parameters, `X-` properties. Change the parsed tree in place, and never
  send `If-Match: *`.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/caldav-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/caldav-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/caldav-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)

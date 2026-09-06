# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/caldav-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

The credentials this server holds are a calendar account. Anyone who obtains them can
read every appointment it contains — which for most people is a continuous record of
where they were, who they met and when they were not at home — and, unless
`CALDAV_READ_ONLY` is set, change or delete all of it. A calendar is also a _shared_
object more often than a mailbox is: an account frequently carries collections other
people own and have delegated. Prefer an app-specific password over the account
password where the provider offers one.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a calendar whose contents you would not put in a model's context.
`CALDAV_CALENDARS` exists for exactly that: it names the collections this server may
touch, and everything else on the account stays invisible to it. It is enforced when
an id is decoded rather than at the edge of each tool, so there is no path from an id
to a URL that skips the check, and a listing reports how many collections it withheld
rather than quietly showing a shorter list.

Destructive operations **ask a person** through MCP elicitation: a dialog raised by
the server and shown by the client, which the model cannot answer on its behalf, and
which nothing proceeds without. Where the client cannot show one they fall back to a
server-generated token bound to the specific target — which proves the call was made
twice with the same arguments and nothing more, and the fallback text says so rather
than implying somebody approved. `ELICITATION=false` moves a capable client onto that
fallback deliberately; it does not remove the guard, and the server prints one line
at startup saying it is off.

## What this server cannot do

Three capabilities are absent by construction rather than disabled by a setting, and
each absence is doing security work:

**It never fetches an address somebody else chose.** An `ATTACH` property may carry a
URL, and this server reports that URL and does not retrieve it. No tool takes a URL,
so there is no way to make the process request one — which is why there is no
SSRF-guard module here at all, and why `openWorldHint` is `false` on every tool. The
only host it speaks to is the one in `CALDAV_URL`.

**It cannot create or delete a calendar.** There is no `MKCALENDAR` verb and no
collection-level `DELETE` in the code. The worst a defect in the addressing scheme
could reach is a single resource, not somebody's entire calendar. The integration
bootstrap creates its collections over the wire precisely because the server cannot,
so the suite never leans on a capability that is documented as missing.

**It does not send mail.** Answering an invitation with `respond_to_event` writes a
`PARTSTAT` into the calendar; on a server with a scheduling plugin, that server may
then send an iTIP message. This process has no SMTP client and makes no outbound
request of any kind. That is also why `respond_to_event` asks first even though it is
not destructive: _irreversible is not the same as destructive_, and something leaving
the building on your behalf is worth a dialog regardless of what the annotation says.

The property holds for _this server_, not for the session it runs in. If the same
agent also has a web-fetch tool, a shell, or another MCP server that can post
somewhere, calendar content read through this server can be exfiltrated through that
other tool. Compose accordingly.

## Untrusted content

**A calendar is a mailbox with extra steps.** Anyone who can send an invitation can
put text into it, on many servers without the owner accepting anything, and a shared
or delegated collection is written by whoever it is shared with. So summaries,
descriptions, locations, attendee names, categories and calendar display names are
all treated as content a stranger wrote.

They are returned between markers carrying a per-call random nonce, with every line
inside prefixed by that nonce. Text written before the call cannot predict either, so
an event cannot close the block early and continue in the server's voice. A reminder
follows the block, because without one the last instruction-shaped sentence in the
model's context is the attacker's. Before that the text is normalised: zero-width and
directional-override characters are removed, and markdown image syntax — inline,
reference and shortcut style — is defused so a rendering client cannot be induced to
fetch a URL carrying data in its query string. That last one is the EchoLeak shape
([CVE-2025-32711](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711),
CVSS 9.3), where a single crafted message nobody opened exfiltrated data during
ordinary background processing.

The injection patterns the server recognises are reported as a **signal**, never used
to drop an entry silently. A filter that appeared to work would be an argument for
trusting whatever got through, which is precisely the wrong conclusion: an attacker
who can iterate will find a phrasing the patterns do not match. Every pattern is
timed against tens of thousands of characters of its own trigger, because a pattern with an
unbounded run and no anchor is quadratic and this process is single-threaded with
stdio as its transport — a scan that takes a second on a real input takes the whole
server with it on a crafted one.

**Calendar names are content too**, and they reach the model through `list_calendars`
long before anyone reads an event. Each entry carries both the raw name and a display
copy, and says so where the two differ: `Team` and `Team<U+200B>` are the same pixels.

Confirmation text never quotes a summary, a description or an attendee. That text is
read by a human and by a model, and putting attacker-chosen prose into it would hand
the attacker the last word at exactly the wrong moment.

**Be clear about what framing buys.** Measured across models, delimiting untrusted
content takes resistance to injection from roughly 61% to roughly 90% — a real
improvement, and nowhere near a guarantee, with the weakest models benefiting least.
Against an attacker who adapts to the defence, prompt-level measures fail. They are a
speed bump. The architecture above is the wall.

## Addressing, and why ids are opaque

An id names a calendar path and a resource name, base64url-encoded. It never carries
an origin: the host is rebuilt from `CALDAV_URL` on every decode, so a forged id
cannot point this server at a different server.

Within that, the check that matters is on the **resolved** path rather than on the
input. Checking a resource name for a literal `/` is not the same check: the URL
parser normalises a percent-encoded dot segment and treats a backslash as a
separator, so `%2E%2E` walks up out of a collection and `%2e%2e\..\victim` lands in a
different one. Since the allowlist is enforced on the calendar path, that would have
let a forged id name a collection it was allowed to touch and then address a resource
in one it was not. Every join of a calendar URL and a resource name goes through one
function that asserts the resulting parent directory _is_ the calendar, which holds
against whatever encoding is tried next.

## XML and iCalendar parsing

Both formats are parsed from bytes a stranger wrote, and both have a well-known way
to go wrong.

The XML parser resolves no entities and refuses a `DOCTYPE` outright, so
billion-laughs expansion and `<!ENTITY … SYSTEM "file:///etc/passwd">` are not
defended against — they are not implemented. Because entities are therefore not
expanded by the parser, they are decoded where a text node becomes a value, and that
decode is where the interesting bug lives: `&#13;&#10;` in a `SUMMARY` would become a
real iCalendar line break and let
`SUMMARY:harmless&#13;&#10;ATTENDEE;PARTSTAT=ACCEPTED:mailto:…` forge a second
property. Numeric references to C0/C1, surrogates and out-of-range code points are
returned as their source text rather than as characters, and a test fires exactly
that payload.

The one genuinely free value this server writes into XML is the search string in a
`text-match`. It goes through an escaper, and a test asserts that
`]]></C:text-match><C:prop-filter …>` appears only as escaped character data.

`VTIMEZONE` definitions are not registered globally. ical.js keeps a process-wide
timezone service, so one hostile entry could redefine `Europe/Berlin` and shift every
time computed afterwards; a known IANA zone always beats a definition carried by a
document, and the service is never written to.

Recurrence is expanded in this process, never by asking the server to do it, and
carries three independent bounds: the configured result limit, a per-series iteration
cap, and a wall-clock ceiling over the whole pass. `FREQ=SECONDLY` with no `UNTIL` is
legal iCalendar and generates millions of occurrences. A window wider than 366 days
is **refused** rather than silently shortened, because a truncated ten-year window
looks exactly like "no further appointments".

## Writing

A `PUT` replaces an entire resource, so every write is a read-modify-write over the
parsed tree rather than a rebuild from fields: fetch, parse, change only the named
properties, serialise, and send it back with `If-Match` carrying the ETag from that
same fetch. Unknown `X-` properties, alarms, attachments, attendees and parameters
this server has no concept of survive because they are never touched.

Never `If-Match: *` — that is the absence of the safeguard wearing its clothes. A
weak ETag cannot protect a write under RFC 9110 and is refused with a reason. On a
412 the write is **not retried**: a blind retry is precisely the lost update the ETag
exists to prevent. The resource is read once more and the answer says what the entry
is now, that nothing was written, and that the same call can be repeated.

`create_*` generates the UID and the resource name itself and sends `If-None-Match: *`,
so a caller never chooses a path — which removes traversal and accidental overwriting
in one move.

# Security

This page is the prose version of [SECURITY.md](https://github.com/ni-c/caldav-mcp/blob/main/SECURITY.md).

## Trust model

The credentials this server holds are a calendar account, and a calendar is a
continuous record of where somebody was, who they met and when they were not at
home. Anyone who obtains them can read all of it, and unless `CALDAV_READ_ONLY`
is set, change or delete it too. Calendars are also shared more often than
mailboxes are: an account routinely carries collections other people own and
delegated. Prefer an app-specific password over the account password where the
provider offers one — same access, revocable on its own.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result, so do not
point this server at a calendar whose contents you would not put in a model's
context. `CALDAV_CALENDARS` is the tool for that: it names the collections this
server may touch, and everything else on the account stays invisible to it. The
check runs where an id is **decoded** rather than at the edge of each tool, so
there is no route from an id to a URL that skips it, and a listing reports how
many collections it withheld rather than quietly showing a shorter list.

## The confirmation, honestly

The destructive tools ask before they act, and it is worth being exact about
what that means, because "asks for confirmation" is a phrase that covers two
quite different things.

Where the client supports **elicitation**, a person sees a dialog. The server
raises it, the client shows it, the model cannot answer it on its behalf, and
nothing proceeds until somebody answers. That is the real guard.

Where the client does not, the tool refuses the first call and hands back a
**single-use token bound to the exact target** — the calendar, the resource, and
a fingerprint of the change. Call again with the token and the same arguments
and it proceeds. What that proves is precisely this: the call was made twice
with the same arguments, and **nothing more**. It does not prove a person saw
anything. The refusal text says so in those words rather than implying somebody
approved, because a fallback that reads like an approval is worse than no
fallback — it converts an absent guarantee into a claimed one.

`ELICITATION=false` moves a capable client onto that fallback deliberately. It
does not remove the guard, there is no setting in which a guarded call goes
unannounced, and a server started with it off prints one line at startup saying
so. The variable carries no `CALDAV_` prefix on purpose, so one `export` reaches
every MCP server in the environment; that is the point of it and also its risk.

[Asking a person](/guide/approval) carries the detail: which tools ask, what
each dialog shows, and why `respond_to_event` asks even though it is not
destructive.

## Untrusted content

**A calendar is a mailbox with extra steps.** Anyone who can send an invitation
can put text into one, on many servers without the owner accepting anything, and
a shared or delegated collection is written by whoever it is shared with. So
summaries, descriptions, locations, attendee names, categories and calendar
display names are all treated as content a stranger wrote.

They come back between markers carrying a per-call random nonce, with every line
inside prefixed by it. Text written before the call cannot predict either, so an
event cannot close the block early and carry on in the server's voice. A
reminder follows the block, because without one the last instruction-shaped
sentence in the model's context is the attacker's.

Before that the text is normalised: zero-width and directional-override
characters removed, and markdown image syntax defused so a rendering client
cannot be induced to fetch a URL carrying data in its query string. That last
one is the EchoLeak shape
([CVE-2025-32711](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711),
CVSS 9.3), where a crafted message nobody opened exfiltrated data during
ordinary background processing.

The injection patterns this server recognises are a **signal, never a filter**.
Nothing is dropped on the strength of a match: a filter that appeared to work
would be an argument for trusting whatever got through, which is exactly the
wrong conclusion, since an attacker who can iterate will find a phrasing the
patterns miss. Each pattern is timed against tens of thousands of characters of
its own trigger, because an unanchored unbounded run is quadratic and this process is
single-threaded with stdio as its transport — a scan that takes a second on real
input takes the server down on crafted input.

**Calendar names are content too**, and they reach the model through
`list_calendars` long before anybody opens an event. Each entry carries the raw
name and a display copy and says so where the two differ: `Team` and
`Team<U+200B>` are the same pixels.

**Nothing card- or event-derived is ever quoted in a confirmation.** That text is
read by a human and by a model at the moment a deletion is being decided;
attacker-chosen prose there would hand the attacker the last word at the worst
possible time.

**And be clear about what framing buys.** Measured across models, delimiting
untrusted content takes resistance to injection from roughly 61% to roughly 90%
— a real improvement and nowhere near a guarantee, with the weakest models
benefiting least. Against an attacker who adapts to the defence, prompt-level
measures fail. They are a speed bump; the architecture is the wall.

## What is absent on purpose

Three capabilities are missing by construction rather than switched off, and
each absence does security work:

- **It never fetches an address somebody else chose.** An `ATTACH` may carry a
  URL; this server reports it and does not retrieve it. No tool takes a URL, so
  there is nothing to point at an internal host — which is why there is no SSRF
  guard here to get wrong, and why `openWorldHint` is `false` on every tool.
- **It cannot create or delete a calendar.** No `MKCALENDAR`, no
  collection-level `DELETE`. The worst a defect in the addressing scheme can
  reach is one event.
- **It does not send mail.** `respond_to_event` writes a `PARTSTAT`; a server
  with a scheduling plugin may then send an iTIP message, but this process has
  no SMTP client and makes no outbound request of any kind.

That holds for *this server*, not for the session it runs in. An agent that also
has a web-fetch tool, a shell, or another MCP server that can post somewhere can
carry calendar content out through that. Compose accordingly.

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/ni-c/caldav-mcp/security/advisories/new),
never a public issue, and please leave real credentials, tokens and internal
hostnames out of the report.

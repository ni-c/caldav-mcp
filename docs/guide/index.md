# What is caldav-mcp?

MCP server for CalDAV calendars: events, tasks and journal entries

## Why

CalDAV is the open standard almost every calendar that is not Google or Exchange
speaks: Nextcloud, Radicale, Baikal, SOGo, Fastmail, mailbox.org, iCloud. One
server therefore reaches all of them, and reaches them directly — there is no
vendor API in between, and nothing about your calendar leaves the machine except
to the server you configured.

The awkward parts of a calendar are the parts a general-purpose HTTP tool cannot
do for you. A recurring meeting is stored as one rule and a handful of
exceptions, so "what is on next Tuesday" is a computation rather than a lookup.
A timestamp means nothing without the zone it was written in, and the zone is
frequently referenced and not included. Writing anything back replaces the whole
entry, so a careless edit removes the reminders and the attendees of an
appointment without saying so.

caldav-mcp does those three things properly and gets out of the way:

- **Recurring entries are expanded here**, into occurrences with ids of their
  own, so one instance can be changed without touching the series. Asking the
  calendar server to expand them is possible and unreliable — support is uneven
  and its absence is silent — so this server does it and behaves the same
  everywhere.
- **Times carry their zone.** Every timestamp comes back as an instant with an
  offset, the IANA zone the entry was written in, and a flag for whole-day
  entries. A daily 09:00 meeting stays at 09:00 across a daylight-saving change,
  which is not what naive date handling does.
- **Writing reads first.** Every change is applied to the entry as stored, so
  the properties this server does not model — attendees, attachments, the
  reminders it cannot write, anything a vendor added — survive because they are
  never touched. The write carries the entry's ETag, so a change made elsewhere
  in the meantime is reported rather than overwritten.

Calendar content is also somebody else's writing. On a server with scheduling
enabled, anyone who knows your address can put an entry in your calendar without
you accepting it, so everything read out of one is marked as untrusted data and
fenced before it reaches the model. See [Security](/guide/security).

## What it is not

- **Not a scheduling client.** It can answer an invitation with your own
  participation status, and that is all: it cannot add or remove attendees, and
  therefore cannot invite or cancel on anybody.
- **Not a calendar manager.** It lists calendars and never creates or deletes
  one. Deleting a collection removes everything in it at once, which is the
  largest single destruction available in this protocol, for an operation people
  perform once a year in a web interface.
- **Not a file reader.** An attachment on an entry is reported as metadata —
  name, type, size, and the URL if it has one — and never fetched or decoded.
- **Not a CardDAV client.** Contacts are a different specification with a
  different data format, and belong in a different server.

See [Not exposed, on purpose](https://github.com/ni-c/caldav-mcp#not-exposed-on-purpose)
for the full list and the reasoning behind each.

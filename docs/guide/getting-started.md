# Getting started

## Requirements

- Node.js ≥ 22
- A CalDAV account — Nextcloud, Radicale, Baikal, SOGo, Fastmail, mailbox.org,
  iCloud, or anything else that speaks the standard
- Its URL, your username, and a password. There is no token to obtain and no
  scopes to grant; see [Configuration](/guide/configuration#signing-in), and use
  an app-specific password where the provider offers one

## Run it

```sh
CALDAV_URL=https://dav.example.net \
CALDAV_USERNAME=you \
CALDAV_PASSWORD=your-app-password \
  npx -y @ni-c/caldav-mcp
```

Nothing is written on startup, and nothing is read either: the server registers
its tools and waits. The first tool call is what walks from that URL to the
principal and the calendar home set.

Two more worth setting straight away:

```sh
CALDAV_TIMEZONE=Europe/Berlin   # for a time somebody types without an offset
CALDAV_READ_ONLY=true           # registers the read tools and nothing else
```

`CALDAV_TIMEZONE` defaults to UTC, which is rarely what a person means by "three
o'clock". `CALDAV_READ_ONLY` is worth trying first: it is the cheapest way to
see what the server does before letting it change anything.

Without credentials the server still starts and still lists its tools; every
call then fails with setup instructions rather than reaching the network. That
is deliberate — a client that probes the tool list at launch should not need a
configured account to see one.

Next: [connect a client](/guide/clients), or read the
[tool reference](/reference/tools).

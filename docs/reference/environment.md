# Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CALDAV_URL` | yes | — | Root of the CalDAV server, e.g. `https://dav.example.net`. A calendar collection URL works too and limits this server to that one calendar |
| `CALDAV_USERNAME` | yes¹ | — | Account name |
| `CALDAV_PASSWORD` | yes¹ | — | Password, or an app-specific password where the provider offers one. Deleted from the environment once read |
| `CALDAV_TOKEN` | yes¹ | — | Bearer token instead of username and password. Never both — a configuration carrying both is refused at startup |
| `CALDAV_CALENDARS` | no | every calendar the account can see | Comma-separated calendars this server may touch, by full path or by final path segment |
| `CALDAV_TIMEZONE` | no | `UTC` | IANA zone for timestamps that carry no offset, e.g. `Europe/Berlin` |
| `CALDAV_USER_EMAIL` | no | the principal's address set | The address you are invited as, so `respond_to_event` can find your own attendee line |
| `CALDAV_MAX_EVENTS` | no | `100` | Entries a listing returns by default, 1–500 |
| `CALDAV_READ_ONLY` | no | `false` | `true` registers only the read tools |
| `CALDAV_ALLOW_TOOLS` | no | — | Tool names, `list_*` prefixes or `essential`; only these register |
| `CALDAV_DENY_TOOLS` | no | — | Same syntax; subtracted from whatever the allow list left |
| `CALDAV_INSECURE_TLS` | no | `false` | `true` accepts a self-signed certificate, on the configured host only |
| `CALDAV_ALLOW_PLAINTEXT` | no | `false` | `true` allows a plain `http://` URL to a host that is not loopback, which sends the credentials unencrypted on every request. Otherwise such a URL refuses to start |
| `ELICITATION` | no | `true` | `false` replaces the approval dialog with the two-call token. **Not prefixed** |

¹ Either `CALDAV_USERNAME` + `CALDAV_PASSWORD`, or `CALDAV_TOKEN`. Most CalDAV
servers speak Basic authentication and want the first pair; the token exists for
the deployments that put a bearer-token proxy in front of one. There is no OAuth
flow here and nothing resembling a scope: what the account can do, this server
can do, which is why an app-specific password is worth using where the provider
offers one.

**Every one of these is a secret or shapes what a secret can reach.** The
booleans are read strictly where a `true` removes a protection
(`CALDAV_INSECURE_TLS`, `CALDAV_ALLOW_PLAINTEXT` accept the exact string `true`
and nothing else) and tolerantly where it turns one on (`CALDAV_READ_ONLY` also
takes `1`, `yes`, `TRUE`). A typo should never quietly remove a safeguard.

The credentials are deleted from `process.env` as soon as they are read, before
any branch that can exit — so a crash reporter, a child process or a later
`printenv` finds nothing. That is also why they cannot be re-read at runtime.

## `ELICITATION`

Whether a client that *can* show a dialog is asked before a guarded tool acts.
`false` takes the two-call-token path instead — it does not remove the guard, and a
server started with it off prints one line saying so.

Two ways it differs from every other variable here:

- **No prefix.** One `export ELICITATION=false` reaches every MCP server in the same
  environment, not just this one. That is the point of it and also its risk; see
  [Asking a person](/guide/approval).
- **Fatal on anything else.** Where the `CALDAV_*` booleans fail *off* on a
  typo, this one stops the server with exit code 1. It is the only variable here
  that defaults to *on*, and a typo that fell back would leave the dialog running
  while you believed it was off.

Values are trimmed and matched case-insensitively. It is read *after*
the credentials are deleted from `process.env`, so the fatal path cannot leave
one sitting there for a crash reporter.

## Narrowing the tool list

`CALDAV_ALLOW_TOOLS` and `CALDAV_DENY_TOOLS` are comma-separated.
Each entry is either an exact tool name or a prefix with a single trailing `*`:

| Value | Registers |
| --- | --- |
| `essential` | the curated preset, marked in the [tool reference](/reference/tools) |
| `list_events,get_event,create_event` | exactly those |
| `list_*` | every tool whose name starts with `list_` |
| `*` | everything — the same as leaving it unset |

Entries are trimmed and matched case-insensitively; empty entries are ignored, and a
value that is empty or only whitespace counts as unset — `CALDAV_ALLOW_TOOLS=`
in a compose file does not mean "allow nothing". `essential` is recognised only in the
allow list.

**An entry that matches no tool aborts startup**, naming the entry and listing the
valid names, as does a malformed pattern such as `*_thing` or `list_*_x`. The
alternative — ignoring the entry — leaves a tool missing from `tools/list` with
nothing pointing at the cause. If both lists together remove everything, the server
refuses to start rather than offering an empty tool list.

Under `CALDAV_READ_ONLY`, an exact write-tool name in the allow list is an
error naming the read-only setting rather than "unknown tool"; a pattern covering
write tools is accepted and merely contributes nothing, with a warning on stderr.
Deny entries are exempt: denying an already-suppressed tool is how a defensive list is
written.

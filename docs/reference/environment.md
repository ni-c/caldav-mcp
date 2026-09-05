# Environment variables

<!-- One table, this shape. Three of the eleven repositories grew a
     heading-per-variable style instead; both read fine, but a new server starts
     here so that the family stops adding variants. -->

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CALDAV_URL` | yes | — | Base URL of the CalDAV instance |
| `CALDAV_TOKEN` | yes | — | API token |
| `CALDAV_READ_ONLY` | no | `false` | `true` registers only the read tools |
| `CALDAV_ALLOW_TOOLS` | no | — | Tool names, `list_*` prefixes or `essential`; only these register |
| `CALDAV_DENY_TOOLS` | no | — | Same syntax; subtracted from whatever the allow list left |
| `CALDAV_INSECURE_TLS` | no | `false` | `true` accepts self-signed certificates |
| `ELICITATION` | no | `true` | `false` replaces the approval dialog with the two-call token. **Not prefixed** |

## `ELICITATION`

<!-- Only for a server that has a guarded tool. Drop this section and the table
     row above if nothing here asks anybody. -->

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
`CALDAV_TOKEN` is deleted from `process.env`, so the fatal path cannot leave
the token sitting there for a crash reporter.

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

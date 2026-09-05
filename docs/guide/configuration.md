# Configuration

See the [environment variable reference](/reference/environment) for the full table.

## Getting a token

## Required scopes

## TLS

<!-- The heading below is fixed: every repository uses "Choosing the tools that
     load", so /guide/configuration#choosing-the-tools-that-load is the same anchor
     everywhere and the README, the FAQ and the tool reference can all link to it.
     Put it directly after the read-only section — they are the same knob family,
     and that adjacency does half the explaining. -->

## Turning the approval dialog off

<!-- Only for a server that has a guarded tool. Drop this section if nothing
     here asks anybody. -->

The guarded tools ask a person through MCP elicitation before they act.
`ELICITATION=false` takes them to the two-call token instead. It does not remove
the guard; there is no setting in which a guarded call goes unannounced.

The variable deliberately carries no `CALDAV_` prefix, which means it
reaches every MCP server in the same environment, and — unlike the booleans
above — a value it does not recognise **stops the server** rather than failing
off. See [Asking a person](/guide/approval).

## Choosing the tools that load

Read-only mode is one cut, along a line this server drew for you.
`CALDAV_ALLOW_TOOLS` and `CALDAV_DENY_TOOLS` let you draw your own:

```sh
CALDAV_ALLOW_TOOLS=essential
CALDAV_ALLOW_TOOLS=list_events,get_event,create_event
CALDAV_DENY_TOOLS=delete_event
```

Why bother, when all of them work: a model chooses the right tool far more reliably
from a handful than from a long list, and every tool it can see costs context on
every single request. If this is the only MCP server in a session, the full set is
fine. If it is one of six, it is not.

**The syntax.** Comma-separated entries. An entry is either an exact tool name or a
prefix with a trailing `*` — `list_*` matches every tool whose name starts with
`list_`. Entries are trimmed and case-insensitive, empty ones are ignored, and an
empty value counts as unset. Nothing else is a pattern: `*_thing` and `list_*_x` are
rejected rather than silently matching nothing.

**`essential`** is a curated preset: `list_calendars`, `list_events`, `get_event`, `search_events`, `get_free_busy`, `create_event` and `update_event` — enough to see what is on, find a gap and put something in, with nothing irreversible in reach. It is marked per tool in the
[tool reference](/reference/tools), generated from the same constant the filter
reads, so the two cannot drift. It composes — naming a tool alongside it puts that
one back, and `CALDAV_DENY_TOOLS` takes one away.

**Both together.** `CALDAV_ALLOW_TOOLS` decides what is in;
`CALDAV_DENY_TOOLS` is then subtracted from the result. With only a deny
list, everything else stays.

**A name that matches nothing stops the server**, with the offending entry and the
list of real names. That is deliberate: the alternative is a tool quietly missing
from `tools/list`, and nobody traces an absence back to an environment variable. The
same applies to a pattern that matches no tool.

**With read-only mode**, the write tools are not registered at all, so naming one
explicitly in `CALDAV_ALLOW_TOOLS` is an error that says so — rather than
calling a tool unknown when it plainly exists. A _pattern_ that covers write tools is
fine and simply contributes nothing, which is what makes `get_*,create_*` a usable
template for both kinds of deployment; and `CALDAV_ALLOW_TOOLS=essential`
narrows to the read half of the preset.

::: tip It is the same cut, not a second one
A filtered tool is never registered, so it is absent from `tools/list` and unknown to
`tools/call` alike — exactly what `CALDAV_READ_ONLY` does to a write tool.
There is no "hidden but callable" state to reason about.
:::

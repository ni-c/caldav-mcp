# Asking a person

<!--
  Applies only to a server that HAS a guarded tool. One that changes nothing —
  calibreweb-mcp, osm-mcp — gets no such page and no ELICITATION variable: a
  switch that does nothing is worse than none. Say that in one paragraph of
  security.md instead.

  Fill every {{...}} and delete these comments. The three fixed quotes below are
  from the MCP specification and are quoted verbatim in every server of this
  family; do not paraphrase them.
-->

{{HOW_MANY}} of the {{TOOL_COUNT}} tools {{WHAT_THEY_COST}}. All of them **ask a
person first**.

Not a `confirm: true` argument the model can set. Not a token the model reads out
of its own previous result. A dialog, raised through [MCP
elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation),
that goes to the client and is shown to whoever is sitting there.

The specification says a client _should_ keep a human in the loop:

> there **SHOULD** always be a human in the loop with the ability to deny tool
> invocations

This server does not rely on that. It raises the question itself, and until an
answer comes back, nothing happens.

## What asks, and when

<!-- One row per guarded tool. Say "always" or name the condition — a tool that
     asks only in one direction (publishing, granting, widening) is the
     interesting case and the row is where a reader sees it. End with a row for
     "everything else | never", so the list is a statement about the whole tool
     surface rather than a selection from it. -->

| Tool | When it asks |
| --- | --- |
| `{{TOOL}}` | always |
| `{{TOOL}}` | only when {{CONDITION}} |
| everything else | never |

<!-- If a tool that looks like it should ask does not, say so here and why. The
     absence is what a reader will wonder about. -->

## What the dialog contains

<!-- Two things, and both matter:
     1. What IS in it — ids, counts, server-side facts.
     2. What is deliberately NOT, and why. Every server in this family keeps
        upstream content out of the prompt, because that prompt is read by a
        model at the exact moment it is deciding. Name the concrete channel:
        a recipe imported from a website, a build log written by whoever opened
        the pull request, a page anyone with edit rights can change.
     Caller-chosen values go on labelled lines under the "supplied by the caller,
     not by this server" heading, never interpolated into the server's sentence. -->

{{WHAT_IS_IN_IT}}

```
{{A REAL PROMPT, COPIED FROM A TEST}}
```

The approval is bound to its target, so one obtained for a call cannot be
replayed against another. For a *set* of targets the binding is a fingerprint of
the exact list: an approval for `["a"]` does not execute `["a", "b"]`.

## Clients that cannot show a dialog

Not every MCP client implements elicitation, and a stateless gateway may not be
able to speak for the one it is currently serving. Rather than refuse to work —
which pushes people towards switching the guard off entirely — the tool falls
back to a **two-call token**: the first call returns a random string, the second
has to quote it back.

Be clear about what that proves, because this server is:

> the token proves the call was made twice with the same arguments, and nothing
> more.

A model can read the token out of the first result and call again in the same
turn without anybody seeing it. It catches a widened target set; it does not
catch a model that was talked into the whole thing. The fallback text says so
rather than implying somebody approved.

## Switching the dialog off

```sh
ELICITATION=false
```

Default is `true`. `false` does **not** remove the guard — it takes the fallback
path above, which means the token. There is no setting in which a guarded call
goes unannounced.

Use it where a dialog is the wrong shape rather than an unwanted one: a scheduled
job, a test harness, a client whose dialog interrupts something else.

::: warning It is deliberately not prefixed
`ELICITATION` has no `{{ENV_PREFIX}}_` in front of it, so one
`export ELICITATION=false` — or one `-e ELICITATION=false` in a compose file —
reaches **every** MCP server in that environment, not just this one. That is the
point of it and also its risk.

Two things make it visible rather than silent:

- a server started with it off prints one line at startup, in the log of every
  server it actually reached:

  ```
  {{PACKAGE}}: ELICITATION=false — guarded tools fall back to the two-call token
  ```

- the fallback text names the server that did not ask, instead of blaming a
  client that was working fine.
  :::

Anything other than `true` or `false` — `1`, `off`, `yes` — **stops the server**
with exit code 1 and a message naming both valid values. This is the only
variable in this family that defaults to _on_: a typo that fell back to the
default would leave the dialog running while the operator believed it was off,
and there would be nothing to tell them.

## Annotations are the other half, and they are only a hint

Every tool of this server declares all four MCP tool annotations —
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — so a
client can tell before it calls what a call would do. See
[Tools](/reference/tools).

They are advice, and the specification says so:

> clients **MUST** consider tool annotations to be untrusted unless they come
> from trusted servers

An annotation is something a client may ignore. The dialog is not: it is enforced
here, on the server side, and no answer means no change. The two are different
claims — the annotation says what a call _does_, the dialog decides whether it
_happens_ — which is why a tool can be marked destructive without being guarded,
and guarded without being destructive.

<!-- Name this server's own example of that gap. Every server has one, and
     pretending the two lists agree is how a real gap gets defined away. -->

{{THE_GAP_IN_THIS_SERVER}}

## Behind a gateway

Both protocol revisions are handled from one code path. On `2025-11-25` the
question is pushed to the client; on `2026-07-28` there is no server→client
channel at all, so the call returns `input_required`, ends, and the client
retries carrying the answer.

That answer arrives as ordinary request content, which the SDK does not
validate — so the state that ties an answer to its question is sealed (HMAC). A
reply whose seal does not open, or opens onto a different target, counts as **no
answer** and produces a fresh question rather than an error. The likeliest cause
is not an attack: it is a gateway that put the server to sleep while the person
was reading.

If you run this behind [mcp-hub](https://github.com/ni-c/mcp-hub), the hub passes
elicitation through in both directions; see its
[elicitation guide](https://ni-c.github.io/mcp-hub/guide/elicitation).

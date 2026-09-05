# Tools

One section per tool: what it does, its parameters, and — for the guarded ones —
what a person is asked.

All of them are registered unless you say otherwise. `CALDAV_ALLOW_TOOLS` and
`CALDAV_DENY_TOOLS` narrow the list to the ones you want, and `essential`
selects the ones marked **essential** below — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

<!-- This file is a placeholder. `npm run docs:tools` overwrites it from the
     tools the server really registers, and `npm run docs:tools:check` fails in
     CI when it goes stale. Edit the GENERATOR, then
     `npm run build && npm run docs:tools`, and commit the result — an edit to
     this file is silently reverted.

     The generator emits the **essential** marker per tool from ESSENTIAL_TOOLS in
     src/tools/catalogue.ts, so preset membership is written down exactly once in
     the whole repository. That is the one fact in this feature most likely to
     drift, and generating it is what stops it. -->

# FAQ & troubleshooting

<!-- Keep this entry. "A tool is missing" is the one question the tool filter
     creates, and the answer people reach for first — a bug — is the wrong one. -->

## One tool I expected is missing

Something narrowed the list. In order of likelihood:

- `CALDAV_READ_ONLY` is set, and it is a write tool.
- `CALDAV_ALLOW_TOOLS` is set and does not name it — it is an allow list, so
  anything not named is out.
- `CALDAV_DENY_TOOLS` names it, possibly through a prefix such as `delete_*`.

A filtered tool is not registered at all, so it is missing from `tools/list` and
answers `tools/call` with "tool not found" — the same as a write tool under
read-only. There is no state where it is hidden but still callable.

What it is _not_ is a typo in one of those variables: an entry that matches no tool
stops the server at startup and says which entry it was. See
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

## The listing is empty and the calendar is not

An empty answer where the server clearly holds entries is usually the reader and
the server disagreeing about how the iCalendar document was packed into the
response, not a filter or a permission.

`calendar-data` is read as **raw source** — deliberately, so that a description
containing a `<` stays a description rather than becoming markup — which means
the XML packaging arrives with it and has to be taken off. Versions before 0.1.4
did not take off a `<![CDATA[…]]>` section or leading indentation, so the
document handed to the parser began `<![CDATA[BEGIN:` or `\n    BEGIN:` and no
parser accepts either. carddav-mcp met exactly that against Open-Xchange, where
an address book of 79 cards listed as empty.

If you see this on 0.1.4 or later, the packaging is one nobody has met yet —
an XML comment inside the node would do it. Please open an issue with the raw
`REPORT` response; that is the one thing the fix cannot be guessed from.

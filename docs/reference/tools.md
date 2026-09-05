<!--
  GENERATED FILE — do not edit by hand.
  Regenerate with: npm run build && npm run docs:tools
  The CI test job fails when this file is out of date.
-->

# Tool reference

All 22 tools: 10 read, 12 write.
With `CALDAV_READ_ONLY=true` the write tools are not registered at all —
they do not appear in `tools/list`.

All 22 are registered unless you say otherwise. `CALDAV_ALLOW_TOOLS`
and `CALDAV_DENY_TOOLS` narrow the list to the ones you want, and
`CALDAV_ALLOW_TOOLS=essential` selects the 7 marked **essential**
below — see [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

👤 marks a tool that **asks a person** before it acts, through MCP
elicitation — a dialog the model cannot answer on its behalf. Where the
client cannot show one, it falls back to a two-call `confirm_token` bound
to the exact target and expiring after five minutes, and says which of the
two it was. `ELICITATION=false` takes that fallback deliberately; it never
removes the guard. See [Asking a person](/guide/approval).

Every tool declares all four MCP annotations — `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`. They are a hint a
client may ignore; the dialog is enforced here and cannot be, which is why
the two lists are not the same one.

## Read tools

### `list_calendars`

**List the calendars** — read-only, **essential**

Every calendar this server may use, with the id to pass to the other tools. Always asks the server rather than answering from a cache — being current is this tool’s whole job.

Takes no parameters.

### `get_server_info`

**What the connected CalDAV server can do** — read-only

Reports the DAV compliance tokens, which components each calendar accepts, and whether the optional features this server relies on actually work here. The first thing to run when something behaves differently than expected — CalDAV implementations differ more than the specification suggests.

Takes no parameters.

### `list_events`

**List events in a time range** — read-only, **essential**

Events between two points in time, from every calendar this server may see or from the ones named. Recurring events are expanded into their individual occurrences, so each one has its own id and can be changed on its own. Defaults to the next 30 days.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | no | Start of the window. Defaults to now. |
| `to` | string | no | End of the window. Defaults to 30 days after `from`. |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `calendars` | string[] | no | Which calendars to look in. Leave it out for all of them. A calendar outside CALDAV_CALENDARS is refused rather than silently skipped. |
| `limit` | integer | no | Entries to return, at most 500. Defaults to CALDAV_MAX_EVENTS. |
| `after` | string | no | The `truncated.next_cursor` of a previous call, to continue where it stopped. The window has to be the same one. |

### `get_event`

**Read one event in full** — read-only, **essential**

The complete event behind an id from a listing: the untruncated description, every reminder, every attendee, every attachment as metadata. An occurrence id answers with that one instance; a series id answers with the series and its rule.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |

### `search_events`

**Search events by text** — read-only, **essential**

Finds events whose summary, description or location contains a term. The search runs on the CalDAV server, one request per field and per calendar — the specification combines several field filters with AND, so asking for all three at once would only match entries carrying the term in every one of them.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | The term to look for. Matching is the server’s to define. |
| `fields` | `"SUMMARY"` \| `"DESCRIPTION"` \| `"LOCATION"`[] | no | Which fields to search. Defaults to all three. |
| `from` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `to` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `calendars` | string[] | no | Which calendars to look in. Leave it out for all of them. A calendar outside CALDAV_CALENDARS is refused rather than silently skipped. |
| `limit` | integer | no | Entries to return, at most 500. Defaults to CALDAV_MAX_EVENTS. |

### `get_free_busy`

**When the calendar is busy** — read-only, **essential**

Busy periods in a time range — start and end only, no titles and no attendees. The datasparing way to ask "when am I free": nothing anybody else wrote comes back, so there is no untrusted content in the answer at all.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `to` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `calendars` | string[] | no | Which calendars to look in. Leave it out for all of them. A calendar outside CALDAV_CALENDARS is refused rather than silently skipped. |

### `list_tasks`

**List tasks** — read-only

Tasks with a start or due date inside a time range. Tasks with no date at all are not returned by a time-range query — the CalDAV specification defines the filter against the dates, and a task with none of them matches no window.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `to` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `calendars` | string[] | no | Which calendars to look in. Leave it out for all of them. A calendar outside CALDAV_CALENDARS is refused rather than silently skipped. |
| `include_completed` | boolean | no | Defaults to false, which leaves completed tasks out. |
| `limit` | integer | no | Entries to return, at most 500. Defaults to CALDAV_MAX_EVENTS. |
| `after` | string | no | The `truncated.next_cursor` of a previous call, to continue where it stopped. The window has to be the same one. |

### `get_task`

**Read one task in full** — read-only

The complete task behind an id from list_tasks, with its untruncated description and every reminder.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |

### `list_journals`

**List journal entries** — read-only

Dated notes in a calendar, inside a time range. Most calendar clients hide these; a CalDAV server stores them alongside events and tasks, and some workflows use them as a diary.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `to` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `calendars` | string[] | no | Which calendars to look in. Leave it out for all of them. A calendar outside CALDAV_CALENDARS is refused rather than silently skipped. |
| `limit` | integer | no | Entries to return, at most 500. Defaults to CALDAV_MAX_EVENTS. |
| `after` | string | no | The `truncated.next_cursor` of a previous call, to continue where it stopped. The window has to be the same one. |

### `get_journal`

**Read one journal entry in full** — read-only

The complete note behind an id from list_journals, untruncated. This is the longest piece of somebody else’s prose this server hands over, so the text channel carries it inside an explicit untrusted fence.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |

## Write tools

### `create_event`

**Create an event** — write, **essential**

Adds an event to a calendar. The UID and the file name are generated here, so an existing entry can never be overwritten by accident. Times without an offset are read in the timezone argument or in CALDAV_TIMEZONE.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `calendar_id` | string | yes | A calendar id from list_calendars — its path. A full URL or the final path segment work too. |
| `summary` | string | yes | The title. |
| `start` | string | yes | When it starts. A bare date makes it an all-day event. |
| `end` | string | no | When it ends. For an all-day event this is exclusive, as iCalendar defines it: a single day ends on the following date. Defaults to one hour after the start, or one day for an all-day event. |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `description` | unknown | no | Longer text. Pass null to remove it, leave it out to keep it. |
| `location` | unknown | no | Where it happens. Pass null to remove it, leave it out to keep it. |
| `categories` | unknown | no | Replaces every category. Pass null or an empty array to clear. |
| `status` | `"CONFIRMED"` \| `"TENTATIVE"` \| `"CANCELLED"` | no |  |
| `transparent` | boolean | no | True to leave the time free rather than marking it busy. |
| `recurrence` | string | no | A raw RRULE, e.g. "FREQ=WEEKLY;BYDAY=MO;COUNT=10". Given as written rather than as separate fields, because the rule grammar is richer than any short set of parameters, and a half-modelled rule is how a series ends up wrong. |
| `alarms` | object[] | no | Replaces the plain DISPLAY reminders. An empty array removes them. Reminders this server cannot write — email alarms, repeating ones, ones with an attachment — are always kept, and the answer says how many. |

### `update_event` 👤

**Change an event** — write, destructive, **essential**

Changes the fields named and leaves everything else exactly as it was — including properties this server does not model, attendees, attachments and reminders it cannot write. Pass null to clear a field. Guarded by the entry’s ETag: if it changed since it was read, nothing is written and the answer says what it is now. Changing a whole recurring series asks first.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |
| `scope` | `"this_occurrence"` \| `"entire_series"` | no | For a recurring entry: change just this occurrence, or the whole series. Defaults to whichever the id names. Changing a whole series asks first. |
| `summary` | string | no | The title. |
| `start` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `end` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `description` | unknown | no | Longer text. Pass null to remove it, leave it out to keep it. |
| `location` | unknown | no | Where it happens. Pass null to remove it, leave it out to keep it. |
| `categories` | unknown | no | Replaces every category. Pass null or an empty array to clear. |
| `status` | `"CONFIRMED"` \| `"TENTATIVE"` \| `"CANCELLED"` | no |  |
| `transparent` | boolean | no |  |
| `alarms` | object[] | no | Replaces the plain DISPLAY reminders. An empty array removes them. Reminders this server cannot write — email alarms, repeating ones, ones with an attachment — are always kept, and the answer says how many. |
| `confirm_token` | string | no | Token from the first call of this tool. |

### `delete_event` 👤

**Delete an event** — write, destructive

Removes an event. An occurrence id removes just that occurrence — which iCalendar does by adding an exception date to the series, so the rest of the series is untouched. A series id removes the whole entry. A CalDAV server keeps no history: this cannot be undone.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |
| `scope` | `"this_occurrence"` \| `"entire_series"` | no | For a recurring entry: change just this occurrence, or the whole series. Defaults to whichever the id names. Changing a whole series asks first. |
| `confirm_token` | string | no | Token from the first call of this tool. |

### `move_event` 👤

**Move an event to another calendar** — write, destructive

Copies an event into another calendar and removes it from the first. The content survives, the address does not: every id that named this event stops working, and a listing is needed to get the new one. The destination may be a calendar other people can see.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |
| `destination_calendar_id` | string | yes | A calendar id from list_calendars — its path. A full URL or the final path segment work too. |
| `confirm_token` | string | no | Token from the first call of this tool. |

### `respond_to_event` 👤

**Accept or decline an invitation** — write

Sets your own participation status on an event you were invited to. On a server with scheduling enabled this sends a reply to the organiser, which cannot be unsent — so it asks first. It changes only your own attendee line and never anybody else’s. This server cannot add or remove attendees at all.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |
| `response` | `"ACCEPTED"` \| `"DECLINED"` \| `"TENTATIVE"` | yes | Your answer. |
| `confirm_token` | string | no | Token from the first call of this tool. |

### `create_task`

**Create a task** — write

Adds a task to a calendar that accepts them. list_calendars reports which do — a collection created for events only will refuse a task, and this server checks before writing rather than passing the server’s refusal back.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `calendar_id` | string | yes | A calendar id from list_calendars — its path. A full URL or the final path segment work too. |
| `summary` | string | yes | The title. |
| `due` | string | no | When it is due. |
| `start` | string | no | When work on it can begin. |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `description` | unknown | no | Longer text. Pass null to remove it, leave it out to keep it. |
| `priority` | integer | no | 1 is highest, 9 lowest, 0 undefined — as RFC 5545 has it. |
| `categories` | unknown | no | Replaces every category. Pass null or an empty array to clear. |
| `alarms` | object[] | no | Replaces the plain DISPLAY reminders. An empty array removes them. Reminders this server cannot write — email alarms, repeating ones, ones with an attachment — are always kept, and the answer says how many. |

### `update_task`

**Change a task** — write, destructive

Changes the fields named and leaves everything else as it was. Pass null to clear a field. Guarded by the entry’s ETag. To mark a task done use complete_task, which records the completion time as well.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |
| `summary` | string | no | The title. |
| `due` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `start` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `description` | unknown | no | Longer text. Pass null to remove it, leave it out to keep it. |
| `priority` | integer | no |  |
| `percent_complete` | integer | no |  |
| `categories` | unknown | no | Replaces every category. Pass null or an empty array to clear. |
| `alarms` | object[] | no | Replaces the plain DISPLAY reminders. An empty array removes them. Reminders this server cannot write — email alarms, repeating ones, ones with an attachment — are always kept, and the answer says how many. |

### `complete_task`

**Mark a task done, or reopen it** — write

Sets the task’s status. Marking it done records the completion time and sets it to 100 %; reopening clears both. The previous state is written down in the entry, so this is reversible — which is why it does not ask first.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |
| `done` | boolean | no | Defaults to true. Pass false to reopen a completed task. |

### `delete_task` 👤

**Delete a task** — write, destructive

Removes a task. A CalDAV server keeps no history: this cannot be undone. To mark a task done instead, use complete_task.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |
| `confirm_token` | string | no | Token from the first call of this tool. |

### `create_journal`

**Create a journal entry** — write

Adds a dated note to a calendar that accepts journal entries. list_calendars reports which do.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `calendar_id` | string | yes | A calendar id from list_calendars — its path. A full URL or the final path segment work too. |
| `summary` | string | yes | The heading. |
| `date` | string | yes | The date the note belongs to. |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `description` | unknown | no | The note itself. Pass null to remove it, leave it out to keep it. |
| `categories` | unknown | no | Replaces every category. Pass null or an empty array to clear. |

### `update_journal`

**Change a journal entry** — write, destructive

Replaces the fields named. A CalDAV server keeps no version history, so the previous text of a note is gone once this succeeds — pass only the fields to change, and pass null to clear one. Guarded by the entry’s ETag, so a note changed elsewhere in the meantime is not silently overwritten.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |
| `summary` | string | no | The title. |
| `date` | string | no | ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00". |
| `timezone` | string | no | IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". Defaults to CALDAV_TIMEZONE. Refused together with a value that already carries an offset. |
| `description` | unknown | no | The note itself. Pass null to remove it, leave it out to keep it. |
| `categories` | unknown | no | Replaces every category. Pass null or an empty array to clear. |

### `delete_journal` 👤

**Delete a journal entry** — write, destructive

Removes a dated note. A CalDAV server keeps no history, and a note is somebody’s writing: this cannot be undone.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from a listing tool. Not meant to be built by hand. |
| `confirm_token` | string | no | Token from the first call of this tool. |

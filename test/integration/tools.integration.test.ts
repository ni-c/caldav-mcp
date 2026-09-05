import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectEveryToolDeclaresOutputSchema,
  expectEveryToolExercised,
  expectPortableToolSchemas,
  startServer,
  toolCoverage,
  type LiveHarness,
} from 'mcp-integration-harness';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import {
  bootstrapRadicale,
  FORBIDDEN_CALENDAR,
  getRaw,
  listRaw,
  putRaw,
  type Sandbox,
} from './bootstrap.js';

/**
 * One story against a real CalDAV server, in order.
 *
 * Sequential rather than a table per tool, because a real backend has state:
 * the event this creates is the one the next test changes and the one after
 * that deletes. Where an assertion matters, it reads the stored `.ics` **back
 * over plain HTTP** rather than through this server — a test that only calls
 * `get_event` proves the server agrees with itself, which is not the question.
 *
 * Two harnesses, on purpose. `asking` announces an elicitation capability and
 * gets a real dialog; `plain` does not, and falls back to the two-call token.
 * Both paths are worth running, and the coverage set is their union.
 */

let sandbox: Sandbox;
let asking: LiveHarness;
let plain: LiveHarness;

/** Ids handed from one test to the next. */
const state: {
  seriesId?: string;
  occurrenceId?: string;
  simpleId?: string;
  allDayId?: string;
  taskId?: string;
  journalId?: string;
  movedId?: string;
  excludedId?: string;
} = {};

const WORK = '/integration/work/';
const PRIVATE = '/integration/private/';

/**
 * Reads the machine-readable half of an answer.
 *
 * `structuredContent` rather than the text block, and not only because it is
 * the channel a program is meant to read: the `get_*` tools put the **fence**
 * in the first text block on purpose, so a test parsing text would be parsing a
 * paragraph of prose. It also means every assertion here runs against a value
 * the SDK has already validated against that tool's own output schema — which
 * is how `recurrence_id` missing its `all_day` field was caught.
 */
async function data(
  harness: LiveHarness,
  name: string,
  args?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await harness.raw(name, args);
  expect(
    result.structuredContent,
    `${name} returned no structuredContent`
  ).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

interface ShapedEvent {
  id: string;
  series_id: string;
  uid?: string;
  summary?: string;
  start: { value: string; all_day: boolean };
  recurrence_id?: { value: string; all_day: boolean };
  recurrence_rule?: string;
}

beforeAll(async () => {
  sandbox = await bootstrapRadicale();
  asking = await startServer({ env: sandbox.env, elicit: 'accept' });
  plain = await startServer({ env: sandbox.env });
}, 300_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

/** Every `.ics` in a calendar, as stored, unfolded. */
async function storedFiles(calendar: string): Promise<string[]> {
  const names = await listRaw(sandbox, calendar);
  return Promise.all(
    names.map(async (name) =>
      (await getRaw(sandbox, calendar, name)).ics.replace(/\r\n[ \t]/g, '')
    )
  );
}

describe('the connection', () => {
  it('reports what the server can do', async () => {
    const info = await data(asking, 'get_server_info');
    expect(info.dav).toContain('calendar-access');
    expect((info.features as { text_match: boolean }).text_match).toBe(true);
    // Radicale 3.8 does answer a free-busy query, and expands recurrences
    // server-side while doing it.
    expect((info.features as { free_busy: boolean }).free_busy).toBe(true);
    expect(info.self_addresses).toContain('integration@example.net');
  });

  it('lists only the allowed calendars, and says how many it withheld', async () => {
    const listing = await data(asking, 'list_calendars');
    const paths = (listing.calendars as { id: string }[]).map((c) => c.id);
    expect(paths.sort()).toEqual([PRIVATE, WORK]);
    expect(listing.withheld).toBe(1);
    expect(listing.untrusted).toBe(true);
  });

  it('advertises schemas every client can read', async () => {
    const { tools } = await asking.client.listTools();
    expectPortableToolSchemas(tools);
    expectEveryToolDeclaresOutputSchema(tools);
  });
});

describe('events', () => {
  it('creates a simple event', async () => {
    const created = await data(asking, 'create_event', {
      calendar_id: WORK,
      summary: 'Coffee',
      start: '2026-09-07T15:00:00',
      end: '2026-09-07T15:30:00',
    });
    expect(created.created).toBe(true);
    state.simpleId = created.id as string;
  });

  it('creates an all-day event and reports it as one', async () => {
    const created = await data(asking, 'create_event', {
      calendar_id: WORK,
      summary: 'Company holiday',
      start: '2026-09-11',
    });
    state.allDayId = created.id as string;

    const entry = await data(asking, 'get_event', { id: state.allDayId });
    const event = entry.event as ShapedEvent;
    expect(event.start.all_day).toBe(true);
    // A bare date, not midnight — reporting an all-day entry as a timestamp is
    // how a whole day shows up as a one-minute appointment.
    expect(event.start.value).toBe('2026-09-11');
  });

  it('creates a weekly series with a reminder', async () => {
    const created = await data(asking, 'create_event', {
      calendar_id: WORK,
      summary: 'Team sync',
      start: '2026-09-07T09:00:00',
      end: '2026-09-07T10:00:00',
      location: 'Room 1',
      recurrence: 'FREQ=WEEKLY;COUNT=4',
      alarms: [{ trigger: '-PT15M', description: 'Team sync soon' }],
    });
    state.seriesId = created.id as string;

    // An attendee and an organiser are added out of band: this server
    // deliberately cannot write either, and respond_to_event needs one to exist.
    const name = `${String(created.uid).split('@')[0]}.ics`;
    const stored = await getRaw(sandbox, 'work', name);
    await putRaw(
      sandbox,
      'work',
      name,
      stored.ics.replace(
        /^END:VEVENT/m,
        'ORGANIZER;CN=Alice:mailto:alice@example.net\r\n' +
          'ATTENDEE;CN=Integration;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:integration@example.net\r\n' +
          'END:VEVENT'
      )
    );
  });

  it('expands the series into occurrences with ids of their own', async () => {
    const listing = await data(asking, 'list_events', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-15T00:00:00Z',
      calendars: [WORK],
    });
    const events = listing.events as ShapedEvent[];
    const sync = events.filter((event) => event.summary === 'Team sync');
    expect(sync).toHaveLength(4);
    expect(new Set(sync.map((event) => event.id)).size).toBe(4);
    expect(new Set(sync.map((event) => event.series_id)).size).toBe(1);

    // Merged across entries and sorted by start, not grouped per resource.
    const starts = events.map((event) => event.start.value);
    expect([...starts].sort()).toEqual(starts);

    const second = sync[1];
    expect(second).toBeDefined();
    state.occurrenceId = second?.id ?? '';
  });

  it('answers differently for a series id and an occurrence id', async () => {
    const series = await data(asking, 'get_event', { id: state.seriesId });
    const occurrence = await data(asking, 'get_event', {
      id: state.occurrenceId,
    });
    expect((series.event as ShapedEvent).recurrence_rule).toBe(
      'FREQ=WEEKLY;COUNT=4'
    );
    expect((occurrence.event as ShapedEvent).recurrence_id).toBeDefined();
    expect((occurrence.event as ShapedEvent).series_id).toBe(state.seriesId);
  });

  it('moves one occurrence and leaves the rest of the series alone', async () => {
    await asking.call('update_event', {
      id: state.occurrenceId,
      start: '2026-09-14T14:00:00',
      end: '2026-09-14T15:00:00',
      summary: 'Team sync (moved)',
    });

    const listing = await data(asking, 'list_events', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-15T00:00:00Z',
      calendars: [WORK],
    });
    const sync = (listing.events as ShapedEvent[])
      .filter((event) => event.summary?.startsWith('Team sync'))
      .map((event) => event.start.value);
    expect(sync).toHaveLength(4);
    expect(sync[1]).toContain('T14:00:00');
    expect(sync[2]).toContain('T09:00:00');
  });

  it('kept the rule, the reminder, the attendee and the organiser', async () => {
    // Read past this server entirely. This is the assertion that proves a
    // read-modify-write preserved what it does not model — the point of the
    // whole write path.
    const files = await storedFiles('work');
    const series = files.find((ics) => ics.includes('RRULE'));
    expect(series).toBeDefined();
    const stored = series ?? '';
    expect(stored).toMatch(/RRULE:FREQ=WEEKLY;COUNT=4/);
    expect(stored).toMatch(/TRIGGER:-PT15M/);
    expect(stored).toMatch(/ATTENDEE[^\r\n]*integration@example\.net/);
    expect(stored).toMatch(/ORGANIZER[^\r\n]*alice@example\.net/);
    // The master plus the override the change created, in one resource.
    expect((stored.match(/^BEGIN:VEVENT/gm) ?? []).length).toBe(2);
  });

  it('asks before changing a whole series, and does it when told to', async () => {
    const before = asking.prompts.length;
    const result = await data(asking, 'update_event', {
      id: state.occurrenceId,
      scope: 'entire_series',
      location: 'Room 2',
    });
    expect(asking.prompts.length).toBeGreaterThan(before);
    expect(result.written).toBe(true);
  });

  it('offers the two-call token to a client that cannot be asked', async () => {
    const text = await plain.confirmed('update_event', {
      id: state.occurrenceId,
      scope: 'entire_series',
      location: 'Room 3',
    });
    expect((JSON.parse(text) as { written: boolean }).written).toBe(true);
    // The dialog client never saw a token; the plain one never saw a dialog.
    // Without this pair, a server that silently stopped asking stays green.
    expect(plain.prompts).toHaveLength(0);
    expect(asking.prompts.length).toBeGreaterThan(0);
  });

  it('sees a change made outside this server', async () => {
    const entry = await data(asking, 'get_event', { id: state.simpleId });
    const uid = (entry.event as ShapedEvent).uid ?? '';
    const name = `${uid.split('@')[0]}.ics`;
    const stored = await getRaw(sandbox, 'work', name);
    await putRaw(
      sandbox,
      'work',
      name,
      stored.ics.replace(/^SUMMARY:.*$/m, 'SUMMARY:Changed elsewhere')
    );

    const after = await data(asking, 'get_event', { id: state.simpleId });
    expect((after.event as ShapedEvent).summary).toBe('Changed elsewhere');
  });

  it('searches by text on the server', async () => {
    // Self-contained: a term that is certainly present, and one that certainly
    // is not. Depending on a rename an earlier test performed would make this
    // fail for somebody else's reason.
    const hit = await data(asking, 'search_events', {
      query: 'Team sync',
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expect(hit.count).toBeGreaterThan(0);

    const miss = await data(asking, 'search_events', {
      query: 'zzz-no-such-event-zzz',
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expect(miss.count).toBe(0);
  });

  it('reports busy periods without any of the titles', async () => {
    const busy = await data(asking, 'get_free_busy', {
      from: '2026-09-07T00:00:00Z',
      to: '2026-09-30T00:00:00Z',
    });
    expect(busy.method).toBe('server');
    expect((busy.busy as unknown[]).length).toBeGreaterThan(0);
    // Nothing anybody wrote comes back — that is the tool's whole argument, and
    // the reason it carries no untrusted marker.
    expect(JSON.stringify(busy)).not.toContain('Team sync');
    expect(busy.untrusted).toBeUndefined();
  });

  it('answers an invitation on the attendee line that is ours', async () => {
    // The dialog client answers 'accept' automatically, so a guarded tool is one
    // call here.
    const result = await data(asking, 'respond_to_event', {
      id: state.seriesId,
      response: 'ACCEPTED',
    });
    expect(result.responded).toBe(true);

    const files = await storedFiles('work');
    const series = files.find((ics) => ics.includes('RRULE')) ?? '';
    expect(series).toMatch(
      /ATTENDEE[^\r\n]*PARTSTAT=ACCEPTED[^\r\n]*integration@example\.net/
    );
    // The organiser line is untouched: this server changes exactly one attendee.
    expect(series).toMatch(/ORGANIZER[^\r\n]*alice@example\.net/);
  });

  it('moves an event to another calendar and invalidates the old id', async () => {
    const moved = await data(asking, 'move_event', {
      id: state.allDayId,
      destination_calendar_id: PRIVATE,
    });
    expect(moved.moved).toBe(true);
    state.movedId = moved.id as string;
    expect(state.movedId).not.toBe(state.allDayId);

    await asking.call(
      'get_event',
      { id: state.allDayId },
      { expectError: true }
    );
    const there = await data(asking, 'get_event', { id: state.movedId });
    expect((there.event as ShapedEvent).summary).toBe('Company holiday');
  });

  it('deletes one occurrence by excluding it, keeping the series', async () => {
    const listing = await data(asking, 'list_events', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-15T00:00:00Z',
      calendars: [WORK],
    });
    const sync = (listing.events as ShapedEvent[]).filter((event) =>
      event.summary?.startsWith('Team sync')
    );
    const last = sync[sync.length - 1];
    expect(last).toBeDefined();
    const victim = last?.id ?? '';
    state.excludedId = victim;

    await asking.call('delete_event', { id: victim });

    const files = await storedFiles('work');
    const series = files.find((ics) => ics.includes('RRULE')) ?? '';
    // Deleting one instance is an exception date on the series, not a DELETE.
    expect(series).toMatch(/^EXDATE/m);
    expect(series).toMatch(/RRULE:FREQ=WEEKLY;COUNT=4/);

    const after = await data(asking, 'list_events', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-15T00:00:00Z',
      calendars: [WORK],
    });
    expect(
      (after.events as ShapedEvent[]).filter((event) =>
        event.summary?.startsWith('Team sync')
      )
    ).toHaveLength(sync.length - 1);
  });

  it('deletes the same occurrence again without a second exception', async () => {
    // A no-op the second time, and still a success: one EXDATE, not two, and
    // nothing reported as deleted that was not.
    await asking.call('delete_event', { id: state.excludedId });
    const files = await storedFiles('work');
    const series = files.find((ics) => ics.includes('RRULE')) ?? '';
    expect(series.match(/^EXDATE/gm)).toHaveLength(1);
  });

  it('refuses this_occurrence on a series id instead of deleting the series', async () => {
    // The dialog used to promise "one occurrence, leaving the rest" and the
    // DELETE removed the whole resource. Refused before the dialog now.
    await asking.call(
      'delete_event',
      { id: state.seriesId, scope: 'this_occurrence' },
      { expectError: true }
    );
    const files = await storedFiles('work');
    expect(files.some((ics) => ics.includes('RRULE'))).toBe(true);
  });

  it('excludes an all-day occurrence on the day its id names', async () => {
    // Read back over plain HTTP: the exception date has to be the calendar
    // date of the occurrence, not the UTC date of midnight in the configured
    // zone, which is the day before east of Greenwich.
    await putRaw(
      sandbox,
      'work',
      'offsite.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//integration//EN',
        'BEGIN:VEVENT',
        'UID:offsite@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART;VALUE=DATE:20260921',
        'DTEND;VALUE=DATE:20260922',
        'RRULE:FREQ=DAILY;COUNT=3',
        'SUMMARY:Offsite',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
    const days = async (): Promise<string[]> => {
      const listing = await data(asking, 'list_events', {
        from: '2026-09-20T00:00:00Z',
        to: '2026-09-25T00:00:00Z',
        calendars: [WORK],
      });
      return (listing.events as ShapedEvent[])
        .filter((event) => event.summary === 'Offsite')
        .map((event) => event.start.value)
        .sort();
    };
    expect(await days()).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);

    const listing = await data(asking, 'list_events', {
      from: '2026-09-20T00:00:00Z',
      to: '2026-09-25T00:00:00Z',
      calendars: [WORK],
    });
    const middle = (listing.events as ShapedEvent[]).find(
      (event) =>
        event.summary === 'Offsite' && event.start.value === '2026-09-22'
    );
    await asking.call('delete_event', { id: middle?.id });

    const stored = (await getRaw(sandbox, 'work', 'offsite.ics')).ics.replace(
      /\r\n[ \t]/g,
      ''
    );
    expect(stored).toMatch(/^EXDATE;VALUE=DATE:20260922\r?$/m);
    expect(await days()).toEqual(['2026-09-21', '2026-09-23']);
  });

  it('deletes a whole series', async () => {
    await asking.call('delete_event', {
      id: state.seriesId,
      scope: 'entire_series',
    });
    await asking.call(
      'get_event',
      { id: state.seriesId },
      { expectError: true }
    );
  });
});

describe('tasks', () => {
  it('creates, lists, changes, completes and deletes a task', async () => {
    const created = await data(asking, 'create_task', {
      calendar_id: WORK,
      summary: 'Write the report',
      due: '2026-09-18T17:00:00',
      priority: 2,
    });
    state.taskId = created.id as string;

    const listing = await data(asking, 'list_tasks', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expect(
      (listing.tasks as { summary?: string }[]).some(
        (task) => task.summary === 'Write the report'
      )
    ).toBe(true);

    const detail = await data(asking, 'get_task', { id: state.taskId });
    expect((detail.task as { priority?: number }).priority).toBe(2);

    await asking.call('update_task', {
      id: state.taskId,
      percent_complete: 50,
    });

    const done = await data(asking, 'complete_task', { id: state.taskId });
    expect(done.status).toBe('COMPLETED');

    // Completed tasks are out of the default listing, and back in on request.
    const hidden = await data(asking, 'list_tasks', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expect(
      (hidden.tasks as { summary?: string }[]).some(
        (task) => task.summary === 'Write the report'
      )
    ).toBe(false);

    const shown = await data(asking, 'list_tasks', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
      include_completed: true,
    });
    expect(
      (shown.tasks as { summary?: string }[]).some(
        (task) => task.summary === 'Write the report'
      )
    ).toBe(true);

    await asking.call('delete_task', { id: state.taskId });
    await asking.call('get_task', { id: state.taskId }, { expectError: true });
  });
});

describe('journals', () => {
  it('creates, lists, changes and deletes a note', async () => {
    const created = await data(asking, 'create_journal', {
      calendar_id: PRIVATE,
      summary: 'Retro',
      date: '2026-09-12',
      description: 'What went well.',
    });
    state.journalId = created.id as string;

    const listing = await data(asking, 'list_journals', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expect(listing.count).toBeGreaterThan(0);

    const detail = await data(asking, 'get_journal', { id: state.journalId });
    expect((detail.journal as { description?: string }).description).toBe(
      'What went well.'
    );

    await asking.call('update_journal', {
      id: state.journalId,
      description: 'What went well, and what did not.',
    });

    await plain.confirmed('delete_journal', { id: state.journalId });
    await asking.call(
      'get_journal',
      { id: state.journalId },
      { expectError: true }
    );
  });
});

describe('the calendar allowlist, against a real server', () => {
  /** A well-formed id for a calendar the operator fenced off. */
  const forbiddenId = `e1.${Buffer.from(
    `/integration/${FORBIDDEN_CALENDAR}/`,
    'utf8'
  ).toString('base64url')}.${Buffer.from('anything.ics', 'utf8').toString(
    'base64url'
  )}`;

  it('refuses an id pointing at a calendar outside CALDAV_CALENDARS', async () => {
    // Built the way an id is built, so nothing but the allowlist stands between
    // the caller and the entry.
    await asking.call(
      'get_event',
      { id: forbiddenId },
      { expectError: /not given access|cannot see/ }
    );
    await asking.call(
      'update_event',
      { id: forbiddenId, summary: 'nope' },
      { expectError: /not given access|cannot see/ }
    );
    await asking.call(
      'delete_event',
      { id: forbiddenId },
      { expectError: /not given access|cannot see/ }
    );
  });

  it('refuses a calendar argument outside the allowlist', async () => {
    await asking.call(
      'list_events',
      { calendars: [`/integration/${FORBIDDEN_CALENDAR}/`] },
      { expectError: /not given access/ }
    );
    await asking.call(
      'create_event',
      {
        calendar_id: `/integration/${FORBIDDEN_CALENDAR}/`,
        summary: 'nope',
        start: '2026-09-07T10:00:00',
      },
      { expectError: /not given access/ }
    );
  });

  it('never lets a search reach a fenced-off calendar', async () => {
    // The easiest way past a calendar allowlist in this protocol: a
    // calendar-query issued Depth:1 against the *home set* returns matches from
    // every collection under it. This server issues one REPORT per allowed
    // calendar instead, and this is what pins that.
    await putRaw(
      sandbox,
      FORBIDDEN_CALENDAR,
      'secret.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//test//EN',
        'BEGIN:VEVENT',
        'UID:secret@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART:20260909T090000Z',
        'DTEND:20260909T100000Z',
        'SUMMARY:zzz-fenced-off-marker-zzz',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );

    const found = await data(asking, 'search_events', {
      query: 'zzz-fenced-off-marker-zzz',
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expect(found.count).toBe(0);

    const listed = await data(asking, 'list_events', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expect(JSON.stringify(listed)).not.toContain('zzz-fenced-off-marker-zzz');

    const busy = await data(asking, 'get_free_busy', {
      from: '2026-09-09T00:00:00Z',
      to: '2026-09-10T00:00:00Z',
    });
    // The fenced-off event is the only thing in that window, so a leak would
    // show up as a busy period that should not be there.
    expect(busy.count).toBe(0);
  });
});

describe('coverage', () => {
  it('exercises every tool in the catalogue', () => {
    const called = new Set([...asking.called, ...plain.called]);
    const report = toolCoverage({ called }, ALL_TOOLS, {});
    // eslint-disable-next-line no-console
    console.log(
      `caldav-mcp: ${report.called.length}/${ALL_TOOLS.length} tools exercised` +
        (report.missing.length > 0
          ? `, missing: ${report.missing.join(', ')}`
          : '')
    );
    expectEveryToolExercised({ called }, ALL_TOOLS, {});
  });
});

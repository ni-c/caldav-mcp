import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALL_TOOLS, READ_TOOLS } from '../src/tools/catalogue.js';
import {
  connect,
  dataOf,
  FakeCalDav,
  textOf,
  type Connected,
} from './harness.js';

/**
 * Every tool, through a real MCP client, against a CalDAV server that answers
 * real multistatus XML.
 *
 * This is where the fleet's conventions are pinned: all four annotation hints
 * on every tool, an object-rooted output schema on every tool, and the exact
 * list of tools that do *not* carry the untrusted marker. Each of those is a
 * claim this server makes about itself, and each is the kind of claim that
 * quietly stops being true.
 */

const HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

const WORK = '/tester/work/';
const PRIVATE = '/tester/private/';

function event(lines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    'UID:fixture@example.net',
    'DTSTAMP:20260901T120000Z',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const SIMPLE = event([
  'DTSTART;TZID=Europe/Berlin:20260907T090000',
  'DTEND;TZID=Europe/Berlin:20260907T100000',
  'SUMMARY:Standup',
  'LOCATION:Room 1',
  'DESCRIPTION:The daily one.',
]);

const SERIES = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:series@example.net',
  'DTSTAMP:20260901T120000Z',
  'DTSTART;TZID=Europe/Berlin:20260907T090000',
  'DTEND;TZID=Europe/Berlin:20260907T100000',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'SUMMARY:Weekly',
  'ORGANIZER;CN=Alice:mailto:alice@example.net',
  'ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.net',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Soon',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const TASK = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VTODO',
  'UID:task@example.net',
  'DTSTAMP:20260901T120000Z',
  'DUE;TZID=Europe/Berlin:20260918T170000',
  'SUMMARY:Write the report',
  'PRIORITY:2',
  'END:VTODO',
  'END:VCALENDAR',
  '',
].join('\r\n');

const JOURNAL = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VJOURNAL',
  'UID:note@example.net',
  'DTSTAMP:20260901T120000Z',
  'DTSTART;VALUE=DATE:20260912',
  'SUMMARY:Retro',
  'DESCRIPTION:What went well.',
  'END:VJOURNAL',
  'END:VCALENDAR',
  '',
].join('\r\n');

let fake: FakeCalDav;
let session: Connected;

const WINDOW = { from: '2026-09-01T00:00:00Z', to: '2026-10-15T00:00:00Z' };

async function call(
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  return session.client.callTool({ name, arguments: args });
}

async function data(
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const result = await call(name, args);
  expect(
    (result as { isError?: boolean }).isError,
    `${name} failed: ${textOf(result)}`
  ).toBeFalsy();
  return dataOf(result);
}

function seedAll(): void {
  fake.seed('work', 'simple.ics', SIMPLE);
  fake.seed('work', 'series.ics', SERIES);
  fake.seed('work', 'task.ics', TASK);
  fake.seed('private', 'note.ics', JOURNAL);
}

beforeEach(async () => {
  fake = new FakeCalDav({ addresses: ['me@example.net'] });
  fake.install();
  seedAll();
  session = await connect({ userEmail: 'me@example.net' }, 'accept');
});

afterEach(async () => {
  await session.close();
  vi.unstubAllGlobals();
});

describe('the tool surface', () => {
  it('registers exactly the catalogue', async () => {
    const { tools } = await session.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...ALL_TOOLS].sort()
    );
  });

  it('declares all four annotation hints on every tool', async () => {
    const { tools } = await session.client.listTools();
    for (const tool of tools) {
      for (const hint of HINTS) {
        expect(
          typeof (tool.annotations as Record<string, unknown> | undefined)?.[
            hint
          ],
          `${tool.name}.${hint}`
        ).toBe('boolean');
      }
    }
  });

  it('declares an object-rooted output schema on every tool', async () => {
    const { tools } = await session.client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(
        (tool.outputSchema as { type?: string } | undefined)?.type,
        tool.name
      ).toBe('object');
    }
  });

  it('marks every read tool read-only and nothing else', async () => {
    const { tools } = await session.client.listTools();
    const readOnly = tools
      .filter(
        (tool) =>
          (tool.annotations as { readOnlyHint?: boolean } | undefined)
            ?.readOnlyHint === true
      )
      .map((tool) => tool.name)
      .sort();
    expect(readOnly).toEqual([...READ_TOOLS].sort());
  });

  it('opens the world nowhere', async () => {
    // Including respond_to_event. The hint marks a tool that makes this server
    // reach an address somebody else chose; an iTIP reply is sent by the
    // backend, and its consequence is stated in the approval dialog instead.
    const { tools } = await session.client.listTools();
    for (const tool of tools) {
      expect(
        (tool.annotations as { openWorldHint?: boolean } | undefined)
          ?.openWorldHint,
        tool.name
      ).toBe(false);
    }
  });

  it('calls replacing somebody’s text destructive, and a marker change not', async () => {
    const { tools } = await session.client.listTools();
    const destructive = tools
      .filter(
        (tool) =>
          (tool.annotations as { destructiveHint?: boolean } | undefined)
            ?.destructiveHint === true
      )
      .map((tool) => tool.name)
      .sort();
    // A CalDAV server keeps no history, so an update replaces writing with no
    // way back — the opposite answer to a wiki's update_page, and the reason
    // this list is pinned rather than derived.
    expect(destructive).toEqual([
      'delete_event',
      'delete_journal',
      'delete_task',
      'move_event',
      'update_event',
      'update_journal',
      'update_task',
    ]);
  });
});

describe('the untrusted marker', () => {
  it('is on every answer built from calendar content, and on nothing else', async () => {
    const { tools } = await session.client.listTools();
    const plain = tools
      .filter((tool) => {
        const properties = (
          tool.outputSchema as { properties?: Record<string, unknown> }
        ).properties;
        return properties?.untrusted === undefined;
      })
      .map((tool) => tool.name)
      .sort();
    // get_server_info reports protocol tokens and this server's own probe
    // results; get_free_busy reports time periods and nothing anybody wrote;
    // the rest are confirmations of this server's own work. A marker on
    // everything would be a marker on nothing.
    expect(plain).toEqual([
      'create_event',
      'create_journal',
      'create_task',
      'delete_event',
      'delete_journal',
      'delete_task',
      'get_free_busy',
      'get_server_info',
      'move_event',
      'respond_to_event',
    ]);
  });

  it('fences the free text of a single entry in the text channel', async () => {
    const listing = await data('list_events', WINDOW);
    const first = (listing.events as { id: string }[])[0];
    const result = await call('get_event', { id: first?.id });
    const text = textOf(result);
    expect(text).toContain('BEGIN UNTRUSTED CALENDAR CONTENT');
    expect(text).toContain('END UNTRUSTED CALENDAR CONTENT');
    // The fence carries a per-line datamark, so a reader fifty lines in still
    // knows whose words these are.
    expect(text).toMatch(/^[0-9a-f]{8}\| /m);
  });
});

describe('reading', () => {
  it('lists the calendars with their components', async () => {
    const listing = await data('list_calendars');
    expect(listing.count).toBe(2);
    expect(listing.withheld).toBe(0);
    const names = (listing.calendars as { id: string }[]).map((c) => c.id);
    expect(names.sort()).toEqual([PRIVATE, WORK]);
  });

  it('reports the server capabilities it probed for', async () => {
    const info = await data('get_server_info');
    expect(info.dav).toContain('calendar-access');
    expect(info.self_addresses).toContain('me@example.net');
    expect((info.features as { text_match: boolean }).text_match).toBe(true);
  });

  it('expands a series and gives every occurrence its own id', async () => {
    const listing = await data('list_events', WINDOW);
    const weekly = (
      listing.events as { id: string; summary?: string }[]
    ).filter((entry) => entry.summary === 'Weekly');
    expect(weekly).toHaveLength(3);
    expect(new Set(weekly.map((entry) => entry.id)).size).toBe(3);
  });

  it('reports a timestamp as an instant, a zone and an all-day flag', async () => {
    const listing = await data('list_events', WINDOW);
    const standup = (
      listing.events as {
        summary?: string;
        start: { value: string; tzid?: string; all_day: boolean };
      }[]
    ).find((entry) => entry.summary === 'Standup');
    expect(standup?.start.value).toBe('2026-09-07T09:00:00+02:00');
    expect(standup?.start.tzid).toBe('Europe/Berlin');
    expect(standup?.start.all_day).toBe(false);
  });

  it('marks the attendee that is us', async () => {
    const listing = await data('list_events', WINDOW);
    const weekly = (
      listing.events as {
        summary?: string;
        attendees?: { email?: string; is_self?: boolean }[];
      }[]
    ).find((entry) => entry.summary === 'Weekly');
    expect(
      weekly?.attendees?.find((a) => a.email === 'me@example.net')?.is_self
    ).toBe(true);
  });

  it('reads one entry in full', async () => {
    const listing = await data('list_events', WINDOW);
    const standup = (listing.events as { id: string; summary?: string }[]).find(
      (entry) => entry.summary === 'Standup'
    );
    const entry = await data('get_event', { id: standup?.id });
    expect((entry.event as { description?: string }).description).toBe(
      'The daily one.'
    );
  });

  it('searches on the server rather than filtering here', async () => {
    const hit = await data('search_events', { ...WINDOW, query: 'Standup' });
    expect(hit.count).toBe(1);
    const miss = await data('search_events', { ...WINDOW, query: 'nothing' });
    expect(miss.count).toBe(0);
  });

  it('lists tasks by their due date even without a start', async () => {
    const listing = await data('list_tasks', WINDOW);
    const task = (
      listing.tasks as { summary?: string; due?: unknown; start?: unknown }[]
    )[0];
    expect(task?.summary).toBe('Write the report');
    expect(task?.due).toBeDefined();
    // No DTSTART in the fixture, so none is reported: filling it from DUE would
    // be inventing a field the entry does not have.
    expect(task?.start).toBeUndefined();
  });

  it('lists journal entries', async () => {
    const listing = await data('list_journals', WINDOW);
    expect(listing.count).toBe(1);
  });

  it('answers free/busy with periods and no titles', async () => {
    const busy = await data('get_free_busy', WINDOW);
    expect(busy.method).toBe('server');
    expect(JSON.stringify(busy)).not.toContain('Standup');
  });
});

describe('writing', () => {
  it('creates an event and answers with an id that works', async () => {
    const created = await data('create_event', {
      calendar_id: WORK,
      summary: 'New thing',
      start: '2026-09-20T10:00:00',
      end: '2026-09-20T11:00:00',
    });
    expect(created.created).toBe(true);
    const entry = await data('get_event', { id: created.id });
    expect((entry.event as { summary?: string }).summary).toBe('New thing');
  });

  it('generates the UID and the file name itself', async () => {
    await data('create_event', {
      calendar_id: WORK,
      summary: 'Generated',
      start: '2026-09-21T10:00:00',
    });
    const names = fake.names('work');
    // No caller-supplied path anywhere: traversal and overwriting are removed
    // rather than defended against.
    expect(names.some((name) => /^[0-9a-f-]{36}\.ics$/.test(name))).toBe(true);
  });

  it('changes only what it was asked to change', async () => {
    const listing = await data('list_events', WINDOW);
    const weekly = (listing.events as { id: string; summary?: string }[]).find(
      (entry) => entry.summary === 'Weekly'
    );
    await data('update_event', { id: weekly?.id, summary: 'Renamed' });

    const stored = (fake.stored('work', 'series.ics') ?? '').replace(
      /\r\n[ \t]/g,
      ''
    );
    // The rule, the reminder, the organiser and the attendee were never
    // mentioned, so they are still there. Preserved by not being touched.
    expect(stored).toMatch(/RRULE:FREQ=WEEKLY;COUNT=3/);
    expect(stored).toMatch(/TRIGGER:-PT15M/);
    expect(stored).toMatch(/ORGANIZER[^\r\n]*alice@example\.net/);
    expect(stored).toMatch(/ATTENDEE[^\r\n]*me@example\.net/);
  });

  it('gives a new override everything the master had', async () => {
    // RFC 5545 makes a component with a RECURRENCE-ID a *complete replacement*
    // for that instance, not a delta: a reader does not fall back to the master
    // for a property the override omits. An override built from times alone
    // therefore drops that occurrence's summary, attendees and alarms — and
    // nothing reports it, because the series still looks right.
    const listing = await data('list_events', WINDOW);
    const weekly = (
      listing.events as { id: string; summary?: string }[]
    ).filter((entry) => entry.summary === 'Weekly');
    await data('update_event', {
      id: weekly[1]?.id,
      location: 'Room 9',
    });

    const stored = (fake.stored('work', 'series.ics') ?? '').replace(
      /\r\n[ \t]/g,
      ''
    );
    const override = stored
      .split('BEGIN:VEVENT')
      .find((block) => block.includes('RECURRENCE-ID'));
    expect(override).toBeDefined();
    expect(override).toMatch(/SUMMARY:Weekly/);
    expect(override).toMatch(/ATTENDEE[^\r\n]*me@example\.net/);
    expect(override).toMatch(/ORGANIZER[^\r\n]*alice@example\.net/);
    expect(override).toMatch(/TRIGGER:-PT15M/);
    expect(override).toMatch(/LOCATION:Room 9/);
    // And the rule stays on the master, or the instance becomes a series.
    expect(override).not.toMatch(/RRULE/);
  });

  it('refuses to change nothing', async () => {
    const listing = await data('list_events', WINDOW);
    const first = (listing.events as { id: string }[])[0];
    const result = await call('update_event', { id: first?.id });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/at least one field/);
  });

  it('refuses to move one end of an event on its own', async () => {
    const listing = await data('list_events', WINDOW);
    const first = (listing.events as { id: string }[])[0];
    const result = await call('update_event', {
      id: first?.id,
      start: '2026-09-07T11:00:00',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/both start and end/);
  });

  it('completes and reopens a task', async () => {
    const listing = await data('list_tasks', WINDOW);
    const task = (listing.tasks as { id: string }[])[0];
    const done = await data('complete_task', { id: task?.id });
    expect(done.status).toBe('COMPLETED');
    expect(fake.stored('work', 'task.ics')).toMatch(/STATUS:COMPLETED/);

    const reopened = await data('complete_task', { id: task?.id, done: false });
    expect(reopened.status).toBe('NEEDS-ACTION');
    expect(fake.stored('work', 'task.ics')).not.toMatch(/^COMPLETED:/m);
  });

  it('moves an event and leaves nothing behind', async () => {
    const listing = await data('list_events', WINDOW);
    const standup = (listing.events as { id: string; summary?: string }[]).find(
      (entry) => entry.summary === 'Standup'
    );
    const moved = await data('move_event', {
      id: standup?.id,
      destination_calendar_id: PRIVATE,
    });
    expect(moved.moved).toBe(true);
    expect(fake.names('work')).not.toContain('simple.ics');
    expect(fake.names('private')).toContain('simple.ics');
  });

  it('deletes one occurrence with an exception date, not a DELETE', async () => {
    const listing = await data('list_events', WINDOW);
    const weekly = (
      listing.events as { id: string; summary?: string }[]
    ).filter((entry) => entry.summary === 'Weekly');
    await data('delete_event', { id: weekly[1]?.id });
    const stored = fake.stored('work', 'series.ics') ?? '';
    expect(stored).toMatch(/^EXDATE/m);
    expect(stored).toMatch(/RRULE/);
    expect(fake.names('work')).toContain('series.ics');
  });

  it('refuses this_occurrence on a series id rather than deleting the series', async () => {
    // The two arguments contradict each other. The old answer was a dialog
    // reading "delete one occurrence, leaving the rest of the series" followed
    // by a DELETE of the whole resource.
    const listing = await data('list_events', WINDOW);
    const weekly = (
      listing.events as { id: string; series_id?: string; summary?: string }[]
    ).find((entry) => entry.summary === 'Weekly');
    const before = session.prompts.length;
    const result = await call('delete_event', {
      id: weekly?.series_id,
      scope: 'this_occurrence',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/names the whole series/);
    expect(fake.names('work')).toContain('series.ics');
    // Refused before anyone was asked, not after.
    expect(session.prompts.length).toBe(before);

    const update = await call('update_event', {
      id: weekly?.series_id,
      scope: 'this_occurrence',
      summary: 'Renamed',
    });
    expect((update as { isError?: boolean }).isError).toBe(true);
    expect(fake.stored('work', 'series.ics')).toContain('SUMMARY:Weekly');
  });

  it('asks before a change reaches every occurrence, whichever id was passed', async () => {
    // A listing hands out the series id next to every occurrence id, and a
    // change through it touches every occurrence just the same. Whether the
    // entry recurs is read from the stored resource, not from the id.
    const listing = await data('list_events', WINDOW);
    const events = listing.events as {
      id: string;
      series_id?: string;
      summary?: string;
    }[];
    const weekly = events.find((entry) => entry.summary === 'Weekly');
    const standup = events.find((entry) => entry.summary === 'Standup');

    let before = session.prompts.length;
    await data('update_event', { id: weekly?.series_id, summary: 'Renamed' });
    expect(session.prompts.length).toBe(before + 1);
    expect(session.prompts.at(-1)).toMatch(/every occurrence/);

    before = session.prompts.length;
    await data('update_event', {
      id: weekly?.id,
      scope: 'entire_series',
      location: 'Room 2',
    });
    expect(session.prompts.length).toBe(before + 1);

    // A single event has no series to reach, so it does not ask.
    before = session.prompts.length;
    await data('update_event', { id: standup?.series_id, summary: 'Renamed' });
    expect(session.prompts.length).toBe(before);
  });

  it('excludes an all-day occurrence on the day the id names', async () => {
    // Midnight in Berlin is 22:00 UTC the day before. Reading UTC fields off
    // that instant put the exception on the previous day: the requested
    // occurrence survived and its neighbour disappeared, reported as success.
    fake.seed(
      'work',
      'allday.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//t//EN',
        'BEGIN:VEVENT',
        'UID:allday@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART;VALUE=DATE:20260907',
        'DTEND;VALUE=DATE:20260908',
        'RRULE:FREQ=DAILY;COUNT=3',
        'SUMMARY:Retreat',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
    const days = async (): Promise<string[]> => {
      const listing = await data('list_events', WINDOW);
      return (
        listing.events as { summary?: string; start: { value: string } }[]
      )
        .filter((entry) => entry.summary === 'Retreat')
        .map((entry) => entry.start.value);
    };
    expect(await days()).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);

    const listing = await data('list_events', WINDOW);
    const middle = (
      listing.events as {
        id: string;
        summary?: string;
        start: { value: string };
      }[]
    ).find(
      (entry) =>
        entry.summary === 'Retreat' && entry.start.value === '2026-09-08'
    );
    await data('delete_event', { id: middle?.id });

    expect(fake.stored('work', 'allday.ics')).toMatch(
      /^EXDATE;VALUE=DATE:20260908\r?$/m
    );
    expect(await days()).toEqual(['2026-09-07', '2026-09-09']);
  });

  it('deletes the same occurrence twice without a second exception', async () => {
    const listing = await data('list_events', WINDOW);
    const weekly = (
      listing.events as { id: string; summary?: string }[]
    ).filter((entry) => entry.summary === 'Weekly');
    await data('delete_event', { id: weekly[1]?.id });
    await data('delete_event', { id: weekly[1]?.id });
    const stored = fake.stored('work', 'series.ics') ?? '';
    expect(stored.match(/^EXDATE/gm)).toHaveLength(1);
    const after = await data('list_events', WINDOW);
    expect(
      (after.events as { summary?: string }[]).filter(
        (entry) => entry.summary === 'Weekly'
      )
    ).toHaveLength(2);
  });

  it('removes the override of a deleted occurrence, whatever zone wrote it', async () => {
    // A TZID-only RECURRENCE-ID with no VTIMEZONE is floating to ical.js, and
    // `toJSDate()` on it applies the host's zone. On a container in UTC the
    // override was never matched, left behind, and re-emitted by the next
    // listing as the occurrence that had just been "deleted".
    fake.seed(
      'work',
      'moved.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//t//EN',
        'BEGIN:VEVENT',
        'UID:moved@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART;TZID=Europe/Berlin:20260907T090000',
        'DTEND;TZID=Europe/Berlin:20260907T100000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:Sync',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:moved@example.net',
        'DTSTAMP:20260901T120000Z',
        'RECURRENCE-ID;TZID=Europe/Berlin:20260914T090000',
        'DTSTART;TZID=Europe/Berlin:20260915T090000',
        'DTEND;TZID=Europe/Berlin:20260915T100000',
        'SUMMARY:Sync (moved)',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
    const listing = await data('list_events', WINDOW);
    const moved = (listing.events as { id: string; summary?: string }[]).find(
      (entry) => entry.summary === 'Sync (moved)'
    );
    expect(moved).toBeDefined();
    await data('delete_event', { id: moved?.id });

    const stored = fake.stored('work', 'moved.ics') ?? '';
    expect(stored).not.toContain('RECURRENCE-ID');
    expect(stored).toMatch(/^EXDATE/m);
    const after = await data('list_events', WINDOW);
    const summaries = (after.events as { summary?: string }[])
      .map((entry) => entry.summary)
      .filter((summary) => summary?.startsWith('Sync'));
    expect(summaries).toEqual(['Sync', 'Sync']);
  });

  it('refuses to move into a calendar that cannot take the event', async () => {
    await session.close();
    fake = new FakeCalDav({
      calendars: [
        { name: 'work' },
        { name: 'locked', readOnly: true },
        { name: 'todo', components: ['VTODO'] },
      ],
    });
    fake.install();
    fake.seed('work', 'simple.ics', SIMPLE);
    session = await connect({}, 'accept');
    const listing = await data('list_events', WINDOW);
    const standup = (listing.events as { id: string }[])[0];

    const locked = await call('move_event', {
      id: standup?.id,
      destination_calendar_id: '/tester/locked/',
    });
    expect((locked as { isError?: boolean }).isError).toBe(true);
    expect(textOf(locked)).toMatch(/not write to it/);

    const todo = await call('move_event', {
      id: standup?.id,
      destination_calendar_id: '/tester/todo/',
    });
    expect((todo as { isError?: boolean }).isError).toBe(true);
    expect(textOf(todo)).toMatch(/does not accept VEVENT/);
    expect(fake.names('work')).toContain('simple.ics');
  });

  it('refuses a timezone it does not know at the schema', async () => {
    let refused = false;
    try {
      const result = (await call('create_event', {
        calendar_id: WORK,
        summary: 'x',
        start: '2026-09-20T10:00:00',
        timezone: 'Mars/Olympus',
      })) as { isError?: boolean };
      refused = result.isError === true;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(fake.requests.filter((request) => request.method === 'PUT')).toEqual(
      []
    );
  });

  it('answers an invitation on our own attendee line only', async () => {
    const listing = await data('list_events', WINDOW);
    const weekly = (listing.events as { id: string; summary?: string }[]).find(
      (entry) => entry.summary === 'Weekly'
    );
    const answered = await data('respond_to_event', {
      id: weekly?.id,
      response: 'DECLINED',
    });
    expect(answered.responded).toBe(true);
    const stored = (fake.stored('work', 'series.ics') ?? '').replace(
      /\r\n[ \t]/g,
      ''
    );
    expect(stored).toMatch(
      /ATTENDEE[^\r\n]*PARTSTAT=DECLINED[^\r\n]*me@example\.net/
    );
    expect(stored).toMatch(/ORGANIZER[^\r\n]*alice@example\.net/);
  });

  it('answers without claiming to be a newer revision than the organiser', async () => {
    // RFC 5546 §3.2.3: an attendee echoes the organiser's SEQUENCE in a reply.
    // Bumping it says "this is a newer revision of the event than the one you
    // sent", so a client comparing sequences treats the attendee's copy as
    // current and ignores the organiser's next real update as stale — an
    // accepted invitation that quietly stops receiving changes. Editing the
    // same event as its owner is the opposite case, and must still bump.
    fake.seed(
      'work',
      'invited.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//t//EN',
        'BEGIN:VEVENT',
        'UID:invited@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART:20260908T070000Z',
        'DTEND:20260908T080000Z',
        'SEQUENCE:3',
        'SUMMARY:Invitation',
        'ORGANIZER;CN=Alice:mailto:alice@example.net',
        'ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.net',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
    const listing = await data('list_events', WINDOW);
    const invitation = (
      listing.events as { id: string; summary?: string }[]
    ).find((entry) => entry.summary === 'Invitation');

    await data('respond_to_event', {
      id: invitation?.id,
      response: 'ACCEPTED',
    });
    const afterReply = fake.stored('work', 'invited.ics') ?? '';
    expect(afterReply).toMatch(/^SEQUENCE:3\r?$/m);
    // The reply still has to be orderable against other replies.
    expect(afterReply).not.toContain('DTSTAMP:20260901T120000Z');

    await data('update_event', { id: invitation?.id, summary: 'Renamed' });
    expect(fake.stored('work', 'invited.ics') ?? '').toMatch(
      /^SEQUENCE:4\r?$/m
    );
  });

  it('creates and deletes a task and a journal entry', async () => {
    const task = await data('create_task', {
      calendar_id: WORK,
      summary: 'Another task',
      due: '2026-09-25T12:00:00',
    });
    await data('update_task', { id: task.id, priority: 5 });
    await data('delete_task', { id: task.id });

    const note = await data('create_journal', {
      calendar_id: PRIVATE,
      summary: 'Another note',
      date: '2026-09-13',
    });
    await data('update_journal', { id: note.id, description: 'Changed.' });
    await data('delete_journal', { id: note.id });
  });
});

describe('asking a person', () => {
  it('shows a dialog to a client that can be asked', async () => {
    const listing = await data('list_events', WINDOW);
    const first = (listing.events as { id: string }[])[0];
    const before = session.prompts.length;
    await data('delete_event', { id: first?.id });
    expect(session.prompts.length).toBeGreaterThan(before);
  });

  it('describes the actual entry rather than a scope name', async () => {
    // The dialog is what a person reads to decide, so it has to be true about
    // this entry. Saying "a whole recurring event and every one of its
    // occurrences" about a single lunch reads as a description and is not one.
    const listing = await data('list_events', WINDOW);
    const events = listing.events as { id: string; summary?: string }[];
    const single = events.find((entry) => entry.summary === 'Standup');
    const series = events.find((entry) => entry.summary === 'Weekly');

    await data('delete_event', { id: single?.id });
    expect(session.prompts.at(-1)).toMatch(/^delete an event/);

    await data('delete_event', { id: series?.id, scope: 'entire_series' });
    // And it counts them, because a count is a server-side fact and the one
    // kind of detail that belongs in this text.
    expect(session.prompts.at(-1)).toMatch(
      /delete a recurring event and all 3 of its occurrences/
    );
  });

  it('counts a resource made only of detached occurrences', async () => {
    // The other shape that holds more than one occurrence: no master at all,
    // just components each carrying a RECURRENCE-ID — what a client writes
    // after a "this and following" split. Reading the rule off the master
    // reported "an event" and then deleted a file holding several of them,
    // which is the same contradiction as a series id with
    // `scope: this_occurrence`, one shape further out.
    fake.seed(
      'work',
      'detached.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//test//EN',
        ...['20260908T090000', '20260915T090000', '20260922T090000'].flatMap(
          (stamp) => [
            'BEGIN:VEVENT',
            'UID:detached@example.net',
            'DTSTAMP:20260901T120000Z',
            `RECURRENCE-ID;TZID=Europe/Berlin:${stamp}`,
            `DTSTART;TZID=Europe/Berlin:${stamp}`,
            `DTEND;TZID=Europe/Berlin:${stamp.replace('T09', 'T10')}`,
            'SUMMARY:Detached',
            'END:VEVENT',
          ]
        ),
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
    const listing = await data('list_events', WINDOW);
    const detached = (
      listing.events as { id: string; series_id: string; summary?: string }[]
    ).find((entry) => entry.summary === 'Detached');

    await data('delete_event', {
      id: detached?.series_id,
      scope: 'entire_series',
    });
    expect(session.prompts.at(-1)).toMatch(
      /delete a recurring event and all 3 of its occurrences/
    );
  });

  it('edits the override that is already there, whatever spelling wrote it', async () => {
    // The lookup used to re-serialise the stored RECURRENCE-ID and compare
    // strings. Two spellings of one occurrence agree only while both sides
    // build them identically — and they stop agreeing on a non-conforming
    // `VALUE=DATE` carrying a TZID, where the listing side resolves the zone
    // and the writing side dropped it. The lookup then found nothing, cloned a
    // *second* override off the master, and left the resource with two
    // components claiming the same instance.
    fake.seed(
      'work',
      'allday.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//test//EN',
        'BEGIN:VEVENT',
        'UID:allday@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART;VALUE=DATE:20260907',
        'DTEND;VALUE=DATE:20260908',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:All day series',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:allday@example.net',
        'DTSTAMP:20260901T120000Z',
        'RECURRENCE-ID;VALUE=DATE;TZID=America/Los_Angeles:20260921',
        'DTSTART;VALUE=DATE:20260921',
        'DTEND;VALUE=DATE:20260922',
        'SUMMARY:Already detached',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
    const listing = await data('list_events', WINDOW);
    const occurrence = (
      listing.events as { id: string; summary?: string }[]
    ).find((entry) => entry.summary === 'Already detached');
    expect(occurrence).toBeDefined();

    await data('update_event', {
      id: occurrence?.id,
      summary: 'Edited in place',
    });

    const stored = fake.stored('work', 'allday.ics') ?? '';
    // Two components, not three: the master and the one override.
    expect(stored.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(stored).toContain('SUMMARY:Edited in place');
    expect(stored).not.toContain('SUMMARY:Already detached');
  });

  it('does not offer a token to a client that can be asked', async () => {
    // The control test: if the wiring is undone, the dialog silently becomes a
    // token and every other approval test still passes.
    const listing = await data('list_events', WINDOW);
    const first = (listing.events as { id: string }[])[0];
    const result = await call('delete_event', { id: first?.id });
    expect(textOf(result)).not.toMatch(/confirm_token=/);
  });

  it('does nothing when the person declines', async () => {
    await session.close();
    session = await connect({ userEmail: 'me@example.net' }, 'decline');
    const listing = await data('list_events', WINDOW);
    const first = (listing.events as { id: string }[])[0];
    const result = await call('delete_event', { id: first?.id });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/declined/);
    expect(fake.names('work')).toContain('simple.ics');
  });

  it('falls back to a two-call token when nobody can be asked', async () => {
    await session.close();
    session = await connect({ userEmail: 'me@example.net' });
    const listing = await data('list_events', WINDOW);
    const first = (listing.events as { id: string; summary?: string }[]).find(
      (entry) => entry.summary === 'Standup'
    );

    const prompt = await call('delete_event', { id: first?.id });
    expect((prompt as { isError?: boolean }).isError).toBe(true);
    const token = /confirm_token="?([\w-]+)"?/.exec(textOf(prompt))?.[1];
    expect(token).toBeDefined();

    const done = await data('delete_event', {
      id: first?.id,
      confirm_token: token,
    });
    expect(done.deleted).toBe(true);
  });

  it('binds a series approval to the change that was asked for', async () => {
    // An approval is a person saying yes to *this* edit of *this* series.
    // Keyed on the target alone, one yes covered any other edit of the same
    // series for as long as the approval lived.
    await session.close();
    session = await connect({ userEmail: 'me@example.net' });
    const listing = await data('list_events', WINDOW);
    const weekly = (listing.events as { id: string; summary?: string }[]).find(
      (entry) => entry.summary === 'Weekly'
    );

    const prompt = await call('update_event', {
      id: weekly?.id,
      scope: 'entire_series',
      summary: 'Approved title',
    });
    expect((prompt as { isError?: boolean }).isError).toBe(true);
    const token = /confirm_token="?([\w-]+)"?/.exec(textOf(prompt))?.[1];
    expect(token).toBeDefined();

    // Same series, same scope, a different change: the token does not fit.
    const other = await call('update_event', {
      id: weekly?.id,
      scope: 'entire_series',
      summary: 'Something else',
      confirm_token: token,
    });
    expect((other as { isError?: boolean }).isError).toBe(true);
    expect(fake.stored('work', 'series.ics')).toContain('SUMMARY:Weekly');

    // The change that was approved still goes through.
    const done = await data('update_event', {
      id: weekly?.id,
      scope: 'entire_series',
      summary: 'Approved title',
      confirm_token: token,
    });
    expect(done.written).toBe(true);
    expect(fake.stored('work', 'series.ics')).toContain(
      'SUMMARY:Approved title'
    );
  });

  it('does not let a token widen the change by clearing more fields', async () => {
    // The sharper half of the rule above, and the one that got through: a
    // field left out means "keep it", a field passed as null means "clear it",
    // and the digest used to map both onto null. So a yes to "change the
    // summary" also authorised "change the summary AND wipe the description,
    // the location and every category" — of every occurrence, against a server
    // that keeps no history and with no second dialog.
    await session.close();
    session = await connect({ userEmail: 'me@example.net' });
    fake.seed(
      'work',
      'series.ics',
      SERIES.replace(
        'SUMMARY:Weekly',
        'SUMMARY:Weekly\r\nDESCRIPTION:Worth keeping\r\nLOCATION:Room 1'
      )
    );
    const listing = await data('list_events', WINDOW);
    const weekly = (listing.events as { id: string; summary?: string }[]).find(
      (entry) => entry.summary === 'Weekly'
    );

    const prompt = await call('update_event', {
      id: weekly?.id,
      scope: 'entire_series',
      summary: 'Approved title',
    });
    const token = /confirm_token="?([\w-]+)"?/.exec(textOf(prompt))?.[1];
    expect(token).toBeDefined();

    const widened = await call('update_event', {
      id: weekly?.id,
      scope: 'entire_series',
      summary: 'Approved title',
      description: null,
      location: null,
      confirm_token: token,
    });
    expect((widened as { isError?: boolean }).isError).toBe(true);
    const stored = fake.stored('work', 'series.ics') ?? '';
    expect(stored).toContain('DESCRIPTION:Worth keeping');
    expect(stored).toContain('LOCATION:Room 1');
  });

  it('refuses a token issued for a different target', async () => {
    await session.close();
    session = await connect({ userEmail: 'me@example.net' });
    const listing = await data('list_events', WINDOW);
    const events = listing.events as { id: string; summary?: string }[];
    const standup = events.find((entry) => entry.summary === 'Standup');
    const weekly = events.find((entry) => entry.summary === 'Weekly');

    const prompt = await call('delete_event', { id: standup?.id });
    const token = /confirm_token="?([\w-]+)"?/.exec(textOf(prompt))?.[1];

    // Same tool, same shape of call, a different entry. The resource key is
    // what makes this fail rather than delete the wrong thing.
    const result = await call('delete_event', {
      id: weekly?.id,
      confirm_token: token,
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(fake.names('work')).toContain('series.ics');
  });
});

describe('read-only mode', () => {
  it('registers only the read tools', async () => {
    await session.close();
    session = await connect({ readOnly: true });
    const { tools } = await session.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...READ_TOOLS].sort()
    );
  });

  it('answers a suppressed write tool the way it answers an unknown one', async () => {
    await session.close();
    session = await connect({ readOnly: true });
    // Indistinguishable on purpose: `remove()` deletes the registration, so a
    // suppressed tool and a nonexistent one give the same answer.
    const message = async (name: string): Promise<string> =>
      session.client.callTool({ name, arguments: { id: 'x' } }).then(
        () => 'resolved',
        (error: Error) => error.message.replace(name, '<name>')
      );
    // Identical once the name is taken out: a suppressed tool is not
    // advertised as existing-but-refused, which would be advertising a refusal.
    expect(await message('delete_event')).toBe(await message('no_such_tool'));
  });
});

describe('an allowlist that cannot be applied', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses an entry that names two calendars, rather than picking one', async () => {
    // Only a bare last segment can be ambiguous, and settling it by choosing
    // would silently grant access to a collection the operator may not have
    // meant — while the server carried on looking healthy. The check runs at
    // discovery because that is the first moment the entries have anything to
    // be matched against.
    await session.close();
    fake = new FakeCalDav({
      calendars: [{ name: 'team/work' }, { name: 'personal/work' }],
    });
    fake.install();
    session = await connect({ calendars: ['work'] });

    const result = await call('list_calendars');
    expect((result as { isError?: boolean }).isError).toBe(true);
    const message = textOf(result);
    expect(message).toContain('cannot be applied as written');
    expect(message).toContain('/tester/personal/work/');
    expect(message).toContain('/tester/team/work/');
    // The way out is named, because "ambiguous" without a remedy is a riddle.
    expect(message).toMatch(/full path/);
  });

  it('warns once about an entry that matches nothing, and keeps working', async () => {
    // A typo usually, but also what an upstream deletion looks like — so it is
    // a warning rather than a refusal. Once per process: the registry is
    // rebuilt whenever its cache expires, and a warning on a loop is a warning
    // people learn to skip.
    await session.close();
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fake = new FakeCalDav();
    fake.install();
    session = await connect({ calendars: ['work', 'wrok'] });

    const first = await data('list_calendars');
    const second = await data('list_calendars');
    expect((first.calendars as unknown[]).length).toBe(1);
    expect((second.calendars as unknown[]).length).toBe(1);

    const lines = warn.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('matching no calendar'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('wrok');
  });
});

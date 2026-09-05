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

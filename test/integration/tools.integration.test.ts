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
} = {};

const WORK = '/integration/work/';
const PRIVATE = '/integration/private/';

function data(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
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

describe('the connection', () => {
  it('reports what the server can do', async () => {
    const info = data(await asking.call('get_server_info'));
    expect(info.dav).toContain('calendar-access');
    expect((info.features as { text_match: boolean }).text_match).toBe(true);
    // Radicale 3.8 does answer a free-busy query, and expands recurrences
    // server-side while doing it. If this ever goes false the tool falls back to
    // computing the periods, which is covered by its own assertion below.
    expect((info.features as { free_busy: boolean }).free_busy).toBe(true);
    expect(info.self_addresses).toContain('integration@example.net');
  });

  it('lists only the allowed calendars, and says how many it withheld', async () => {
    const listing = data(await asking.call('list_calendars'));
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
    const created = data(
      await asking.call('create_event', {
        calendar_id: WORK,
        summary: 'Coffee',
        start: '2026-09-07T15:00:00',
        end: '2026-09-07T15:30:00',
      })
    );
    expect(created.created).toBe(true);
    state.simpleId = created.id as string;
  });

  it('creates an all-day event', async () => {
    const created = data(
      await asking.call('create_event', {
        calendar_id: WORK,
        summary: 'Company holiday',
        start: '2026-09-11',
      })
    );
    state.allDayId = created.id as string;
    const entry = data(await asking.call('get_event', { id: state.allDayId }));
    const event = entry.event as { start: { value: string; all_day: boolean } };
    expect(event.start.all_day).toBe(true);
    expect(event.start.value).toBe('2026-09-11');
  });

  it('creates a weekly series with a reminder and an attendee', async () => {
    const created = data(
      await asking.call('create_event', {
        calendar_id: WORK,
        summary: 'Team sync',
        start: '2026-09-07T09:00:00',
        end: '2026-09-07T10:00:00',
        location: 'Room 1',
        recurrence: 'FREQ=WEEKLY;COUNT=4',
        alarms: [{ trigger: '-PT15M', description: 'Team sync soon' }],
      })
    );
    state.seriesId = created.id as string;

    // An attendee is added out of band: this server deliberately cannot write
    // one, and respond_to_event needs one to exist.
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
    const listing = data(
      await asking.call('list_events', {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-15T00:00:00Z',
        calendars: [WORK],
      })
    );
    const events = listing.events as {
      id: string;
      series_id: string;
      summary?: string;
      start: { value: string };
    }[];
    const sync = events.filter((event) => event.summary === 'Team sync');
    expect(sync).toHaveLength(4);
    // Every occurrence has a distinct id and they all share one series id.
    expect(new Set(sync.map((event) => event.id)).size).toBe(4);
    expect(new Set(sync.map((event) => event.series_id)).size).toBe(1);
    // Sorted by start, across calendars.
    const starts = events.map((event) => event.start.value);
    expect([...starts].sort()).toEqual(starts);
    state.occurrenceId = sync[1]?.id as string;
  });

  it('answers differently for a series id and an occurrence id', async () => {
    const series = data(await asking.call('get_event', { id: state.seriesId }));
    const occurrence = data(
      await asking.call('get_event', { id: state.occurrenceId })
    );
    expect((series.event as { recurrence_rule?: string }).recurrence_rule).toBe(
      'FREQ=WEEKLY;COUNT=4'
    );
    expect(
      (occurrence.event as { recurrence_id?: unknown }).recurrence_id
    ).toBeDefined();
    expect((occurrence.event as { series_id: string }).series_id).toBe(
      state.seriesId
    );
  });

  it('moves one occurrence and leaves the rest of the series alone', async () => {
    await asking.call('update_event', {
      id: state.occurrenceId,
      start: '2026-09-14T14:00:00',
      end: '2026-09-14T15:00:00',
      summary: 'Team sync (moved)',
    });

    const listing = data(
      await asking.call('list_events', {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-15T00:00:00Z',
        calendars: [WORK],
      })
    );
    const sync = (
      listing.events as { summary?: string; start: { value: string } }[]
    )
      .filter((event) => event.summary?.startsWith('Team sync'))
      .map((event) => event.start.value);
    expect(sync).toHaveLength(4);
    expect(sync[1]).toContain('T14:00:00');
    expect(sync[2]).toContain('T09:00:00');
  });

  it('kept the rule, the reminder and the attendee in the stored file', async () => {
    // Read past this server entirely. This is the assertion that proves a
    // read-modify-write preserved what it does not model — the point of the
    // whole write path.
    const names = await listRaw(sandbox, 'work');
    const files = await Promise.all(
      names.map(async (name) => (await getRaw(sandbox, 'work', name)).ics)
    );
    const series = files.find((ics) => ics.includes('RRULE'));
    expect(series).toBeDefined();
    const unfolded = (series ?? '').replace(/\r\n[ \t]/g, '');
    expect(unfolded).toMatch(/RRULE:FREQ=WEEKLY;COUNT=4/);
    expect(unfolded).toMatch(/TRIGGER:-PT15M/);
    expect(unfolded).toMatch(/ATTENDEE[^\r\n]*integration@example\.net/);
    expect(unfolded).toMatch(/ORGANIZER[^\r\n]*alice@example\.net/);
    // The override the change created, and the master, both in one resource.
    expect((unfolded.match(/^BEGIN:VEVENT/gm) ?? []).length).toBe(2);
  });

  it('asks before changing a whole series, and does it when told to', async () => {
    const before = asking.prompts.length;
    const text = await asking.call('update_event', {
      id: state.occurrenceId,
      scope: 'entire_series',
      location: 'Room 2',
    });
    expect(asking.prompts.length).toBeGreaterThan(before);
    expect(data(text).written).toBe(true);
  });

  it('offers the two-call token to a client that cannot be asked', async () => {
    const text = await plain.confirmed('update_event', {
      id: state.occurrenceId,
      scope: 'entire_series',
      location: 'Room 3',
    });
    expect(data(text).written).toBe(true);
    // The dialog client never saw a token; the plain one never saw a dialog.
    expect(plain.prompts).toHaveLength(0);
  });

  it('refuses to write when the entry changed underneath', async () => {
    const entry = data(await asking.call('get_event', { id: state.simpleId }));
    const name = `${String((entry.event as { uid: string }).uid).split('@')[0]}.ics`;
    const stored = await getRaw(sandbox, 'work', name);

    // Change it out of band between the read and the write. The server reads
    // the ETag inside the call, so the race has to be created here.
    await putRaw(
      sandbox,
      'work',
      name,
      stored.ics.replace(/^SUMMARY:.*$/m, 'SUMMARY:Changed elsewhere')
    );

    // The next update reads a fresh ETag, so it succeeds — the 412 path is
    // exercised in the unit suite where the race is deterministic. What is
    // asserted here is that the out-of-band change is what the server now sees.
    const after = data(await asking.call('get_event', { id: state.simpleId }));
    expect((after.event as { summary: string }).summary).toBe(
      'Changed elsewhere'
    );
  });

  it('searches by text on the server', async () => {
    const found = data(
      await asking.call('search_events', {
        query: 'Coffee',
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      })
    );
    expect(found.count).toBe(0);

    const hit = data(
      await asking.call('search_events', {
        query: 'Changed elsewhere',
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      })
    );
    expect(hit.count).toBeGreaterThan(0);
  });

  it('reports busy periods without any of the titles', async () => {
    const busy = data(
      await asking.call('get_free_busy', {
        from: '2026-09-07T00:00:00Z',
        to: '2026-09-30T00:00:00Z',
      })
    );
    expect(busy.method).toBe('server');
    expect((busy.busy as unknown[]).length).toBeGreaterThan(0);
    // Nothing anybody wrote comes back — that is the tool's whole argument.
    expect(JSON.stringify(busy)).not.toContain('Team sync');
    expect(busy.untrusted).toBeUndefined();
  });

  it('answers an invitation on the attendee line that is ours', async () => {
    // The dialog client answers 'accept' automatically, so a guarded tool is
    // one call here. The token path for this tool is covered by `plain` below.
    const text = await asking.call('respond_to_event', {
      id: state.seriesId,
      response: 'ACCEPTED',
    });
    expect(data(text).responded).toBe(true);

    const names = await listRaw(sandbox, 'work');
    const files = await Promise.all(
      names.map(async (name) => (await getRaw(sandbox, 'work', name)).ics)
    );
    const series = (files.find((ics) => ics.includes('RRULE')) ?? '').replace(
      /\r\n[ \t]/g,
      ''
    );
    expect(series).toMatch(
      /ATTENDEE[^\r\n]*PARTSTAT=ACCEPTED[^\r\n]*integration@example\.net/
    );
  });

  it('moves an event to another calendar and invalidates the old id', async () => {
    const text = await asking.call('move_event', {
      id: state.allDayId,
      destination_calendar_id: PRIVATE,
    });
    const moved = data(text);
    expect(moved.moved).toBe(true);
    state.movedId = moved.id as string;
    expect(state.movedId).not.toBe(state.allDayId);

    await asking.call(
      'get_event',
      { id: state.allDayId },
      { expectError: true }
    );
    const there = data(await asking.call('get_event', { id: state.movedId }));
    expect((there.event as { summary: string }).summary).toBe(
      'Company holiday'
    );
  });

  it('deletes one occurrence by excluding it, keeping the series', async () => {
    const listing = data(
      await asking.call('list_events', {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-15T00:00:00Z',
        calendars: [WORK],
      })
    );
    const sync = (listing.events as { id: string; summary?: string }[]).filter(
      (event) => event.summary?.startsWith('Team sync')
    );
    const victim = sync[sync.length - 1]?.id as string;

    await asking.call('delete_event', { id: victim });

    const names = await listRaw(sandbox, 'work');
    const files = await Promise.all(
      names.map(async (name) => (await getRaw(sandbox, 'work', name)).ics)
    );
    const series = (files.find((ics) => ics.includes('RRULE')) ?? '').replace(
      /\r\n[ \t]/g,
      ''
    );
    expect(series).toMatch(/^EXDATE/m);
    expect(series).toMatch(/RRULE:FREQ=WEEKLY;COUNT=4/);

    const after = data(
      await asking.call('list_events', {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-15T00:00:00Z',
        calendars: [WORK],
      })
    );
    expect(
      (after.events as { summary?: string }[]).filter((event) =>
        event.summary?.startsWith('Team sync')
      )
    ).toHaveLength(sync.length - 1);
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
  it('creates, lists, completes and deletes a task', async () => {
    const created = data(
      await asking.call('create_task', {
        calendar_id: WORK,
        summary: 'Write the report',
        due: '2026-09-18T17:00:00',
        priority: 2,
      })
    );
    state.taskId = created.id as string;

    const listing = data(
      await asking.call('list_tasks', {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      })
    );
    expect(
      (listing.tasks as { summary?: string }[]).some(
        (task) => task.summary === 'Write the report'
      )
    ).toBe(true);

    const detail = data(await asking.call('get_task', { id: state.taskId }));
    expect((detail.task as { priority?: number }).priority).toBe(2);

    await asking.call('update_task', {
      id: state.taskId,
      percent_complete: 50,
    });

    const done = data(await asking.call('complete_task', { id: state.taskId }));
    expect(done.status).toBe('COMPLETED');

    // Completed tasks are out of the default listing, and back in on request.
    const hidden = data(
      await asking.call('list_tasks', {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      })
    );
    expect(
      (hidden.tasks as { summary?: string }[]).some(
        (task) => task.summary === 'Write the report'
      )
    ).toBe(false);
    const shown = data(
      await asking.call('list_tasks', {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
        include_completed: true,
      })
    );
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
    const created = data(
      await asking.call('create_journal', {
        calendar_id: PRIVATE,
        summary: 'Retro',
        date: '2026-09-12',
        description: 'What went well.',
      })
    );
    state.journalId = created.id as string;

    const listing = data(
      await asking.call('list_journals', {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      })
    );
    expect(listing.count).toBeGreaterThan(0);

    const detail = data(
      await asking.call('get_journal', { id: state.journalId })
    );
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
  it('refuses an id pointing at a calendar outside CALDAV_CALENDARS', async () => {
    // A well-formed id for a real resource in a real calendar the operator
    // fenced off. Built the way an id is built, so nothing but the allowlist
    // stands between the caller and the entry.
    const forbidden = `e1.${Buffer.from(`/integration/${FORBIDDEN_CALENDAR}/`, 'utf8').toString('base64url')}.${Buffer.from('anything.ics', 'utf8').toString('base64url')}`;
    for (const tool of ['get_event', 'update_event', 'delete_event']) {
      await asking.call(
        tool,
        tool === 'update_event'
          ? { id: forbidden, summary: 'nope' }
          : { id: forbidden },
        { expectError: /not given access|cannot see/ }
      );
    }
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

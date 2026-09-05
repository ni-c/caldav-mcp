import { afterEach, describe, expect, it, vi } from 'vitest';

import { CalDavApiError } from '../src/api.js';
import {
  CalendarNotAllowedError,
  PreconditionFailedError,
  ResultTooLargeError,
  ToolInputError,
} from '../src/errors.js';
import { hintFor, run, textResult } from '../src/result.js';
import { parseFreeBusy } from '../src/tools/events.js';
import { connect, FakeCalDav, textOf, type Connected } from './harness.js';

/**
 * The paths a happy run never reaches: refusals, fallbacks and the shapes a
 * different CalDAV server answers with.
 */

const WORK = '/tester/work/';
const WINDOW = { from: '2026-09-01T00:00:00Z', to: '2026-10-15T00:00:00Z' };

describe('reading a VFREEBUSY document', () => {
  it('reads one component per period, which is what Radicale sends', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VFREEBUSY',
      'DTSTART:20260907T070000Z',
      'DTEND:20260907T080000Z',
      'FBTYPE:BUSY',
      'END:VFREEBUSY',
      'BEGIN:VFREEBUSY',
      'DTSTART:20260914T070000Z',
      'DTEND:20260914T080000Z',
      'END:VFREEBUSY',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    expect(parseFreeBusy(ics, WORK)).toEqual([
      {
        start: '2026-09-07T07:00:00Z',
        end: '2026-09-07T08:00:00Z',
        type: 'BUSY',
        calendar: WORK,
      },
      {
        start: '2026-09-14T07:00:00Z',
        end: '2026-09-14T08:00:00Z',
        calendar: WORK,
      },
    ]);
  });

  it('reads FREEBUSY properties carrying start/end pairs', () => {
    // The other legal shape: one component with several periods on one line.
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VFREEBUSY',
      'FREEBUSY;FBTYPE=BUSY:20260907T070000Z/20260907T080000Z,20260908T070000Z/20260908T080000Z',
      'END:VFREEBUSY',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const periods = parseFreeBusy(ics, WORK);
    expect(periods).toHaveLength(2);
    expect(periods[1]?.start).toBe('2026-09-08T07:00:00Z');
    expect(periods[0]?.type).toBe('BUSY');
  });

  it('unfolds a wrapped line before reading it', () => {
    const ics =
      'BEGIN:VCALENDAR\r\nBEGIN:VFREEBUSY\r\nFREEBUSY:20260907T070000Z/2026\r\n 0907T080000Z\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n';
    expect(parseFreeBusy(ics, WORK)).toHaveLength(1);
  });

  it('answers with nothing for a document holding no periods', () => {
    expect(parseFreeBusy('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', WORK)).toEqual(
      []
    );
  });
});

describe('mapping an error to a tool result', () => {
  it('reports each error class in its own words', async () => {
    const cases: [Error, RegExp][] = [
      [new ToolInputError('caldav-mcp: bad argument'), /bad argument/],
      [new ResultTooLargeError('caldav-mcp: too big'), /too big/],
      [new CalendarNotAllowedError('caldav-mcp: fenced off'), /fenced off/],
      [
        new PreconditionFailedError('caldav-mcp: nothing written'),
        /nothing written/,
      ],
      [new Error('something else'), /caldav-mcp: something else/],
    ];
    for (const [error, expected] of cases) {
      const result = await run(async () => {
        throw error;
      });
      expect((result as { isError?: boolean }).isError, error.name).toBe(true);
      expect(textOf(result), error.name).toMatch(expected);
    }
  });

  it('attaches the sanitised body and the hint to an upstream failure', async () => {
    const result = await run(async () => {
      throw new CalDavApiError(
        403,
        '<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><cal:supported-calendar-component/></d:error>',
        'PUT',
        'https://dav.example.net/x.ics',
        'supported-calendar-component'
      );
    });
    const text = textOf(result);
    expect(text).toMatch(/HTTP 403/);
    expect(text).toMatch(/does not accept that kind of entry/);
  });

  it('passes a successful result through untouched', async () => {
    const result = await run(async () => textResult('fine'));
    expect(textOf(result)).toBe('fine');
  });
});

describe('the hints', () => {
  it('answers each status a CalDAV server actually returns', () => {
    for (const [status, expected] of [
      [401, /app-specific password/],
      [403, /permission on the calendar/],
      [404, /gone/],
      [405, /dav\.php/],
      [409, /parent collection/],
      [412, /changed on the server/],
      [415, /content type/],
      [507, /storage quota/],
    ] as const) {
      expect(hintFor(status), String(status)).toMatch(expected);
    }
    expect(hintFor(418)).toBe('');
  });

  it('prefers a precondition over the status code', () => {
    // `<C:supported-calendar-component/>` says exactly what went wrong where
    // "HTTP 403" says nothing.
    expect(hintFor(403, 'need-privileges')).toMatch(
      /read this calendar but not/
    );
    expect(hintFor(403, 'no-uid-conflict')).toMatch(/already uses that UID/);
  });
});

describe('through the tools', () => {
  let fake: FakeCalDav;
  let session: Connected;

  afterEach(async () => {
    await session?.close();
    vi.unstubAllGlobals();
  });

  async function start(
    options: ConstructorParameters<typeof FakeCalDav>[0] = {}
  ) {
    fake = new FakeCalDav(options);
    fake.install();
    session = await connect({}, 'accept');
    return fake;
  }

  async function call(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    return session.client.callTool({ name, arguments: args });
  }

  function seed(name: string, lines: string[], calendar = 'work'): void {
    fake.seed(
      calendar,
      name,
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//t//EN',
        'BEGIN:VEVENT',
        `UID:${name}@example.net`,
        'DTSTAMP:20260901T120000Z',
        ...lines,
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
  }

  it('computes busy periods when the server refuses a free-busy query', async () => {
    await start({ refuseFreeBusy: true });
    seed('a.ics', [
      'DTSTART:20260907T070000Z',
      'DTEND:20260907T080000Z',
      'SUMMARY:Busy',
    ]);
    seed('b.ics', [
      'DTSTART:20260908T070000Z',
      'DTEND:20260908T080000Z',
      'SUMMARY:Free',
      'TRANSP:TRANSPARENT',
    ]);

    const result = (await call('get_free_busy', WINDOW)) as {
      structuredContent?: {
        method?: string;
        busy?: unknown[];
        notes?: string[];
      };
    };
    expect(result.structuredContent?.method).toBe('computed');
    // A transparent entry does not count as busy, as a free-busy answer would
    // also leave it out.
    expect(result.structuredContent?.busy).toHaveLength(1);
    expect(result.structuredContent?.notes?.join(' ')).toMatch(/worked out/);
  });

  it('retries a text-match with an explicit collation and says it did', async () => {
    // Some sabre/dav builds refuse the server default. A search that quietly
    // became case-sensitive is worse than one that says so.
    await start({ refuseCollation: true });
    seed('a.ics', [
      'DTSTART:20260907T070000Z',
      'DTEND:20260907T080000Z',
      'SUMMARY:Standup',
    ]);
    const result = (await call('search_events', {
      ...WINDOW,
      query: 'Standup',
    })) as { structuredContent?: { collation?: string; notes?: string[] } };
    expect(result.structuredContent?.collation).toBe('i;ascii-casemap');
    expect(result.structuredContent?.notes?.join(' ')).toMatch(/collation/);
  });

  it('refuses to move a single occurrence to another calendar', async () => {
    await start();
    seed('s.ics', [
      'DTSTART:20260907T070000Z',
      'DTEND:20260907T080000Z',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:Series',
    ]);
    const listing = (await call('list_events', WINDOW)) as {
      structuredContent?: { events?: { id: string; series_id: string }[] };
    };
    const occurrence = listing.structuredContent?.events?.[1];
    expect(occurrence?.id).not.toBe(occurrence?.series_id);

    const result = await call('move_event', {
      id: occurrence?.id,
      destination_calendar_id: '/tester/private/',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    // One occurrence is part of one stored entry, so it cannot travel alone.
    expect(textOf(result)).toMatch(/part of one stored entry/);
  });

  it('refuses to move an event into the calendar it is already in', async () => {
    await start();
    seed('a.ics', [
      'DTSTART:20260907T070000Z',
      'DTEND:20260907T080000Z',
      'SUMMARY:x',
    ]);
    const listing = (await call('list_events', WINDOW)) as {
      structuredContent?: { events?: { id: string }[] };
    };
    const result = await call('move_event', {
      id: listing.structuredContent?.events?.[0]?.id,
      destination_calendar_id: WORK,
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/already in that calendar/);
  });

  it('refuses to change a whole series that uses RANGE=THISANDFUTURE', async () => {
    // Doing it wrong would move occurrences this server does not understand.
    await start();
    fake.seed(
      'work',
      'range.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//t//EN',
        'BEGIN:VEVENT',
        'UID:range@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART:20260907T070000Z',
        'DTEND:20260907T080000Z',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:Series',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:range@example.net',
        'DTSTAMP:20260901T120000Z',
        'RECURRENCE-ID;RANGE=THISANDFUTURE:20260914T070000Z',
        'DTSTART:20260914T090000Z',
        'DTEND:20260914T100000Z',
        'SUMMARY:Moved',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
    const listing = (await call('list_events', WINDOW)) as {
      structuredContent?: { events?: { id: string }[]; notes?: string[] };
    };
    expect(listing.structuredContent?.notes?.join(' ')).toMatch(
      /THISANDFUTURE/
    );
    const result = await call('update_event', {
      id: listing.structuredContent?.events?.[0]?.id,
      scope: 'entire_series',
      summary: 'nope',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/THISANDFUTURE/);
  });

  it('refuses a recurrence rule it cannot read', async () => {
    await start();
    const result = await call('create_event', {
      calendar_id: WORK,
      summary: 'x',
      start: '2026-09-20T10:00:00',
      recurrence: 'every other tuesday',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/not a recurrence rule/);
  });

  it('refuses an end before the start, and explains the all-day rule', async () => {
    await start();
    const result = await call('create_event', {
      calendar_id: WORK,
      summary: 'x',
      start: '2026-09-20T10:00:00',
      end: '2026-09-20T09:00:00',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/end is exclusive/);
  });

  it('refuses an id from a listing it did not produce', async () => {
    await start();
    const result = await call('get_event', { id: 'not-an-id' });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/not an id this server issued/);
  });

  it('refuses a cursor that belongs to a different window', async () => {
    await start();
    seed('a.ics', [
      'DTSTART:20260907T070000Z',
      'DTEND:20260907T080000Z',
      'SUMMARY:x',
    ]);
    const result = await call('list_events', {
      ...WINDOW,
      after: '2020-01-01T00:00:00Z|nonsense',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/does not match anything in this window/);
  });

  it('pages a long listing and hands back a usable cursor', async () => {
    await start();
    for (let index = 0; index < 5; index += 1) {
      seed(`e${index}.ics`, [
        `DTSTART:2026090${index + 1}T070000Z`,
        `DTEND:2026090${index + 1}T080000Z`,
        `SUMMARY:Event ${index}`,
      ]);
    }
    const first = (await call('list_events', { ...WINDOW, limit: 2 })) as {
      structuredContent?: {
        events?: { summary?: string }[];
        truncated?: { next_cursor?: string; returned?: number };
      };
    };
    expect(first.structuredContent?.events).toHaveLength(2);
    const cursor = first.structuredContent?.truncated?.next_cursor;
    expect(cursor).toBeDefined();

    const next = (await call('list_events', {
      ...WINDOW,
      limit: 2,
      after: cursor,
    })) as { structuredContent?: { events?: { summary?: string }[] } };
    expect(next.structuredContent?.events?.[0]?.summary).toBe('Event 2');
  });

  it('reports a calendar URL as a single calendar', async () => {
    // Pasting a collection URL out of a client's settings is what most people
    // actually do, so it is detected rather than treated as a mistake.
    await start();
    await session.close();
    session = await connect({ url: 'https://dav.example.net/tester/work' });
    const listing = (await call('list_calendars')) as {
      structuredContent?: { calendars?: { id: string }[]; notes?: string[] };
    };
    expect(listing.structuredContent?.calendars).toHaveLength(1);
    expect(listing.structuredContent?.notes?.join(' ')).toMatch(
      /is a calendar collection/
    );
  });

  it('names an allowlist entry that matched nothing', async () => {
    await start();
    await session.close();
    session = await connect({ calendars: ['work', 'wrok'] });
    const listing = (await call('list_calendars')) as {
      structuredContent?: { withheld?: number; notes?: string[] };
    };
    expect(listing.structuredContent?.withheld).toBe(1);
    expect(listing.structuredContent?.notes?.join(' ')).toMatch(/wrok/);
  });
});

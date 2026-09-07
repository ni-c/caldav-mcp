import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalDavApi, CalDavApiError } from '../src/api.js';
import { CalendarRegistry } from '../src/calendars.js';
import { buildOccurrenceId, buildSeriesId } from '../src/entity-id.js';
import { parseCalendar } from '../src/ical.js';
import { expandSeries, kindOf } from '../src/recurrence.js';
import { parseInstant } from '../src/time.js';
import { parseFreeBusy } from '../src/tools/events.js';
import {
  connect,
  dataOf,
  FakeCalDav,
  ORIGIN,
  testConfig,
  textOf,
  type Connected,
  type FakeOptions,
} from './harness.js';

/**
 * The branches a caller or the backend can reach that no other suite
 * reached: every refusal on the write path, every approval outcome but
 * "accept", every field a create or update tool writes, and the small
 * catches in the parsers and the transport.
 */

const CALENDAR = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN'];
const WINDOW = { from: '2026-09-01', to: '2026-09-30' };
const WORK = '/tester/work/';

function event(lines: string[], uid = 'e@example.net'): string {
  return [
    ...CALENDAR,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260901T120000Z',
    'DTSTART:20260907T070000Z',
    'DTEND:20260907T080000Z',
    'SUMMARY:Plain',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function task(lines: string[] = [], uid = 't@example.net'): string {
  return [
    ...CALENDAR,
    'BEGIN:VTODO',
    `UID:${uid}`,
    'DTSTAMP:20260901T120000Z',
    'DUE:20260910T120000Z',
    'SUMMARY:Chore',
    ...lines,
    'END:VTODO',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function journal(uid = 'j@example.net'): string {
  return [
    ...CALENDAR,
    'BEGIN:VJOURNAL',
    `UID:${uid}`,
    'DTSTAMP:20260901T120000Z',
    'DTSTART;VALUE=DATE:20260910',
    'SUMMARY:Diary',
    'DESCRIPTION:Dear diary',
    'END:VJOURNAL',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const WEEKLY = event(
  [
    'RRULE:FREQ=WEEKLY;COUNT=5',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.net',
    'ORGANIZER:mailto:boss@example.net',
  ],
  'weekly@example.net'
);

type Session = Connected & {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  ids(): Promise<{
    event: string;
    occurrence: string;
    task: string;
    journal: string;
  }>;
};

async function open(
  options: FakeOptions = {},
  config: Parameters<typeof connect>[0] = {},
  elicit?: 'accept' | 'decline' | 'cancel'
): Promise<{ fake: FakeCalDav; session: Session }> {
  const fake = new FakeCalDav(options);
  fake.install();
  fake.seed('work', 'weekly.ics', WEEKLY);
  fake.seed('work', 'task.ics', task());
  fake.seed('work', 'journal.ics', journal());
  const base = await connect(
    { userEmail: 'me@example.net', ...config },
    elicit
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    base.client.callTool({ name, arguments: args });
  const session: Session = {
    ...base,
    call,
    ids: async () => {
      const events = dataOf(await call('list_events', WINDOW)).events as {
        id: string;
        recurrence_id?: unknown;
      }[];
      const tasks = dataOf(await call('list_tasks', WINDOW)).tasks as {
        id: string;
      }[];
      const journals = dataOf(await call('list_journals', WINDOW)).journals as {
        id: string;
      }[];
      return {
        event: buildSeriesId('vevent', WORK, 'weekly.ics'),
        occurrence: events.find((e) => e.recurrence_id !== undefined)?.id ?? '',
        task: tasks[0]?.id ?? '',
        journal: journals[0]?.id ?? '',
      };
    },
  };
  return { fake, session };
}

function writes(fake: FakeCalDav): number {
  return fake.requests.filter(
    (r) => r.method === 'PUT' || r.method === 'DELETE'
  ).length;
}

describe('what each approval outcome leaves untouched', () => {
  let fake: FakeCalDav;
  let session: Session;

  afterEach(async () => {
    await session.close();
    vi.unstubAllGlobals();
  });

  const guarded = async () => {
    const ids = await session.ids();
    return [
      ['delete_event', { id: ids.event }],
      ['update_event', { id: ids.event, scope: 'entire_series', summary: 'X' }],
      [
        'move_event',
        { id: ids.event, destination_calendar_id: '/tester/private/' },
      ],
      ['respond_to_event', { id: ids.event, response: 'ACCEPTED' }],
      ['delete_task', { id: ids.task }],
      ['delete_journal', { id: ids.journal }],
    ] as const;
  };

  it.each(['decline', 'cancel'] as const)(
    'a %s changes nothing and says so',
    async (answer) => {
      ({ fake, session } = await open({}, {}, answer));
      for (const [tool, args] of await guarded()) {
        const before = writes(fake);
        const result = (await session.call(tool, args)) as {
          isError?: boolean;
        };
        expect(result.isError, tool).toBe(true);
        expect(textOf(result), tool).toMatch(/declined/);
        expect(writes(fake), tool).toBe(before);
      }
    }
  );

  it('a wrong token is rejected and changes nothing', async () => {
    ({ fake, session } = await open());
    for (const [tool, args] of await guarded()) {
      const before = writes(fake);
      const result = (await session.call(tool, {
        ...args,
        confirm_token: 'not-the-token',
      })) as { isError?: boolean };
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).not.toMatch(/deleted|moved|changed: true/);
      expect(writes(fake), tool).toBe(before);
    }
  });

  it('describes a target it cannot read as exactly that', async () => {
    ({ fake, session } = await open(
      {
        failWith: (method, path) =>
          method === 'GET' && path.endsWith('weekly.ics')
            ? { status: 500, body: 'broken' }
            : undefined,
      },
      {},
      'accept'
    ));
    const ids = await session.ids();
    await session.call('delete_event', { id: ids.event });
    expect(session.prompts[0]).toMatch(/could not read to describe/);
  });
});

describe('what the write path refuses before writing', () => {
  let fake: FakeCalDav;
  let session: Session;

  afterEach(async () => {
    await session.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses every guarded write when the server sends no strong ETag', async () => {
    ({ fake, session } = await open({ etags: 'weak' }, {}, 'accept'));
    const ids = await session.ids();
    for (const [tool, args] of [
      ['delete_event', { id: ids.event }],
      ['delete_event', { id: ids.occurrence, scope: 'this_occurrence' }],
      ['update_event', { id: ids.event, summary: 'X' }],
      [
        'move_event',
        { id: ids.event, destination_calendar_id: '/tester/private/' },
      ],
      ['delete_task', { id: ids.task }],
      ['delete_journal', { id: ids.journal }],
      ['complete_task', { id: ids.task }],
    ] as const) {
      const before = writes(fake);
      const result = (await session.call(tool, args)) as { isError?: boolean };
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toMatch(/strong ETag/);
      expect(writes(fake), tool).toBe(before);
    }
  });

  it('refuses every write when the calendar has gone since the id was minted', async () => {
    // Unreachable by construction — parseEntityId and byPath read the same
    // registry — so the registry is made to forget, and the guard has to
    // hold on its own.
    ({ fake, session } = await open({}, {}, 'accept'));
    const ids = await session.ids();
    vi.spyOn(CalendarRegistry.prototype, 'byPath').mockReturnValue(undefined);
    for (const [tool, args] of [
      ['get_event', { id: ids.event }],
      ['delete_event', { id: ids.event }],
      ['delete_event', { id: ids.occurrence, scope: 'this_occurrence' }],
      ['update_event', { id: ids.event, summary: 'X' }],
      [
        'move_event',
        { id: ids.event, destination_calendar_id: '/tester/private/' },
      ],
      ['delete_task', { id: ids.task }],
      ['delete_journal', { id: ids.journal }],
    ] as const) {
      const before = writes(fake);
      const result = (await session.call(tool, args)) as { isError?: boolean };
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toMatch(/no longer available/);
      expect(writes(fake), tool).toBe(before);
    }
  });

  it('refuses an entry that no longer holds the kind the id names', async () => {
    ({ fake, session } = await open({}, {}, 'accept'));
    fake.seed('work', 'x.ics', task([], 'x@example.net'));
    const asEvent = buildSeriesId('vevent', WORK, 'x.ics');
    expect(textOf(await session.call('get_event', { id: asEvent }))).toMatch(
      /no longer holds anything of the kind/
    );
    expect(
      textOf(await session.call('update_event', { id: asEvent, summary: 'X' }))
    ).toMatch(/no longer holds anything this tool can change/);
    // An occurrence the series does not produce.
    const gone = buildOccurrenceId(
      'vevent',
      WORK,
      'weekly.ics',
      '20301225T070000Z'
    );
    expect(textOf(await session.call('get_event', { id: gone }))).toMatch(
      /occurrence deleted/
    );
    // An override without its master.
    fake.seed(
      'work',
      'orphan.ics',
      event(['RECURRENCE-ID:20260907T070000Z'], 'orphan@example.net')
    );
    const orphan = buildOccurrenceId(
      'vevent',
      WORK,
      'orphan.ics',
      '20260914T070000Z'
    );
    expect(
      textOf(
        await session.call('update_event', {
          id: orphan,
          scope: 'this_occurrence',
          summary: 'X',
        })
      )
    ).toMatch(/not in this entry any more/);
  });

  it('refuses to edit an entry it cannot read whole', async () => {
    ({ fake, session } = await open(
      { contentLength: 9 * 1024 * 1024 },
      {},
      'accept'
    ));
    const result = await session.call('update_event', {
      id: buildSeriesId('vevent', WORK, 'weekly.ics'),
      summary: 'X',
    });
    expect(textOf(result)).toMatch(/inline attachment/);
    expect(writes(fake)).toBe(0);
  });

  it('refuses to answer an invitation with no address to answer as', async () => {
    ({ fake, session } = await open({}, { userEmail: undefined }, 'accept'));
    const result = await session.call('respond_to_event', {
      id: buildSeriesId('vevent', WORK, 'weekly.ics'),
      response: 'ACCEPTED',
    });
    expect(textOf(result)).toMatch(/cannot tell which attendee is you/);
  });

  it('refuses a calendar name that fits two calendars', async () => {
    fake = new FakeCalDav({
      calendars: [{ name: 'a/work' }, { name: 'b/work' }],
    });
    fake.install();
    const base = await connect();
    session = {
      ...base,
      call: (name, args = {}) =>
        base.client.callTool({ name, arguments: args }),
      ids: () => Promise.reject(new Error('unused')),
    };
    const result = await session.call('list_events', {
      ...WINDOW,
      calendars: ['work'],
    });
    expect(textOf(result)).toMatch(/matches 2 calendars/);
  });

  it('tells a fenced-off calendar from one it cannot see', async () => {
    ({ fake, session } = await open({}, { calendars: ['work'] }));
    const fenced = buildSeriesId('vevent', '/tester/private/', 'x.ics');
    const unknown = buildSeriesId('vevent', '/tester/nope/', 'x.ics');
    expect(textOf(await session.call('get_event', { id: fenced }))).toMatch(
      /not given access to/
    );
    expect(textOf(await session.call('get_event', { id: unknown }))).toMatch(
      /cannot see/
    );
  });
});

describe('the fields the write tools write', () => {
  let fake: FakeCalDav;
  let session: Session;

  beforeEach(async () => {
    ({ fake, session } = await open({}, {}, 'accept'));
  });

  afterEach(async () => {
    await session.close();
    vi.unstubAllGlobals();
  });

  const lastPut = (): string =>
    fake.requests.filter((r) => r.method === 'PUT').at(-1)?.body ?? '';

  it('writes a task with a start, a priority and a reminder, then changes them', async () => {
    const created = dataOf(
      await session.call('create_task', {
        calendar_id: WORK,
        summary: 'Plan',
        start: '2026-09-08T09:00:00',
        due: '2026-09-09T09:00:00',
        priority: 2,
        alarms: [{ trigger: '-PT10M' }],
      })
    );
    expect(lastPut()).toMatch(/DTSTART;TZID=Europe\/Berlin:20260908T090000/);
    expect(lastPut()).toMatch(/PRIORITY:2/);
    expect(lastPut()).toMatch(/TRIGGER:-PT10M/);
    const changed = dataOf(
      await session.call('update_task', {
        id: created.id,
        start: '2026-09-08T10:00:00',
        due: '2026-09-10',
        priority: 5,
        percent_complete: 40,
      })
    );
    expect(lastPut()).toMatch(/DTSTART;TZID=Europe\/Berlin:20260908T100000/);
    expect(lastPut()).toMatch(/DUE;VALUE=DATE:20260910/);
    expect(lastPut()).toMatch(/PRIORITY:5/);
    expect(lastPut()).toMatch(/PERCENT-COMPLETE:40/);
    const listed =
      (changed.task as { start?: unknown; priority?: number }) ?? {};
    expect(listed.start).toBeDefined();
    expect(listed.priority).toBe(5);
  });

  it('writes transparency and a moved time on an event', async () => {
    const created = dataOf(
      await session.call('create_event', {
        calendar_id: WORK,
        summary: 'Free',
        start: '2026-09-08T09:00:00Z',
        transparent: true,
      })
    );
    expect(lastPut()).toMatch(/TRANSP:TRANSPARENT/);
    expect(lastPut()).toMatch(/DTSTART:20260908T090000Z/);
    await session.call('update_event', {
      id: created.id,
      transparent: false,
      start: '2026-09-08T11:00:00',
      end: '2026-09-08T12:30:00',
    });
    expect(lastPut()).toMatch(/TRANSP:OPAQUE/);
    expect(lastPut()).toMatch(/DTSTART;TZID=Europe\/Berlin:20260908T110000/);
    expect(lastPut()).toMatch(/DTEND;TZID=Europe\/Berlin:20260908T123000/);
  });

  it('moves a journal entry to another day, and refuses an update that changes nothing', async () => {
    const ids = await session.ids();
    const fenced = dataOf(
      await session.call('get_journal', { id: ids.journal })
    );
    expect((fenced.journal as { summary?: string }).summary).toBe('Diary');
    expect(
      textOf(await session.call('update_journal', { id: ids.journal }))
    ).toMatch(/nothing to change/);
    await session.call('update_journal', {
      id: ids.journal,
      date: '2026-09-12',
    });
    expect(lastPut()).toMatch(/DTSTART;VALUE=DATE:20260912/);
  });

  it('refuses a timestamp that is shaped like one and is not', async () => {
    const result = await session.call('create_event', {
      calendar_id: WORK,
      summary: 'x',
      start: '2026-13-01T10:00:00Z',
    });
    expect(textOf(result)).toMatch(/not a valid timestamp/);
  });

  it('reports a series it could not walk to the end', async () => {
    // Every minute since 2020: millions of iterations before the window,
    // which is what the iteration bound is for.
    fake.seed(
      'work',
      'minutely.ics',
      event(['RRULE:FREQ=MINUTELY'], 'minutely@example.net')
        .replace('DTSTART:20260907T070000Z', 'DTSTART:20200101T070000Z')
        .replace('DTEND:20260907T080000Z', 'DTEND:20200101T071000Z')
    );
    const listing = dataOf(await session.call('list_events', WINDOW));
    expect(
      (listing.truncated as { bounded_series?: string[] }).bounded_series
    ).toEqual(['minutely@example.net']);
  });
});

describe('what get_server_info says about a server that refuses', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the two queries it could not run', async () => {
    const fake = new FakeCalDav({
      refuseCollation: true,
      refuseFreeBusy: true,
    });
    fake.install();
    const session = await connect();
    try {
      const info = dataOf(
        await session.client.callTool({
          name: 'get_server_info',
          arguments: {},
        })
      );
      expect(info.features).toEqual({ text_match: false, free_busy: false });
      expect(info.notes).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/refused a text-match/),
          expect.stringMatching(/refused a free-busy/),
        ])
      );
    } finally {
      await session.close();
    }
  });

  it('skips transparent and cancelled entries when computing free/busy itself', async () => {
    const fake = new FakeCalDav({ refuseFreeBusy: true });
    fake.install();
    fake.seed('work', 'a.ics', event(['TRANSP:TRANSPARENT'], 'a@example.net'));
    fake.seed('work', 'b.ics', event(['STATUS:CANCELLED'], 'b@example.net'));
    fake.seed('work', 'c.ics', event([], 'c@example.net'));
    const session = await connect();
    try {
      const busy = dataOf(
        await session.client.callTool({
          name: 'get_free_busy',
          arguments: WINDOW,
        })
      );
      expect((busy.busy as unknown[]).length).toBe(1);
    } finally {
      await session.close();
    }
  });
});

describe('the small catches', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a document that is not a VCALENDAR', () => {
    expect(() =>
      parseCalendar('BEGIN:VCARD\r\nVERSION:4.0\r\nEND:VCARD\r\n', 'x')
    ).toThrow(/not a VCALENDAR/);
  });

  it('names a component kind, or nothing', () => {
    const root = parseCalendar(event([]), 'x');
    expect(kindOf(root)).toBeUndefined();
    expect(kindOf(root.getFirstSubcomponent('vevent')!)).toBe('vevent');
  });

  it('has an empty origin for a URL it cannot parse, and sends nowhere', async () => {
    const api = new CalDavApi(testConfig({ url: 'not a url' }));
    expect(api.origin).toBe('');
    await expect(api.options('nowhere')).rejects.toThrow(/refused to send/);
  });

  it('reads an error body that does not stream', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 500,
      ok: false,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () =>
        new TextEncoder().encode('x'.repeat(100_000)).buffer,
    }));
    const api = new CalDavApi(testConfig());
    const error = await api.get(`${ORIGIN}/x.ics`).then(
      () => undefined,
      (thrown: unknown) => thrown as CalDavApiError
    );
    expect(error?.body.length).toBe(64 * 1024);
  });

  it('matches nothing for an allowlist URL it cannot parse', () => {
    const registry = new CalendarRegistry(
      [
        {
          url: `${ORIGIN}/tester/work/`,
          path: '/tester/work/',
          displayName: 'Work',
          description: undefined,
          components: [],
          ctag: undefined,
          color: undefined,
          readOnly: false,
        },
      ],
      ['https://['],
      ORIGIN
    );
    expect(registry.allowed()).toHaveLength(0);
  });

  it('leaves a free-busy period with an unreadable DURATION out', () => {
    const periods = parseFreeBusy(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VFREEBUSY',
        'FREEBUSY:20260907T070000Z/PT1H',
        'FREEBUSY:20260908T070000Z/PTXH',
        'FREEBUSY:20260909T070000Z/20260909T080000Z',
        'END:VFREEBUSY',
        'END:VCALENDAR',
      ].join('\r\n'),
      WORK
    );
    expect(periods.map((p) => p.start)).toEqual([
      '2026-09-07T07:00:00Z',
      '2026-09-09T07:00:00Z',
    ]);
  });

  it('refuses a timestamp that parses to nothing', () => {
    expect(() => parseInstant('2026-13-01T10:00:00Z', 'start', 'UTC')).toThrow(
      /not a valid timestamp/
    );
  });

  it('stops walking overrides at an expired deadline', () => {
    const lines = [
      'DTSTART:20260101T070000Z',
      'DTEND:20260101T080000Z',
      'RRULE:FREQ=DAILY',
    ];
    const overrides = Array.from({ length: 600 }, (_, i) => {
      const day = String(1 + (i % 28)).padStart(2, '0');
      const month = String(1 + (Math.floor(i / 28) % 12)).padStart(2, '0');
      return [
        'BEGIN:VEVENT',
        'UID:e@example.net',
        'DTSTAMP:20260101T000000Z',
        `RECURRENCE-ID:2026${month}${day}T070000Z`,
        `DTSTART:2027${month}${day}T070000Z`,
        `DTEND:2027${month}${day}T080000Z`,
        'SUMMARY:Moved',
        'END:VEVENT',
      ].join('\r\n');
    });
    const ics = [
      ...CALENDAR,
      'BEGIN:VEVENT',
      'UID:e@example.net',
      'DTSTAMP:20260101T000000Z',
      ...lines,
      'SUMMARY:Daily',
      'END:VEVENT',
      ...overrides,
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const root = parseCalendar(ics, 'x');
    const result = expandSeries(root.getAllSubcomponents('vevent'), {
      from: new Date('2027-01-01T00:00:00Z'),
      to: new Date('2027-12-31T00:00:00Z'),
      cap: 10_000,
      fallbackZone: 'UTC',
      deadline: Date.now() - 1,
    });
    expect(result.bounded).toBe(true);
  });
});

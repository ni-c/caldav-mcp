import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOccurrenceId, buildSeriesId } from '../src/entity-id.js';
import {
  connect,
  dataOf,
  FakeCalDav,
  FEED_URL,
  ORIGIN,
  textOf,
  type Connected,
  type FakeOptions,
} from './harness.js';

/**
 * Subscribed calendars (#52).
 *
 * Open-Xchange lists a subscription — holidays, a school calendar, another
 * family's calendar — as `CS:subscribed` instead of `C:calendar`, and REPORTs
 * work on it. It is a feed somebody else publishes, so it is listed read-only,
 * never written to or answered from, and read only when named: by the caller in
 * `calendars`, or by an explicit CALDAV_CALENDARS entry.
 */
const WINDOW = { from: '2026-11-01', to: '2026-12-01' };
const FEED = '/tester/holidays/';
const WRITE_METHODS = new Set(['PUT', 'DELETE', 'MOVE', 'COPY', 'POST']);

function event(uid: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261101T000000Z',
    'DTSTART:20261110T100000Z',
    'DTEND:20261110T110000Z',
    `SUMMARY:${uid}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function item(
  kind: 'VEVENT' | 'VTODO' | 'VJOURNAL',
  uid: string,
  dates: string[]
): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    `BEGIN:${kind}`,
    `UID:${uid}`,
    'DTSTAMP:20261101T000000Z',
    ...dates,
    `SUMMARY:${uid}`,
    `END:${kind}`,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const OWN_AND_FEED: FakeOptions = {
  calendars: [
    { name: 'work' },
    { name: 'holidays', subscribed: 'only', displayName: 'Holidays' },
  ],
};

interface Listed {
  id: string;
  read_only: boolean;
  subscribed?: true;
}

describe('a subscribed calendar', () => {
  let fake: FakeCalDav;
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function start(
    options: FakeOptions = OWN_AND_FEED,
    config: Parameters<typeof connect>[0] = {}
  ): Promise<void> {
    fake = new FakeCalDav(options);
    fake.install();
    session = await connect(config, 'accept');
  }

  async function call(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    return session!.client.callTool({ name, arguments: args });
  }

  const feedRequests = (): { method: string; url: string }[] =>
    fake.requests.filter(
      (request) =>
        new URL(request.url).pathname.startsWith(FEED) &&
        request.method !== 'PROPFIND'
    );

  function seedFeed(): void {
    fake.seed('holidays', 'h.ics', event('feed entry'));
    fake.seed(
      'holidays',
      's.ics',
      item('VEVENT', 'feed series', [
        'DTSTART:20261102T090000Z',
        'DTEND:20261102T100000Z',
        'RRULE:FREQ=DAILY;COUNT=5',
      ])
    );
    fake.seed('holidays', 't.ics', item('VTODO', 'feed task', []));
    fake.seed(
      'holidays',
      'j.ics',
      item('VJOURNAL', 'feed note', ['DTSTART:20261110T100000Z'])
    );
  }

  describe('in list_calendars', () => {
    it('is listed read-only and marked, with a note', async () => {
      await start();
      const listing = dataOf(await call('list_calendars'));
      const calendars = listing.calendars as Listed[];
      expect(calendars.map((c) => c.id)).toEqual([
        '/tester/work/',
        '/tester/holidays/',
      ]);
      const feed = calendars.find((c) => c.id === FEED);
      expect(feed).toMatchObject({ read_only: true, subscribed: true });
      expect(calendars[0]).not.toHaveProperty('subscribed');
      expect((listing.notes as string[]).join(' ')).toContain(
        'Calendars marked `subscribed` are feeds somebody else publishes.'
      );
    });

    it('carries no note when there is no subscription', async () => {
      await start({ calendars: [{ name: 'work' }] });
      const listing = dataOf(await call('list_calendars'));
      expect(JSON.stringify(listing.notes ?? [])).not.toContain('subscribed');
    });

    it('is read-only even when the server grants write, and listed once', async () => {
      await start({
        calendars: [{ name: 'work' }, { name: 'holidays', subscribed: 'also' }],
      });
      const calendars = dataOf(await call('list_calendars'))
        .calendars as Listed[];
      expect(calendars.filter((c) => c.id === FEED)).toEqual([
        expect.objectContaining({ read_only: true, subscribed: true }),
      ]);
    });

    it('stays out when it is also an inbox, an outbox, an address book or notifications', async () => {
      await start({
        calendars: [{ name: 'work' }],
        extraCollections: [
          { href: '/tester/inbox/', types: ['subscribed', 'schedule-inbox'] },
          { href: '/tester/outbox/', types: ['subscribed', 'schedule-outbox'] },
          { href: '/tester/contacts/', types: ['subscribed', 'addressbook'] },
          { href: '/tester/notes/', types: ['subscribed', 'notification'] },
        ],
      });
      const calendars = dataOf(await call('list_calendars'))
        .calendars as Listed[];
      expect(calendars.map((c) => c.id)).toEqual(['/tester/work/']);
    });

    it('never pushes the account’s own calendars out at the cap', async () => {
      const feeds = Array.from({ length: 260 }, (_, i) => ({
        name: `a-feed-${String(i).padStart(3, '0')}`,
        subscribed: 'only' as const,
      }));
      await start({ calendars: [...feeds, { name: 'work' }] });
      const listing = dataOf(await call('list_calendars'));
      const ids = (listing.calendars as Listed[]).map((c) => c.id);
      expect(ids).toHaveLength(256);
      expect(ids[0]).toBe('/tester/work/');
      expect((listing.notes as string[]).join(' ')).toContain(
        'its own before subscriptions'
      );
    });

    it('is fenced like any calendar by CALDAV_CALENDARS', async () => {
      await start(OWN_AND_FEED, { calendars: ['work'] });
      const listing = dataOf(await call('list_calendars'));
      expect((listing.calendars as Listed[]).map((c) => c.id)).toEqual([
        '/tester/work/',
      ]);
      expect(listing.withheld).toBe(1);
      const named = (await call('list_events', {
        ...WINDOW,
        calendars: ['holidays'],
      })) as { isError?: boolean };
      expect(named.isError).toBe(true);
      expect(textOf(named)).toContain('not given access');
    });
  });

  describe('when no calendar is named', () => {
    it.each([
      ['list_events', WINDOW],
      ['list_tasks', WINDOW],
      ['list_tasks', { undated: true }],
      ['list_journals', WINDOW],
      ['search_events', { ...WINDOW, query: 'feed' }],
      ['get_free_busy', WINDOW],
    ] as const)('%s never asks it (%o)', async (tool, args) => {
      await start();
      fake.seed('work', 'w.ics', event('own entry'));
      fake.seed('holidays', 'h.ics', event('feed entry'));
      fake.seed('holidays', 't.ics', item('VTODO', 'feed task', []));
      fake.seed(
        'holidays',
        'j.ics',
        item('VJOURNAL', 'feed note', ['DTSTART:20261110T100000Z'])
      );
      const result = (await call(tool, args)) as { isError?: boolean };
      expect(result.isError).not.toBe(true);
      expect(feedRequests()).toEqual([]);
      expect(JSON.stringify(dataOf(result))).not.toContain('feed');
    });

    it('is an error, not an empty answer, when every calendar is a subscription', async () => {
      await start({ calendars: [{ name: 'holidays', subscribed: 'only' }] });
      const result = (await call('list_events', WINDOW)) as {
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'every calendar available is a subscription'
      );
    });

    it('is asked when CALDAV_CALENDARS names it', async () => {
      await start(OWN_AND_FEED, { calendars: ['work', 'holidays'] });
      fake.seed('work', 'w.ics', event('own entry'));
      fake.seed('holidays', 'h.ics', event('feed entry'));
      const listing = dataOf(await call('list_events', WINDOW));
      const summaries = (listing.events as { summary: string }[])
        .map((e) => e.summary)
        .toSorted();
      expect(summaries).toEqual(['feed entry', 'own entry']);
    });
  });

  describe('when it is named', () => {
    it('is read, and its content is marked untrusted', async () => {
      await start();
      fake.seed('holidays', 'h.ics', event('feed entry'));
      const result = await call('list_events', {
        ...WINDOW,
        calendars: ['holidays'],
      });
      const listing = dataOf(result);
      expect((listing.events as { summary: string }[])[0]?.summary).toBe(
        'feed entry'
      );
      expect(textOf(result)).toContain('"untrusted": true');
    });

    it('is read by an id, too', async () => {
      await start();
      fake.seed('holidays', 'h.ics', event('feed entry'));
      const result = dataOf(
        await call('get_event', { id: buildSeriesId('vevent', FEED, 'h.ics') })
      );
      expect((result.event as { summary: string }).summary).toBe('feed entry');
    });
  });

  describe('written to', () => {
    const ID = buildSeriesId('vevent', FEED, 'h.ics');
    const TASK = buildSeriesId('vtodo', FEED, 't.ics');
    const JOURNAL = buildSeriesId('vjournal', FEED, 'j.ics');

    it.each([
      [
        'create_event',
        { calendar_id: FEED, summary: 'x', start: '2026-11-20T10:00:00' },
      ],
      ['update_event', { id: ID, summary: 'changed' }],
      ['delete_event', { id: ID }],
      ['move_event', { id: ID, destination_calendar_id: '/tester/work/' }],
      ['respond_to_event', { id: ID, response: 'ACCEPTED' }],
      [
        'delete_event',
        {
          id: buildOccurrenceId('vevent', FEED, 's.ics', '20261103T090000Z'),
          scope: 'this_occurrence',
        },
      ],
      ['create_task', { calendar_id: FEED, summary: 'x' }],
      ['update_task', { id: TASK, summary: 'changed' }],
      ['complete_task', { id: TASK }],
      ['delete_task', { id: TASK }],
      [
        'create_journal',
        { calendar_id: FEED, summary: 'x', date: '2026-11-20' },
      ],
      ['update_journal', { id: JOURNAL, summary: 'changed' }],
      ['delete_journal', { id: JOURNAL }],
    ] as const)(
      '%s is refused before anything is sent or asked',
      async (tool, args) => {
        await start(OWN_AND_FEED, { userEmail: 'tester@example.net' });
        seedFeed();
        const before = fake.requests.length;
        const result = (await call(tool, args)) as { isError?: boolean };
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('but not write to it');
        expect(
          fake.requests
            .slice(before)
            .filter((request) => WRITE_METHODS.has(request.method))
        ).toEqual([]);
        expect(session!.prompts).toEqual([]);
      }
    );
  });

  it('is refused as the destination of a move, before anything is sent or asked', async () => {
    await start();
    fake.seed('work', 'w.ics', event('own entry'));
    const before = fake.requests.length;
    const result = (await call('move_event', {
      id: buildSeriesId('vevent', '/tester/work/', 'w.ics'),
      destination_calendar_id: FEED,
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(
      fake.requests
        .slice(before)
        .filter((request) => WRITE_METHODS.has(request.method))
    ).toEqual([]);
    expect(session!.prompts).toEqual([]);
  });

  it('is the one calendar, read by default, when CALDAV_URL points at it', async () => {
    // Open-Xchange marks it `subscribed` instead of `calendar`, and the check on
    // a configured collection knew only `calendar`: the URL of one feed opened
    // the whole account.
    await start(OWN_AND_FEED, { url: `${ORIGIN}/tester/holidays` });
    fake.seed('work', 'w.ics', event('own entry'));
    fake.seed('holidays', 'h.ics', event('feed entry'));
    const calendars = dataOf(await call('list_calendars'))
      .calendars as Listed[];
    expect(calendars).toEqual([
      expect.objectContaining({ id: FEED, read_only: true, subscribed: true }),
    ]);
    const listing = dataOf(await call('list_events', WINDOW));
    expect(
      (listing.events as { summary: string }[]).map((e) => e.summary)
    ).toEqual(['feed entry']);
  });

  it('probes one of the account’s own calendars in get_server_info', async () => {
    await start({
      calendars: [{ name: 'a-feed', subscribed: 'only' }, { name: 'work' }],
    });
    const before = fake.requests.length;
    await call('get_server_info');
    const probes = fake.requests
      .slice(before)
      .filter((request) => request.method === 'REPORT');
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(new URL(probe.url).pathname).toBe('/tester/work/');
    }
  });

  it('never makes this server leave the configured origin, whatever the feed address', async () => {
    await start();
    fake.seed('holidays', 'h.ics', event('feed entry'));
    await call('list_calendars');
    await call('list_events', { ...WINDOW, calendars: ['holidays'] });
    await call('get_server_info');
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(new URL(request.url).origin).toBe(ORIGIN);
    }
    expect(JSON.stringify(fake.requests)).not.toContain(FEED_URL);
    const listing = await call('list_calendars');
    expect(textOf(listing)).not.toContain('feeds.example.org');
  });
});

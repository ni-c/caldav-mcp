import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type LiveHarness } from 'mcp-integration-harness';

import {
  bootstrapBaikal,
  getRawBaikal,
  putRawBaikal,
  type BaikalSandbox,
} from './baikal.js';

/**
 * The portability pass: sabre/dav, not Radicale.
 *
 * Deliberately **not** a second copy of the Radicale suite. That one proves
 * coverage — every tool in the catalogue, once, against a real server — and
 * running it twice would double the wall clock to re-prove the same thing.
 * This one asserts the places where two correct CalDAV servers legitimately
 * differ, because those are the places where a server that only ever met one
 * of them is wrong without knowing it.
 *
 * There is no `expectEveryToolExercised` here for that reason, and its absence
 * is the design rather than an omission.
 *
 * Baikal earns the slot because it is sabre/dav, which is what the hosted
 * services people connect to are built on. Every difference below was verified
 * against 0.10.1 rather than assumed.
 */

let sandbox: BaikalSandbox;
let server: LiveHarness;

const WORK = '/dav.php/calendars/integration/work/';

const SERIES = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//integration//EN',
  'BEGIN:VEVENT',
  'UID:sabre-series@example.net',
  'DTSTAMP:20260901T120000Z',
  'DTSTART;TZID=Europe/Berlin:20260907T090000',
  'DTEND;TZID=Europe/Berlin:20260907T100000',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'SUMMARY:Weekly on sabre',
  'LOCATION:Ampersand & Angle <brackets>',
  'ORGANIZER;CN=Alice:mailto:alice@example.net',
  'ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:integration@example.net',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Soon',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const WINDOW = { from: '2026-09-01T00:00:00Z', to: '2026-10-15T00:00:00Z' };

function dataOf(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: Record<string, unknown> })
    .structuredContent;
  expect(
    structured,
    `no structuredContent: ${JSON.stringify(result).slice(0, 400)}`
  ).toBeDefined();
  return structured ?? {};
}

async function call(
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return dataOf(await server.raw(name, args));
}

beforeAll(async () => {
  sandbox = await bootstrapBaikal();
  await putRawBaikal(sandbox, 'work', 'sabre-series.ics', SERIES);
  server = await startServer({ env: sandbox.env, elicit: 'accept' });
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe('discovery against a path-prefixed endpoint', () => {
  it('walks from /dav.php to the calendars underneath it', async () => {
    // Radicale sits at the root of its origin; sabre is routinely mounted under
    // a path, and Baikal's is `/dav.php`. Every href it returns then carries
    // that prefix, so a discovery that assumed the origin root would build
    // URLs one segment short and 404 on everything.
    const info = await call('get_server_info');
    expect(String(info.principal ?? '')).toContain('/dav.php/principals/');

    const calendars = await call('list_calendars');
    const paths = (calendars.calendars as { id: string }[]).map(
      (entry) => entry.id
    );
    expect(paths).toContain(WORK);
    // The third calendar exists and is fenced off, and the count says so
    // rather than the listing quietly being shorter.
    expect(calendars.withheld).toBe(1);
  });

  it('finds the endpoint through /.well-known/caldav as well', async () => {
    // RFC 6764 defines the well-known route *as* a redirect, and Baikal's is a
    // 302 to `/dav.php`. This server never follows a redirect on an
    // authenticated request; the probe is the one place a Location is read,
    // and it is pinned to the configured origin. Pointing CALDAV_URL at the
    // bare origin has to land in the same place as pointing it at /dav.php.
    const viaOrigin = await startServer({
      env: { ...sandbox.env, CALDAV_URL: 'http://127.0.0.1:8088' },
    });
    try {
      const result = await viaOrigin.raw('list_calendars', {});
      const calendars = dataOf(result).calendars as { id: string }[];
      expect(calendars.map((entry) => entry.id)).toContain(WORK);
    } finally {
      await viaOrigin.close();
    }
  }, 120_000);
});

describe('the sabre spellings', () => {
  it('reads lowercase d: and cal: prefixes as the same properties', async () => {
    // Radicale answers with a default namespace for DAV and `C:` for CalDAV;
    // sabre prefixes both, in lowercase. The parser collapses prefixes, and
    // this is the live proof that it does — the unit tests can only assert it
    // against a fixture written by the same hand as the parser.
    const calendars = await call('list_calendars');
    const work = (calendars.calendars as { id: string; name?: string }[]).find(
      (entry) => entry.id === WORK
    );
    expect(work?.name).toBe('work');
  });

  it('expands a series and can address one occurrence of it', async () => {
    const listing = await call('list_events', WINDOW);
    const events = listing.events as {
      id: string;
      summary?: string;
      recurrence_id?: unknown;
    }[];
    const mine = events.filter((event) => event.summary === 'Weekly on sabre');
    expect(mine).toHaveLength(3);

    // Expansion is done here, not by the server, so the ids have to survive a
    // round trip through sabre's href spelling.
    const second = mine[1];
    expect(second?.recurrence_id).toBeDefined();
    const fetched = await call('get_event', { id: second?.id });
    expect((fetched.event as { summary?: string }).summary).toBe(
      'Weekly on sabre'
    );
  });

  it('decodes the XML entities in a value sabre escaped', async () => {
    // The `calendar-data` is a stop node, so it arrives with its entities
    // intact whichever server sent it. `&` and `<` in a LOCATION is the
    // ordinary case that shows whether it was decoded.
    const listing = await call('list_events', WINDOW);
    const event = (listing.events as { location?: string }[]).find(
      (entry) => entry.location !== undefined
    );
    expect(event?.location).toBe('Ampersand & Angle <brackets>');
  });
});

describe('what sabre does differently on a write', () => {
  it('creates, updates and deletes through its ETag semantics', async () => {
    // sabre quotes its ETags and changes them on every write, which is what
    // the read-modify-write path depends on. A server handing back an
    // unchanged ETag would make the second update here fail with a 412.
    const created = await call('create_event', {
      calendar_id: WORK,
      summary: 'Written through sabre',
      start: '2026-09-10T09:00:00',
      end: '2026-09-10T10:00:00',
    });
    const id = String(created.id);

    await call('update_event', { id, summary: 'Renamed through sabre' });
    await call('update_event', { id, location: 'Room 2' });

    const fetched = await call('get_event', { id });
    const event = fetched.event as { summary?: string; location?: string };
    expect(event.summary).toBe('Renamed through sabre');
    expect(event.location).toBe('Room 2');

    await call('delete_event', { id });
    await server.call('get_event', { id }, { expectError: /not found|404/i });
  });

  it('keeps the alarm and the attendee it was never asked about', async () => {
    // The point of read-modify-write, checked against a different server's
    // serialiser: sabre rewrites what it stores, so anything this server had
    // to reconstruct rather than leave alone would show up here.
    const listing = await call('list_events', WINDOW);
    const series = (listing.events as { id: string; summary?: string }[]).find(
      (entry) => entry.summary === 'Weekly on sabre'
    );
    await call('update_event', {
      id: series?.id,
      scope: 'entire_series',
      summary: 'Weekly, renamed',
    });

    const { ics } = await getRawBaikal(sandbox, 'work', 'sabre-series.ics');
    const unfolded = ics.replace(/\r\n[ \t]/g, '');
    expect(unfolded).toContain('RRULE:FREQ=WEEKLY;COUNT=3');
    expect(unfolded).toContain('BEGIN:VALARM');
    expect(unfolded).toMatch(/ATTENDEE[^\r\n]*integration@example\.net/);
    expect(unfolded).toMatch(/ORGANIZER[^\r\n]*alice@example\.net/);
    // The comma comes back escaped, which is RFC 5545 doing its job rather
    // than a defect: a comma separates values in a multi-valued property, so a
    // literal one in a SUMMARY has to be `\\,`. Asserting the raw form here
    // would be asserting a bug.
    expect(unfolded).toContain('SUMMARY:Weekly\\, renamed');
  });
});

describe('searching, where the collations differ', () => {
  it('finds a term, asking again with a collation if it has to', async () => {
    // The bug this exists for: some sabre builds refuse a `text-match` that
    // does not name a collation, with a `supported-collation` precondition,
    // where Radicale accepts the same body. The server retries naming
    // `i;ascii-casemap` and reports which one answered, so the difference is
    // visible rather than being a tool that works on one server and errors on
    // another.
    const found = await call('search_events', {
      query: 'sabre',
      ...WINDOW,
    });
    expect((found.events as unknown[]).length).toBeGreaterThan(0);
    if (found.collation !== undefined) {
      expect(String(found.collation)).toBe('i;ascii-casemap');
    }
  });
});

describe('free/busy, where the answer shape differs', () => {
  it('answers with periods, however this server got them', async () => {
    // Radicale expands a free-busy query itself. sabre answers with FREEBUSY
    // properties carrying `start/end` — or `start/duration`, which is equally
    // legal and which the parser had to learn. Either way the tool answers
    // periods and says which route produced them.
    const busy = await call('get_free_busy', WINDOW);
    expect(['server', 'computed']).toContain(String(busy.method));
    expect(Number(busy.count)).toBeGreaterThan(0);
    for (const period of busy.busy as { start: string; end: string }[]) {
      // The tool carries no untrusted marker, so nothing but timestamps may
      // come out of it.
      expect(period.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(period.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });
});

describe('the allowlist, against a second server', () => {
  it('refuses an id naming the fenced-off calendar', async () => {
    // Same property as on Radicale, and worth re-checking here because the
    // path this server compares against is one sabre chose, prefix and all.
    const forged = Buffer.from(
      '/dav.php/calendars/integration/shared/',
      'utf8'
    ).toString('base64url');
    const name = Buffer.from('anything.ics', 'utf8').toString('base64url');
    await server.call(
      'get_event',
      { id: `e1.${forged}.${name}` },
      { expectError: /not given access|cannot see/ }
    );
  });
});

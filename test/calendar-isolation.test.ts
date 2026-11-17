import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connect,
  dataOf,
  FakeCalDav,
  type Connected,
  type FakeOptions,
} from './harness.js';

/**
 * One calendar that refuses must not take the others with it.
 *
 * A listing asks every calendar in turn. A collection that answers 403 or 404,
 * or more than can be read, used to fail the call for all of them, so a single
 * odd collection on an account made every default listing unusable. Now it is
 * named in a note and the rest are listed — unless every calendar refused,
 * which is an error and not an empty answer that reads like "nothing there".
 */
const THREE = [{ name: 'work' }, { name: 'private' }, { name: 'third' }];
const WINDOW = { from: '2026-11-01', to: '2026-12-01' };

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

function task(uid: string, lines: string[] = []): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    'DTSTAMP:20261101T000000Z',
    `SUMMARY:${uid}`,
    ...lines,
    'END:VTODO',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** A REPORT against one calendar answered with `reply`, everything else as usual. */
function refusing(
  calendar: string,
  reply: { status: number; body?: string; headers?: Record<string, string> }
): NonNullable<FakeOptions['failWith']> {
  return (method, path) =>
    method === 'REPORT' && path.endsWith(`/${calendar}/`) ? reply : undefined;
}

const TOO_LARGE = {
  status: 207,
  body: '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"/>',
  headers: { 'content-length': String(17 * 1024 * 1024) },
};

describe('a calendar that refuses', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function start(options: FakeOptions): Promise<FakeCalDav> {
    const fake = new FakeCalDav({ calendars: THREE, ...options });
    fake.install();
    fake.seed('work', 'w.ics', event('in work'));
    fake.seed('private', 'p.ics', event('in private'));
    fake.seed('third', 't.ics', event('in third'));
    session = await connect();
    return fake;
  }

  async function call(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return session!.client.callTool({ name, arguments: args });
  }

  it('is named, and the others are listed', async () => {
    await start({ failWith: refusing('third', { status: 403 }) });
    const listing = dataOf(await call('list_events', WINDOW));
    const summaries = (listing.events as { summary: string }[]).map(
      (e) => e.summary
    );
    expect(summaries.toSorted()).toEqual(['in private', 'in work']);
    const notes = (listing.notes as string[]).join(' ');
    expect(notes).toContain('third');
    expect(notes).toContain('HTTP 403');
    expect(notes).toContain('2 of 3 calendars answered.');
  });

  it('is named with the size advice when its answer was too large', async () => {
    await start({ failWith: refusing('third', TOO_LARGE) });
    const listing = dataOf(await call('list_events', WINDOW));
    expect((listing.events as unknown[]).length).toBe(2);
    expect((listing.notes as string[]).join(' ')).toContain(
      'A shorter time range would make it smaller.'
    );
  });

  it('names at most twenty refusing calendars and counts the rest', async () => {
    const calendars = Array.from({ length: 30 }, (_, i) => ({
      name: `c${String(i).padStart(2, '0')}`,
    }));
    const fake = new FakeCalDav({
      calendars,
      failWith: (method, path) =>
        method === 'REPORT' && !path.endsWith('/c00/')
          ? { status: 403 }
          : undefined,
    });
    fake.install();
    fake.seed('c00', 'a.ics', event('answered'));
    session = await connect();
    const listing = dataOf(await call('list_events', WINDOW));
    const notes = listing.notes as string[];
    expect(notes.filter((note) => note.includes('HTTP 403'))).toHaveLength(20);
    expect(notes).toContain(
      '9 more calendars refused the request or answered with too much, so ' +
        'their entries are not listed either.'
    );
    expect(notes).toContain('1 of 30 calendars answered.');
    expect(notes).toHaveLength(22);
  });

  it('makes the call an error when every calendar refused', async () => {
    await start({
      failWith: (method) => (method === 'REPORT' ? { status: 403 } : undefined),
    });
    const result = (await call('list_events', WINDOW)) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('is not isolated when the account was refused (401)', async () => {
    await start({ failWith: refusing('third', { status: 401 }) });
    const result = (await call('list_events', WINDOW)) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('is isolated in a search too', async () => {
    await start({ failWith: refusing('third', { status: 404 }) });
    const listing = dataOf(
      await call('search_events', { query: 'in', ...WINDOW })
    );
    expect((listing.events as unknown[]).length).toBe(2);
    expect((listing.notes as string[]).join(' ')).toContain('HTTP 404');
  });

  it('is isolated in free/busy when the fallback listing is refused too', async () => {
    await start({
      refuseFreeBusy: true,
      failWith: (method, path) =>
        method === 'REPORT' && path.endsWith('/third/')
          ? { status: 403 }
          : undefined,
    });
    const answer = dataOf(await call('get_free_busy', WINDOW));
    expect(JSON.stringify(answer.notes)).toContain(
      '2 of 3 calendars answered.'
    );
  });
});

describe('the undated listing asks for undated tasks only', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function start(options: FakeOptions = {}): Promise<FakeCalDav> {
    const fake = new FakeCalDav({ calendars: THREE, ...options });
    fake.install();
    fake.seed('work', 'undated.ics', task('undated'));
    fake.seed('work', 'dated.ics', task('dated', ['DUE:20261110T100000Z']));
    fake.seed('private', 'p.ics', task('private undated'));
    session = await connect();
    return fake;
  }

  async function undated(): Promise<Record<string, unknown>> {
    return dataOf(
      await session!.client.callTool({
        name: 'list_tasks',
        arguments: { undated: true },
      })
    );
  }

  it('sends both is-not-defined filters', async () => {
    const fake = await start();
    const before = fake.requests.length;
    await undated();
    const reports = fake.requests
      .slice(before)
      .filter((request) => request.method === 'REPORT');
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report.body).toContain(
        '<C:prop-filter name="DTSTART"><C:is-not-defined/></C:prop-filter>'
      );
      expect(report.body).toContain(
        '<C:prop-filter name="DUE"><C:is-not-defined/></C:prop-filter>'
      );
    }
  });

  it('asks again without the filter when the server refuses it, and says so', async () => {
    await start({ refuseIsNotDefined: true });
    const listing = await undated();
    const summaries = (listing.tasks as { summary: string }[]).map(
      (t) => t.summary
    );
    expect(summaries.toSorted()).toEqual(['private undated', 'undated']);
    expect(JSON.stringify(listing.notes)).toContain(
      'refused the filter for tasks without a date in 3 calendars'
    );
  });

  it('names a calendar whose answer was too large, without advising a time range', async () => {
    await start({ failWith: refusing('work', TOO_LARGE) });
    const listing = await undated();
    const summaries = (listing.tasks as { summary: string }[]).map(
      (t) => t.summary
    );
    expect(summaries).toEqual(['private undated']);
    const text = JSON.stringify(listing);
    expect(text).toContain('work');
    expect(text).not.toMatch(/time range/i);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * A server answers a windowed query with tasks that have no date (RFC 4791 9.9
 * matches them through CREATED or COMPLETED, or always). No window can place
 * them, so they are not listed — but the listing now says how many it was
 * given, so a model that only ever asks for the next thirty days learns that
 * `undated` exists. It claims what the server returned, never a total.
 */
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

const WINDOW = { from: '2026-11-01', to: '2026-12-01' };
const HINT = /without a start or due date/;

describe('the note about tasks without a date', () => {
  let fake: FakeCalDav;
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function start(seed: [string, string][]): Promise<void> {
    fake = new FakeCalDav();
    fake.install();
    for (const [name, ics] of seed) fake.seed('work', name, ics);
    session = await connect();
  }

  async function call(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return dataOf(await session!.client.callTool({ name, arguments: args }));
  }

  it('counts the open ones the server returned, and comes first', async () => {
    await start([
      ['a.ics', task('a')],
      ['b.ics', task('b')],
      ['done.ics', task('done', ['STATUS:COMPLETED'])],
      ['dated.ics', task('dated', ['DUE:20261110T120000Z'])],
    ]);
    const listing = await call('list_tasks', WINDOW);
    expect((listing.notes as string[])[0]).toBe(
      'The server also returned 2 open tasks without a start or due date. ' +
        'No time range can place them, so they are not in `tasks`; call ' +
        'list_tasks with `undated: true` to list them.'
    );
    expect(
      (listing.tasks as { summary: string }[]).map((t) => t.summary)
    ).toEqual(['dated']);
  });

  it('uses the singular for one', async () => {
    await start([['a.ics', task('a')]]);
    const listing = await call('list_tasks', WINDOW);
    expect((listing.notes as string[])[0]).toContain('returned 1 open task ');
  });

  it('counts completed ones too when they were asked for, and names both flags', async () => {
    await start([
      ['a.ics', task('a')],
      ['done.ics', task('done', ['STATUS:COMPLETED'])],
    ]);
    const listing = await call('list_tasks', {
      ...WINDOW,
      include_completed: true,
    });
    const note = (listing.notes as string[])[0] ?? '';
    expect(note).toContain('returned 2 tasks without');
    expect(note).toContain('`undated: true` and `include_completed: true`');
  });

  it('is absent when the server returned none, and in the undated mode', async () => {
    await start([['dated.ics', task('dated', ['DUE:20261110T120000Z'])]]);
    expect(
      JSON.stringify((await call('list_tasks', WINDOW)).notes ?? [])
    ).not.toMatch(HINT);
    fake.seed('work', 'a.ics', task('a'));
    expect(
      JSON.stringify((await call('list_tasks', { undated: true })).notes ?? [])
    ).not.toMatch(HINT);
  });

  it('costs no extra request', async () => {
    await start([['a.ics', task('a')]]);
    const before = fake.requests.length;
    await call('list_tasks', WINDOW);
    const reports = fake.requests
      .slice(before)
      .filter((request) => request.method === 'REPORT');
    // The default fake has two calendars: one REPORT each, nothing more.
    expect(reports).toHaveLength(2);
  });

  it('never appears on events or journals', async () => {
    await start([['a.ics', task('a')]]);
    for (const tool of ['list_events', 'list_journals']) {
      expect(
        JSON.stringify((await call(tool, WINDOW)).notes ?? [])
      ).not.toMatch(HINT);
    }
  });
});

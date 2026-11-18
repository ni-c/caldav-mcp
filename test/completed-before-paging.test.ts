import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * The windowed `list_tasks` left completed tasks out *after* the page was cut,
 * so done tasks took page slots and an answer could hold fewer tasks than its
 * `limit` while saying there were more. Both modes now leave them out before
 * the page is cut, judged by one predicate.
 */
function task(uid: string, day: number, status?: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    'DTSTAMP:20261101T000000Z',
    `SUMMARY:${uid}`,
    `DUE:202611${String(day).padStart(2, '0')}T120000Z`,
    ...(status === undefined ? [] : [`STATUS:${status}`]),
    'END:VTODO',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const WINDOW = { from: '2026-11-01', to: '2026-12-01' };

const summaries = (listing: Record<string, unknown>): string[] =>
  (listing.tasks as { summary: string }[]).map((t) => t.summary);

describe('completed tasks in a windowed listing', () => {
  let fake: FakeCalDav;
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function start(
    tasks: [string, number, string | undefined][]
  ): Promise<void> {
    fake = new FakeCalDav();
    fake.install();
    for (const [uid, day, status] of tasks) {
      fake.seed('work', `${uid}.ics`, task(uid, day, status));
    }
    session = await connect();
  }

  async function page(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return dataOf(
      await session!.client.callTool({
        name: 'list_tasks',
        arguments: { ...WINDOW, ...args },
      })
    );
  }

  it('do not take the slots of a page', async () => {
    await start([
      ['done1', 2, 'COMPLETED'],
      ['done2', 3, 'COMPLETED'],
      ['open1', 4, undefined],
      ['open2', 5, undefined],
    ]);
    const listing = await page({ limit: 2 });
    expect(summaries(listing)).toEqual(['open1', 'open2']);
    expect(listing.count).toBe(2);
    expect(listing).not.toHaveProperty('truncated');
  });

  it('page across the boundary without losing an open task', async () => {
    await start([
      ['a', 2, undefined],
      ['b', 3, 'COMPLETED'],
      ['c', 4, undefined],
      ['d', 5, 'COMPLETED'],
      ['e', 6, undefined],
    ]);
    const first = await page({ limit: 2 });
    expect(summaries(first)).toEqual(['a', 'c']);
    const cursor = (first.truncated as { next_cursor: string }).next_cursor;
    const second = await page({ limit: 2, after: cursor });
    expect(summaries(second)).toEqual(['e']);
    expect(second).not.toHaveProperty('truncated');
  });

  it('leave an empty answer when every task is done', async () => {
    await start([
      ['done1', 2, 'COMPLETED'],
      ['done2', 3, 'completed'],
    ]);
    const listing = await page({});
    expect(listing.count).toBe(0);
    expect(listing).not.toHaveProperty('truncated');
  });

  it('are listed when asked for', async () => {
    await start([
      ['done', 2, 'COMPLETED'],
      ['open', 3, undefined],
    ]);
    const listing = await page({ include_completed: true });
    expect(summaries(listing)).toEqual(['done', 'open']);
  });
});

describe('one predicate for both modes', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it('treats a STATUS in fullwidth letters as done before paging, in both modes', async () => {
    // NFKC folds "ＣＯＭＰＬＥＴＥＤ" into "COMPLETED" for the reported status. The
    // undated listing compared the raw value before paging, so the done task
    // took the only slot of a one-task page and was dropped after it: an empty
    // page that claimed one more task.
    const fake = new FakeCalDav();
    fake.install();
    const fullwidth = 'ＣＯＭＰＬＥＴＥＤ';
    fake.seed('work', 'a-dated.ics', task('a-dated-done', 2, fullwidth));
    fake.seed('work', 'b-dated.ics', task('b-dated-open', 3, undefined));
    const undated = (uid: string, status?: string): string =>
      task(uid, 2, status).replace(/^DUE:.*\r\n/m, '');
    fake.seed('work', 'a-undated.ics', undated('a-undated-done', fullwidth));
    fake.seed('work', 'b-undated.ics', undated('b-undated-open'));
    session = await connect();
    for (const [args, open] of [
      [WINDOW, 'b-dated-open'],
      [{ undated: true }, 'b-undated-open'],
    ] as const) {
      const listing = dataOf(
        await session.client.callTool({
          name: 'list_tasks',
          arguments: { ...args, limit: 1 },
        })
      );
      const names = (listing.tasks as { summary: string }[]).map(
        (t) => t.summary
      );
      expect(names, JSON.stringify(args)).toEqual([open]);
      expect(listing, JSON.stringify(args)).not.toHaveProperty('truncated');
    }
  });
});

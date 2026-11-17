import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connect,
  dataOf,
  FakeCalDav,
  textOf,
  type Connected,
} from './harness.js';

/**
 * `list_tasks` with `undated`.
 *
 * A `time-range` filter is matched against DTSTART and DUE, so a task that has
 * neither is in no window and no windowed listing can return it. These tests
 * pin the other half: that such a task can be listed, read back and completed,
 * and that asking for it does not change what a windowed listing returns.
 */

const WINDOW = { from: '2026-09-01', to: '2026-09-30' };

/** One VTODO, as a stored resource. `dates` are the date lines, possibly none. */
function task(
  uid: string,
  summary: string,
  dates: string[] = [],
  extra: string[] = []
): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    'DTSTAMP:20260901T120000Z',
    `SUMMARY:${summary}`,
    ...dates,
    ...extra,
    'END:VTODO',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** The summaries of a listing, sorted so the order of the listing is not tested. */
function summaries(listing: Record<string, unknown>): string[] {
  return (listing.tasks as { summary?: string }[])
    .map((entry) => entry.summary ?? '')
    .toSorted();
}

describe('list_tasks with undated', () => {
  let fake: FakeCalDav;
  let session: Connected;

  beforeEach(async () => {
    fake = new FakeCalDav();
    fake.install();
    session = await connect({}, 'accept');
  });

  afterEach(async () => {
    await session.close();
    vi.unstubAllGlobals();
  });

  async function call(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    return session.client.callTool({ name, arguments: args });
  }

  function seedMixed(): void {
    fake.seed(
      'work',
      'due.ics',
      task('due@example.net', 'Has a due date', ['DUE:20260910T120000Z'])
    );
    fake.seed(
      'work',
      'start.ics',
      task('start@example.net', 'Has only a start', [
        'DTSTART:20260911T090000Z',
      ])
    );
    fake.seed('work', 'none-a.ics', task('a@example.net', 'No date A'));
    fake.seed('work', 'none-b.ics', task('b@example.net', 'No date B'));
    fake.seed(
      'work',
      'done.ics',
      task(
        'c@example.net',
        'No date but done',
        [],
        ['STATUS:COMPLETED', 'PERCENT-COMPLETE:100']
      )
    );
  }

  it('lists the tasks that have neither a start nor a due date', async () => {
    seedMixed();
    const listing = dataOf(await call('list_tasks', { undated: true }));
    // The completed one stays out by default, as in a windowed listing, and a
    // task with only a start or only a due date is dated.
    expect(summaries(listing)).toEqual(['No date A', 'No date B']);
    expect(listing.count).toBe(2);
    for (const entry of listing.tasks as Record<string, unknown>[]) {
      expect(entry).not.toHaveProperty('start');
      expect(entry).not.toHaveProperty('due');
    }
  });

  it('honours include_completed', async () => {
    seedMixed();
    const listing = dataOf(
      await call('list_tasks', { undated: true, include_completed: true })
    );
    expect(summaries(listing)).toEqual([
      'No date A',
      'No date B',
      'No date but done',
    ]);
  });

  it('filters completed tasks before paging', async () => {
    fake.seed('work', 'a.ics', task('done', 'Done', [], ['STATUS:COMPLETED']));
    fake.seed('work', 'b.ics', task('open', 'Open'));
    const listing = dataOf(
      await call('list_tasks', { undated: true, limit: 1 })
    );
    expect(summaries(listing)).toEqual(['Open']);
    expect(listing).not.toHaveProperty('truncated');
  });

  it('reports no window, because there is none', async () => {
    seedMixed();
    const listing = dataOf(await call('list_tasks', { undated: true }));
    expect(listing).not.toHaveProperty('window');
  });

  it('does not change what a windowed listing returns', async () => {
    seedMixed();
    // The fake answers a REPORT with every resource of the component whatever
    // the time-range says, which is the worst case for this: a server that
    // returns the undated tasks anyway must still not have them listed as
    // though they were inside the window.
    const listing = dataOf(await call('list_tasks', WINDOW));
    expect(summaries(listing)).toEqual(['Has a due date', 'Has only a start']);
  });

  it('asks the server without a time range', async () => {
    seedMixed();
    const before = fake.requests.length;
    await call('list_tasks', { undated: true });
    const reports = fake.requests
      .slice(before)
      .filter((request) => request.method === 'REPORT');
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report.body).toContain('<C:comp-filter name="VTODO"');
      expect(report.body).not.toContain('time-range');
    }

    const windowedFrom = fake.requests.length;
    await call('list_tasks', WINDOW);
    const windowed = fake.requests
      .slice(windowedFrom)
      .filter((request) => request.method === 'REPORT');
    expect(
      windowed.every((request) => request.body?.includes('time-range'))
    ).toBe(true);
  });

  it('reads an undated task back by the id the listing gave', async () => {
    fake.seed(
      'work',
      'none.ics',
      task('n@example.net', 'No date', [], ['DESCRIPTION:Look at this later.'])
    );
    const listing = dataOf(await call('list_tasks', { undated: true }));
    const id = (listing.tasks as { id: string }[])[0]?.id;
    expect(id).toBeDefined();
    const single = dataOf(await call('get_task', { id }));
    const read = single.task as { summary?: string; description?: string };
    expect(read.summary).toBe('No date');
    expect(read.description).toBe('Look at this later.');
  });

  it('can complete an undated task by its id', async () => {
    fake.seed('work', 'none.ics', task('n@example.net', 'No date'));
    const listing = dataOf(await call('list_tasks', { undated: true }));
    const id = (listing.tasks as { id: string }[])[0]?.id;
    const done = dataOf(await call('complete_task', { id }));
    expect(done.status).toBe('COMPLETED');
    // Done now, so it drops out of the default listing and shows with the flag.
    expect(dataOf(await call('list_tasks', { undated: true })).count).toBe(0);
    expect(
      dataOf(
        await call('list_tasks', { undated: true, include_completed: true })
      ).count
    ).toBe(1);
  });

  it('pages with a cursor and loses nothing at the boundary', async () => {
    for (const letter of ['a', 'b', 'c']) {
      fake.seed(
        'work',
        `${letter}.ics`,
        task(`${letter}@example.net`, `No date ${letter}`)
      );
    }
    const first = dataOf(await call('list_tasks', { undated: true, limit: 2 }));
    expect(first.count).toBe(2);
    const truncated = first.truncated as {
      next_cursor?: string;
      reason: string;
    };
    expect(truncated.next_cursor).toBeDefined();
    expect(truncated.reason).toContain('1 more task with no date');

    const second = dataOf(
      await call('list_tasks', {
        undated: true,
        limit: 2,
        after: truncated.next_cursor,
      })
    );
    expect(second.count).toBe(1);
    expect(second).not.toHaveProperty('truncated');
    expect([...summaries(first), ...summaries(second)].toSorted()).toEqual([
      'No date a',
      'No date b',
      'No date c',
    ]);
  });

  it('refuses a time range instead of ignoring it', async () => {
    seedMixed();
    for (const extra of [
      { from: '2026-09-01' },
      { to: '2026-09-30' },
      { timezone: 'Europe/Berlin' },
    ]) {
      const result = (await call('list_tasks', {
        undated: true,
        ...extra,
      })) as { isError?: boolean };
      expect(result.isError, JSON.stringify(extra)).toBe(true);
      expect(textOf(result)).toContain('`undated`');
    }
  });

  it('leaves out an entry it cannot read and says so', async () => {
    fake.seed('work', 'good.ics', task('g@example.net', 'No date good'));
    // Contains BEGIN:VTODO so the fake returns it, and never closes it.
    fake.seed(
      'work',
      'bad.ics',
      'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\nSUMMARY:cut off'
    );
    const listing = dataOf(await call('list_tasks', { undated: true }));
    expect(summaries(listing)).toEqual(['No date good']);
    expect(JSON.stringify(listing.notes)).toContain('bad.ics');
  });

  it('lists a task whose recurrence rule has no anchor, and says the rule is ignored', async () => {
    // RRULE without DTSTART or DUE generates nothing, so the task used to be
    // in neither mode and nothing said so.
    fake.seed(
      'work',
      'rule.ics',
      task('rule@example.net', 'Rule without a start', ['RRULE:FREQ=DAILY'])
    );
    const listing = dataOf(await call('list_tasks', { undated: true }));
    expect(summaries(listing)).toEqual(['Rule without a start']);
    expect(JSON.stringify(listing.notes)).toContain('recurrence rule');
    const id = (listing.tasks as { id: string }[])[0]?.id;
    const single = dataOf(await call('get_task', { id }));
    expect((single.task as { summary?: string }).summary).toBe(
      'Rule without a start'
    );
  });

  it('reports a date it cannot read instead of passing the task over', async () => {
    fake.seed(
      'work',
      'garbage.ics',
      task('g@example.net', 'Garbage due', ['DUE:garbage'])
    );
    fake.seed(
      'work',
      'empty.ics',
      task('e@example.net', 'Empty due', ['DUE;VALUE=DATE:'])
    );
    const listing = dataOf(await call('list_tasks', { undated: true }));
    expect(listing.count).toBe(0);
    const notes = JSON.stringify(listing.notes);
    expect(notes).toContain('garbage.ics');
    expect(notes).toContain('empty.ics');
  });
});

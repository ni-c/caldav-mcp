import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSeriesId } from '../src/entity-id.js';
import {
  connect,
  dataOf,
  FakeCalDav,
  textOf,
  type Connected,
  type FakeOptions,
} from './harness.js';

/** The edges of `list_tasks { undated: true }` the first tests did not reach. */
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

const summaries = (listing: Record<string, unknown>): string[] =>
  (listing.tasks as { summary: string }[]).map((t) => t.summary);

describe('the undated listing at its edges', () => {
  let fake: FakeCalDav;
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function start(options: FakeOptions = {}): Promise<void> {
    fake = new FakeCalDav(options);
    fake.install();
    session = await connect({}, 'accept');
  }

  async function call(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return session!.client.callTool({ name, arguments: args });
  }

  async function undated(
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    return dataOf(await call('list_tasks', { undated: true, ...args }));
  }

  it('answers an empty calendar with nothing, and no truncation', async () => {
    await start();
    const listing = await undated();
    expect(listing.count).toBe(0);
    expect(listing).not.toHaveProperty('truncated');
  });

  it('answers a calendar of completed tasks with nothing by default', async () => {
    await start();
    fake.seed('work', 'a.ics', task('a', ['STATUS:COMPLETED']));
    fake.seed('work', 'b.ics', task('b', ['STATUS:COMPLETED']));
    expect((await undated()).count).toBe(0);
    expect((await undated({ include_completed: true })).count).toBe(2);
  });

  it('refuses a cursor that matches nothing, with the reason', async () => {
    await start();
    fake.seed('work', 'a.ics', task('a'));
    const result = (await call('list_tasks', {
      undated: true,
      after: 'not-a-cursor',
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not match anything in this listing');
  });

  it('refuses a cursor from the other mode, in both directions', async () => {
    await start();
    fake.seed('work', 'd1.ics', task('d1', ['DUE:20261110T120000Z']));
    fake.seed('work', 'd2.ics', task('d2', ['DUE:20261111T120000Z']));
    fake.seed('work', 'u1.ics', task('u1'));
    fake.seed('work', 'u2.ics', task('u2'));
    const window = { from: '2026-11-01', to: '2026-12-01' };
    const windowed = dataOf(await call('list_tasks', { ...window, limit: 1 }));
    const windowCursor = (windowed.truncated as { next_cursor: string })
      .next_cursor;
    const intoUndated = (await call('list_tasks', {
      undated: true,
      after: windowCursor,
    })) as { isError?: boolean };
    expect(intoUndated.isError).toBe(true);
    const listed = await undated({ limit: 1 });
    const undatedCursor = (listed.truncated as { next_cursor: string })
      .next_cursor;
    const intoWindow = (await call('list_tasks', {
      ...window,
      after: undatedCursor,
    })) as { isError?: boolean };
    expect(intoWindow.isError).toBe(true);
  });

  it('orders two calendars by path and pages across their boundary', async () => {
    await start();
    fake.seed('work', 'w1.ics', task('work 1'));
    fake.seed('work', 'w2.ics', task('work 2'));
    fake.seed('private', 'p1.ics', task('private 1'));
    fake.seed('private', 'p2.ics', task('private 2'));
    const first = await undated({ limit: 3 });
    expect(summaries(first)).toEqual(['private 1', 'private 2', 'work 1']);
    const cursor = (first.truncated as { next_cursor: string }).next_cursor;
    expect(summaries(await undated({ limit: 3, after: cursor }))).toEqual([
      'work 2',
    ]);
  });

  it('does not ask a calendar that takes no tasks', async () => {
    await start({
      calendars: [{ name: 'work' }, { name: 'events', components: ['VEVENT'] }],
    });
    fake.seed('work', 'w.ics', task('in work'));
    fake.seed('events', 'e.ics', task('in an events-only calendar'));
    expect(summaries(await undated())).toEqual(['in work']);
  });

  it('stops when the call budget runs out and says after how many calendars', async () => {
    await start();
    fake.seed('work', 'w.ics', task('in work'));
    fake.seed('private', 'p.ics', task('in private'));
    await call('list_calendars', {});
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 20_000));
    const truncated = (await undated()).truncated as {
      reason: string;
      follow_up: string;
    };
    expect(truncated.reason).toContain('Stopped after 1 of 2 calendars');
    expect(truncated.follow_up).toBe('Name fewer calendars in `calendars`.');
  });

  it('stops at the ceiling of collected tasks and names the way out', async () => {
    await start();
    for (let i = 0; i < 5000; i += 1) {
      fake.seed('private', `p${i}.ics`, task(`p${i}`));
    }
    fake.seed('work', 'w.ics', task('in work'));
    const truncated = (await undated({ limit: 2 })).truncated as {
      reason: string;
    };
    expect(truncated.reason).toContain('5000 occurrences had been collected');
  });

  it('lets update_task change an undated task and read it back', async () => {
    // On main this wrote the change and then answered "that entry has no
    // readable content", because the re-read expanded a task with no date.
    await start();
    fake.seed('work', 'u.ics', task('before'));
    const result = dataOf(
      await call('update_task', {
        id: buildSeriesId('vtodo', '/tester/work/', 'u.ics'),
        summary: 'after',
      })
    );
    expect((result.task as { summary: string }).summary).toBe('after');
    expect(fake.stored('work', 'u.ics')).toContain('SUMMARY:after');
  });
});

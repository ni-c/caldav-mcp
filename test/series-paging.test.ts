import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * Each series used to be expanded to at most `limit` occurrences. The next
 * page expands the series again from the start of the window, so a daily event
 * in a thirty-day window with `limit: 10` showed its first ten occurrences and
 * never the other twenty — with no note, which reads exactly like "no further
 * appointments".
 */
function series(uid: string, rule: string, start: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T000000Z',
    `DTSTART:${start}`,
    `RRULE:${rule}`,
    `SUMMARY:${uid}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const WINDOW = { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' };

describe('a recurring series across pages', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function pages(limit: number): Promise<Record<string, unknown>[]> {
    const answers: Record<string, unknown>[] = [];
    let after: string | undefined;
    for (let round = 0; round < 20; round += 1) {
      const page = dataOf(
        await session!.client.callTool({
          name: 'list_events',
          arguments: { ...WINDOW, limit, ...(after ? { after } : {}) },
        })
      );
      answers.push(page);
      after = (page.truncated as { next_cursor?: string } | undefined)
        ?.next_cursor;
      if (after === undefined) break;
    }
    return answers;
  }

  it('yields every occurrence exactly once, ten at a time', async () => {
    const fake = new FakeCalDav();
    fake.install();
    fake.seed(
      'work',
      'daily.ics',
      series('daily', 'FREQ=DAILY;COUNT=30', '20261101T090000Z')
    );
    session = await connect();
    const answers = await pages(10);
    const starts = answers.flatMap((page) =>
      (page.events as { start: { value: string } }[]).map((e) => e.start.value)
    );
    expect(starts).toHaveLength(30);
    expect(new Set(starts).size).toBe(30);
    for (const page of answers) {
      expect((page.events as unknown[]).length).toBeLessThanOrEqual(10);
      expect(page.truncated ?? {}).not.toHaveProperty('bounded_series');
    }
  });

  it('says from when on nothing is listed when one series fills the ceiling', async () => {
    const fake = new FakeCalDav();
    fake.install();
    fake.seed(
      'work',
      'minutely.ics',
      series('minutely', 'FREQ=MINUTELY', '20261101T000000Z')
    );
    session = await connect();
    const page = dataOf(
      await session.client.callTool({
        name: 'list_events',
        arguments: { ...WINDOW, limit: 5 },
      })
    );
    const truncated = page.truncated as {
      reason: string;
      follow_up: string;
      bounded_series?: string[];
    };
    // 5000 minutes from midnight: the 5000th starts at 11:19 on the fourth,
    // and is left out so that "nothing from" holds exactly.
    expect(truncated.reason).toContain(
      'nothing from 2026-11-04T11:19:00Z on is listed.'
    );
    expect(truncated.reason).toContain('4994 more entries in this window.');
    expect(truncated.follow_up).toBe(
      'Call again with `after` set to next_cursor.'
    );
    expect(truncated).not.toHaveProperty('bounded_series');
  });

  it('tells the last page where the rest of the window starts', async () => {
    const fake = new FakeCalDav();
    fake.install();
    fake.seed(
      'work',
      'minutely.ics',
      series('minutely', 'FREQ=MINUTELY', '20261101T000000Z')
    );
    session = await connect();
    const answers = await pages(500);
    const last = answers.at(-1)!;
    const truncated = last.truncated as {
      follow_up: string;
      next_cursor?: string;
    };
    expect(truncated.next_cursor).toBeUndefined();
    expect(truncated.follow_up).toBe(
      'Call again with `from` set to 2026-11-04T11:19:00Z for the rest of the window.'
    );
    const listed = answers.flatMap((page) => page.events as unknown[]);
    expect(listed).toHaveLength(4999);
  });

  it('still collects an entry that comes after a flooding series', async () => {
    // The ceiling used to fill in the order the server sent the entries, so
    // one minutely series first in the answer hid every entry after it — and
    // the reason read as if the calendar had been read in full.
    const fake = new FakeCalDav();
    fake.install();
    fake.seed(
      'work',
      'a-minutely.ics',
      series('minutely', 'FREQ=MINUTELY', '20261101T000000Z')
    );
    fake.seed(
      'work',
      'b-daily.ics',
      series('daily', 'FREQ=DAILY;COUNT=30', '20261101T000030Z')
    );
    session = await connect();
    const page = dataOf(
      await session.client.callTool({
        name: 'list_events',
        arguments: { ...WINDOW, limit: 5 },
      })
    );
    expect(
      (page.events as { summary: string }[]).map((e) => e.summary)
    ).toEqual(['minutely', 'daily', 'minutely', 'minutely', 'minutely']);
  });

  it('lets a search find a match that comes after a flooding series', async () => {
    const fake = new FakeCalDav();
    fake.install();
    fake.seed(
      'work',
      'a-minutely.ics',
      series('minutely', 'FREQ=MINUTELY', '20261101T000000Z')
    );
    fake.seed(
      'work',
      'b-daily.ics',
      series('daily', 'FREQ=DAILY;COUNT=30', '20261101T000030Z')
    );
    session = await connect();
    const page = dataOf(
      await session.client.callTool({
        name: 'search_events',
        arguments: { query: 'i', ...WINDOW, limit: 2 },
      })
    );
    expect(
      (page.events as { summary: string }[]).map((e) => e.summary)
    ).toEqual(['minutely', 'daily']);
    expect((page.truncated as { reason: string }).reason).toContain(
      'nothing from 2026-11-04T11:'
    );
  });
});

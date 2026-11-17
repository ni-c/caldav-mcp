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

  it('names a series the call ceiling cut, next to the count of the rest', async () => {
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
      bounded_series?: string[];
    };
    expect(truncated.bounded_series).toContain('minutely');
    expect(truncated.reason).toMatch(/^\d+ more entries in this window\. /);
    expect(truncated.reason).toContain('more occurrences than could be walked');
  });

  it('stops at the ceiling inside a calendar and says so', async () => {
    // The ceiling was only checked between calendars, so one calendar of long
    // series could collect without bound. The second entry here is never
    // expanded, and the answer says why.
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
      series('daily', 'FREQ=DAILY;COUNT=30', '20261101T090000Z')
    );
    session = await connect();
    const page = dataOf(
      await session.client.callTool({
        name: 'list_events',
        arguments: { ...WINDOW, limit: 5 },
      })
    );
    expect((page.truncated as { reason: string }).reason).toContain(
      '5000 occurrences had been collected'
    );
  });
});

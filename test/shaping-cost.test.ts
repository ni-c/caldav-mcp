import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * A listing shapes the page it returns, and every occurrence of a series reads
 * its master's cleaned fields once.
 *
 * Everything collected — up to the call's ceiling of 5000 — used to be shaped
 * before a page was cut out of it, and each occurrence cleaned the master's
 * full text and rebuilt its attendee list again. One hourly series with a long
 * description and two thousand attendees cost 9.5 seconds and 1.5 GB of heap
 * for `limit: 1`.
 */
function heavySeries(): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    'UID:heavy@example.net',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20260101T000000Z',
    'DTEND:20260101T003000Z',
    'RRULE:FREQ=HOURLY',
    'SUMMARY:heavy',
    `DESCRIPTION:${'d'.repeat(1_000_000)}`,
    ...Array.from(
      { length: 4000 },
      (_, i) => `ATTENDEE;CN=Person ${i}:mailto:p${i}@example.net`
    ),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

describe('the cost of a listing', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it.each([1, 500])(
    'stays small for one heavy hourly series at limit %i',
    async (limit) => {
      const fake = new FakeCalDav();
      fake.install();
      fake.seed('work', 'heavy.ics', heavySeries());
      session = await connect();
      const started = Date.now();
      const page = dataOf(
        await session.client.callTool({
          name: 'list_events',
          arguments: { from: '2026-01-01', to: '2027-01-01', limit },
        })
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((page.events as unknown[]).length).toBeGreaterThanOrEqual(1);
      expect(page.truncated).toHaveProperty('next_cursor');
    },
    60_000
  );
});

describe('window_covered_until', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it('names the due date of a task that has only one', async () => {
    // It was read from the shaped `start`, which such a task does not have,
    // so a page ending on one said it covered the window until ''.
    const fake = new FakeCalDav();
    fake.install();
    for (const day of ['10', '11']) {
      fake.seed(
        'work',
        `t${day}.ics`,
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//t//EN',
          'BEGIN:VTODO',
          `UID:t${day}`,
          'DTSTAMP:20261101T000000Z',
          `DUE:202611${day}T120000Z`,
          `SUMMARY:due ${day}`,
          'END:VTODO',
          'END:VCALENDAR',
          '',
        ].join('\r\n')
      );
    }
    session = await connect();
    const page = dataOf(
      await session.client.callTool({
        name: 'list_tasks',
        arguments: { from: '2026-11-01', to: '2026-12-01', limit: 1 },
      })
    );
    const tasks = page.tasks as { due: { value: string } }[];
    const truncated = page.truncated as { window_covered_until: string };
    expect(truncated.window_covered_until).toBe(tasks[0]?.due.value);
    expect(truncated.window_covered_until).not.toBe('');
  });
});

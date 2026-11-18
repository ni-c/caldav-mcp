import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_RESULT_BYTES } from '../src/result.js';
import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * Worked out from the events, free/busy reads every event in the window, so
 * one minutely series gave five thousand one-minute periods — about 750 kB,
 * twice, through an answer with no size ceiling. Periods are joined the way a
 * free-busy answer joins them, and the answer is under the ceiling.
 */
const WINDOW = { from: '2026-11-01', to: '2026-12-01' };

function event(uid: string, start: string, end: string, rule?: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261101T000000Z',
    `DTSTART:${start}`,
    `DTEND:${end}`,
    ...(rule === undefined ? [] : [`RRULE:${rule}`]),
    `SUMMARY:${uid}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

describe('get_free_busy worked out from many events', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it('joins touching periods, so a minutely series is one', async () => {
    const fake = new FakeCalDav({ refuseFreeBusy: true });
    fake.install();
    fake.seed(
      'work',
      'm.ics',
      event('m', '20261101T000000Z', '20261101T000100Z', 'FREQ=MINUTELY')
    );
    session = await connect();
    const result = await session.client.callTool({
      name: 'get_free_busy',
      arguments: WINDOW,
    });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    const answer = dataOf(result);
    expect(answer.count).toBe(1);
    expect(answer.busy).toHaveLength(1);
  }, 30_000);

  it('joins overlapping periods and keeps separate ones apart', async () => {
    const fake = new FakeCalDav({ refuseFreeBusy: true });
    fake.install();
    fake.seed(
      'work',
      'a.ics',
      event('a', '20261102T100000Z', '20261102T110000Z')
    );
    fake.seed(
      'work',
      'b.ics',
      event('b', '20261102T103000Z', '20261102T120000Z')
    );
    fake.seed(
      'work',
      'c.ics',
      event('c', '20261102T140000Z', '20261102T150000Z')
    );
    session = await connect();
    const answer = dataOf(
      await session.client.callTool({
        name: 'get_free_busy',
        arguments: WINDOW,
      })
    );
    const busy = answer.busy as { start: string; end: string }[];
    expect(busy).toHaveLength(2);
    expect(Date.parse(busy[0]!.start)).toBe(Date.parse('2026-11-02T10:00:00Z'));
    expect(Date.parse(busy[0]!.end)).toBe(Date.parse('2026-11-02T12:00:00Z'));
  });

  it('stays under the ceiling with thousands of separate periods', async () => {
    const fake = new FakeCalDav({ refuseFreeBusy: true });
    fake.install();
    // Every other minute busy: nothing to join.
    fake.seed(
      'work',
      's.ics',
      event(
        's',
        '20261101T000000Z',
        '20261101T000100Z',
        'FREQ=MINUTELY;INTERVAL=2'
      )
    );
    session = await connect();
    const result = await session.client.callTool({
      name: 'get_free_busy',
      arguments: WINDOW,
    });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    const answer = dataOf(result);
    expect(answer.count).toBe((answer.busy as unknown[]).length);
    expect((answer.notes as string[]).join(' ')).toMatch(/left out/);
  });

  it.each([
    ['America/New_York', '20261117T010000Z', '20261117T020000Z'],
    ['Europe/Berlin', '20261117T233000Z', '20261118T000000Z'],
  ])(
    'never lets an all-day period swallow a timed one next to it (%s)',
    async (timezone, start, end) => {
      const fake = new FakeCalDav({ refuseFreeBusy: true });
      fake.install();
      fake.seed(
        'work',
        'day.ics',
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//t//EN',
          'BEGIN:VEVENT',
          'UID:day',
          'DTSTAMP:20261101T000000Z',
          'DTSTART;VALUE=DATE:20261117',
          'DTEND;VALUE=DATE:20261118',
          'SUMMARY:day',
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n')
      );
      fake.seed('work', 'meeting.ics', event('meeting', start, end));
      session = await connect({ timezone });
      const answer = dataOf(
        await session.client.callTool({
          name: 'get_free_busy',
          arguments: WINDOW,
        })
      );
      const busy = answer.busy as { start: string; end: string }[];
      expect(
        busy.some(
          (period) =>
            Date.parse(period.start) ===
            Date.parse(
              `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T${start.slice(9, 11)}:${start.slice(11, 13)}:00Z`
            )
        )
      ).toBe(true);
    }
  );
});

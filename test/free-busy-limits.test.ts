import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * get_free_busy works the periods out of the events when a calendar refuses
 * the free-busy query. It used to read one page of them — CALDAV_MAX_ENTRIES —
 * so every event past it was a busy period reported as free, and it had no
 * clock across its calendars.
 */
const WINDOW = { from: '2026-11-01', to: '2026-12-01' };

function event(uid: string, day: string, lines: string[] = []): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261101T000000Z',
    `DTSTART:202611${day}T100000Z`,
    `DTEND:202611${day}T110000Z`,
    `SUMMARY:${uid}`,
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

describe('get_free_busy worked out from the events', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads every event in the window, not one page of them', async () => {
    const fake = new FakeCalDav({ refuseFreeBusy: true });
    fake.install();
    for (const day of ['02', '03', '04', '05', '06']) {
      fake.seed('work', `${day}.ics`, event(`e${day}`, day));
    }
    session = await connect({ maxEntries: 2 });
    const answer = dataOf(
      await session.client.callTool({
        name: 'get_free_busy',
        arguments: WINDOW,
      })
    );
    expect(answer.count).toBe(5);
  });

  it('says so when a calendar holds more than it could read', async () => {
    const fake = new FakeCalDav({ refuseFreeBusy: true });
    fake.install();
    fake.seed(
      'work',
      'm.ics',
      event('minutely', '01', ['RRULE:FREQ=MINUTELY'])
    );
    session = await connect();
    const answer = dataOf(
      await session.client.callTool({
        name: 'get_free_busy',
        arguments: WINDOW,
      })
    );
    expect((answer.notes as string[]).join(' ')).toMatch(
      /Not every event in "\/tester\/work\/" could be read, so busy periods there may be missing\./
    );
  });

  it('stops when the call budget runs out, and says after how many calendars', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const calendars = Array.from({ length: 40 }, (_, i) => ({
      name: `c${String(i).padStart(2, '0')}`,
    }));
    const fake = new FakeCalDav({
      calendars,
      refuseFreeBusy: true,
      latencyMs: 1_000,
    });
    fake.install();
    session = await connect();
    const before = fake.requests.length;
    const answer = dataOf(
      await session.client.callTool({
        name: 'get_free_busy',
        arguments: WINDOW,
      })
    );
    expect(fake.requests.length - before).toBeLessThan(80);
    expect((answer.notes as string[]).join(' ')).toMatch(
      /Stopped after \d+ of 40 calendars: the call's 30-second budget ran out/
    );
  });
});

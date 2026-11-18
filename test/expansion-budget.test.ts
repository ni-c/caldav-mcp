import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * The five seconds a call may spend expanding recurring entries are counted
 * while it expands. They were a deadline set when the call began, so a server
 * that took five seconds to answer left every series stopped at its first step
 * and named as one that could not be walked.
 */
function weekly(uid: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20260105T090000Z',
    'DTEND:20260105T100000Z',
    'RRULE:FREQ=WEEKLY',
    `SUMMARY:${uid}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

describe('the expansion budget', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is not used up by a slow server', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fake = new FakeCalDav({
      calendars: [{ name: 'work' }, { name: 'private' }],
      latencyMs: 6_000,
    });
    fake.install();
    fake.seed('work', 'w.ics', weekly('in work'));
    fake.seed('private', 'p.ics', weekly('in private'));
    session = await connect();
    const listing = dataOf(
      await session.client.callTool({
        name: 'list_events',
        arguments: { from: '2026-11-01', to: '2026-12-01' },
      })
    );
    expect((listing.events as unknown[]).length).toBe(10);
    expect(listing.truncated ?? {}).not.toHaveProperty('bounded_series');
  });
});

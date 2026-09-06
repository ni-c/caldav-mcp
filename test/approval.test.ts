import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setResourceKey } from 'mcp-approval';

import { orderedResourceKey } from '../src/write.js';
import {
  connect,
  dataOf,
  FakeCalDav,
  textOf,
  type Connected,
} from './harness.js';

/**
 * The approval gate, from the outside: what a token or a dialog answer is
 * bound to, and what each outcome leaves untouched. Every assertion is on the
 * wire — the PUTs and DELETEs the fake recorded — or on what is still stored.
 */

const CALENDAR = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN'];

function event(uid: string, summary = 'Plain'): string {
  return [
    ...CALENDAR,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260901T120000Z',
    'DTSTART:20260907T070000Z',
    'DTEND:20260907T080000Z',
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const WINDOW = { from: '2026-09-01', to: '2026-09-30' };

describe('a resource key over a tuple', () => {
  it('tells the positions apart, where the set-shaped key did not', () => {
    // `setResourceKey` sorts, which is right for a set and wrong for
    // (from, to): the key for Work→Private was the key for Private→Work.
    expect(setResourceKey('move_event', ['/a/', '/b/', 'x.ics'])).toBe(
      setResourceKey('move_event', ['/b/', '/a/', 'x.ics'])
    );
    expect(orderedResourceKey('move_event', ['/a/', '/b/', 'x.ics'])).not.toBe(
      orderedResourceKey('move_event', ['/b/', '/a/', 'x.ics'])
    );
    expect(orderedResourceKey('op', ['a', 'b'])).toBe(
      orderedResourceKey('op', ['a', 'b'])
    );
  });
});

describe('what a move token is bound to', () => {
  let fake: FakeCalDav;
  let session: Connected;

  beforeEach(async () => {
    fake = new FakeCalDav();
    fake.install();
    fake.seed('work', 'e.ics', event('work@example.net', 'In work'));
    fake.seed('private', 'e.ics', event('private@example.net', 'In private'));
    // No elicitation capability: the two-call token is the only path.
    session = await connect();
  });

  afterEach(async () => {
    await session.close();
    vi.unstubAllGlobals();
  });

  async function call(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return session.client.callTool({ name, arguments: args });
  }

  async function idOf(calendar: string): Promise<string> {
    const listing = dataOf(
      await call('list_events', { ...WINDOW, calendars: [calendar] })
    );
    return (listing.events as { id: string }[])[0]?.id ?? '';
  }

  it('does not authorise the move in the other direction', async () => {
    // An approval to move e.ics from Work to Private was also an approval to
    // move the e.ics in Private to Work: same operation, same three parts,
    // sorted into the same set.
    const fromWork = await idOf('/tester/work/');
    const fromPrivate = await idOf('/tester/private/');
    const prompt = await call('move_event', {
      id: fromWork,
      destination_calendar_id: '/tester/private/',
    });
    const token = /confirm_token="?([\w-]+)"?/.exec(textOf(prompt))?.[1];
    expect(token).toBeDefined();

    const writes = () =>
      fake.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE');
    const before = writes().length;
    const reversed = (await call('move_event', {
      id: fromPrivate,
      destination_calendar_id: '/tester/work/',
      confirm_token: token,
    })) as { isError?: boolean };
    expect(reversed.isError).toBe(true);
    expect(writes()).toHaveLength(before);
    expect(fake.stored('work', 'e.ics')).toContain('SUMMARY:In work');
    expect(fake.stored('private', 'e.ics')).toContain('SUMMARY:In private');

    // The token still does what it was issued for. The private e.ics is
    // taken out of the way first: a move refuses to overwrite a resource of
    // the same name at the destination (If-None-Match: *), which is right,
    // and not what this test is about.
    fake.calendars.get('/tester/private/')?.resources.delete('e.ics');
    const moved = dataOf(
      await call('move_event', {
        id: fromWork,
        destination_calendar_id: '/tester/private/',
        confirm_token: token,
      })
    );
    expect(moved.moved).toBe(true);
    expect(fake.stored('work', 'e.ics')).toBeUndefined();
  });
});

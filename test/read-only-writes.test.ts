import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOccurrenceId, buildSeriesId } from '../src/entity-id.js';
import { connect, FakeCalDav, textOf, type Connected } from './harness.js';

/**
 * A calendar the account can only read is refused by every write tool before
 * anything is sent and before anybody is asked. The check used to sit in the
 * create tools and the move destination only: updates, completions, responses
 * and occurrence exclusions reached the server, and the deletes and
 * respond_to_event put a dialog in front of the user first for something that
 * could not be done.
 */
const LOCKED = '/tester/work/';
const OPEN = '/tester/private/';

function ics(kind: 'VEVENT' | 'VTODO' | 'VJOURNAL', lines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    `BEGIN:${kind}`,
    `UID:${kind.toLowerCase()}@example.net`,
    'DTSTAMP:20261101T000000Z',
    'SUMMARY:read only',
    ...lines,
    `END:${kind}`,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const EVENT = buildSeriesId('vevent', LOCKED, 'e.ics');
const SERIES = buildSeriesId('vevent', LOCKED, 's.ics');
const OCCURRENCE = buildOccurrenceId(
  'vevent',
  LOCKED,
  's.ics',
  '20261103T090000Z'
);
const TASK = buildSeriesId('vtodo', LOCKED, 't.ics');
const JOURNAL = buildSeriesId('vjournal', LOCKED, 'j.ics');

const CALLS: [string, Record<string, unknown>][] = [
  [
    'create_event',
    { calendar_id: LOCKED, summary: 'x', start: '2026-11-20T10:00:00' },
  ],
  ['create_task', { calendar_id: LOCKED, summary: 'x' }],
  ['create_journal', { calendar_id: LOCKED, summary: 'x', date: '2026-11-20' }],
  ['update_event', { id: EVENT, summary: 'changed' }],
  [
    'update_event',
    { id: OCCURRENCE, scope: 'this_occurrence', summary: 'changed' },
  ],
  ['update_task', { id: TASK, summary: 'changed' }],
  ['update_journal', { id: JOURNAL, summary: 'changed' }],
  ['complete_task', { id: TASK }],
  ['delete_event', { id: EVENT }],
  ['delete_event', { id: OCCURRENCE, scope: 'this_occurrence' }],
  ['delete_event', { id: SERIES, scope: 'entire_series' }],
  ['delete_task', { id: TASK }],
  ['delete_journal', { id: JOURNAL }],
  ['move_event', { id: EVENT, destination_calendar_id: OPEN }],
  ['respond_to_event', { id: EVENT, response: 'ACCEPTED' }],
];

const FILES = ['e.ics', 's.ics', 't.ics', 'j.ics'];
const stored = (fake: FakeCalDav): (string | undefined)[] => [
  ...FILES.map((file) => fake.stored('work', file)),
  ...FILES.map((file) => fake.stored('private', file)),
];

const WRITES = new Set(['PUT', 'DELETE', 'MOVE', 'COPY', 'POST', 'PROPPATCH']);

describe('a read-only calendar', () => {
  let fake: FakeCalDav;
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function start(): Promise<void> {
    fake = new FakeCalDav({
      calendars: [{ name: 'work', readOnly: true }, { name: 'private' }],
    });
    fake.install();
    fake.seed(
      'work',
      'e.ics',
      ics('VEVENT', [
        'DTSTART:20261102T100000Z',
        'DTEND:20261102T110000Z',
        'ORGANIZER:mailto:organizer@example.net',
        'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:tester@example.net',
      ])
    );
    fake.seed(
      'work',
      's.ics',
      ics('VEVENT', [
        'DTSTART:20261102T090000Z',
        'DTEND:20261102T100000Z',
        'RRULE:FREQ=DAILY;COUNT=5',
      ])
    );
    fake.seed('work', 't.ics', ics('VTODO', ['DUE:20261110T120000Z']));
    fake.seed('work', 'j.ics', ics('VJOURNAL', ['DTSTART:20261102T090000Z']));
    session = await connect({ userEmail: 'tester@example.net' }, 'accept');
  }

  it.each(CALLS)(
    '%s is refused before anything is sent or asked (%o)',
    async (name, args) => {
      await start();
      const before = stored(fake);
      const requests = fake.requests.length;
      const result = (await session!.client.callTool({
        name,
        arguments: args,
      })) as { isError?: boolean };
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/can read .* but not write to it/);
      const writes = fake.requests
        .slice(requests)
        .filter((request) => WRITES.has(request.method));
      expect(writes).toEqual([]);
      expect(session!.prompts).toEqual([]);
      expect(stored(fake)).toEqual(before);
    }
  );

  it('still lets the writable calendar be written', async () => {
    await start();
    const result = (await session!.client.callTool({
      name: 'create_task',
      arguments: { calendar_id: OPEN, summary: 'fine' },
    })) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
  });
});

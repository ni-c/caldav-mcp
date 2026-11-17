import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSeriesId } from '../src/entity-id.js';
import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * ical.js parses a property value when it is first read, which for CREATED,
 * LAST-MODIFIED and COMPLETED is in `shapeEntry` — after the guard that skips a
 * broken entry. One unreadable stamp in one task took the whole listing down
 * ("value.toJSDate is not a function"), and anyone who can write to a shared
 * calendar can write one. The field is left out; the task is still listed.
 */
function task(uid: string, lines: string[]): string {
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

const BROKEN_STAMPS = [
  'COMPLETED;VALUE=TEXT:x',
  'CREATED:garbage',
  'LAST-MODIFIED:not-a-stamp',
];

describe('an unreadable timestamp', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function start(dates: string[]): Promise<void> {
    const fake = new FakeCalDav();
    fake.install();
    fake.seed('work', 'bad.ics', task('bad', [...dates, ...BROKEN_STAMPS]));
    fake.seed('work', 'good.ics', task('good', dates));
    session = await connect();
  }

  it.each([
    ['an undated listing', [], { undated: true, include_completed: true }],
    [
      'a windowed listing',
      ['DUE:20261120T120000Z'],
      { from: '2026-11-01', to: '2026-12-01', include_completed: true },
    ],
  ])(
    'leaves the field out in %s and lists the task',
    async (_label, dates, args) => {
      await start(dates);
      const listing = dataOf(
        await session!.client.callTool({ name: 'list_tasks', arguments: args })
      );
      const tasks = listing.tasks as Record<string, unknown>[];
      expect(tasks.map((t) => t.summary).toSorted()).toEqual(['bad', 'good']);
      const bad = tasks.find((t) => t.summary === 'bad');
      expect(bad).not.toHaveProperty('completed');
      expect(bad).not.toHaveProperty('created');
      expect(bad).not.toHaveProperty('last_modified');
    }
  );

  it('does not stop get_task from reading the entry', async () => {
    await start([]);
    const single = dataOf(
      await session!.client.callTool({
        name: 'get_task',
        arguments: { id: buildSeriesId('vtodo', '/tester/work/', 'bad.ics') },
      })
    );
    expect((single.task as { summary?: string }).summary).toBe('bad');
  });
});

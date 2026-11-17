import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSeriesId } from '../src/entity-id.js';
import {
  connect,
  dataOf,
  FakeCalDav,
  textOf,
  type Connected,
} from './harness.js';

/**
 * `update_task` said "Pass null to clear a field" and then refused null for
 * `due` and `start`, so a date could be changed but never removed — a task
 * could not be turned into one without a date. A start that a recurrence rule
 * or a duration depends on is the exception, refused before anything is sent.
 */
function task(lines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VTODO',
    'UID:t@example.net',
    'DTSTAMP:20261101T000000Z',
    'SUMMARY:A task',
    ...lines,
    'END:VTODO',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const ID = buildSeriesId('vtodo', '/tester/work/', 't.ics');

describe('update_task with null dates', () => {
  let fake: FakeCalDav;
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function start(lines: string[]): Promise<void> {
    fake = new FakeCalDav();
    fake.install();
    fake.seed('work', 't.ics', task(lines));
    session = await connect({}, 'accept');
  }

  async function update(args: Record<string, unknown>): Promise<unknown> {
    return session!.client.callTool({
      name: 'update_task',
      arguments: { id: ID, ...args },
    });
  }

  it('removes a due date, and the task is then listed as undated', async () => {
    await start(['DUE:20261110T120000Z']);
    dataOf(await update({ due: null }));
    expect(fake.stored('work', 't.ics')).not.toMatch(/^DUE/m);
    const listing = dataOf(
      await session!.client.callTool({
        name: 'list_tasks',
        arguments: { undated: true },
      })
    );
    expect((listing.tasks as { summary: string }[])[0]?.summary).toBe('A task');
  });

  it('removes a start and keeps the due date', async () => {
    await start(['DTSTART:20261108T090000Z', 'DUE:20261110T120000Z']);
    dataOf(await update({ start: null }));
    const stored = fake.stored('work', 't.ics') ?? '';
    expect(stored).not.toMatch(/^DTSTART/m);
    expect(stored).toMatch(/^DUE/m);
  });

  it.each([
    ['a recurrence rule', ['DTSTART:20261108T090000Z', 'RRULE:FREQ=WEEKLY']],
    ['a duration', ['DTSTART:20261108T090000Z', 'DURATION:PT1H']],
  ])(
    'refuses to remove a start that %s depends on, and writes nothing',
    async (_label, lines) => {
      await start(lines);
      const before = fake.stored('work', 't.ics');
      const result = (await update({ start: null })) as { isError?: boolean };
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Nothing was written');
      expect(fake.stored('work', 't.ics')).toBe(before);
    }
  );

  it('treats null on a date the task does not have as nothing to remove', async () => {
    await start([]);
    const result = (await update({ due: null })) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(fake.stored('work', 't.ics')).not.toMatch(/^DUE/m);
  });
});

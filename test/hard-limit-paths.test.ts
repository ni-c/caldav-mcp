import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hardLimits } from '../src/hard-limit.js';
import type { ICAL } from '../src/ical.js';
import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * The overrun paths of every listing, reached with work that never ends.
 *
 * An entry whose summary is `spin` makes the expansion never return, and one
 * whose summary is `spin-shape` makes shaping never return. Which ical.js
 * loop is behind such a hang does not matter to these paths, so the loop is
 * a plain one; the limits are shortened so a test does not wait seconds.
 */
function spins(components: readonly ICAL.Component[], marker: string): boolean {
  return components.some(
    (component) => component.getFirstPropertyValue('summary') === marker
  );
}

function spin(): never {
  for (;;) {
    // Never ends.
  }
}

vi.mock('../src/recurrence.js', async (original) => {
  const actual = await original<typeof import('../src/recurrence.js')>();
  return {
    ...actual,
    expandSeries: (
      components: readonly ICAL.Component[],
      ...rest: unknown[]
    ): unknown => {
      if (spins(components, 'spin')) spin();
      return (actual.expandSeries as (...args: unknown[]) => unknown)(
        components,
        ...rest
      );
    },
    undatedOccurrence: (
      components: readonly ICAL.Component[],
      ...rest: unknown[]
    ): unknown => {
      if (spins(components, 'spin')) spin();
      return (actual.undatedOccurrence as (...args: unknown[]) => unknown)(
        components,
        ...rest
      );
    },
  };
});

vi.mock('../src/shape.js', async (original) => {
  const actual = await original<typeof import('../src/shape.js')>();
  return {
    ...actual,
    shapeEntry: (
      occurrence: { component: ICAL.Component },
      ...rest: unknown[]
    ): unknown => {
      if (spins([occurrence.component], 'spin-shape')) spin();
      return (actual.shapeEntry as (...args: unknown[]) => unknown)(
        occurrence,
        ...rest
      );
    },
  };
});

function event(name: string, summary: string, day: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    `UID:${name}`,
    'DTSTAMP:20261101T000000Z',
    `DTSTART:202611${day}T090000Z`,
    `DTEND:202611${day}T100000Z`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function task(name: string, summary: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VTODO',
    `UID:${name}`,
    'DTSTAMP:20261101T000000Z',
    `SUMMARY:${summary}`,
    'END:VTODO',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const WINDOW = { from: '2026-11-01', to: '2026-12-01' };
const saved = { ...hardLimits };

describe('the overrun paths of every listing', () => {
  let fake: FakeCalDav;
  let session: Connected | undefined;

  beforeEach(() => {
    hardLimits.entry = 150;
    hardLimits.singleEntry = 150;
    fake = new FakeCalDav();
    fake.install();
  });

  afterEach(async () => {
    Object.assign(hardLimits, saved);
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function call(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    session ??= await connect();
    return dataOf(await session.client.callTool({ name, arguments: args }));
  }

  it('skips an entry a search could not finish, and then stops evaluating', async () => {
    for (let i = 0; i < 4; i += 1) {
      fake.seed('work', `a${i}.ics`, event(`spin-${i}`, 'spin', '10'));
    }
    fake.seed('work', 'z.ics', event('fine', 'spin fine', '11'));
    const answer = await call('search_events', { query: 'spin', ...WINDOW });
    const notes = (answer.notes as string[]).join(' ');
    expect(notes).toContain('took longer to evaluate than this server allows');
    expect(notes).toMatch(/2 more stored entries were not evaluated/);
  }, 30_000);

  it('skips a task without a date it could not finish, and lists the rest', async () => {
    fake.seed('work', 'a.ics', task('stuck', 'spin'));
    fake.seed('work', 'b.ics', task('fine', 'fine'));
    const answer = await call('list_tasks', { undated: true });
    expect(
      (answer.tasks as { summary: string }[]).map((t) => t.summary)
    ).toEqual(['fine']);
    expect((answer.notes as string[]).join(' ')).toContain(
      'took longer to evaluate than this server allows'
    );
  }, 30_000);

  it('keeps a page whole when one entry cannot be shaped, by its id and time alone', async () => {
    fake.seed('work', 'a.ics', event('stuck', 'spin-shape', '10'));
    fake.seed('work', 'b.ics', event('fine', 'fine', '11'));
    const answer = await call('list_events', WINDOW);
    const events = answer.events as Record<string, unknown>[];
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      recurring: false,
      truncated_fields: ['all'],
      start: { value: expect.stringContaining('2026-11-10') },
    });
    expect(events[0]).not.toHaveProperty('summary');
    expect(events[1]).toMatchObject({ summary: 'fine' });
  }, 30_000);

  it('reports a task that cannot be shaped by its due date', async () => {
    fake.seed(
      'work',
      'a.ics',
      task('stuck', 'spin-shape').replace(
        'SUMMARY:spin-shape',
        'DUE:20261110T090000Z\r\nSUMMARY:spin-shape'
      )
    );
    const answer = await call('list_tasks', WINDOW);
    expect((answer.tasks as Record<string, unknown>[])[0]).toMatchObject({
      truncated_fields: ['all'],
      due: { value: expect.stringContaining('2026-11-10') },
    });
  }, 30_000);
});

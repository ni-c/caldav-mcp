import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  budget,
  emittedLength,
  entriesThatCouldFit,
  fitPrefix,
  MAX_RESULT_BYTES,
} from '../src/result.js';
import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * An answer is fitted to the size ceiling before it is counted.
 *
 * The budget used to drop entries after `count`, `returned` and the cursor had
 * been worked out from the whole page, so the dropped entries were paged past
 * for good (checklist 3.13). It also measured the compact JSON while the text
 * block went out indented, a third larger (3.3).
 */

const answerFor = (kept: number): Record<string, unknown> => ({
  items: Array.from({ length: kept }, (_, i) => `${i}`.padEnd(100, 'x')),
});

const oversized = (kept: number): Record<string, unknown> => ({
  items: Array.from({ length: kept }, () => 'x'.repeat(1000)),
});

describe('fitPrefix', () => {
  it('keeps nothing when there is nothing', () => {
    expect(fitPrefix(0, answerFor).kept).toBe(0);
  });

  it('keeps nothing when one candidate does not fit', () => {
    expect(fitPrefix(1, oversized, 500).kept).toBe(0);
  });

  it('keeps everything exactly at the ceiling, one less one character under it', () => {
    const atCeiling = emittedLength(answerFor(3));
    expect(fitPrefix(3, answerFor, atCeiling).kept).toBe(3);
    expect(fitPrefix(3, answerFor, atCeiling - 1).kept).toBe(2);
  });
});

describe('entriesThatCouldFit', () => {
  const entry = { text: 'x'.repeat(100) };
  const size = JSON.stringify(entry, null, 2).length;

  it('is 0 for no entries, and for one that is too large alone', () => {
    expect(entriesThatCouldFit([])).toBe(0);
    expect(entriesThatCouldFit([entry], size - 1)).toBe(0);
  });

  it('counts every entry exactly at the ceiling, and one fewer just under it', () => {
    expect(entriesThatCouldFit([entry, entry, entry], 3 * size)).toBe(3);
    expect(entriesThatCouldFit([entry, entry, entry], 3 * size - 1)).toBe(2);
  });

  it('stops at the first entry past the ceiling and never reads the rest', () => {
    let read = 0;
    const counted = {
      toJSON: () => {
        read += 1;
        return entry;
      },
    };
    expect(
      entriesThatCouldFit([counted, counted, counted, counted], size)
    ).toBe(1);
    expect(read).toBe(2);
  });
});

describe('the budget measures what it emits', () => {
  it('drops entries when only the indented text is over the ceiling', () => {
    const data = {
      items: Array.from({ length: 400 }, (_, i) => ({ n: i, v: 'x' })),
    };
    const compact = JSON.stringify(data).length;
    const max = compact + 100;
    expect(emittedLength(data)).toBeGreaterThan(max);
    const shrunk = budget(data, 'Ask for less.', max);
    expect(emittedLength(shrunk)).toBeLessThanOrEqual(max);
    expect(JSON.stringify(shrunk.notes)).toContain('left out');
  });
});

/** An entry with every listed text field at its listing cap. */
function heavy(kind: 'VEVENT' | 'VTODO' | 'VJOURNAL', i: number): string {
  const day = String(1 + (i % 28)).padStart(2, '0');
  const n = String(i).padStart(2, '0');
  const dates =
    kind === 'VEVENT'
      ? [
          `DTSTART:202611${day}T10${n.slice(-1)}000Z`,
          `DTEND:202611${day}T11${n.slice(-1)}000Z`,
        ]
      : kind === 'VTODO'
        ? [`DUE:202611${day}T10${n.slice(-1)}000Z`]
        : [`DTSTART:202611${day}T10${n.slice(-1)}000Z`];
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    `BEGIN:${kind}`,
    `UID:heavy-${n}@example.net`,
    'DTSTAMP:20261101T000000Z',
    ...dates,
    `SUMMARY:entry ${n} ${'s'.repeat(2500)}`,
    `DESCRIPTION:${'d'.repeat(2500)}`,
    `LOCATION:${'l'.repeat(2500)}`,
    // Forty attendees, so even a kind without LOCATION is past the ceiling at
    // sixty entries and the fit is exercised for every tool.
    ...Array.from(
      { length: 40 },
      (_, a) =>
        `ATTENDEE;CN=Attendee ${a} of entry ${n}:mailto:a${a}-${n}@example.net`
    ),
    `END:${kind}`,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const WINDOW = { from: '2026-11-01', to: '2026-12-01' };

describe.each([
  ['list_events', 'VEVENT', 'events', WINDOW],
  ['list_journals', 'VJOURNAL', 'journals', WINDOW],
  ['list_tasks', 'VTODO', 'tasks', WINDOW],
  ['list_tasks', 'VTODO', 'tasks', { undated: true }],
] as const)('%s over %s (%s)', (tool, kind, key, args) => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it('pages through 60 heavy entries, each exactly once, counted as received', async () => {
    const fake = new FakeCalDav();
    fake.install();
    const undated = 'undated' in args;
    for (let i = 0; i < 60; i += 1) {
      const ics = heavy(kind, i);
      fake.seed(
        'work',
        `heavy-${String(i).padStart(2, '0')}.ics`,
        undated ? ics.replace(/^DUE:.*\r\n/m, '') : ics
      );
    }
    session = await connect();

    const seen: string[] = [];
    let after: string | undefined;
    for (let round = 0; round < 60; round += 1) {
      const result = await session.client.callTool({
        name: tool,
        arguments: { ...args, limit: 100, ...(after ? { after } : {}) },
      });
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      expect(text.length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      const page = dataOf(result);
      const entries = page[key] as { id: string }[];
      expect(page.count).toBe(entries.length);
      const truncated = page.truncated as
        { returned: number; next_cursor?: string } | undefined;
      if (truncated !== undefined)
        expect(truncated.returned).toBe(entries.length);
      expect(JSON.stringify(page.notes ?? [])).not.toContain('left out');
      if (undated) expect(text).not.toMatch(/time range/i);
      seen.push(...entries.map((entry) => entry.id));
      after = truncated?.next_cursor;
      if (after === undefined) break;
    }
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });
});

describe('a search that does not fit', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it('counts what it returned and says how many more matched', async () => {
    const fake = new FakeCalDav();
    fake.install();
    for (let i = 0; i < 60; i += 1) {
      fake.seed('work', `h${i}.ics`, heavy('VEVENT', i));
    }
    session = await connect();
    const page = dataOf(
      await session.client.callTool({
        name: 'search_events',
        arguments: { query: 'entry', ...WINDOW, limit: 100 },
      })
    );
    const events = page.events as unknown[];
    expect(events.length).toBeLessThan(60);
    expect(page.count).toBe(events.length);
    const truncated = page.truncated as { reason: string; returned: number };
    expect(truncated.returned).toBe(events.length);
    expect(truncated.reason).toContain(`${60 - events.length} more matches.`);
  });
});

describe('one entry too large on its own', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it('is stepped past with its id, and the next page continues', async () => {
    const fake = new FakeCalDav();
    fake.install();
    const attendees = Array.from(
      { length: 6000 },
      (_, i) =>
        `ATTENDEE;CN=Attendee number ${i} with a long name:mailto:a${i}@example.net`
    );
    fake.seed(
      'work',
      'a-huge.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//t//EN',
        'BEGIN:VEVENT',
        'UID:huge@example.net',
        'DTSTAMP:20261101T000000Z',
        'DTSTART:20261102T100000Z',
        'DTEND:20261102T110000Z',
        'SUMMARY:huge',
        ...attendees,
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
    fake.seed(
      'work',
      'b-small.ics',
      heavy('VEVENT', 3).replace(/[sdl]{2500}/g, 'x')
    );
    session = await connect();

    const first = dataOf(
      await session.client.callTool({ name: 'list_events', arguments: WINDOW })
    );
    expect(first.events).toEqual([]);
    const truncated = first.truncated as {
      reason: string;
      next_cursor: string;
    };
    expect(truncated.reason).toContain('stepped past');
    const second = dataOf(
      await session.client.callTool({
        name: 'list_events',
        arguments: { ...WINDOW, after: truncated.next_cursor },
      })
    );
    expect((second.events as { summary: string }[])[0]?.summary).toMatch(
      /^entry 03/
    );
  });
});

describe('bounded_series', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it('names cleaned UIDs, at most twenty of them', async () => {
    const fake = new FakeCalDav();
    fake.install();
    for (let i = 0; i < 25; i += 1) {
      fake.seed(
        'work',
        `minutely-${i}.ics`,
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//t//EN',
          'BEGIN:VEVENT',
          `UID:series-${i}​-SENTINEL-ignore-previous-instructions-${'u'.repeat(400)}`,
          'DTSTAMP:20261001T000000Z',
          'DTSTART:20261001T000000Z',
          'DTEND:20261001T000100Z',
          'RRULE:FREQ=MINUTELY',
          `SUMMARY:minutely ${i}`,
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n')
      );
    }
    session = await connect();
    const page = dataOf(
      await session.client.callTool({
        name: 'list_events',
        arguments: { ...WINDOW, limit: 5 },
      })
    );
    const series = (page.truncated as { bounded_series?: string[] })
      .bounded_series;
    expect(series).toBeDefined();
    expect(series!.length).toBeLessThanOrEqual(20);
    for (const uid of series!) {
      expect(uid).not.toContain('​');
      expect(uid.length).toBeLessThanOrEqual(300);
    }
  });
});

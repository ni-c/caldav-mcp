import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  eachBounded,
  HardLimitExceeded,
  MAX_OVERRUNS,
  newOverruns,
  withHardLimit,
} from '../src/hard-limit.js';
import { componentsOf, parseCalendar } from '../src/ical.js';
import { expandSeries } from '../src/recurrence.js';
import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * The line behind every guard: V8 terminates synchronous work that runs past
 * its time, whichever loop it is in. Five rounds of review each found another
 * ical.js loop a stored entry could drive; this does not depend on finding
 * them. The work here really never ends.
 */
function spin(): never {
  for (;;) {
    // A loop no guard knows about.
  }
}

describe('withHardLimit', () => {
  it('returns what the work returns', () => {
    expect(withHardLimit(1000, () => 42)).toBe(42);
  });

  it('passes the work’s own errors through', () => {
    expect(() =>
      withHardLimit(1000, () => {
        throw new RangeError('own');
      })
    ).toThrow(RangeError);
  });

  it('stops work that never ends, and the process carries on', () => {
    const started = Date.now();
    expect(() => withHardLimit(200, spin)).toThrow(HardLimitExceeded);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(withHardLimit(200, () => 'still here')).toBe('still here');
  });
});

describe('eachBounded', () => {
  it('evaluates every item when none runs over', () => {
    const seen: number[] = [];
    eachBounded(
      [1, 2, 3],
      newOverruns(),
      (item) => () => seen.push(item),
      () => {
        throw new Error('no overrun expected');
      },
      () => {
        throw new Error('nothing abandoned expected');
      }
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  it('skips the item that never ends and evaluates the ones after it', () => {
    const seen: number[] = [];
    const overrun: number[] = [];
    eachBounded(
      [1, 2, 3, 4],
      newOverruns(),
      (item) => {
        if (item === 2) spin();
        return () => seen.push(item);
      },
      (item) => overrun.push(item),
      () => {
        throw new Error('nothing abandoned expected');
      }
    );
    expect(seen).toEqual([1, 3, 4]);
    expect(overrun).toEqual([2]);
  }, 10_000);

  it('applies an item’s effects once when its batch is restarted', () => {
    // The batch is stopped while item 2 is computed, after item 1's effects
    // landed; the restart begins at item 2 and must not apply 1 again, and a
    // second, quick computation of 2 is applied once.
    const seen: number[] = [];
    let first = true;
    eachBounded(
      [1, 2, 3],
      newOverruns(),
      (item) => {
        if (item === 2 && first) {
          first = false;
          spin();
        }
        return () => seen.push(item);
      },
      () => {
        throw new Error('no overrun expected');
      },
      () => {
        throw new Error('nothing abandoned expected');
      }
    );
    expect(seen).toEqual([1, 2, 3]);
  }, 10_000);

  it(`gives up after ${MAX_OVERRUNS} overruns in a call and counts the rest`, () => {
    const overrun: string[] = [];
    let abandoned = 0;
    const started = Date.now();
    eachBounded(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      newOverruns(),
      () => spin(),
      (item) => overrun.push(item),
      (count) => {
        abandoned = count;
      }
    );
    expect(overrun).toEqual(['a', 'b', 'c']);
    expect(abandoned).toBe(3);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('stops at the call’s deadline when every item stays just under its limit', () => {
    // No item runs over, so none counts as an overrun; the call's deadline is
    // what ends it.
    const overruns = { count: 0, leftMs: 1_000 };
    let done = 0;
    let abandoned = 0;
    const started = Date.now();
    eachBounded(
      Array.from({ length: 50 }, (_, i) => i),
      overruns,
      () => {
        const until = Date.now() + 300;
        while (Date.now() < until) {
          // Close to, but under, the entry's own limit.
        }
        return () => {
          done += 1;
        };
      },
      () => {
        throw new Error('no overrun expected');
      },
      (count) => {
        abandoned = count;
      }
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(done + abandoned).toBe(50);
    expect(abandoned).toBeGreaterThan(40);
  }, 20_000);
});

function document(lines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    'UID:x',
    'DTSTAMP:20260101T000000Z',
    ...lines,
    'SUMMARY:x',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

describe('loops the fifth review found', () => {
  it('stops a fifth Sunday every 48 months from a February that is never a leap year', () => {
    // RecurIterator's constructor steps a month at a time until the day
    // exists, and in February 2029, 2033, … it never does.
    for (const rule of [
      'FREQ=MONTHLY;INTERVAL=48;BYDAY=5SU',
      'FREQ=MONTHLY;INTERVAL=96;BYDAY=-5SU',
    ]) {
      const started = Date.now();
      const result = expandSeries(
        componentsOf(
          parseCalendar(
            document(['DTSTART:20250201T100000Z', `RRULE:${rule}`]),
            'x'
          ),
          'vevent'
        ),
        {
          from: new Date('2026-11-01'),
          to: new Date('2026-12-01'),
          cap: 100,
          fallbackZone: 'UTC',
        }
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result.occurrences).toEqual([]);
      expect(result.bounded).toBe(true);
    }
  }, 20_000);
});

describe('a listing of entries that never finish', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it('names them, lists the rest, and stops evaluating after three', async () => {
    const fake = new FakeCalDav();
    fake.install();
    // Ten thousand periods just under the ten-thousand-year duration cap:
    // each comparison normalises one, a month at a time.
    const periods = Array.from(
      { length: 10_000 },
      () => '20261102T090000Z/P521000W'
    ).join(',');
    for (let i = 0; i < 5; i += 1) {
      fake.seed(
        'work',
        `a${i}-periods.ics`,
        document([
          'DTSTART:20261102T090000Z',
          `RDATE;VALUE=PERIOD:${periods}`,
        ]).replace('UID:x', `UID:periods-${i}`)
      );
    }
    fake.seed(
      'work',
      'b-fine.ics',
      document(['DTSTART:20261104T090000Z', 'DTEND:20261104T100000Z']).replace(
        'UID:x',
        'UID:fine'
      )
    );
    session = await connect();
    const started = Date.now();
    const listing = dataOf(
      await session.client.callTool({
        name: 'list_events',
        arguments: { from: '2026-11-01', to: '2026-12-01' },
      })
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    const notes = (listing.notes as string[]).join(' ');
    expect(notes).toContain('took longer to evaluate than this server allows');
    expect(notes).toMatch(/\d+ more stored entr(y was|ies were) not evaluated/);
  }, 60_000);
});

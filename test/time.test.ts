import { describe, expect, it } from 'vitest';

import { ToolInputError } from '../src/errors.js';
import { isKnownZone } from '../src/ical.js';
import {
  cacheZone,
  formatDateInZone,
  formatInZone,
  parseInstant,
  renderTime,
  toUtcStamp,
  wallClockToInstant,
  zoneOffsetMinutes,
  ZONE_CACHE_LIMIT,
} from '../src/time.js';

const BERLIN = 'Europe/Berlin';

describe('zoneOffsetMinutes', () => {
  it('follows the summer/winter rule of the zone', () => {
    // 12:00 UTC on a July day and on a January day, in Berlin.
    expect(zoneOffsetMinutes(BERLIN, new Date('2026-07-15T12:00:00Z'))).toBe(
      120
    );
    expect(zoneOffsetMinutes(BERLIN, new Date('2026-01-15T12:00:00Z'))).toBe(
      60
    );
  });

  it('is zero for UTC and negative west of Greenwich', () => {
    expect(zoneOffsetMinutes('UTC', new Date('2026-07-15T12:00:00Z'))).toBe(0);
    expect(
      zoneOffsetMinutes('America/New_York', new Date('2026-07-15T12:00:00Z'))
    ).toBe(-240);
  });

  it('handles a zone whose offset is not a whole hour', () => {
    expect(
      zoneOffsetMinutes('Asia/Kolkata', new Date('2026-07-15T12:00:00Z'))
    ).toBe(330);
    expect(
      zoneOffsetMinutes('Australia/Adelaide', new Date('2026-01-15T12:00:00Z'))
    ).toBe(630);
  });

  it('reads midnight as hour 0, not hour 24', () => {
    // Some ICU versions render midnight as "24" even with hour12: false. If that
    // leaks through, every offset computed at midnight is a day out.
    expect(zoneOffsetMinutes(BERLIN, new Date('2026-07-14T22:00:00Z'))).toBe(
      120
    );
    expect(zoneOffsetMinutes('UTC', new Date('2026-07-15T00:00:00Z'))).toBe(0);
  });
});

describe('wallClockToInstant', () => {
  const wall = (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute = 0
  ) => ({ year, month, day, hour, minute, second: 0 });

  it('resolves a summer wall clock against the summer offset', () => {
    expect(wallClockToInstant(BERLIN, wall(2026, 7, 15, 9)).toISOString()).toBe(
      '2026-07-15T07:00:00.000Z'
    );
  });

  it('resolves a winter wall clock against the winter offset', () => {
    expect(wallClockToInstant(BERLIN, wall(2026, 1, 15, 9)).toISOString()).toBe(
      '2026-01-15T08:00:00.000Z'
    );
  });

  it('takes the first occurrence of an ambiguous wall clock', () => {
    // 2026-10-25, clocks go back at 03:00 local. 02:30 happens twice; the first
    // is still CEST (+02:00), i.e. 00:30 UTC.
    expect(
      wallClockToInstant(BERLIN, wall(2026, 10, 25, 2, 30)).toISOString()
    ).toBe('2026-10-25T00:30:00.000Z');
  });

  it('does not throw on a wall clock the zone skips', () => {
    // 2026-03-29, clocks go forward at 02:00 local, so 02:30 never happens.
    // A recurring 02:30 meeting must not fail once a year.
    const instant = wallClockToInstant(BERLIN, wall(2026, 3, 29, 2, 30));
    expect(Number.isNaN(instant.getTime())).toBe(false);
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('a daily 09:00 meeting across a DST change', () => {
  it('stays at 09:00 local on both sides', () => {
    // The property that matters, stated as the user would: a recurring meeting
    // keeps its wall-clock time even though the UTC instant moves by an hour.
    const before = wallClockToInstant(BERLIN, {
      year: 2026,
      month: 3,
      day: 28,
      hour: 9,
      minute: 0,
      second: 0,
    });
    const after = wallClockToInstant(BERLIN, {
      year: 2026,
      month: 3,
      day: 30,
      hour: 9,
      minute: 0,
      second: 0,
    });
    expect(before.toISOString()).toBe('2026-03-28T08:00:00.000Z');
    expect(after.toISOString()).toBe('2026-03-30T07:00:00.000Z');
    expect(formatInZone(before, BERLIN)).toBe('2026-03-28T09:00:00+01:00');
    expect(formatInZone(after, BERLIN)).toBe('2026-03-30T09:00:00+02:00');
  });
});

describe('formatInZone', () => {
  it('writes Z for UTC and an explicit offset otherwise', () => {
    const instant = new Date('2026-07-15T07:00:00Z');
    expect(formatInZone(instant, 'UTC')).toBe('2026-07-15T07:00:00Z');
    expect(formatInZone(instant, BERLIN)).toBe('2026-07-15T09:00:00+02:00');
    expect(formatInZone(instant, 'America/New_York')).toBe(
      '2026-07-15T03:00:00-04:00'
    );
  });

  it('writes a half-hour offset as minutes, not as a fraction', () => {
    expect(formatInZone(new Date('2026-07-15T07:00:00Z'), 'Asia/Kolkata')).toBe(
      '2026-07-15T12:30:00+05:30'
    );
  });
});

describe('formatDateInZone', () => {
  it('reads the date in the zone, not in UTC', () => {
    // 22:30 UTC is already the next day in Berlin.
    const instant = new Date('2026-07-15T22:30:00Z');
    expect(formatDateInZone(instant, 'UTC')).toBe('2026-07-15');
    expect(formatDateInZone(instant, BERLIN)).toBe('2026-07-16');
  });
});

describe('toUtcStamp', () => {
  it('produces the only timestamp form a request body accepts', () => {
    expect(toUtcStamp(new Date('2026-09-07T07:00:00Z'))).toBe(
      '20260907T070000Z'
    );
    expect(toUtcStamp(new Date('2026-01-02T03:04:05Z'))).toBe(
      '20260102T030405Z'
    );
  });
});

describe('parseInstant', () => {
  it('reads a bare date as an all-day value in the given zone', () => {
    const parsed = parseInstant('2026-09-07', 'start', BERLIN);
    expect(parsed.allDay).toBe(true);
    expect(parsed.instant.toISOString()).toBe('2026-09-06T22:00:00.000Z');
    expect(parsed.zone).toBe(BERLIN);
  });

  it('reads a bare date-time in the default zone, not in the host zone', () => {
    // This is the one `new Date()` gets wrong: it would read this as local time
    // of whatever TZ the container happens to have inherited.
    const parsed = parseInstant('2026-09-07T09:00:00', 'start', BERLIN);
    expect(parsed.instant.toISOString()).toBe('2026-09-07T07:00:00.000Z');
    expect(parsed.allDay).toBe(false);
  });

  it('honours an explicit timezone argument over the default', () => {
    const parsed = parseInstant(
      '2026-09-07T09:00:00',
      'start',
      BERLIN,
      'America/New_York'
    );
    expect(parsed.instant.toISOString()).toBe('2026-09-07T13:00:00.000Z');
    expect(parsed.zone).toBe('America/New_York');
  });

  it('accepts an explicit offset and keeps it as the instant', () => {
    const parsed = parseInstant('2026-09-07T09:00:00+02:00', 'start', BERLIN);
    expect(parsed.instant.toISOString()).toBe('2026-09-07T07:00:00.000Z');
    expect(parsed.allDay).toBe(false);
  });

  it('marks a Z value as having no zone of its own', () => {
    expect(
      parseInstant('2026-09-07T07:00:00Z', 'start', BERLIN).zone
    ).toBeUndefined();
  });

  it('refuses an offset and a timezone at the same time', () => {
    expect(() =>
      parseInstant('2026-09-07T09:00:00+02:00', 'start', BERLIN, 'UTC')
    ).toThrow(ToolInputError);
  });

  it('refuses a date that does not exist', () => {
    // The shape is right and Date.UTC would roll it forward to March 2nd.
    expect(() => parseInstant('2026-02-30', 'start', BERLIN)).toThrow(
      /not a real date/
    );
    expect(() => parseInstant('2026-02-30T09:00:00', 'start', BERLIN)).toThrow(
      /not a real date/
    );
  });

  it('refuses an impossible time of day', () => {
    expect(() => parseInstant('2026-09-07T25:00:00', 'start', BERLIN)).toThrow(
      ToolInputError
    );
  });

  it('names the field and the three accepted shapes when it cannot parse', () => {
    let message = '';
    try {
      parseInstant('next tuesday', 'start', BERLIN);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('start');
    expect(message).toContain('2026-09-07T09:00:00+02:00');
    expect(message).toContain('CALDAV_TIMEZONE');
  });
});

describe('renderTime', () => {
  it('reports the instant, the zone rule and the all-day flag', () => {
    const rendered = renderTime(new Date('2026-07-15T07:00:00Z'), {
      zone: BERLIN,
      allDay: false,
      fallbackZone: 'UTC',
    });
    expect(rendered).toEqual({
      value: '2026-07-15T09:00:00+02:00',
      tzid: BERLIN,
      allDay: false,
    });
  });

  it('omits tzid for a value that carried none', () => {
    const rendered = renderTime(new Date('2026-07-15T07:00:00Z'), {
      allDay: false,
      fallbackZone: 'UTC',
    });
    expect(rendered).toEqual({ value: '2026-07-15T07:00:00Z', allDay: false });
    expect('tzid' in rendered).toBe(false);
  });

  it('renders an all-day value as a bare date', () => {
    expect(
      renderTime(new Date('2026-09-06T22:00:00Z'), {
        zone: BERLIN,
        allDay: true,
        fallbackZone: 'UTC',
      }).value
    ).toBe('2026-09-07');
  });
});

describe('the zone caches', () => {
  it('stops growing once it has seen more zones than exist', () => {
    // Every zone cache in this server is keyed by a TZID out of a calendar
    // document — a string somebody else wrote — and lives as long as the
    // process. A calendar carrying a hundred thousand invented zone names
    // would otherwise make a long-running server grow without bound. Past the
    // cap the cache simply stops taking entries; a cold lookup is still a
    // correct lookup, which is what this checks.
    const cache = new Map<string, number>();
    for (let index = 0; index < ZONE_CACHE_LIMIT + 500; index += 1) {
      cacheZone(cache, `Invented/Zone${index}`, index);
    }
    expect(cache.size).toBe(ZONE_CACHE_LIMIT);
  });

  it('still answers correctly for a zone it did not keep', () => {
    // The cap is an optimisation, so exhausting it must not change an answer.
    for (let index = 0; index < ZONE_CACHE_LIMIT + 10; index += 1) {
      isKnownZone(`Invented/Zone${index}`);
    }
    expect(isKnownZone('Europe/Berlin')).toBe(true);
    expect(isKnownZone('Nowhere/Nothing')).toBe(false);
    expect(
      wallClockToInstant('Europe/Berlin', {
        year: 2026,
        month: 9,
        day: 7,
        hour: 9,
        minute: 0,
        second: 0,
      }).toISOString()
    ).toBe('2026-09-07T07:00:00.000Z');
  });
});

import ICAL from 'ical.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolInputError } from '../src/errors.js';
import { componentsOf, parseCalendar, readTime } from '../src/ical.js';
import { guarded } from '../src/ical-guard.js';
import { expandSeries } from '../src/recurrence.js';
import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * Documents built to make ical.js loop for as long as they like.
 *
 * Each of these froze or crashed the process from one stored entry: an RDATE
 * period of a billion weeks, a VTIMEZONE whose own rule never matches or steps
 * fifteen digits of days, a secondly timezone rule that filled the heap. Two
 * lines hold them: `parseCalendar` refuses a document past limits no real
 * calendar comes near, and the guards on ical.js's primitives bound whatever
 * gets past — tested here with the first line bypassed.
 */
function document(lines: string[], before: string[] = []): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    ...before,
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

function zone(rule: string, name = 'X', start = '16010101T000000'): string[] {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${name}`,
    'BEGIN:STANDARD',
    `DTSTART:${start}`,
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0100',
    ...(rule === '' ? [] : [`RRULE:${rule}`]),
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

const WINDOW = { from: new Date('2026-11-01'), to: new Date('2026-12-01') };

/** Parses without the limits, to reach the guards behind them. */
function unchecked(ics: string): ICAL.Component {
  return new ICAL.Component(ICAL.parse(ics));
}

function timed<T>(work: () => T): { result: T | Error; ms: number } {
  const started = Date.now();
  try {
    return { result: work(), ms: Date.now() - started };
  } catch (error) {
    return { result: error as Error, ms: Date.now() - started };
  }
}

const refused = (ics: string): string => {
  try {
    parseCalendar(ics, 'the stored entry');
  } catch (error) {
    expect(error).toBeInstanceOf(ToolInputError);
    return (error as Error).message;
  }
  throw new Error('not refused');
};

const rules = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, i) => `RRULE:FREQ=WEEKLY;BYDAY=${['MO', 'TU', 'WE', 'TH', 'FR'][i]}`
  );

const days = (count: number): string =>
  Array.from({ length: count }, (_, i) => `${i + 1}MO`).join(',');

const stamps = (count: number): string =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1) + i * 3_600_000)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('.000', '')
  ).join(',');

describe('the limits a document is held to', () => {
  it.each([
    ['a minutely rule', 'FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30'],
    [
      'an interval',
      'FREQ=YEARLY;INTERVAL=999999999999999;BYMONTH=3;BYDAY=-1SU',
    ],
    ['a secondly rule', 'FREQ=SECONDLY'],
    ['a day no February has', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=SU'],
    ['two months', 'FREQ=YEARLY;BYMONTH=3,10;BYDAY=-1SU'],
    ['two hours', 'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;BYHOUR=2,3'],
    ['a 53rd Sunday', 'FREQ=YEARLY;BYMONTH=2;BYDAY=53SU'],
    [
      'a counted weekday in a week of days',
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=8,9,10,11,12,13,14;BYDAY=2SU',
    ],
    [
      'days that are not a week',
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1,3,5,7,9,11,13;BYDAY=SU',
    ],
    ['a list of fixed days', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1,2'],
  ])('refuses a timezone with %s', (_label, rule) => {
    expect(
      refused(document(['DTSTART;TZID=X:20261102T090000'], zone(rule)))
    ).toContain('defines a timezone with a rule no timezone uses');
  });

  it.each([
    ['the Exchange shape', 'FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10'],
    [
      'a week of days',
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=8,9,10,11,12,13,14;BYDAY=SU',
    ],
    ['an end', 'FREQ=YEARLY;BYMONTH=4;BYDAY=1SU;UNTIL=20060402T070000Z'],
    ['a fixed day', 'FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=21'],
    [
      'the Lotus Notes shape',
      'FREQ=YEARLY;BYMINUTE=0;BYHOUR=2;BYDAY=-1SU;BYMONTH=3',
    ],
    ['a bare yearly rule', 'FREQ=YEARLY'],
    ['a counted weekday from the end', 'FREQ=YEARLY;BYMONTH=10;BYDAY=-5SU'],
    ['no rule at all', ''],
  ])('accepts a timezone with %s', (_label, rule) => {
    expect(() =>
      parseCalendar(
        document(['DTSTART;TZID=X:20261102T090000'], zone(rule)),
        'the stored entry'
      )
    ).not.toThrow();
  });

  it('refuses more than four recurrence rules, and accepts four', () => {
    expect(() =>
      parseCalendar(document(['DTSTART:20261102T090000Z', ...rules(4)]), 'x')
    ).not.toThrow();
    expect(
      refused(document(['DTSTART:20261102T090000Z', ...rules(5)]))
    ).toContain('carries 5 recurrence rules');
  });

  it('refuses a rule with more than 64 weekdays, and accepts 64', () => {
    expect(() =>
      parseCalendar(
        document([
          'DTSTART:20261102T090000Z',
          `RRULE:FREQ=YEARLY;BYDAY=${days(53)},TU,WE,TH,FR,SA,SU,1TU,1WE,1TH,1FR,1SA`,
        ]),
        'x'
      )
    ).not.toThrow();
    expect(
      refused(
        document([
          'DTSTART:20261102T090000Z',
          `RRULE:FREQ=YEARLY;BYDAY=${days(53)},TU,WE,TH,FR,SA,SU,1TU,1WE,1TH,1FR,1SA,1SU`,
        ])
      )
    ).toContain('more weekdays than a calendar writes');
  });

  it('refuses more than 10,000 extra or excluded dates', () => {
    expect(() =>
      parseCalendar(
        document([
          'DTSTART:20261102T090000Z',
          'RRULE:FREQ=HOURLY',
          `EXDATE:${stamps(10_000)}`,
        ]),
        'x'
      )
    ).not.toThrow();
    expect(
      refused(
        document([
          'DTSTART:20261102T090000Z',
          'RRULE:FREQ=HOURLY',
          `EXDATE:${stamps(10_001)}`,
        ])
      )
    ).toContain('lists 10001 extra or excluded dates');
  });

  it('refuses a line with more parameters than a calendar writes, quickly', () => {
    const { result, ms } = timed(() =>
      parseCalendar(
        document([
          'DTSTART:20261102T090000Z',
          `X-A${';a=b'.repeat(200_000)}:v`,
        ]),
        'x'
      )
    );
    expect(ms).toBeLessThan(1_000);
    expect((result as Error).message).toContain(
      'more parameters than a calendar writes'
    );
  });

  it('is not passed by a stray quote mark before the parameters', () => {
    // The gate used to flip a quoted state on every quote; ical.js opens a
    // quoted value only right after '='. One stray quote put the gate inside
    // quotes while ical.js went on reading parameters.
    const { result, ms } = timed(() =>
      parseCalendar(
        document([
          'DTSTART:20261102T090000Z',
          `X-A;P=a";Q=":"${';a=b'.repeat(200_000)}:v`,
        ]),
        'x'
      )
    );
    expect(ms).toBeLessThan(1_000);
    expect((result as Error).message).toContain(
      'more parameters than a calendar writes'
    );
  });

  it('counts a quoted list as one parameter, as ical.js does', () => {
    const members = Array.from(
      { length: 150 },
      (_, i) => `"mailto:m${i}@example.net"`
    ).join(',');
    expect(() =>
      parseCalendar(
        document([
          'DTSTART:20261102T090000Z',
          `ATTENDEE;MEMBER=${members};CN=x:mailto:a@example.net`,
        ]),
        'x'
      )
    ).not.toThrow();
  });

  it('refuses an interval no calendar writes, in any rule', () => {
    expect(
      refused(
        document([
          'DTSTART:20261102T090000Z',
          `RRULE:FREQ=MONTHLY;INTERVAL=${'9'.repeat(309)}`,
        ])
      )
    ).toContain('an interval no calendar writes');
  });

  it('refuses a timezone with more than 5000 transitions', () => {
    const transitions = Array.from(
      { length: 5001 },
      (_, i) =>
        `RDATE:${1700 + Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, '0')}01T000000`
    );
    expect(
      refused(
        document(
          ['DTSTART;TZID=X:20261102T090000'],
          [
            'BEGIN:VTIMEZONE',
            'TZID:X',
            'BEGIN:STANDARD',
            'DTSTART:16010101T000000',
            'TZOFFSETFROM:+0100',
            'TZOFFSETTO:+0100',
            ...transitions,
            'END:STANDARD',
            'END:VTIMEZONE',
          ]
        )
      )
    ).toContain('more transitions than a calendar writes');
  });

  it('refuses a document of more than 20,000 components, without overflowing', () => {
    const blocks = Array.from(
      { length: 150_000 },
      () => 'BEGIN:X-Y\r\nEND:X-Y'
    ).join('\r\n');
    expect(
      refused(
        document(['DTSTART:20261102T090000Z']).replace(
          'BEGIN:VEVENT',
          `${blocks}\r\nBEGIN:VEVENT`
        )
      )
    ).toContain('more components than a calendar writes');
  });

  it('accepts a long value, which is not a parameter section', () => {
    expect(() =>
      parseCalendar(
        document([
          'DTSTART:20261102T090000Z',
          `DESCRIPTION:${'a;b:c'.repeat(50_000)}`,
        ]),
        'x'
      )
    ).not.toThrow();
  });
});

describe('the guards behind the limits', () => {
  it('stops an RDATE period of a billion weeks', () => {
    const { result, ms } = timed(() =>
      expandSeries(
        componentsOf(
          unchecked(
            document([
              'DTSTART:20260101T000000Z',
              'RDATE:20260101T000000Z/P999999999999999W',
            ])
          ),
          'vevent'
        ),
        { ...WINDOW, cap: 100, fallbackZone: 'UTC' }
      )
    );
    expect(ms).toBeLessThan(1_000);
    expect(result).not.toBeInstanceOf(Error);
  }, 20_000);

  it.each([
    'FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30',
    'FREQ=DAILY;INTERVAL=999999999999999',
    'FREQ=MINUTELY;INTERVAL=999999999999999',
    'FREQ=SECONDLY;INTERVAL=999999999999999',
    'FREQ=SECONDLY',
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=SU',
  ])(
    'refuses a timezone whose rule is %s, and refuses it again at once',
    (rule) => {
      const root = unchecked(
        document(
          ['DTSTART;TZID=X:20261102T090000', 'CREATED;TZID=X:20261101T090000'],
          zone(rule)
        )
      );
      const [event] = componentsOf(root, 'vevent');
      const first = timed(() => readTime(event!, 'dtstart', 'UTC'));
      expect(first.ms).toBeLessThan(1_000);
      expect(first.result).toBeInstanceOf(ToolInputError);
      expect((first.result as Error).message).toContain(
        'defines a timezone whose rules this server cannot evaluate'
      );
      const again = timed(() => readTime(event!, 'created', 'UTC'));
      expect(again.ms).toBeLessThan(20);
      expect(again.result).toBeInstanceOf(ToolInputError);
    },
    20_000
  );

  it('still reads a real timezone defined from 1601', () => {
    const root = parseCalendar(
      document(
        ['DTSTART;TZID=Customized Time Zone:20260907T090000'],
        [
          'BEGIN:VTIMEZONE',
          'TZID:Customized Time Zone',
          'BEGIN:STANDARD',
          'DTSTART:16010101T030000',
          'TZOFFSETFROM:+0200',
          'TZOFFSETTO:+0100',
          'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
          'END:STANDARD',
          'BEGIN:DAYLIGHT',
          'DTSTART:16010101T020000',
          'TZOFFSETFROM:+0100',
          'TZOFFSETTO:+0200',
          'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
          'END:DAYLIGHT',
          'END:VTIMEZONE',
        ]
      ),
      'x'
    );
    const [event] = componentsOf(root, 'vevent');
    expect(readTime(event!, 'dtstart', 'UTC')?.instant.toISOString()).toBe(
      '2026-09-07T07:00:00.000Z'
    );
  });

  it('stops a monthly rule with an interval of 309 digits', () => {
    const { result, ms } = timed(() =>
      expandSeries(
        componentsOf(
          unchecked(
            document([
              'DTSTART:20261102T090000Z',
              `RRULE:FREQ=MONTHLY;INTERVAL=${'9'.repeat(309)}`,
            ])
          ),
          'vevent'
        ),
        { ...WINDOW, cap: 100, fallbackZone: 'UTC' }
      )
    );
    expect(ms).toBeLessThan(1_000);
    expect(result).not.toBeInstanceOf(Error);
  }, 20_000);

  it('refuses to normalise a time whose month is not a number', () => {
    const time = ICAL.Time.fromData({ year: 2026, month: 11, day: 2 });
    time.month = Number.POSITIVE_INFINITY;
    expect(() => time.adjust(0, 0, 0, 0)).toThrow(/could not be evaluated/);
  });

  it('does not condemn a zone when only the call ran out of time', () => {
    const root = parseCalendar(
      document(
        ['DTSTART;TZID=Customized Time Zone:20260907T090000'],
        [
          'BEGIN:VTIMEZONE',
          'TZID:Customized Time Zone',
          'BEGIN:STANDARD',
          'DTSTART:16010101T030000',
          'TZOFFSETFROM:+0200',
          'TZOFFSETTO:+0100',
          'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
          'END:STANDARD',
          'BEGIN:DAYLIGHT',
          'DTSTART:16010101T020000',
          'TZOFFSETFROM:+0100',
          'TZOFFSETTO:+0200',
          'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
          'END:DAYLIGHT',
          'END:VTIMEZONE',
        ]
      ),
      'x'
    );
    const [event] = componentsOf(root, 'vevent');
    const spent = timed(() =>
      guarded(0, () => readTime(event!, 'dtstart', 'UTC'))
    );
    expect(spent.ms).toBeLessThan(100);
    expect(spent.result).toBeInstanceOf(ToolInputError);
    expect(readTime(event!, 'dtstart', 'UTC')?.instant.toISOString()).toBe(
      '2026-09-07T07:00:00.000Z'
    );
  });

  it('refuses to add a billion weeks to a time', () => {
    const time = ICAL.Time.fromData({ year: 2026, month: 11, day: 2, hour: 9 });
    expect(() =>
      time.addDuration(ICAL.Duration.fromString('P999999999999999W'))
    ).toThrow();
    time.addDuration(ICAL.Duration.fromString('P2W'));
    expect(time.day).toBe(16);
  });
});

describe('a listing with a hostile entry in it', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  it('names it, lists the rest, and answers at once', async () => {
    const fake = new FakeCalDav();
    fake.install();
    fake.seed(
      'work',
      'hostile.ics',
      document(
        ['DTSTART;TZID=X:20261102T090000'],
        zone('FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30')
      )
    );
    fake.seed(
      'work',
      'period.ics',
      document([
        'DTSTART:20261103T090000Z',
        'RDATE:20261103T090000Z/P999999999999999W',
      ])
    );
    fake.seed(
      'work',
      'fine.ics',
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
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(
      (listing.events as { uid: string }[]).map((event) => event.uid)
    ).toContain('fine');
    expect((listing.notes as string[]).join(' ')).toContain(
      'Skipped "hostile.ics"'
    );
  }, 30_000);
});

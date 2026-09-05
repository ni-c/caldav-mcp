import { describe, expect, it } from 'vitest';

import {
  componentsOf,
  parseCalendar,
  readTime,
  type Kind,
} from '../src/ical.js';
import {
  expandSeries,
  parseRecurrenceId,
  spellRecurrenceId,
} from '../src/recurrence.js';

const BERLIN = 'Europe/Berlin';

/** Wraps VEVENT lines in a minimal VCALENDAR. */
function calendar(lines: string[], extra: string[] = []): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    ...extra,
    ...lines,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function event(lines: string[]): string[] {
  return [
    'BEGIN:VEVENT',
    'UID:series@example.net',
    'DTSTAMP:20260901T120000Z',
    ...lines,
    'END:VEVENT',
  ];
}

function expand(
  ics: string,
  options: {
    from: string;
    to: string;
    cap?: number;
    zone?: string;
    kind?: Kind;
  }
) {
  const root = parseCalendar(ics, 'fixture');
  return expandSeries(componentsOf(root, options.kind ?? 'vevent'), {
    from: new Date(options.from),
    to: new Date(options.to),
    cap: options.cap ?? 100,
    fallbackZone: options.zone ?? BERLIN,
  });
}

const startsOf = (result: { occurrences: { start: { instant: Date } }[] }) =>
  result.occurrences.map((occurrence) =>
    occurrence.start.instant.toISOString()
  );

describe('a rule that ends', () => {
  it('expands a daily COUNT series', () => {
    const result = expand(
      calendar(
        event([
          'DTSTART;TZID=Europe/Berlin:20260907T090000',
          'DTEND;TZID=Europe/Berlin:20260907T100000',
          'RRULE:FREQ=DAILY;COUNT=3',
          'SUMMARY:Standup',
        ])
      ),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }
    );
    expect(result.recurring).toBe(true);
    expect(startsOf(result)).toEqual([
      '2026-09-07T07:00:00.000Z',
      '2026-09-08T07:00:00.000Z',
      '2026-09-09T07:00:00.000Z',
    ]);
  });

  it('expands a weekly UNTIL series', () => {
    const result = expand(
      calendar(
        event([
          'DTSTART:20260907T070000Z',
          'DTEND:20260907T080000Z',
          'RRULE:FREQ=WEEKLY;UNTIL=20260922T000000Z',
        ])
      ),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }
    );
    expect(startsOf(result)).toEqual([
      '2026-09-07T07:00:00.000Z',
      '2026-09-14T07:00:00.000Z',
      '2026-09-21T07:00:00.000Z',
    ]);
  });
});

describe('a rule that does not end', () => {
  it('is bounded by the window, not by the rule', () => {
    const result = expand(
      calendar(
        event([
          'DTSTART:20260907T070000Z',
          'DTEND:20260907T080000Z',
          'RRULE:FREQ=DAILY',
        ])
      ),
      { from: '2026-09-07T00:00:00Z', to: '2026-09-12T00:00:00Z' }
    );
    expect(result.occurrences).toHaveLength(5);
    expect(result.truncated).toBe(false);
    expect(result.bounded).toBe(false);
  });

  it('stops on the iteration bound and says so, rather than running away', () => {
    // FREQ=SECONDLY over a month is millions of instances. The window filter
    // alone would not save the process; the iteration bound is what does.
    const started = Date.now();
    const result = expand(
      calendar(
        event([
          'DTSTART:20260907T070000Z',
          'DTEND:20260907T070100Z',
          'RRULE:FREQ=SECONDLY',
        ])
      ),
      { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', cap: 500 }
    );
    const elapsed = Date.now() - started;
    expect(result.bounded).toBe(true);
    expect(result.notes.join(' ')).toMatch(/shorter range/);
    // The point of the bound is that it is fast. If this ever takes seconds,
    // the bound stopped working rather than the machine got slower.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('the daylight-saving property', () => {
  it('keeps a daily 09:00 meeting at 09:00 across the March change', () => {
    const result = expand(
      calendar(
        event([
          'DTSTART;TZID=Europe/Berlin:20260327T090000',
          'DTEND;TZID=Europe/Berlin:20260327T100000',
          'RRULE:FREQ=DAILY;COUNT=5',
        ])
      ),
      { from: '2026-03-01T00:00:00Z', to: '2026-04-05T00:00:00Z' }
    );
    // The UTC instants move by an hour; the wall clock does not. That is the
    // whole point of expanding wall clocks and resolving them separately.
    expect(startsOf(result)).toEqual([
      '2026-03-27T08:00:00.000Z',
      '2026-03-28T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
      '2026-03-31T07:00:00.000Z',
    ]);
  });

  it('does the same when the document carries its own VTIMEZONE', () => {
    const vtimezone = [
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Berlin',
      'BEGIN:DAYLIGHT',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'TZNAME:CEST',
      'DTSTART:19700329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'TZNAME:CET',
      'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'END:VTIMEZONE',
    ];
    const result = expand(
      calendar(
        event([
          'DTSTART;TZID=Europe/Berlin:20260327T090000',
          'DTEND;TZID=Europe/Berlin:20260327T100000',
          'RRULE:FREQ=DAILY;COUNT=3',
        ]),
        vtimezone
      ),
      { from: '2026-03-01T00:00:00Z', to: '2026-04-05T00:00:00Z' }
    );
    expect(startsOf(result)).toEqual([
      '2026-03-27T08:00:00.000Z',
      '2026-03-28T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
    ]);
  });
});

describe('a hostile VTIMEZONE', () => {
  it('cannot shift an entry parsed afterwards', () => {
    // The document redefines a well-known zone. ical.js does not register a
    // parsed VTIMEZONE globally, and this server never registers one either, so
    // the redefinition must not survive into the next parse. If it ever does,
    // one calendar entry can move every appointment in the account.
    const hostile = calendar(
      event([
        'DTSTART;TZID=Europe/Berlin:20260907T090000',
        'DTEND;TZID=Europe/Berlin:20260907T100000',
      ]),
      [
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:STANDARD',
        'TZOFFSETFROM:+0900',
        'TZOFFSETTO:+0900',
        'TZNAME:EVIL',
        'DTSTART:19700101T000000',
        'END:STANDARD',
        'END:VTIMEZONE',
      ]
    );
    const innocent = calendar(
      event([
        'DTSTART;TZID=Europe/Berlin:20260907T090000',
        'DTEND;TZID=Europe/Berlin:20260907T100000',
      ])
    );

    const before = expand(innocent, {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expand(hostile, {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    const after = expand(innocent, {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });

    expect(startsOf(before)).toEqual(['2026-09-07T07:00:00.000Z']);
    expect(startsOf(after)).toEqual(startsOf(before));
  });

  it('does not even shift its own entry, because the platform zone wins', () => {
    // A known IANA id is resolved from the platform's zone database, so the
    // document's own definition of Europe/Berlin is ignored for that id.
    const hostile = calendar(
      event([
        'DTSTART;TZID=Europe/Berlin:20260907T090000',
        'DTEND;TZID=Europe/Berlin:20260907T100000',
      ]),
      [
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:STANDARD',
        'TZOFFSETFROM:+0900',
        'TZOFFSETTO:+0900',
        'TZNAME:EVIL',
        'DTSTART:19700101T000000',
        'END:STANDARD',
        'END:VTIMEZONE',
      ]
    );
    expect(
      startsOf(
        expand(hostile, {
          from: '2026-09-01T00:00:00Z',
          to: '2026-10-01T00:00:00Z',
        })
      )
    ).toEqual(['2026-09-07T07:00:00.000Z']);
  });
});

describe('EXDATE', () => {
  it('removes an occurrence when written with a TZID', () => {
    const result = expand(
      calendar(
        event([
          'DTSTART;TZID=Europe/Berlin:20260907T090000',
          'DTEND;TZID=Europe/Berlin:20260907T100000',
          'RRULE:FREQ=WEEKLY;COUNT=4',
          'EXDATE;TZID=Europe/Berlin:20260914T090000',
        ])
      ),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-15T00:00:00Z' }
    );
    expect(startsOf(result)).toEqual([
      '2026-09-07T07:00:00.000Z',
      '2026-09-21T07:00:00.000Z',
      '2026-09-28T07:00:00.000Z',
    ]);
  });

  it('removes an occurrence when the EXDATE is written in UTC and the series is not', () => {
    // The comparison is on the instant, not on the spelling. Comparing strings
    // here is the classic "my EXDATE does not work" bug.
    const result = expand(
      calendar(
        event([
          'DTSTART;TZID=Europe/Berlin:20260907T090000',
          'DTEND;TZID=Europe/Berlin:20260907T100000',
          'RRULE:FREQ=WEEKLY;COUNT=3',
          'EXDATE:20260914T070000Z',
        ])
      ),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-15T00:00:00Z' }
    );
    expect(startsOf(result)).toEqual([
      '2026-09-07T07:00:00.000Z',
      '2026-09-21T07:00:00.000Z',
    ]);
  });
});

describe('overrides', () => {
  const series = (overrides: string[]) =>
    calendar([
      ...event([
        'DTSTART;TZID=Europe/Berlin:20260907T090000',
        'DTEND;TZID=Europe/Berlin:20260907T100000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:Weekly',
      ]),
      ...overrides,
    ]);

  it('replaces the instance it names', () => {
    const result = expand(
      series([
        'BEGIN:VEVENT',
        'UID:series@example.net',
        'DTSTAMP:20260901T120000Z',
        'RECURRENCE-ID;TZID=Europe/Berlin:20260914T090000',
        'DTSTART;TZID=Europe/Berlin:20260914T140000',
        'DTEND;TZID=Europe/Berlin:20260914T150000',
        'SUMMARY:Moved to the afternoon',
        'END:VEVENT',
      ]),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-15T00:00:00Z' }
    );
    expect(startsOf(result)).toEqual([
      '2026-09-07T07:00:00.000Z',
      '2026-09-14T12:00:00.000Z',
      '2026-09-21T07:00:00.000Z',
    ]);
    const moved = result.occurrences[1];
    expect(moved?.isOverride).toBe(true);
    expect(moved?.component.getFirstPropertyValue('summary')).toBe(
      'Moved to the afternoon'
    );
  });

  it('appears when it was moved to after the window the rule generates in', () => {
    // The instance belongs to 14 September but was pushed to 20 October. A walk
    // that stops at the window edge would never generate it, so pass B has to
    // find it. This is the failure that makes a moved meeting vanish.
    const result = expand(
      series([
        'BEGIN:VEVENT',
        'UID:series@example.net',
        'DTSTAMP:20260901T120000Z',
        'RECURRENCE-ID;TZID=Europe/Berlin:20260914T090000',
        'DTSTART;TZID=Europe/Berlin:20261020T090000',
        'DTEND;TZID=Europe/Berlin:20261020T100000',
        'SUMMARY:Pushed back a month',
        'END:VEVENT',
      ]),
      { from: '2026-10-15T00:00:00Z', to: '2026-10-25T00:00:00Z' }
    );
    expect(startsOf(result)).toEqual(['2026-10-20T07:00:00.000Z']);
  });

  it('does not appear when it was moved out of the window', () => {
    // Its RECURRENCE-ID is inside the window and its actual time is not. The
    // window has to be tested against the instance, not against the rule.
    const result = expand(
      series([
        'BEGIN:VEVENT',
        'UID:series@example.net',
        'DTSTAMP:20260901T120000Z',
        'RECURRENCE-ID;TZID=Europe/Berlin:20260914T090000',
        'DTSTART;TZID=Europe/Berlin:20261201T090000',
        'DTEND;TZID=Europe/Berlin:20261201T100000',
        'END:VEVENT',
      ]),
      { from: '2026-09-13T00:00:00Z', to: '2026-09-16T00:00:00Z' }
    );
    expect(result.occurrences).toHaveLength(0);
  });

  it('reports a RANGE=THISANDFUTURE series instead of expanding it wrongly', () => {
    const result = expand(
      series([
        'BEGIN:VEVENT',
        'UID:series@example.net',
        'DTSTAMP:20260901T120000Z',
        'RECURRENCE-ID;TZID=Europe/Berlin;RANGE=THISANDFUTURE:20260914T090000',
        'DTSTART;TZID=Europe/Berlin:20260914T140000',
        'DTEND;TZID=Europe/Berlin:20260914T150000',
        'END:VEVENT',
      ]),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-15T00:00:00Z' }
    );
    expect(result.notes.join(' ')).toMatch(/THISANDFUTURE/);
  });
});

describe('a document with overrides and no master', () => {
  it('reports each one on its own and says why', () => {
    const result = expand(
      calendar([
        'BEGIN:VEVENT',
        'UID:orphan@example.net',
        'DTSTAMP:20260901T120000Z',
        'RECURRENCE-ID:20260914T070000Z',
        'DTSTART:20260914T070000Z',
        'DTEND:20260914T080000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:orphan@example.net',
        'DTSTAMP:20260901T120000Z',
        'RECURRENCE-ID:20260921T070000Z',
        'DTSTART:20260921T090000Z',
        'DTEND:20260921T100000Z',
        'END:VEVENT',
      ]),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }
    );
    expect(startsOf(result)).toEqual([
      '2026-09-14T07:00:00.000Z',
      '2026-09-21T09:00:00.000Z',
    ]);
    expect(result.notes.join(' ')).toMatch(/no master component/);
  });
});

describe('all-day entries', () => {
  it('expands a weekly all-day series and marks it as such', () => {
    const result = expand(
      calendar(
        event([
          'DTSTART;VALUE=DATE:20260907',
          'DTEND;VALUE=DATE:20260908',
          'RRULE:FREQ=WEEKLY;COUNT=3',
        ])
      ),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }
    );
    expect(result.occurrences).toHaveLength(3);
    expect(result.occurrences[0]?.start.allDay).toBe(true);
    // Midnight in the fallback zone, not midnight UTC.
    expect(startsOf(result)[0]).toBe('2026-09-06T22:00:00.000Z');
  });

  it('treats the exclusive DTEND as the end of the day, so the day overlaps', () => {
    // A one-day entry runs 07 Sep to 08 Sep exclusive. A window covering only
    // the 7th must find it.
    const result = expand(
      calendar(
        event(['DTSTART;VALUE=DATE:20260907', 'DTEND;VALUE=DATE:20260908'])
      ),
      { from: '2026-09-07T00:00:00Z', to: '2026-09-08T00:00:00Z' }
    );
    expect(result.occurrences).toHaveLength(1);
  });
});

describe('a floating series', () => {
  it('is resolved in the configured zone', () => {
    const result = expand(
      calendar(
        event([
          'DTSTART:20260907T090000',
          'DTEND:20260907T100000',
          'RRULE:FREQ=DAILY;COUNT=2',
        ])
      ),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z', zone: BERLIN }
    );
    expect(startsOf(result)).toEqual([
      '2026-09-07T07:00:00.000Z',
      '2026-09-08T07:00:00.000Z',
    ]);
  });
});

describe('a single non-recurring entry', () => {
  it('is reported once and not marked recurring', () => {
    const result = expand(
      calendar(event(['DTSTART:20260907T070000Z', 'DTEND:20260907T080000Z'])),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }
    );
    expect(result.recurring).toBe(false);
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]?.recurrenceId).toBeUndefined();
  });

  it('is left out when it does not overlap the window', () => {
    const result = expand(
      calendar(event(['DTSTART:20260907T070000Z', 'DTEND:20260907T080000Z'])),
      { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }
    );
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('the cap', () => {
  it('stops collecting and says the result is truncated', () => {
    const result = expand(
      calendar(
        event([
          'DTSTART:20260907T070000Z',
          'DTEND:20260907T080000Z',
          'RRULE:FREQ=DAILY',
        ])
      ),
      { from: '2026-09-07T00:00:00Z', to: '2027-09-07T00:00:00Z', cap: 10 }
    );
    expect(result.occurrences).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });
});

describe('recurrence id spelling', () => {
  const roundTrip = (ics: string) => {
    const root = parseCalendar(ics, 'fixture');
    const [component] = componentsOf(root, 'vevent');
    const start = readTime(component as never, 'dtstart', BERLIN);
    const spelling = spellRecurrenceId(start as never, BERLIN);
    return { spelling, parsed: parseRecurrenceId(spelling, BERLIN) };
  };

  it('round-trips a UTC value', () => {
    const { spelling, parsed } = roundTrip(
      calendar(event(['DTSTART:20260907T070000Z', 'DTEND:20260907T080000Z']))
    );
    expect(spelling).toBe('20260907T070000Z');
    expect(parsed.instant.toISOString()).toBe('2026-09-07T07:00:00.000Z');
  });

  it('round-trips a zoned value, keeping the zone', () => {
    const { spelling, parsed } = roundTrip(
      calendar(
        event([
          'DTSTART;TZID=Europe/Berlin:20260907T090000',
          'DTEND;TZID=Europe/Berlin:20260907T100000',
        ])
      )
    );
    expect(spelling).toBe('TZID=Europe/Berlin:20260907T090000');
    expect(parsed.instant.toISOString()).toBe('2026-09-07T07:00:00.000Z');
    expect(parsed.zone).toBe(BERLIN);
  });

  it('round-trips an all-day value', () => {
    const { spelling, parsed } = roundTrip(
      calendar(
        event(['DTSTART;VALUE=DATE:20260907', 'DTEND;VALUE=DATE:20260908'])
      )
    );
    expect(spelling).toBe('VALUE=DATE:20260907');
    expect(parsed.allDay).toBe(true);
  });

  it('round-trips an all-day value that carries a zone', () => {
    // A TZID on a DATE is not conforming, and servers store it anyway. The
    // spelling used to render the date in that zone and record only the date,
    // so reading it back in the *fallback* zone produced a different instant —
    // spell and parse were not inverses. Downstream that meant the write path
    // could not find the override that was already there, cloned a second one
    // off the master, and left two components claiming one instance.
    const { spelling, parsed } = roundTrip(
      calendar(
        event([
          'DTSTART;VALUE=DATE;TZID=America/Los_Angeles:20260921',
          'DTEND;VALUE=DATE:20260922',
        ])
      )
    );
    expect(spelling).toBe('VALUE=DATE;TZID=America/Los_Angeles:20260921');
    expect(parsed.allDay).toBe(true);
    expect(parsed.zone).toBe('America/Los_Angeles');
    // The property that matters: the instant survives the trip unchanged.
    const direct = readTime(
      componentsOf(
        parseCalendar(
          calendar(
            event([
              'DTSTART;VALUE=DATE;TZID=America/Los_Angeles:20260921',
              'DTEND;VALUE=DATE:20260922',
            ])
          ),
          'fixture'
        ),
        'vevent'
      )[0] as never,
      'dtstart',
      BERLIN
    );
    expect(parsed.instant.getTime()).toBe(
      (direct as { instant: Date }).instant.getTime()
    );
  });

  it('still reads a zone-less all-day spelling in the fallback zone', () => {
    expect(
      parseRecurrenceId('VALUE=DATE:20260907', BERLIN).instant.toISOString()
    ).toBe('2026-09-06T22:00:00.000Z');
  });

  it('refuses a spelling it did not produce', () => {
    expect(() => parseRecurrenceId('next tuesday', BERLIN)).toThrow(
      /does not name an occurrence/
    );
  });
});

describe('tasks and journals', () => {
  it('expands a recurring VTODO by its DUE date', () => {
    const result = expand(
      calendar([
        'BEGIN:VTODO',
        'UID:task@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART;TZID=Europe/Berlin:20260907T090000',
        'DUE;TZID=Europe/Berlin:20260907T170000',
        'RRULE:FREQ=WEEKLY;COUNT=2',
        'SUMMARY:Weekly report',
        'END:VTODO',
      ]),
      {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
        kind: 'vtodo',
      }
    );
    expect(startsOf(result)).toEqual([
      '2026-09-07T07:00:00.000Z',
      '2026-09-14T07:00:00.000Z',
    ]);
  });

  it('reports a VJOURNAL that has only a start', () => {
    const result = expand(
      calendar([
        'BEGIN:VJOURNAL',
        'UID:note@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART;VALUE=DATE:20260907',
        'SUMMARY:Notes',
        'END:VJOURNAL',
      ]),
      {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
        kind: 'vjournal',
      }
    );
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]?.end).toBeUndefined();
  });
});

describe('a zone name the platform does not know', () => {
  const exchange = [
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
  ];

  it('never travels as a zone, so nothing downstream hands it to Intl', () => {
    // The shape Exchange emits. The document's own VTIMEZONE decides the
    // instant; the *name* used to be carried along and reached
    // `Intl.DateTimeFormat` when the entry was rendered — a RangeError out of
    // the whole listing, planted by one invitation.
    const result = expand(
      calendar(
        event([
          'DTSTART;TZID=Customized Time Zone:20260907T090000',
          'DTEND;TZID=Customized Time Zone:20260907T100000',
          'RRULE:FREQ=DAILY;COUNT=2',
          'SUMMARY:From Exchange',
        ]),
        exchange
      ),
      { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }
    );
    expect(result.occurrences).toHaveLength(2);
    for (const occurrence of result.occurrences) {
      expect(occurrence.start.zone).toBeUndefined();
      expect(() => spellRecurrenceId(occurrence.start, BERLIN)).not.toThrow();
    }
    // The VTIMEZONE above is Central European time, so 09:00 is 07:00Z.
    expect(startsOf(result)[0]).toBe('2026-09-07T07:00:00.000Z');
  });

  it('is dropped from a RECURRENCE-ID spelling as well', () => {
    const time = parseRecurrenceId(
      'TZID=Nowhere/Nothing:20260907T090000',
      BERLIN
    );
    expect(time.zone).toBeUndefined();
    expect(spellRecurrenceId(time, BERLIN)).toBe('20260907T070000Z');
  });
});

describe('a resource with thousands of edited occurrences', () => {
  function overrides(count: number): string[] {
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const day = String(1 + (index % 28)).padStart(2, '0');
      const month = String(1 + (Math.floor(index / 28) % 12)).padStart(2, '0');
      const year = 2000 + Math.floor(index / 336);
      lines.push(
        'BEGIN:VEVENT',
        'UID:series@example.net',
        'DTSTAMP:20260901T120000Z',
        `RECURRENCE-ID;TZID=Europe/Berlin:${year}${month}${day}T090000`,
        `DTSTART;TZID=Europe/Berlin:${year}${month}${day}T100000`,
        `DTEND;TZID=Europe/Berlin:${year}${month}${day}T110000`,
        'SUMMARY:Moved',
        'END:VEVENT'
      );
    }
    return lines;
  }

  it('reads a bounded number of them and says so', () => {
    const root = parseCalendar(
      calendar([
        ...event([
          'DTSTART;TZID=Europe/Berlin:20000101T090000',
          'DTEND;TZID=Europe/Berlin:20000101T100000',
          'RRULE:FREQ=DAILY',
          'SUMMARY:Daily',
        ]),
        ...overrides(2_500),
      ]),
      'fixture'
    );
    const result = expandSeries(componentsOf(root, 'vevent'), {
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-08T00:00:00Z'),
      cap: 100,
      fallbackZone: BERLIN,
    });
    expect(result.bounded).toBe(true);
    expect(result.notes.join(' ')).toMatch(/more than 2000 edited occurrences/);
  });

  it('stops on an expired deadline before resolving them all', () => {
    // The rule walk honoured the deadline; the override loops did not, and
    // they are the expensive half. Measured before the fix: over a second for
    // twenty thousand overrides with a deadline already in the past.
    const root = parseCalendar(
      calendar([
        ...event([
          'DTSTART;TZID=Europe/Berlin:20000101T090000',
          'DTEND;TZID=Europe/Berlin:20000101T100000',
          'RRULE:FREQ=DAILY',
          'SUMMARY:Daily',
        ]),
        ...overrides(2_000),
      ]),
      'fixture'
    );
    const started = Date.now();
    const result = expandSeries(componentsOf(root, 'vevent'), {
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-08T00:00:00Z'),
      cap: 100,
      fallbackZone: BERLIN,
      deadline: Date.now() - 1,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.bounded).toBe(true);
    expect(result.notes.join(' ')).toMatch(/took too long/);
  });
});

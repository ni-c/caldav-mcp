import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildOccurrenceId,
  buildSeriesId,
  isOccurrenceId,
  parseEntityId,
  seriesIdOf,
  type CalendarLookup,
} from '../src/entity-id.js';
import { decodeCalendarData } from '../src/dav-xml.js';
import { CalendarNotAllowedError, ToolInputError } from '../src/errors.js';
import type { Kind } from '../src/ical.js';
import { normaliseEtag } from '../src/api.js';
import type { CalendarEntry } from '../src/calendars.js';
import { componentsOf, ICAL, parseCalendar, readInt } from '../src/ical.js';
import {
  shapedEvent,
  shapedJournal,
  shapedTask,
} from '../src/output-schema.js';
import { redactUrlCredentials } from '../src/redact.js';
import { expandSeries } from '../src/recurrence.js';
import { alarmParam } from '../src/schema.js';
import { calendarId, shapeEntry } from '../src/shape.js';
import { parseRecurrenceId, spellRecurrenceId } from '../src/recurrence.js';

/**
 * Properties, as opposed to the examples in the other files.
 *
 * An example test says "this input maps to that output" and is only as good as
 * the inputs someone thought of. The checks here state what must hold for *all*
 * inputs and let fast-check search for the counterexample — which is the right
 * shape for this code, because every function below reads a string that a
 * CalDAV server or an operator wrote, and the interesting cases are the ones
 * nobody would type on purpose.
 *
 * Two conventions:
 *
 * - Failures are reproducible. `numRuns` is fixed and the seed is printed by
 *   fast-check on a counterexample, so a red CI run can be replayed exactly.
 * - Nothing here asserts "does not throw" and stops. A parser that swallows
 *   everything is as wrong as one that crashes; the assertions say *which*
 *   error is allowed.
 */

const RUNS = { numRuns: 500 };

const ALLOWED = '/tester/work/';
const KNOWN = '/tester/shared/';

const registry: CalendarLookup = {
  allows: (path) => path === ALLOWED,
  knows: (path) => path === ALLOWED || path === KNOWN,
};

const kinds: Kind[] = ['vevent', 'vtodo', 'vjournal'];

const FALLBACK_ZONE = 'UTC';

/** Zones the platform knows, including the ones with a half-hour offset. */
const zones = [
  undefined,
  'UTC',
  'Europe/Berlin',
  'Europe/Luxembourg',
  'America/New_York',
  'Asia/Kolkata',
  'Australia/Adelaide',
  'Pacific/Chatham',
] as const;

/** Instants across a wide span, including both sides of a DST transition. */
const instant = fc
  .integer({ min: Date.UTC(1970, 0, 1), max: Date.UTC(2100, 0, 1) })
  .map((ms) => new Date(ms - (ms % 1000)));

/** Exactly the four shapes {@link spellRecurrenceId} can emit. */
const recurrenceSpelling = fc
  .tuple(instant, fc.constantFrom(...zones), fc.boolean())
  .map(([at, zone, allDay]) =>
    spellRecurrenceId({ instant: at, zone, allDay, utc: false }, FALLBACK_ZONE)
  );

/**
 * A resource name the scheme is meant to carry.
 *
 * The exclusions mirror the decoder's rules rather than restating them as a
 * regex: what is filtered out here is exactly what `parseEntityId` refuses, so
 * a change to one side without the other shows up as a failing round trip
 * instead of as a silently narrower test.
 */
const resourceName = fc.string({ minLength: 1, unit: 'binary' }).filter(
  (name) =>
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.startsWith('.') &&
    !/%2e/i.test(name) &&
    ![...name].some((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || c === '?' || c === '#';
    })
);

describe('entity ids round trip', () => {
  it('a series id decodes back to the calendar and resource it was built from', () => {
    fc.assert(
      fc.property(fc.constantFrom(...kinds), resourceName, (kind, name) => {
        const decoded = parseEntityId(
          buildSeriesId(kind, ALLOWED, name),
          kind,
          registry
        );
        expect(decoded.kind).toBe(kind);
        expect(decoded.calendarPath).toBe(ALLOWED);
        expect(decoded.resourceName).toBe(name);
        expect(decoded.recurrenceId).toBeUndefined();
        expect(isOccurrenceId(decoded)).toBe(false);
      }),
      RUNS
    );
  });

  /**
   * The occurrence round trip, stated over the spellings that actually occur.
   *
   * `recurrenceId` is never a string from the wire: `shape.ts` fills it from
   * {@link spellRecurrenceId}, which emits one of four shapes built from an
   * instant and an `isKnownZone` name. Generating arbitrary strings here found
   * that `buildOccurrenceId` will happily encode a value its own decoder
   * refuses — a NUL, say — which is true but unreachable, and pinning it would
   * have frozen an asymmetry nothing can exercise. Driving the generator
   * through `spellRecurrenceId` instead states the contract that has to hold:
   * whatever the expander spells, the id layer carries back intact.
   */
  it('an occurrence id carries its RECURRENCE-ID and reduces to its series', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...kinds),
        resourceName,
        recurrenceSpelling,
        (kind, name, recurrence) => {
          const id = buildOccurrenceId(kind, ALLOWED, name, recurrence);
          const decoded = parseEntityId(id, kind, registry);
          expect(decoded.recurrenceId).toBe(recurrence);
          expect(isOccurrenceId(decoded)).toBe(true);
          expect(seriesIdOf(decoded)).toBe(buildSeriesId(kind, ALLOWED, name));
        }
      ),
      RUNS
    );
  });

  /**
   * `spellRecurrenceId` and `parseRecurrenceId` are inverses.
   *
   * The comment in `recurrence.ts` records what it costs when they are not: an
   * all-day occurrence carrying a TZID was spelled in one zone and read back in
   * another, the write path failed to find the override that already existed,
   * cloned a second one off the master, and left two components claiming the
   * same instance. That is a data-corrupting bug found by hand once; this is
   * the same statement made over every zone and instant.
   */
  it('spelling a RECURRENCE-ID and reading it back names the same instant', () => {
    fc.assert(
      fc.property(
        instant,
        fc.constantFrom(...zones),
        fc.boolean(),
        (at, zone, allDay) => {
          const spelled = spellRecurrenceId(
            { instant: at, zone, allDay, utc: false },
            FALLBACK_ZONE
          );
          const read = parseRecurrenceId(spelled, FALLBACK_ZONE);
          expect(read.allDay).toBe(allDay);
          expect(spellRecurrenceId(read, FALLBACK_ZONE)).toBe(spelled);
        }
      ),
      RUNS
    );
  });
});

describe('entity ids reject everything else', () => {
  /**
   * Totality: an arbitrary string is either a valid id or a typed refusal.
   *
   * This is the property that matters for an id, because the argument arrives
   * from the model and every other guarantee in the module — the allowlist, the
   * path checks — is only reachable if the decoder never fails in some fourth
   * way, such as a `TypeError` out of `Buffer.from` or an id that decodes to a
   * path the caller then trusts.
   */
  it('an arbitrary string either decodes or raises a typed error', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (candidate) => {
        try {
          const decoded = parseEntityId(candidate, 'vevent', registry);
          expect(decoded.calendarPath).toBe(ALLOWED);
          expect(decoded.resourceName.length).toBeGreaterThan(0);
        } catch (error) {
          expect(
            error instanceof ToolInputError ||
              error instanceof CalendarNotAllowedError
          ).toBe(true);
        }
      }),
      RUNS
    );
  });

  /**
   * The base64url decode is one-to-one.
   *
   * `Buffer.from(…, 'base64url')` is lenient — it ignores characters outside
   * the alphabet and accepts a truncated group — so without the re-encode
   * check in `decode` two different ids could name the same calendar. That is
   * an allowlist bypass, not a cosmetic issue: it lets a hand-built id reach a
   * path the operator did not permit. Stated as a property rather than as the
   * three examples someone happened to try.
   */
  it('no mutated id decodes to an allowed calendar', () => {
    const valid = buildSeriesId('vevent', ALLOWED, 'a1b2c3.ics');
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: valid.length - 1 }),
        fc.constantFrom('=', '+', '/', ' ', '\n', '\0', 'ä'),
        (index, injected) => {
          const mutated =
            valid.slice(0, index) + injected + valid.slice(index + 1);
          fc.pre(mutated !== valid);
          expect(() => parseEntityId(mutated, 'vevent', registry)).toThrow();
        }
      ),
      RUNS
    );
  });

  it('a calendar outside the allowlist is refused by name, not by 404', () => {
    fc.assert(
      fc.property(resourceName, (name) => {
        expect(() =>
          parseEntityId(
            buildSeriesId('vevent', KNOWN, name),
            'vevent',
            registry
          )
        ).toThrow(CalendarNotAllowedError);
      }),
      RUNS
    );
  });
});

describe('credential redaction', () => {
  /**
   * The three properties that make `redactUrlCredentials` safe to call on a
   * value about to be logged, whatever the operator actually typed.
   */
  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (value) => {
        const once = redactUrlCredentials(value);
        expect(redactUrlCredentials(once)).toBe(once);
      }),
      RUNS
    );
  });

  it('leaves a URL without credentials byte-identical', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        fc.pre(!url.includes('@'));
        expect(redactUrlCredentials(url)).toBe(url);
      }),
      RUNS
    );
  });

  it('never lets a password reach the output', () => {
    fc.assert(
      fc.property(
        fc.webUrl().filter((url) => !url.includes('@')),
        fc.stringMatching(/^[A-Za-z0-9]{6,20}$/),
        fc.stringMatching(/^[A-Za-z0-9]{6,20}$/),
        (url, user, password) => {
          const [scheme, rest] = url.split('://') as [string, string];
          const withCredentials = `${scheme}://${user}:${password}@${rest}`;
          const redacted = redactUrlCredentials(withCredentials);
          expect(redacted).not.toContain(password);
          expect(redacted).toContain('***@');
        }
      ),
      RUNS
    );
  });
});

// ---------------------------------------------------------------------------
// Second pass, 2026-09-07: the parsers and the shape layer.
// ---------------------------------------------------------------------------

/** A TEXT value as it sits on a content line: escaped, no line break. */
function icsText(value: string): string {
  return value
    .replace(/[\r\n]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/** Characters that must never reach a result: C0, DEL, and the invisible set. */
const FORBIDDEN = [0x00, 0x07, 0x1b, 0x7f, 0x200b, 0x202e, 0xfeff].map((code) =>
  String.fromCodePoint(code)
);

/** Property values a calendar can carry: text, numbers, and the awkward ones. */
const propertyValue = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme', maxLength: 60 }),
  fc.integer().map(String),
  fc.double({ noNaN: false }).map(String),
  fc.constantFrom(
    '1.5',
    '1e20',
    '99999999999999999999',
    'abc',
    '-0',
    'Infinity',
    '0x10',
    '',
    ' ',
    'constructor',
    '__proto__'
  )
);

const valueType = fc.constantFrom(
  '',
  ';VALUE=FLOAT',
  ';VALUE=TEXT',
  ';VALUE=INTEGER'
);

const CALENDAR_ENTRY: CalendarEntry = {
  url: 'https://dav.example.net/tester/work/',
  path: '/tester/work/',
  displayName: 'Work',
  description: undefined,
  components: [],
  ctag: undefined,
  color: undefined,
  readOnly: false,
};

/** A parameter value: no delimiter, no quote, no line break, no space. */
const param = (value: string): string =>
  value.replace(/[\r\n;:"]/g, '').replace(/[ -]/g, '');

/** One component of the given kind with arbitrary property values. */
const component = fc
  .record({
    kind: fc.constantFrom(...kinds),
    summary: propertyValue,
    description: propertyValue,
    location: propertyValue,
    categories: propertyValue,
    status: propertyValue,
    url: propertyValue,
    priority: fc.tuple(valueType, propertyValue),
    percent: fc.tuple(valueType, propertyValue),
    sequence: fc.tuple(valueType, propertyValue),
    size: propertyValue,
    fmttype: propertyValue,
    cn: propertyValue,
    partstat: propertyValue,
    role: propertyValue,
    trigger: propertyValue,
  })
  .map((v) => {
    const name = { vevent: 'VEVENT', vtodo: 'VTODO', vjournal: 'VJOURNAL' }[
      v.kind
    ];
    return {
      kind: v.kind,
      ics: [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//t//EN',
        `BEGIN:${name}`,
        'UID:p@example.net',
        'DTSTAMP:20260901T120000Z',
        'DTSTART:20260907T070000Z',
        ...(v.kind === 'vevent' ? ['DTEND:20260907T080000Z'] : []),
        ...(v.kind === 'vtodo' ? ['DUE:20260908T080000Z'] : []),
        `SUMMARY:${icsText(v.summary)}`,
        `DESCRIPTION:${icsText(v.description)}`,
        `LOCATION:${icsText(v.location)}`,
        `CATEGORIES:${icsText(v.categories)}`,
        `STATUS:${icsText(v.status)}`,
        `URL:${icsText(v.url)}`,
        `PRIORITY${v.priority[0]}:${icsText(v.priority[1])}`,
        `PERCENT-COMPLETE${v.percent[0]}:${icsText(v.percent[1])}`,
        `SEQUENCE${v.sequence[0]}:${icsText(v.sequence[1])}`,
        `ATTACH;FMTTYPE=${param(v.fmttype)};SIZE=${param(v.size)}:https://files.example/a`,
        `ATTENDEE;CN="${param(v.cn)}";PARTSTAT=${param(v.partstat)};ROLE=${param(v.role)}:mailto:a@example.net`,
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'DESCRIPTION:Reminder',
        `TRIGGER:${icsText(v.trigger)}`,
        'END:VALARM',
        `END:${name}`,
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    };
  });

describe('what somebody else wrote, read', () => {
  it('is parsed, or refused with a typed one-line error', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.string({ unit: 'binary' }),
          component.map((c) => c.ics),
          component.map((c) =>
            c.ics.replace('END:VCALENDAR', 'END:VCALENDAR\r\nBEGIN:X')
          )
        ),
        (text) => {
          try {
            parseCalendar(text, 'the entry');
          } catch (error) {
            expect(error).toBeInstanceOf(ToolInputError);
            const message = (error as Error).message;
            expect(message).not.toMatch(/[\r\n]/);
            expect(message.length).toBeLessThan(400);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it('always shapes into what the output schema promises', () => {
    // The K-02 class, pinned for every value rather than the two that were
    // found: whatever a calendar holds, a listing must be answerable.
    const schemas = {
      vevent: shapedEvent,
      vtodo: shapedTask,
      vjournal: shapedJournal,
    };
    fc.assert(
      fc.property(component, ({ kind, ics }) => {
        let root;
        try {
          root = parseCalendar(ics, 'the entry');
        } catch (error) {
          expect(error).toBeInstanceOf(ToolInputError);
          return;
        }
        const { occurrences } = expandSeries(componentsOf(root, kind), {
          from: new Date('2026-01-01T00:00:00Z'),
          to: new Date('2027-01-01T00:00:00Z'),
          cap: 10,
          fallbackZone: FALLBACK_ZONE,
        });
        const occurrence = occurrences[0];
        if (occurrence === undefined) return;
        for (const detailed of [false, true]) {
          const shaped = shapeEntry(occurrence, {
            kind,
            calendar: CALENDAR_ENTRY,
            resourceName: 'p.ics',
            fallbackZone: FALLBACK_ZONE,
            detailed,
            selfAddresses: ['a@example.net'],
          });
          const parsed = schemas[kind].safeParse(shaped.entry);
          expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(
            true
          );
          const json = JSON.stringify(shaped.entry);
          expect(JSON.parse(json)).toEqual(shaped.entry);
          for (const forbidden of FORBIDDEN) {
            expect(json.includes(forbidden)).toBe(false);
          }
          for (const field of ['priority', 'percent_complete', 'sequence']) {
            const value = (shaped.entry as Record<string, unknown>)[field];
            if (value !== undefined) {
              expect(Number.isSafeInteger(value)).toBe(true);
            }
          }
        }
      }),
      RUNS
    );
  });

  it('reads an integer property as a safe integer or not at all', () => {
    fc.assert(
      fc.property(valueType, propertyValue, (type, value) => {
        const root = parseCalendar(
          [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//t//EN',
            'BEGIN:VTODO',
            'UID:i@example.net',
            'DTSTAMP:20260901T120000Z',
            `PRIORITY${type}:${icsText(value)}`,
            'END:VTODO',
            'END:VCALENDAR',
            '',
          ].join('\r\n'),
          'the entry'
        );
        const todo = componentsOf(root, 'vtodo')[0];
        if (todo === undefined) return;
        const read = readInt(todo, 'priority');
        expect(read === undefined || Number.isSafeInteger(read)).toBe(true);
      }),
      RUNS
    );
  });
});

describe('what goes back out on the wire', () => {
  it('normalises an ETag to nothing or to an entity-tag', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = normaliseEtag(raw);
        expect(
          result === undefined || /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(result)
        ).toBe(true);
      }),
      RUNS
    );
  });

  it('accepts a duration only when ical.js reads it whole', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[+-]?[Pp][0-9DdTtHhMmSsWw]{1,14}$/),
        (trigger) => {
          const accepted = alarmParam.safeParse({ trigger }).success;
          if (!accepted) return;
          const duration = ICAL.Duration.fromString(trigger.toUpperCase());
          expect(Number.isFinite(duration.toSeconds())).toBe(true);
          expect(duration.toString()).toMatch(/^-?P/);
        }
      ),
      RUNS
    );
  });

  it('prints a calendar id as the URL parser spelled it', () => {
    fc.assert(
      fc.property(fc.webPath(), (path) => {
        const spelled = new URL(
          `https://h${path.startsWith('/') ? '' : '/'}${path}`
        ).pathname;
        expect(calendarId(spelled)).toBe(spelled);
      }),
      RUNS
    );
  });
});

/** How a server has to write one; `]]>` cannot appear inside a section. */
function wrapCdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

/**
 * The property the Open-Xchange dialect broke in the sibling server.
 *
 * A CDATA section is a way of carrying text through XML unaltered, so
 * unwrapping one has to give back exactly what the server put in — including
 * the sequences that force it to split the section, which are the ones a
 * hand-written example is least likely to try.
 */
describe('a CDATA section carries any text a server puts in it', () => {
  it('unwraps to what was wrapped, whatever the document said', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(decodeCalendarData(wrapCdata(text))).toBe(text.trim());
      }),
      RUNS
    );
  });

  it('leaves entity references inside a section untouched', () => {
    // Inside CDATA `&amp;` is five characters and the document means them.
    fc.assert(
      fc.property(
        fc.constantFrom('&amp;', '&#13;', '&#0;', '&lt;', '&#x0A;'),
        (entity) => {
          expect(decodeCalendarData(wrapCdata(`SUMMARY:${entity}`))).toBe(
            `SUMMARY:${entity}`
          );
        }
      ),
      RUNS
    );
  });

  it('never throws, whatever a hostile server sends', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (value) => {
        expect(() => decodeCalendarData(value)).not.toThrow();
      }),
      RUNS
    );
  });
});

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
import { CalendarNotAllowedError, ToolInputError } from '../src/errors.js';
import type { Kind } from '../src/ical.js';
import { redactUrlCredentials } from '../src/redact.js';
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

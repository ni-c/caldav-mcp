import ICAL from 'ical.js';

import { ToolInputError } from './errors.js';

/**
 * Bounds on the loops inside ical.js that a stored entry can drive.
 *
 * Calendar content is written by strangers, and ical.js has loops whose length
 * the document chooses: a rule whose parts never match spins inside one
 * `RecurIterator.next()`, a fifteen-digit `INTERVAL` or a period of a billion
 * weeks walks one day or one month at a time, a YEARLY rule searches up to the
 * year 20000, and a VTIMEZONE's own rules are expanded whenever a time in that
 * zone is compared — from inside the library, wherever this server reads a
 * time. Each froze or crashed this single-threaded process with one invitation.
 *
 * The library's primitives are wrapped here, once, for the whole process:
 *
 * - **Size checks are unconditional.** A rule step longer than four hundred
 *   years, or a duration or normalisation longer than ten thousand, is
 *   refused wherever it happens.
 * - **Rule work is budgeted.** Every rule check and every year expanded spends
 *   from a guard. A series walk sets one with {@link guarded}; a timezone
 *   expansion always runs on a budget of its own.
 * - **A timezone that failed stays failed.** Its next use is refused at once,
 *   rather than paying the budget again for every time it is asked about.
 *
 * The document is also checked before ical.js evaluates any of it: see
 * `assertEvaluable` in ical.ts.
 */

/** The longest rule step this server lets ical.js walk: four hundred years. */
export const MAX_STEP_DAYS = 146_097;

/**
 * The longest duration added to a time: ten thousand years. What it stops is a
 * billion weeks, which ical.js's normalisation walks a month at a time.
 */
const MAX_DURATION_DAYS = 3_652_425;

/** Rule checks one series walk may cost, across all of its steps. */
const MAX_RULE_CHECKS = 100_000;

/**
 * Rule checks one timezone expansion may cost, on its own budget: a real zone
 * defined from 1601, the way Exchange writes it, costs some 55,000 to reach
 * the present, and must not eat the budget of the series being walked.
 */
const MAX_ZONE_CHECKS = 200_000;
const ZONE_BUDGET_MS = 250;

/**
 * A guard tripped. A `ToolInputError`, so wherever it surfaces it reads as a
 * stored entry this server cannot evaluate, never as a crash; a series walk
 * catches it first and reports itself incomplete.
 */
export class RuleTooExpensive extends ToolInputError {
  constructor(
    message = 'caldav-mcp: the stored entry could not be evaluated within ' +
      "this server's budget. This is the stored entry, not the arguments of " +
      'this call.'
  ) {
    super(message);
    this.name = 'RuleTooExpensive';
  }
}

let ruleGuard: { left: number; deadline: number } | undefined;

/**
 * Clears the guard state after a hard limit stopped work mid-way: V8's
 * termination runs no `finally`, so whatever guard was set stays set.
 */
export function resetGuards(): void {
  ruleGuard = undefined;
}

/** Runs `walk` under a fresh guard, restoring whatever was there before. */
export function guarded<T>(deadline: number, walk: () => T): T {
  const previous = ruleGuard;
  ruleGuard = { left: MAX_RULE_CHECKS, deadline };
  try {
    return walk();
  } finally {
    ruleGuard = previous;
  }
}

/**
 * Spends `weight` of the guard and checks the clock on every call: a single
 * call can cost milliseconds, and checking only every so often multiplied that
 * by the stride.
 */
function spendGuard(weight: number): void {
  if (ruleGuard === undefined) return;
  ruleGuard.left -= weight;
  if (ruleGuard.left < 0 || Date.now() > ruleGuard.deadline) {
    throw new RuleTooExpensive();
  }
}

function tooLong(days: number, limit: number): boolean {
  return !Number.isFinite(days) || Math.abs(days) > limit;
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

/** Replaces a prototype method with `wrap(original)`. */
function patch(
  prototype: object,
  name: string,
  wrap: (original: Method) => Method
): void {
  const target = prototype as Record<string, Method>;
  const original = target[name];
  if (typeof original !== 'function') {
    throw new TypeError(`ical.js has no ${name} to bound`);
  }
  target[name] = wrap(original);
}

const iterator = ICAL.RecurIterator.prototype;

// Stepping a month or a year is what every loop over months does, the ones in
// an iterator's constructor included: a fifth Sunday every 48 months from a
// February that is never a leap year was searched for ever there.
for (const name of ['increment_month', 'increment_year']) {
  patch(
    iterator,
    name,
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        spendGuard(1);
        return original.apply(this, args);
      }
  );
}

// The loop that runs until a candidate passes the rule's parts; only MONTHLY
// and YEARLY count their misses in ical.js. Hot, so no rest arguments.
patch(
  iterator,
  'check_contracting_rules',
  (original) =>
    function (this: unknown) {
      spendGuard(1);
      return original.call(this);
    }
);

// A YEARLY iterator searches for a year its parts match, a whole year of days
// per call, in its constructor.
patch(
  iterator,
  'expand_year_days',
  (original) =>
    function (this: unknown, year: unknown) {
      spendGuard(64);
      return original.call(this, year);
    }
);

// A DAILY, WEEKLY or finer rule moves INTERVAL days per step, one day at a
// time, before anything else runs.
patch(
  iterator,
  'increment_monthday',
  (original) =>
    function (this: unknown, days: unknown) {
      if (tooLong(Number(days), MAX_STEP_DAYS)) throw new RuleTooExpensive();
      return original.call(this, days);
    }
);

// Adding a duration sets the day field directly and leaves the rest to a
// normalisation that walks it a month at a time. An RDATE period is compared
// through exactly this.
patch(
  ICAL.Time.prototype,
  'addDuration',
  (original) =>
    function (this: unknown, duration: unknown) {
      const seconds = (duration as ICAL.Duration).toSeconds();
      if (tooLong(seconds / 86_400, MAX_DURATION_DAYS)) {
        throw new RuleTooExpensive();
      }
      return original.call(this, duration);
    }
);

/** Where ical.js keeps a time's fields; private, so named once. */
const TIME_FIELDS = '_time';

interface TimeFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Every setter on a time defers to this normalisation, which walks the day
// count a month at a time: a rule stepping fifteen digits of minutes sets the
// minute field and spins here, before any rule code runs again. The fields it
// is about to normalise are measured, not only the arguments. Hot, so plain.
patch(
  ICAL.Time.prototype,
  'adjust',
  (original) =>
    function (
      this: unknown,
      days: unknown,
      hours: unknown,
      minutes: unknown,
      seconds: unknown,
      time: unknown
    ) {
      const fields = (time ??
        (this as Record<string, TimeFields>)[TIME_FIELDS]) as TimeFields;
      if (!Number.isFinite(fields.month) || !Number.isFinite(fields.year)) {
        throw new RuleTooExpensive();
      }
      const total =
        (Math.abs(fields.month) / 12) * 366 +
        fields.day +
        (days as number) +
        (fields.hour + (hours as number)) / 24 +
        (fields.minute + (minutes as number)) / 1440 +
        (fields.second + (seconds as number)) / 86_400;
      if (tooLong(total, MAX_DURATION_DAYS)) throw new RuleTooExpensive();
      return original.call(this, days, hours, minutes, seconds, time);
    }
);

/** Zones whose rules could not be expanded within their own budget. */
const brokenZones = new WeakSet<object>();

/**
 * Changes one zone may expand to. A real zone has a few hundred transitions;
 * ical.js scans this list linearly for every time it converts.
 */
const MAX_ZONE_CHANGES = 20_000;

const BROKEN_ZONE =
  'caldav-mcp: the stored entry defines a timezone whose rules this server ' +
  'cannot evaluate. This is the stored entry, not the arguments of this call.';

// A VTIMEZONE's observance rules are expanded by ical.js itself whenever a time
// in that zone is converted or compared — inside a series walk or anywhere
// else this server reads a time.
patch(
  ICAL.Timezone.prototype,
  '_ensureCoverage',
  (original) =>
    function (this: unknown, year: unknown) {
      const zone = this as { changes?: unknown[] };
      if (brokenZones.has(zone)) throw new RuleTooExpensive(BROKEN_ZONE);
      const outer = ruleGuard;
      const own = Date.now() + ZONE_BUDGET_MS;
      const guard = {
        left: MAX_ZONE_CHECKS,
        deadline: Math.min(own, outer?.deadline ?? Number.POSITIVE_INFINITY),
      };
      ruleGuard = guard;
      try {
        const result = original.call(this, year);
        if ((zone.changes?.length ?? 0) > MAX_ZONE_CHANGES) {
          brokenZones.add(zone);
          throw new RuleTooExpensive(BROKEN_ZONE);
        }
        return result;
      } catch (error) {
        if (!(error instanceof RuleTooExpensive)) throw error;
        // Broken for good unless the call's deadline ran out first; then
        // the zone may be fine next time.
        // Every trip but the call's own deadline is the zone's doing: its
        // checks, its 250 ms, or a size no real zone has.
        if (outer === undefined || Date.now() <= outer.deadline) {
          brokenZones.add(zone);
        }
        // A zone condemned says so; one that only met a spent budget does
        // not, so a valid zone is not blamed for a hostile neighbour.
        if (brokenZones.has(zone)) throw new RuleTooExpensive(BROKEN_ZONE);
        throw error instanceof RuleTooExpensive && error.message !== BROKEN_ZONE
          ? error
          : new RuleTooExpensive();
      } finally {
        ruleGuard = outer;
      }
    }
);

import {
  ICAL,
  isKnownZone,
  readTime,
  splitSeries,
  type Kind,
  type RawTime,
} from './ical.js';
import { ToolInputError } from './errors.js';
import { wallClockToInstant } from './time.js';

/**
 * Client-side recurrence expansion.
 *
 * The server is never asked to expand. RFC 4791 offers `<C:expand>` and support
 * for it is uneven — and, worse, it fails *silently*: a server that ignores the
 * element answers with master components, so the result looks thin rather than
 * wrong. Doing it here is the same amount of code, works identically everywhere,
 * and is testable from fixtures with no backend at all, which is why this module
 * contains no HTTP.
 *
 * The division of labour with ical.js is the part worth understanding.
 * `RecurExpansion` produces the **sequence of wall clocks** a rule generates —
 * 09:00 on each day, verified across a daylight-saving boundary both with and
 * without a VTIMEZONE in the document. Turning each of those into an instant is
 * this server's job, through `time.ts`. That split is what makes a daily 09:00
 * meeting stay at 09:00 when the clocks change, instead of drifting an hour.
 */

/** Bound on how far a single rule is walked, whatever the window says. */
const MAX_ITERATIONS = 10_000;

/** Bound on the whole expansion pass, across every series in the request. */
const MAX_ELAPSED_MS = 5_000;

/**
 * How far outside the requested window overrides are still collected.
 *
 * A `time-range` filter is evaluated by the server against the stored component,
 * so an occurrence that an override moved into the window can be missing from
 * the response entirely. Widening the *request* by a month catches the ones
 * people actually create — a meeting shifted by a few days or a week. An
 * occurrence displaced by more than this can be missed, and that is a stated
 * limitation rather than a silent one.
 */
export const WINDOW_SLACK_MS = 31 * 24 * 60 * 60 * 1000;

/** One instance of a series, or a single non-recurring entry. */
export interface Occurrence {
  /**
   * The RECURRENCE-ID that addresses this instance, spelled as iCalendar would.
   * Absent for an entry that does not recur.
   */
  recurrenceId: string | undefined;
  start: RawTime;
  end: RawTime | undefined;
  /** The component to read the rest of the fields from: master, or an override. */
  component: ICAL.Component;
  /** True when a real component with a RECURRENCE-ID backs this instance. */
  isOverride: boolean;
}

export interface ExpansionResult {
  occurrences: Occurrence[];
  /** True when the entry carries an RRULE or RDATE. */
  recurring: boolean;
  /** True when {@link MAX_ITERATIONS} or the deadline stopped a rule early. */
  bounded: boolean;
  /** True when the cap stopped collection before the window was covered. */
  truncated: boolean;
  notes: string[];
}

export interface ExpandOptions {
  /** Only occurrences overlapping this window are returned. */
  from: Date;
  to: Date;
  /** Most occurrences to return from this one entry. */
  cap: number;
  /** Zone for a value written with neither `Z` nor a `TZID`. */
  fallbackZone: string;
  /** Shared deadline, so many series cannot collectively hang the process. */
  deadline?: number;
}

/**
 * Spells a RECURRENCE-ID the way iCalendar would, for use inside an entity id.
 *
 * Three forms, matching the three ways a value can be written. The spelling
 * carries the zone because the same wall clock in two zones is two different
 * instances, and an id that dropped it could address the wrong one.
 */
export function spellRecurrenceId(time: RawTime, fallbackZone: string): string {
  const at = time.instant;
  if (time.allDay) {
    // The zone a date is rendered in has to be the one it was resolved in, or
    // midnight in Berlin prints as the previous day in UTC and the id addresses
    // an occurrence that does not exist.
    return `VALUE=DATE:${stampDate(at, time.zone ?? fallbackZone)}`;
  }
  if (time.zone === undefined) return `${stampUtc(at)}Z`;
  return `TZID=${time.zone}:${stampLocal(at, time.zone)}`;
}

/** Reads a spelling produced by {@link spellRecurrenceId} back into an instant. */
export function parseRecurrenceId(
  spelling: string,
  fallbackZone: string
): RawTime {
  const date = /^VALUE=DATE:(\d{4})(\d{2})(\d{2})$/.exec(spelling);
  if (date !== null) {
    return {
      instant: wallClockToInstant(fallbackZone, {
        year: Number(date[1]),
        month: Number(date[2]),
        day: Number(date[3]),
        hour: 0,
        minute: 0,
        second: 0,
      }),
      zone: undefined,
      allDay: true,
      utc: false,
    };
  }
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(spelling);
  if (utc !== null) {
    return {
      instant: new Date(
        Date.UTC(
          Number(utc[1]),
          Number(utc[2]) - 1,
          Number(utc[3]),
          Number(utc[4]),
          Number(utc[5]),
          Number(utc[6])
        )
      ),
      zone: undefined,
      allDay: false,
      utc: true,
    };
  }
  const zoned =
    /^TZID=([^:]+):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(spelling);
  if (zoned !== null) {
    const zone = zoned[1] as string;
    return {
      instant: wallClockToInstant(isKnownZone(zone) ? zone : fallbackZone, {
        year: Number(zoned[2]),
        month: Number(zoned[3]),
        day: Number(zoned[4]),
        hour: Number(zoned[5]),
        minute: Number(zoned[6]),
        second: Number(zoned[7]),
      }),
      zone,
      allDay: false,
      utc: false,
    };
  }
  throw new ToolInputError(
    'caldav-mcp: that id does not name an occurrence this server can address.'
  );
}

/**
 * The comparison key for an occurrence.
 *
 * Epoch milliseconds, deliberately, rather than the serialised spelling. A
 * RECURRENCE-ID may be written in UTC while the EXDATE excluding it is written
 * with a TZID, or the other way round — comparing strings then says the two are
 * different instants when they are the same one, which is exactly the shape of
 * the "my EXDATE does not work" bug every calendar client has shipped once.
 */
function keyOf(time: RawTime): number {
  return time.instant.getTime();
}

/** Expands one calendar resource into the occurrences inside a window. */
export function expandSeries(
  components: readonly ICAL.Component[],
  options: ExpandOptions
): ExpansionResult {
  const notes: string[] = [];
  const deadline = options.deadline ?? Date.now() + MAX_ELAPSED_MS;
  const { master, overrides } = splitSeries([...components]);

  const overrideByKey = new Map<number, ICAL.Component>();
  let thisAndFuture = false;
  for (const override of overrides) {
    const property = override.getFirstProperty('recurrence-id');
    if (property === null) continue;
    if (property.getParameter('range') !== undefined) thisAndFuture = true;
    const time = instantOfProperty(property, options.fallbackZone);
    overrideByKey.set(keyOf(time), override);
  }
  if (thisAndFuture) {
    notes.push(
      'This series uses RECURRENCE-ID;RANGE=THISANDFUTURE, which this server ' +
        'does not apply. Instances after that point are reported at the times ' +
        'the rule gives, which may not be the times a calendar client shows.'
    );
  }

  // An entry that is only overrides: a client was handed a "this occurrence"
  // update and wrote exactly that. Every component stands on its own.
  if (master === undefined) {
    if (overrides.length > 0) {
      notes.push(
        'This entry has no master component, only individual occurrences. Each ' +
          'is reported on its own.'
      );
    }
    const standalone = overrides
      .map((component) => toOccurrence(component, options.fallbackZone, true))
      .filter(
        (occurrence): occurrence is Occurrence => occurrence !== undefined
      )
      .filter((occurrence) => overlaps(occurrence, options));
    return {
      occurrences: standalone.slice(0, options.cap),
      recurring: overrides.length > 1,
      bounded: false,
      truncated: standalone.length > options.cap,
      notes,
    };
  }

  const masterStart = readTime(master, 'dtstart', options.fallbackZone);
  if (masterStart === undefined) {
    // A VTODO or VJOURNAL need not have a DTSTART at all.
    const single = toOccurrence(master, options.fallbackZone, false);
    return {
      occurrences: single === undefined ? [] : [single],
      recurring: false,
      bounded: false,
      truncated: false,
      notes,
    };
  }

  const rules = master.getAllProperties('rrule');
  const rdates = master.getAllProperties('rdate');
  const recurring = rules.length > 0 || rdates.length > 0;

  if (!recurring) {
    const single = toOccurrence(master, options.fallbackZone, false);
    const kept =
      single !== undefined && overlaps(single, options) ? [single] : [];
    return {
      occurrences: kept,
      recurring: false,
      bounded: false,
      truncated: false,
      notes,
    };
  }

  const exdates = new Set<number>();
  for (const property of master.getAllProperties('exdate')) {
    for (const time of instantsOfProperty(property, options.fallbackZone)) {
      exdates.add(keyOf(time));
    }
  }

  const emitted = new Set<number>();
  const occurrences: Occurrence[] = [];
  let bounded = false;
  let truncated = false;

  const expansion = new ICAL.RecurExpansion({
    component: master,
    dtstart: master.getFirstPropertyValue('dtstart') as ICAL.Time,
  });
  const stopAfter = options.to.getTime() + WINDOW_SLACK_MS;

  for (let steps = 0; ; steps += 1) {
    if (steps >= MAX_ITERATIONS) {
      bounded = true;
      notes.push(
        `This series generates more than ${MAX_ITERATIONS} occurrences in the ` +
          'window asked for, so the walk was stopped. Ask for a shorter range.'
      );
      break;
    }
    if (steps % 256 === 0 && Date.now() > deadline) {
      bounded = true;
      notes.push(
        'Expanding the recurring entries took too long, so the result is ' +
          'incomplete. Ask for a shorter range or fewer calendars.'
      );
      break;
    }

    const next = expansion.next();
    if (next === null || next === undefined) break;
    const at = instantOfTime(next, masterStart.zone, options.fallbackZone);
    if (at.instant.getTime() > stopAfter) break;

    const key = keyOf(at);
    if (exdates.has(key)) continue;

    const override = overrideByKey.get(key);
    const occurrence =
      override === undefined
        ? occurrenceFromMaster(master, at, masterStart, options.fallbackZone)
        : toOccurrence(override, options.fallbackZone, true);
    if (occurrence === undefined) continue;
    emitted.add(key);

    // The window is tested against the instance's own times, not against the
    // point the rule generated: an override that moved this instance out of the
    // window must not appear, even though its RECURRENCE-ID is inside it.
    if (!overlaps(occurrence, options)) continue;

    occurrences.push(occurrence);
    if (occurrences.length >= options.cap) {
      truncated = true;
      break;
    }
  }

  // Pass B — the overrides the rule walk could not reach. An instance moved a
  // week later than its RECURRENCE-ID is generated outside the window (or after
  // the walk stopped) and would otherwise be dropped, which is the failure that
  // makes a moved meeting silently disappear.
  if (!truncated) {
    for (const [key, component] of overrideByKey) {
      if (emitted.has(key)) continue;
      const occurrence = toOccurrence(component, options.fallbackZone, true);
      if (occurrence === undefined) continue;
      if (!overlaps(occurrence, options)) continue;
      occurrences.push(occurrence);
      if (occurrences.length >= options.cap) {
        truncated = true;
        break;
      }
    }
  }

  occurrences.sort(
    (left, right) =>
      left.start.instant.getTime() - right.start.instant.getTime()
  );
  return { occurrences, recurring, bounded, truncated, notes };
}

function overlaps(
  occurrence: Occurrence,
  window: { from: Date; to: Date }
): boolean {
  const start = occurrence.start.instant.getTime();
  const end = occurrence.end?.instant.getTime() ?? start;
  // Half-open, so a meeting ending exactly when the window starts is out and one
  // starting exactly when it ends is out. A zero-length entry is compared on its
  // start alone, or it would never overlap anything.
  if (end === start) {
    return start >= window.from.getTime() && start < window.to.getTime();
  }
  return end > window.from.getTime() && start < window.to.getTime();
}

function occurrenceFromMaster(
  master: ICAL.Component,
  at: RawTime,
  masterStart: RawTime,
  fallbackZone: string
): Occurrence {
  const masterEnd =
    readTime(master, 'dtend', fallbackZone) ??
    readTime(master, 'due', fallbackZone);
  const durationMs =
    masterEnd === undefined
      ? 0
      : masterEnd.instant.getTime() - masterStart.instant.getTime();
  return {
    recurrenceId: spellRecurrenceId(at, fallbackZone),
    start: at,
    end:
      masterEnd === undefined
        ? undefined
        : {
            instant: new Date(at.instant.getTime() + durationMs),
            zone: masterEnd.zone,
            allDay: masterEnd.allDay,
            utc: masterEnd.utc,
          },
    component: master,
    isOverride: false,
  };
}

function toOccurrence(
  component: ICAL.Component,
  fallbackZone: string,
  isOverride: boolean
): Occurrence | undefined {
  const start = readTime(component, 'dtstart', fallbackZone);
  if (start === undefined) return undefined;
  const end =
    readTime(component, 'dtend', fallbackZone) ??
    readTime(component, 'due', fallbackZone);
  const recurrenceProperty = component.getFirstProperty('recurrence-id');
  return {
    recurrenceId:
      recurrenceProperty === null
        ? undefined
        : spellRecurrenceId(
            instantOfProperty(recurrenceProperty, fallbackZone),
            fallbackZone
          ),
    start,
    end,
    component,
    isOverride,
  };
}

/** Resolves a property whose value is a single date or date-time. */
function instantOfProperty(
  property: ICAL.Property,
  fallbackZone: string
): RawTime {
  const tzid = property.getParameter('tzid');
  const named = typeof tzid === 'string' ? tzid : undefined;
  return instantOfTime(
    property.getFirstValue() as ICAL.Time,
    named,
    fallbackZone
  );
}

/** Resolves every value of a property that may carry several (EXDATE, RDATE). */
function instantsOfProperty(
  property: ICAL.Property,
  fallbackZone: string
): RawTime[] {
  const tzid = property.getParameter('tzid');
  const named = typeof tzid === 'string' ? tzid : undefined;
  return property
    .getValues()
    .map((value) => instantOfTime(value as ICAL.Time, named, fallbackZone));
}

/**
 * Turns one wall clock from ical.js into an instant.
 *
 * This is the crossing point described at the top of the file: everything
 * arriving here is a wall clock, and the zone that applies to it is the one the
 * *series* was written in, not whatever ical.js decided.
 */
function instantOfTime(
  value: ICAL.Time,
  zone: string | undefined,
  fallbackZone: string
): RawTime {
  const wall = {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second,
  };
  if (value.isDate) {
    return {
      instant: wallClockToInstant(zone ?? fallbackZone, wall),
      zone,
      allDay: true,
      utc: false,
    };
  }
  if (zone === undefined && value.zone?.tzid === 'UTC') {
    return {
      instant: new Date(
        Date.UTC(
          wall.year,
          wall.month - 1,
          wall.day,
          wall.hour,
          wall.minute,
          wall.second
        )
      ),
      zone: undefined,
      allDay: false,
      utc: true,
    };
  }
  const effective =
    zone !== undefined && isKnownZone(zone) ? zone : fallbackZone;
  return {
    instant: wallClockToInstant(effective, wall),
    zone,
    allDay: false,
    utc: false,
  };
}

function stampUtc(at: Date): string {
  return (
    `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}` +
    `T${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}`
  );
}

function stampLocal(at: Date, zone: string): string {
  const parts = zoneParts(at, zone);
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

function stampDate(at: Date, zone: string): string {
  const parts = zoneParts(at, zone);
  return `${parts.year}${parts.month}${parts.day}`;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(
  at: Date,
  zone: string
): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string> {
  let formatter = zoneFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(at);
  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Midnight renders as 24 in some ICU versions.
    hour: two(Number(read('hour')) % 24),
    minute: read('minute'),
    second: read('second'),
  };
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** The component kind a document holds, for a listing that queried one kind. */
export function kindOf(component: ICAL.Component): Kind | undefined {
  const name = component.name;
  return name === 'vevent' || name === 'vtodo' || name === 'vjournal'
    ? name
    : undefined;
}

import { ToolInputError } from './errors.js';

/**
 * Wall-clock arithmetic for named time zones, without shipping a zone database.
 *
 * ical.js can read a VTIMEZONE that travels with an event, and that is the case
 * it is good at. It cannot resolve a bare `TZID=Europe/Berlin` that arrives with
 * no VTIMEZONE — which is legal, and which Apple's clients emit routinely on the
 * assumption that the reader has zoneinfo. Left alone, ical.js treats such a
 * value as floating time, so every timestamp lands in the wrong hour, silently.
 *
 * Node has the zone database already, in ICU, reachable through `Intl`. So the
 * offset for a given instant is asked of `Intl` rather than derived from a
 * VTIMEZONE, and the answer is exact because it is a question about one instant
 * rather than about a rule.
 */

/** `YYYYMMDDTHHMMSSZ`, the only timestamp form that goes into a request body. */
export type UtcStamp = string;

const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|z|[+-]\d{2}:?\d{2})$/;
const ISO_FLOATING =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Broken-down wall clock, with no zone attached. */
interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The offset of `zone` at a given instant, in minutes east of UTC.
 *
 * Works by formatting the instant in the zone and reading the wall clock back:
 * the difference between that wall clock read as UTC and the instant itself is
 * the offset. `Intl` is the authority, so this follows every historical rule the
 * platform knows.
 */
export function zoneOffsetMinutes(zone: string, instant: Date): number {
  const parts = zoneFormatter(zone).formatToParts(instant);
  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };
  // `hour12: false` still renders midnight as 24 in some ICU versions.
  const hour = read('hour') % 24;
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second')
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
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
      era: 'short',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turns a wall clock in a zone into the instant it names.
 *
 * Not a fixed-point iteration, because that silently picks the wrong side of a
 * daylight-saving change. Instead both plausible offsets are tried — the one in
 * force a day earlier and the one a day later — and each is kept only if the
 * instant it produces really does have that offset. That is what distinguishes
 * the three cases from each other rather than guessing between them:
 *
 * - **One candidate valid** — the ordinary case, and the answer.
 * - **Both valid** — the hour that repeats when the clocks go back. The
 *   *earlier* instant is chosen: a person writing "02:30" on that night means
 *   the first one, and so does every calendar client.
 * - **Neither valid** — the hour skipped when the clocks go forward, which does
 *   not exist. The pre-transition offset is used, so the value lands an hour
 *   later in real time. Refusing would be defensible, but a recurring 02:30
 *   meeting must not fail once a year.
 */
export function wallClockToInstant(zone: string, wall: WallClock): Date {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second
  );
  const before = zoneOffsetMinutes(zone, new Date(naive - DAY_MS));
  const after = zoneOffsetMinutes(zone, new Date(naive + DAY_MS));

  const candidates: number[] = [];
  for (const offset of before === after ? [before] : [before, after]) {
    const instant = naive - offset * 60_000;
    if (zoneOffsetMinutes(zone, new Date(instant)) === offset) {
      candidates.push(instant);
    }
  }
  if (candidates.length === 0) {
    // The gap. `before` is the offset the wall clock was written against.
    return new Date(naive - before * 60_000);
  }
  return new Date(Math.min(...candidates));
}

/** `2026-09-07T09:00:00+02:00` for an instant seen from a zone. */
export function formatInZone(instant: Date, zone: string): string {
  const offset = zoneOffsetMinutes(zone, instant);
  const shifted = new Date(instant.getTime() + offset * 60_000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const suffix =
    offset === 0 ? 'Z' : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    suffix
  );
}

/** `YYYYMMDDTHHMMSSZ` for a request body. */
export function toUtcStamp(instant: Date): UtcStamp {
  return (
    `${instant.getUTCFullYear()}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}` +
    `T${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`
  );
}

/** `YYYY-MM-DD` for an all-day value, read in the zone it was written in. */
export function formatDateInZone(instant: Date, zone: string): string {
  const offset = zoneOffsetMinutes(zone, instant);
  const shifted = new Date(instant.getTime() + offset * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** What a caller-supplied timestamp resolved to. */
export interface ParsedInput {
  /** The instant, for comparison and for a request body. */
  instant: Date;
  /** True when the caller named a date and no time. */
  allDay: boolean;
  /**
   * The zone the value should be written back in: the caller's `timezone`, the
   * zone implied by an explicit offset, or the configured default. `undefined`
   * for a UTC value, which is written as UTC.
   */
  zone: string | undefined;
}

/**
 * Parses a caller-supplied timestamp.
 *
 * Three accepted forms, and the third is why this is not one line of `new Date`:
 *
 * - `2026-09-07T09:00:00+02:00` or `…Z` — an instant, unambiguous.
 * - `2026-09-07T09:00:00` — a wall clock, resolved in `zone`.
 * - `2026-09-07` — a date, meaning an all-day value.
 *
 * `new Date()` would accept all three and quietly disagree with the caller about
 * the second (it reads a bare date-time as *local* time, which on a server is
 * whatever TZ the container inherited) and about the third (which it reads as
 * UTC midnight). Both mistakes shift real appointments.
 */
export function parseInstant(
  value: string,
  field: string,
  defaultZone: string,
  explicitZone?: string
): ParsedInput {
  const zone = explicitZone ?? defaultZone;
  const raw = value.trim();

  const date = ISO_DATE.exec(raw);
  if (date !== null) {
    const wall = {
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour: 0,
      minute: 0,
      second: 0,
    };
    assertCalendarDate(wall, raw, field);
    return {
      instant: wallClockToInstant(zone, wall),
      allDay: true,
      zone,
    };
  }

  const zoned = ISO_WITH_ZONE.exec(raw);
  if (zoned !== null) {
    if (explicitZone !== undefined) {
      throw new ToolInputError(
        `caldav-mcp: ${field} carries its own offset (${zoned[7]}) and a ` +
          `timezone (${explicitZone}) was given as well. Pass one or the other, ` +
          'so there is no question which one was meant.'
      );
    }
    const parsed = new Date(raw.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) {
      throw new ToolInputError(
        `caldav-mcp: ${field} is not a valid timestamp: "${value}".`
      );
    }
    const isUtc = /[Zz]$/.test(raw);
    return {
      instant: parsed,
      allDay: false,
      zone: isUtc ? undefined : defaultZone,
    };
  }

  const floating = ISO_FLOATING.exec(raw);
  if (floating !== null) {
    const wall = {
      year: Number(floating[1]),
      month: Number(floating[2]),
      day: Number(floating[3]),
      hour: Number(floating[4]),
      minute: Number(floating[5]),
      second: Number(floating[6] ?? '0'),
    };
    assertCalendarDate(wall, raw, field);
    if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) {
      throw new ToolInputError(
        `caldav-mcp: ${field} is not a valid time of day: "${value}".`
      );
    }
    return { instant: wallClockToInstant(zone, wall), allDay: false, zone };
  }

  throw new ToolInputError(
    `caldav-mcp: ${field} must be an ISO 8601 date or timestamp — ` +
      '"2026-09-07", "2026-09-07T09:00:00" (interpreted in the timezone ' +
      'parameter or CALDAV_TIMEZONE), or "2026-09-07T09:00:00+02:00". ' +
      `Got "${value}".`
  );
}

/**
 * Rejects a date that does not exist, which the regex cannot.
 *
 * `2026-02-30` matches the shape and `Date.UTC` rolls it forward to March 2nd
 * without complaint. A caller who asked for the 30th of February should be told
 * so, not silently given a different day.
 */
function assertCalendarDate(wall: WallClock, raw: string, field: string): void {
  const probe = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  if (
    probe.getUTCFullYear() !== wall.year ||
    probe.getUTCMonth() !== wall.month - 1 ||
    probe.getUTCDate() !== wall.day
  ) {
    throw new ToolInputError(
      `caldav-mcp: ${field} is not a real date: "${raw}".`
    );
  }
}

/** How a timestamp is reported back: the instant, its zone, and the all-day flag. */
export interface RenderedTime {
  /** ISO 8601 with an explicit offset, or a bare date for an all-day value. */
  value: string;
  /** The zone the entry was written in, where the entry named one. */
  tzid?: string;
  /** True when the entry carries a date rather than a date-time. */
  allDay: boolean;
}

/**
 * Renders a stored value for a tool result.
 *
 * The offset alone is not enough and neither is the TZID alone, which is why
 * both are reported. An offset says what the instant is; the zone name says what
 * the *rule* is, and only the rule survives a daylight-saving change — an event
 * pinned to `+02:00` moves an hour every winter, an event in `Europe/Berlin`
 * does not. A client that only wants an instant reads `value` and ignores the
 * rest.
 */
export function renderTime(
  instant: Date,
  options: { zone?: string | undefined; allDay: boolean; fallbackZone: string }
): RenderedTime {
  const zone = options.zone ?? options.fallbackZone;
  if (options.allDay) {
    return {
      value: formatDateInZone(instant, zone),
      ...(options.zone === undefined ? {} : { tzid: options.zone }),
      allDay: true,
    };
  }
  return {
    value: formatInZone(instant, zone),
    ...(options.zone === undefined ? {} : { tzid: options.zone }),
    allDay: false,
  };
}
